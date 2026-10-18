/**
 * T20 浏览器 / 持久 JS 集成自证。
 *
 * 覆盖：
 * a. 同一会话两次 js 调用状态持久（state = 41 → state + 1 = 42）；
 * b. 不同 agent/session 的 kernel 隔离（A 的 state 不出现在 B）；
 * c. nodeRepl.emitImage → dsh attachment 存储 → 下一模型请求 image 块（T14 通路），
 *    并覆盖 attachment 服务缺席时的显式文本降级；
 * d. 长求值取消（dsh signal → NodeReplSession abort/kernel reset）与 agent dispose /
 *    插件卸载的 kernel 清理（无残留记录、在途 run 收口）；
 * e. @deepseek-ai/dsh-browser-use 的注册面（源码实际只有独占注册表、无后端/工具面），
 *    以及探针自带的受控 mock provider 一次读取 + 一次操作经 dsh 管线执行；
 * f. js / browser 工具调用都经过 tools/pre-execute（计数，证明不旁路）。
 *
 * 真实浏览器：该 provider 包不携带浏览器引擎或可注入后端；本探针只验证注册面与
 * mock 后端管线，不冒充真实浏览器验收。CUA（桌面操作）在 dsh 生态无 provider，不伪造入口。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import LocalAttachmentStore from "@deepseek-ai/dsh-attachment-local";
import type { AttachmentStore, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import BrowserUseRegistry from "@deepseek-ai/dsh-browser-use";
import { BrowserUseProviderName } from "@deepseek-ai/dsh-browser-use/brand";
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type {
  ContentBlock,
  GenerateOptions,
  StreamChunk,
  UserMessage,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";

import ZcodeLoop, { PersistentJs } from "../src/index.js";

/** 1x1 RGBA PNG（attachment-local 会校验并归一化）。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type Step = (request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>;

class ProbeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly steps: Step[] = [];

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
      defaultMaxTokens: 512,
      inputModalities: ["text", "image"] as const,
    });
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const step = this.steps.shift();
    assert(step, "ProbeAdapter: script exhausted");
    for (const chunk of await step(request)) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

interface ToolCallSpec {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

function toolCallChunks(calls: readonly ToolCallSpec[]): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [index, call] of calls.entries()) {
    const args = JSON.stringify(call.args ?? {});
    chunks.push(
      { type: "block-start", index, blockType: "tool-call" },
      {
        type: "tool-call-delta",
        index,
        id: ToolCallId(call.id),
        name: call.name,
        argumentsDelta: args,
      },
      {
        type: "block-end",
        index,
        block: { type: "tool-call", id: ToolCallId(call.id), name: call.name, arguments: args },
      },
    );
  }
  chunks.push({ type: "finish", reason: { kind: "tool-calls" } });
  return chunks;
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

function contentText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text" || block.type === "reasoning") return block.text;
      if (block.type === "image") return `[image ${block.attachment.attachmentId}]`;
      if (block.type === "file") return `[file ${block.attachment.attachmentId}]`;
      return JSON.stringify(block);
    })
    .join("\n");
}

function lastToolResult(agent: Agent) {
  const event = agent.session
    .snapshotEvents()
    .filter((candidate) => candidate.type === "tool/result")
    .at(-1);
  assert(event?.type === "tool/result", "expected a durable tool/result");
  return event.data.message;
}

async function runToolTurn(
  agent: Agent,
  adapter: ProbeAdapter,
  calls: readonly ToolCallSpec[],
  prompt = "run probe",
): Promise<void> {
  adapter.steps.push(() => toolCallChunks(calls), () => textChunks("done"));
  agent.followup(userMessage(prompt));
  await agent.whenIdle();
}

interface MountOptions {
  attachments?: boolean;
  browserUse?: boolean;
}

async function mount(options: MountOptions = {}) {
  const dshHome = await mkdtemp(join(tmpdir(), "browser-cua-repl-home-"));
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  if (options.attachments === true) {
    await ctx.plugin(LocalAttachmentStore, { dshHome });
  }
  if (options.browserUse === true) await ctx.plugin(BrowserUseRegistry);
  const persistentJsFiber = await ctx.plugin(PersistentJs, {});
  await ctx.plugin(ZcodeLoop, { provider: "probe", model: "mock" });
  const adapter = new ProbeAdapter();
  ctx.llm.registerAdapter(["probe"], adapter);
  const service = ctx.get("persistentJs") as PersistentJs;
  return { ctx, adapter, dshHome, persistentJsFiber, service };
}

async function createAgent(ctx: Context, id: string): Promise<AgentHandle> {
  return ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: "probe", model: "mock" },
  });
}

interface MockBrowserProvider {
  readonly backend: { page: string; reads: number; clicks: number };
  dispose(): Promise<void>;
}

/**
 * 受控 mock browser provider：注册独占 provider 槽位，并自己提供两个 dsh 工具。
 * 这不是 @deepseek-ai/dsh-browser-use 自带的工具面（该包只有注册表），
 * 真实浏览器执行未验证。
 */
function installMockBrowserProvider(ctx: Context): MockBrowserProvider {
  const backend = { page: "mock page: title=Probe; body=hello", reads: 0, clicks: 0 };
  const release = ctx.browserUse.register(BrowserUseProviderName("probe-mock-browser"));
  const disposers = [
    ctx.tools.register(
      defineTool({
        name: "browser_read",
        description: "Read the current page from the probe-owned mock browser backend.",
        parameters: {},
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        execute: async () => {
          backend.reads += 1;
          return { page: backend.page, reads: backend.reads };
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: "browser_click",
        description: "Perform one click on the probe-owned mock browser backend.",
        parameters: {},
        output: {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        execute: async () => {
          backend.clicks += 1;
          return { clicked: true, clicks: backend.clicks };
        },
      }),
    ),
  ];
  return {
    backend,
    async dispose() {
      for (const dispose of disposers) dispose();
      await release();
    },
  };
}

/** a + b: 同会话持久、跨会话隔离。 */
async function persistenceAndIsolationProbe(
  ctx: Context,
  adapter: ProbeAdapter,
  handleA: AgentHandle,
  handleB: AgentHandle,
): Promise<void> {
  await runToolTurn(handleA.agent, adapter, [
    { id: "js-set", name: "js", args: { code: "state = 41" } },
  ], "set persistent state");
  await runToolTurn(handleA.agent, adapter, [
    { id: "js-read", name: "js", args: { code: "state + 1" } },
  ], "read persistent state");
  const persisted = contentText(lastToolResult(handleA.agent).content);
  assert.match(persisted, /=> 42/, `same-session state must persist: ${persisted}`);

  await runToolTurn(handleB.agent, adapter, [
    { id: "js-isolated", name: "js", args: { code: "typeof state" } },
  ], "read state in another session");
  const isolated = contentText(lastToolResult(handleB.agent).content);
  assert.match(isolated, /=> undefined/, `state must not leak across sessions: ${isolated}`);
  assert(!isolated.includes("=> 42"), "session B must not observe session A's value");

  await runToolTurn(handleB.agent, adapter, [
    { id: "js-b-set", name: "js", args: { code: "state = 7" } },
  ], "set state in session B");
  await runToolTurn(handleA.agent, adapter, [
    { id: "js-a-again", name: "js", args: { code: "state" } },
  ], "re-read state in session A");
  const stillA = contentText(lastToolResult(handleA.agent).content);
  assert.match(stillA, /=> 41/, `session A state must stay 41: ${stillA}`);
  console.log("[browser-cua-repl] a/b. persistent JS state and cross-session isolation verified");
}

/** c: emitImage → attachment store → next model request image block. */
async function imageProbe(
  ctx: Context,
  adapter: ProbeAdapter,
  agent: Agent,
): Promise<void> {
  await runToolTurn(agent, adapter, [
    {
      id: "js-image",
      name: "js",
      args: {
        code: `nodeRepl.emitImage({ base64: ${JSON.stringify(PNG_BASE64)}, mimeType: "image/png" })`,
      },
    },
  ], "emit an image");

  const request = adapter.requests.at(-1);
  assert(request, "expected the post-tool request");
  const toolBlocks = request.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []));
  const imageBlock = toolBlocks.find((block): block is Extract<ContentBlock, { type: "image" }> =>
    block.type === "image");
  assert(imageBlock, `post-tool request must carry an image block: ${JSON.stringify(toolBlocks.map((b) => b.type))}`);

  const durable = lastToolResult(agent);
  assert(Array.isArray(durable.content), "durable tool/result must keep block structure");
  assert(
    durable.content.some((block) => block.type === "image"),
    "durable tool/result must keep the image reference",
  );

  const store = ctx.get("attachments") as AttachmentStore;
  const stored = await store.readImage(imageBlock.attachment);
  assert(stored.data.length > 0, "emitted image bytes must be readable through attachment storage");
  const ref: ImageAttachmentRef = stored.ref;
  // attachment-local 会归一化编码（实测 1x1 PNG → webp）；只断言仍是图片。
  assert.match(ref.mediaType, /^image\//);
  assert(ref.bytes > 0);
  console.log("[browser-cua-repl] c. emitImage routed through dsh attachments into the model request");
}

/** c 降级：attachment 服务缺席时输出显式文本占位，不伪造 image 块。 */
async function imageDegradationProbe(): Promise<void> {
  const { ctx, persistentJsFiber } = await mount({ attachments: false });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(ctx, "repl-no-attachments");
    const controller = new AbortController();
    const result = await ctx.tools.execute({
      callId: ToolCallId("js-image-degraded"),
      name: "js",
      arguments: {
        code: `nodeRepl.emitImage({ base64: ${JSON.stringify(PNG_BASE64)}, mimeType: "image/png" })`,
      },
      agent: handle.agent,
      signal: controller.signal,
    });
    assert.equal(result.isError, false);
    assert(
      result.content.every((block) => block.type === "text"),
      "without attachments the result must not claim an image block",
    );
    const text = contentText(result.content);
    assert.match(text, /\[image image\/png omitted: dsh attachment service is not mounted\]/);
    console.log("[browser-cua-repl] c'. missing attachment service degrades to explicit text");
  } finally {
    await handle?.dispose();
    await persistentJsFiber.dispose();
    await ctx.fiber.dispose();
  }
}

/** d: cancel 长求值 → AbortError/kernel reset；dispose → kernel 记录清零。 */
async function cancellationProbe(
  ctx: Context,
  adapter: ProbeAdapter,
  agent: Agent,
): Promise<void> {
  const started = Promise.withResolvers<void>();
  const stopListening = ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name === "js") started.resolve();
    return next();
  });
  try {
    adapter.steps.push(() =>
      toolCallChunks([
        {
          id: "js-cancel",
          name: "js",
          args: { code: "await new Promise(() => {})", timeout_ms: 120_000 },
        },
      ]),
    );
    agent.followup(userMessage("run a long evaluation"));
    await started.promise;
    // pre-execute 在工具体之前触发；等工具体真正进入 NodeReplSession.run 的 await 再取消。
    await new Promise((resolve) => setTimeout(resolve, 100));
    agent.cancel({ kind: "user" });
    await agent.whenIdle();
  } finally {
    stopListening();
  }

  const result = lastToolResult(agent);
  const cancelledText = contentText(result.content);
  assert.equal(
    result.isError,
    true,
    `cancelled evaluation must surface as an error: ${cancelledText}`,
  );
  // dsh 的规范取消结果正文可能是空或通用失败文案；turn/end 的 aborted 是权威判据。
  if (cancelledText.length > 0) {
    assert.match(cancelledText, /Abort|cancel|disposed|failed/i);
  }
  const turnEnd = agent.session
    .snapshotEvents()
    .filter((event) => event.type === "turn/end")
    .at(-1);
  assert(turnEnd?.type === "turn/end");
  assert.equal(turnEnd.data.reason.kind, "aborted");

  // abort 走 NodeReplSession 的 kernel reset：取消前写入的 state 不再可见。
  await runToolTurn(agent, adapter, [
    { id: "js-after-cancel", name: "js", args: { code: "typeof state" } },
  ], "verify kernel reset after cancellation");
  const afterCancel = contentText(lastToolResult(agent).content);
  assert.match(afterCancel, /=> undefined/, `cancellation must reset the kernel: ${afterCancel}`);
  console.log("[browser-cua-repl] d1. in-flight js evaluation aborts through the dsh signal");
}

/** e + f: browser-use 注册面、mock 后端读取/操作、pre-execute 计数。 */
async function browserProbe(
  ctx: Context,
  adapter: ProbeAdapter,
  agent: Agent,
  preExecuteNames: string[],
  provider: MockBrowserProvider,
): Promise<void> {
  assert.equal(
    ctx.browserUse.providerName,
    "probe-mock-browser",
    "mock provider must own the exclusive browser-use slot",
  );
  await assert.rejects(
    async () => ctx.browserUse.register(BrowserUseProviderName("second-provider")),
    /already registered/,
    "a second provider registration must fail",
  );

  await runToolTurn(agent, adapter, [{ id: "browser-read", name: "browser_read" }], "read the page");
  const readResult = contentText(lastToolResult(agent).content);
  assert.match(readResult, /mock page: title=Probe/, `mock read must return page content: ${readResult}`);

  await runToolTurn(agent, adapter, [{ id: "browser-click", name: "browser_click" }], "click once");
  const clickResult = contentText(lastToolResult(agent).content);
  assert.match(clickResult, /"clicks":1/, `mock operation must mutate backend state: ${clickResult}`);

  assert.equal(provider.backend.reads, 1);
  assert.equal(provider.backend.clicks, 1);
  assert(preExecuteNames.includes("browser_read"), "browser_read must cross tools/pre-execute");
  assert(preExecuteNames.includes("browser_click"), "browser_click must cross tools/pre-execute");
  assert(preExecuteNames.includes("js"), "js must cross tools/pre-execute");
  console.log(
    "[browser-cua-repl] e/f. exclusive registration, mock read+click, and pre-execute coverage verified",
  );
}

/** d2: 插件卸载中止在途 run 并清空 kernel 记录。 */
async function unloadProbe(
  ctx: Context,
  adapter: ProbeAdapter,
  service: PersistentJs,
  fiber: Fiber,
): Promise<void> {
  const handle = await createAgent(ctx, "repl-unload");
  const started = Promise.withResolvers<void>();
  const stopListening = ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name === "js") started.resolve();
    return next();
  });
  try {
    adapter.steps.push(() =>
      toolCallChunks([
        {
          id: "js-unload",
          name: "js",
          args: { code: "await new Promise(() => {})", timeout_ms: 120_000 },
        },
      ]),
    );
    handle.agent.followup(userMessage("run until unload"));
    await started.promise;
    // 等工具体真正进入 run，确保卸载目标是"在途执行"而不是尚未 dispatch 的调用。
    await new Promise((resolve) => setTimeout(resolve, 100));
    const unloading = fiber.dispose();
    await handle.agent.whenIdle();
    await unloading;
    assert.equal(service.activeSessionCount(), 0, "plugin unload must close every kernel");
    assert.equal(
      ctx.tools.get("js", handle.agent),
      undefined,
      "plugin unload must unregister the scoped js tool",
    );
    const unloadedResult = lastToolResult(handle.agent);
    assert.equal(unloadedResult.isError, true, "in-flight evaluation must settle as an error on unload");
    console.log("[browser-cua-repl] d2. plugin unload aborts in-flight work and closes kernels");
  } finally {
    stopListening();
    await handle.dispose();
    await handle.dispose();
  }
}

async function assertBrowserUsePackageSurface(): Promise<void> {
  const module = await import("@deepseek-ai/dsh-browser-use");
  assert.deepEqual(
    Object.keys(module).sort(),
    ["BrowserUseRegistry", "default"],
    "browser-use package must expose only the registration service",
  );
  console.log(
    "[browser-cua-repl] e. @deepseek-ai/dsh-browser-use ships only BrowserUseRegistry " +
      "(no browser backend or tool surface); real browser execution is not claimed",
  );
}

const watchdog = setTimeout(() => {
  console.error("[browser-cua-repl] FAIL: watchdog expired");
  process.exit(1);
}, 90_000);
watchdog.unref();

let primaryHome: string | undefined;
try {
  await assertBrowserUsePackageSurface();

  const { ctx, adapter, dshHome, persistentJsFiber, service } = await mount({
    attachments: true,
    browserUse: true,
  });
  primaryHome = dshHome;
  const preExecuteNames: string[] = [];
  ctx.on("tools/pre-execute", async (exec, next) => {
    preExecuteNames.push(exec.name);
    return next();
  });

  assert.equal(ctx.browserUse.providerName, undefined);
  const provider = installMockBrowserProvider(ctx);
  const handleA = await createAgent(ctx, "repl-session-a");
  const handleB = await createAgent(ctx, "repl-session-b");
  let unloadDone = false;
  try {
    await persistenceAndIsolationProbe(ctx, adapter, handleA, handleB);
    await imageProbe(ctx, adapter, handleA.agent);
    await browserProbe(ctx, adapter, handleA.agent, preExecuteNames, provider);
    await cancellationProbe(ctx, adapter, handleA.agent);

    assert(service.activeSessionCount() >= 2, "each live agent must own a kernel");
    await handleA.dispose();
    await handleB.dispose();
    await service.whenIdle();
    assert.equal(service.activeSessionCount(), 0, "agent dispose must close both kernels");

    await unloadProbe(ctx, adapter, service, persistentJsFiber);
    unloadDone = true;
  } finally {
    await provider.dispose();
    assert.equal(ctx.browserUse.providerName, undefined, "provider release must free the slot");
    if (!unloadDone) {
      await persistentJsFiber.dispose();
    }
    if (ctx.fiber.state !== 4) await ctx.fiber.dispose();
  }

  await imageDegradationProbe();
  clearTimeout(watchdog);
  console.log(
    "[browser-cua-repl] PASS: persistence, isolation, media, cancellation, lifecycle, " +
      "browser registration/mock pipeline, and pre-execute coverage",
  );
  process.exit(0);
} catch (error) {
  clearTimeout(watchdog);
  console.error("[browser-cua-repl] FAIL:", error);
  process.exit(1);
} finally {
  if (primaryHome !== undefined) await rm(primaryHome, { recursive: true, force: true });
}
