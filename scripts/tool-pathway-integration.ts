/**
 * T08 工具完整通路集成自证。
 *
 * 复用 pipeline/model-config 的装配（npm Cordis + 真实 ToolRuntime + 本插件，
 * 不装 stock agent-loop），逐项覆盖：
 * a. 长工具遵守 dsh `timeoutMs`（timeout policy 包装），未声明工具没有桥 deadline；
 * b. 超大结果：未装 spill 时完整进入模型与 durable log；装 spill 时模型只收
 *    preview + locator，locator 可读回完整内容；
 * c. 并发分类：无条件安全并行、未声明独占、条件安全保守串行，结果顺序稳定；
 * d. 权限拒绝零副作用；执行中取消走 dsh 合作式信号，不旁路；
 * e. 同 turn 动态工具增删在下一步 dispatch/header/toolHistory 可见；
 * f. 工具结果多块结构进入 durable tool/result 与下一请求（image 引用保留结构，
 *    文本不丢）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
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
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import * as SpillPolicy from "@deepseek-ai/dsh-spill-policy";
import LocalSpillStore from "@deepseek-ai/dsh-spill-local";
import * as TimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";

import ZcodeLoop, { createDshToolBridge } from "../src/index.js";

// ------------------------------------------------------------------
// scripted adapter
// ------------------------------------------------------------------

type Step = (request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>;

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly steps: Step[] = [];

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const step = this.steps.shift();
    assert(step, "ScriptedAdapter: script exhausted");
    for (const chunk of await step(request)) {
      if (request.signal?.aborted) throw new Error("aborted");
      yield chunk;
    }
  }
}

interface ToolCallSpec {
  id: string;
  name: string;
  args?: Record<string, unknown>;
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

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

// ------------------------------------------------------------------
// 装配
// ------------------------------------------------------------------

interface MountOptions {
  timeoutPolicy?: boolean;
  spill?: { root: string; maxInlineTokens: number };
}

async function mount(options: MountOptions = {}) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  if (options.timeoutPolicy === true) await ctx.plugin(TimeoutPolicy);
  if (options.spill !== undefined) {
    await ctx.plugin(LocalSpillStore, { root: options.spill.root, cleanupPeriodDays: 0 });
    await ctx.plugin(SpillPolicy, { maxInlineTokens: options.spill.maxInlineTokens });
  }
  await ctx.plugin(ZcodeLoop, { provider: "mock", model: "mock" });
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter(["mock"], adapter);
  return { ctx, adapter };
}

async function createAgent(ctx: Context, id: string) {
  const handle = await ctx.agents.create({ sessionId: SessionId(id) });
  return { handle, agent: handle.agent };
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

async function runTurn(agent: Agent, adapter: ScriptedAdapter, calls: readonly ToolCallSpec[]): Promise<void> {
  adapter.steps.push(() => toolCallChunks(calls), () => textChunks("done"));
  agent.followup(userMessage("run probe"));
  await agent.whenIdle();
}

/** defineTool 的入参校验包装不接受注册期 `undefined` 探测，元数据在返回对象上补。 */
function defineProbeTool(
  name: string,
  execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>,
  options: {
    render?: (value: unknown) => ContentBlock[];
    timeoutMs?: number;
    isConcurrencySafe?: (args: unknown) => boolean;
  } = {},
): ToolDefinition {
  const tool = defineTool({
    name,
    description: `probe tool ${name}`,
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) =>
        options.render?.(value) ?? [{ type: "text", text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => (await execute(args, exec)) as Record<string, never>,
  });
  return Object.assign(tool, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe }),
  });
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

function toolResultEvents(agent: Agent) {
  return agent.session.snapshotEvents().filter((event) => event.type === "tool/result");
}

function lastToolResult(agent: Agent) {
  const event = toolResultEvents(agent).at(-1);
  assert(event?.type === "tool/result", "expected a durable tool/result");
  return event.data.message;
}

// ------------------------------------------------------------------
// a. dsh 配置的 timeout 是唯一策略
// ------------------------------------------------------------------

async function timeoutProbe(): Promise<void> {
  const { ctx, adapter } = await mount({ timeoutPolicy: true });
  const abortObserved: Record<string, boolean> = {};
  const elapsed: Record<string, number> = {};

  const slow = (name: string) => (_args: unknown, exec: { signal: AbortSignal }) =>
    new Promise<Record<string, never>>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        elapsed[name] = Date.now() - startedAt;
        resolve({});
      }, 2_000);
      const onAbort = () => {
        clearTimeout(timer);
        abortObserved[name] = true;
        reject(new Error(`${name} aborted`));
      };
      if (exec.signal.aborted) onAbort();
      else exec.signal.addEventListener("abort", onAbort, { once: true });
    });

  const delay =
    (name: string, delayMs: number) =>
    (_args: unknown, exec: { signal: AbortSignal }) =>
      new Promise<Record<string, never>>((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setTimeout(() => {
          elapsed[name] = Date.now() - startedAt;
          resolve({});
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          abortObserved[name] = true;
          reject(new Error(`${name} aborted`));
        };
        if (exec.signal.aborted) onAbort();
        else exec.signal.addEventListener("abort", onAbort, { once: true });
      });

  ctx.tools.register(defineProbeTool("declared_fast", delay("declared_fast", 300), { timeoutMs: 1_500 }));
  ctx.tools.register(defineProbeTool("declared_slow", slow("declared_slow"), { timeoutMs: 300 }));
  ctx.tools.register(defineProbeTool("undeclared_slow", delay("undeclared_slow", 500)));

  const { handle, agent } = await createAgent(ctx, "tool-timeout");
  const probe = createDshToolBridge({ ctx, agent: () => agent });
  probe.syncTools();
  assert.deepEqual(probe.registry.get("declared_slow")?.timeout, {
    kind: "timed",
    defaultMs: 300,
    allowCallOverride: false,
    cleanupGraceMs: 250,
  });
  assert.deepEqual(probe.registry.get("declared_fast")?.timeout, {
    kind: "timed",
    defaultMs: 1_500,
    allowCallOverride: false,
    cleanupGraceMs: 250,
  });
  assert.deepEqual(probe.registry.get("undeclared_slow")?.timeout, { kind: "none" });
  assert.equal(probe.registry.get("declared_slow")?.metadata.timeoutMs, 300);
  assert.equal(probe.registry.get("undeclared_slow")?.metadata.timeoutMs, undefined);
  assert.equal(probe.registry.get("declared_slow")?.resultBudget.maxModelBytes, Number.MAX_SAFE_INTEGER);

  await runTurn(agent, adapter, [{ id: "timeout-fast", name: "declared_fast" }]);
  const fast = lastToolResult(agent);
  assert.equal(fast.isError, false);
  assert(elapsed.declared_fast !== undefined && elapsed.declared_fast < 1_000, "declared_fast must finish under its limit");

  await runTurn(agent, adapter, [{ id: "timeout-slow", name: "declared_slow" }]);
  const timedOut = lastToolResult(agent);
  assert.equal(timedOut.isError, true, "declared timeout must surface as an error result");
  const timedOutText = contentText(timedOut.content);
  assert.match(timedOutText, /timed out|timeout/i, `timeout error must be explicit: ${timedOutText}`);
  assert.match(
    timedOutText,
    /tool call timed out after 300ms/,
    `dsh timeout policy must own the surfaced error: ${timedOutText}`,
  );
  assert(!/120000|120000ms|120s/.test(timedOutText), "the removed 120s bridge deadline must not leak");
  assert.equal(abortObserved.declared_slow, true, "expiry must abort the dispatched signal");
  assert(elapsed.declared_slow === undefined, "timeout must settle before the 2s body completes");

  await runTurn(agent, adapter, [{ id: "timeout-undeclared", name: "undeclared_slow" }]);
  const undeclared = lastToolResult(agent);
  assert.equal(undeclared.isError, false, "undeclared tools must have no bridge deadline");
  assert(elapsed.undeclared_slow !== undefined && elapsed.undeclared_slow >= 450, "undeclared tool completes normally");

  await handle.dispose();
  console.log("[tool-pathway] a. dsh timeout policy respected; no bridge 120s deadline");
}

// ------------------------------------------------------------------
// b. 超大结果（无 spill / 有 spill）
// ------------------------------------------------------------------

const BIG_TEXT = `${"head-".repeat(1)}\n${"x".repeat(300 * 1024)}\nTAIL-MARKER`;

async function oversizedProbe(): Promise<void> {
  {
    const { ctx, adapter } = await mount();
    ctx.tools.register(
      defineProbeTool("big_output", async () => ({ blob: BIG_TEXT }), {
        render: () => [{ type: "text", text: BIG_TEXT }],
      }),
    );
    const { handle, agent } = await createAgent(ctx, "tool-big-no-spill");
    await runTurn(agent, adapter, [{ id: "big-call", name: "big_output" }]);

    const second = adapter.requests[1];
    assert(second, "expected the post-tool request");
    const toolMessage = second.messages.filter((message) => message.role === "tool").at(-1);
    assert(toolMessage, "post-tool request must include the tool result");
    assert.equal(contentText(toolMessage.content), BIG_TEXT, "model must receive the complete oversized result");

    const durable = lastToolResult(agent);
    assert.equal(contentText(durable.content), BIG_TEXT, "durable tool/result must keep the complete result");

    // 严格 JSONL 读回：逐行序列化后重建 Session，内容仍一致。
    const events = agent.session.snapshotEvents();
    const jsonl = events.map((event) => JSON.stringify(event)).join("\n");
    const parsed = jsonl.split("\n").map((line) => JSON.parse(line) as (typeof events)[number]);
    assert.equal(parsed.map((event) => JSON.stringify(event)).join("\n"), jsonl, "JSONL roundtrip must be byte-identical");
    const replayed = Session.create(SessionId("tool-big-replay"), parsed);
    const replayedTool = replayed.deriveMessages().filter((message) => message.role === "tool").at(-1);
    assert(replayedTool, "replayed session must keep the tool result");
    assert.equal(contentText(replayedTool.content), BIG_TEXT, "JSONL replay must reproduce the full result");

    await handle.dispose();
    console.log("[tool-pathway] b1. oversized result preserved without spill");
  }

  {
    const root = await mkdtemp(join(tmpdir(), "tool-pathway-spill-"));
    try {
      const { ctx, adapter } = await mount({ spill: { root, maxInlineTokens: 120 } });
      ctx.tools.register(
        defineProbeTool("spill_output", async () => ({ blob: BIG_TEXT }), {
          render: () => [{ type: "text", text: BIG_TEXT }],
        }),
      );
      const { handle, agent } = await createAgent(ctx, "tool-big-spill");
      await runTurn(agent, adapter, [{ id: "spill-call", name: "spill_output" }]);

      const second = adapter.requests[1];
      assert(second, "expected the post-tool request");
      const toolMessage = second.messages.filter((message) => message.role === "tool").at(-1);
      assert(toolMessage, "post-tool request must include the spilled result");
      const preview = contentText(toolMessage.content);
      assert(preview.length < BIG_TEXT.length, "spill policy must shrink the model-visible result");
      assert.match(preview, /Full formatted result stored at:/, `preview must advertise a locator: ${preview.slice(0, 200)}`);
      const match = /Full formatted result stored at: (.+?)\. Use /.exec(preview);
      assert(match, "locator must be parseable");
      const locator = match[1]!;
      assert.equal(await readFile(locator, "utf8"), BIG_TEXT, "locator must read back the complete result");

      const durable = lastToolResult(agent);
      assert.equal(contentText(durable.content), preview, "durable tool/result must keep the dsh-formed preview+locator");

      await handle.dispose();
      console.log("[tool-pathway] b2. spill preview + readable locator preserved through the bridge");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ------------------------------------------------------------------
// c. 并发与独占
// ------------------------------------------------------------------

async function concurrencyProbe(): Promise<void> {
  const { ctx, adapter } = await mount();
  const active: Record<string, number> = {};
  let current = 0;
  let maxActive = 0;

  const reset = () => {
    current = 0;
    maxActive = 0;
    for (const name of Object.keys(active)) delete active[name];
  };
  const work = (name: string, delayMs: number) => async () => {
    active[name] = (active[name] ?? 0) + 1;
    current += 1;
    maxActive = Math.max(maxActive, current);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { name };
    } finally {
      current -= 1;
      active[name] = (active[name] ?? 1) - 1;
    }
  };

  ctx.tools.register(defineProbeTool("safe_alpha", work("safe_alpha", 60), {
    render: () => [{ type: "text", text: "safe_alpha" }],
    isConcurrencySafe: () => true,
  }));
  ctx.tools.register(defineProbeTool("safe_beta", work("safe_beta", 60), {
    render: () => [{ type: "text", text: "safe_beta" }],
    isConcurrencySafe: () => true,
  }));
  ctx.tools.register(defineProbeTool("exclusive_gamma", work("exclusive_gamma", 60), {
    render: () => [{ type: "text", text: "exclusive_gamma" }],
  }));
  ctx.tools.register(defineProbeTool("exclusive_delta", work("exclusive_delta", 60), {
    render: () => [{ type: "text", text: "exclusive_delta" }],
  }));
  ctx.tools.register(defineProbeTool("conditional_epsilon", work("conditional_epsilon", 50), {
    render: () => [{ type: "text", text: "conditional_epsilon" }],
    isConcurrencySafe: (args) => (args as { mode?: unknown }).mode === "read",
  }));

  const { handle, agent } = await createAgent(ctx, "tool-concurrency");
  const probe = createDshToolBridge({ ctx, agent: () => agent });
  probe.syncTools();
  assert.equal(probe.registry.getMetadata("safe_alpha")?.concurrentSafe, true);
  assert.equal(probe.registry.getMetadata("exclusive_gamma")?.concurrentSafe, false);
  assert.equal(
    probe.registry.getMetadata("conditional_epsilon")?.concurrentSafe,
    false,
    "conditional classifiers are conservatively exclusive at registration",
  );

  reset();
  await runTurn(agent, adapter, [
    { id: "safe-1", name: "safe_alpha" },
    { id: "safe-2", name: "safe_beta" },
  ]);
  assert.equal(maxActive, 2, "unconditionally safe calls must overlap");
  assert.deepEqual(
    toolResultEvents(agent).map((event) => event.type === "tool/result" ? event.data.message.toolCallId : ""),
    ["safe-1", "safe-2"].map((id) => ToolCallId(id)),
    "durable result order must follow call order",
  );

  reset();
  await runTurn(agent, adapter, [
    { id: "exclusive-1", name: "exclusive_gamma" },
    { id: "exclusive-2", name: "exclusive_delta" },
  ]);
  assert.equal(maxActive, 1, "undeclared tools must serialize");
  assert.deepEqual(
    toolResultEvents(agent).map((event) => event.type === "tool/result" ? event.data.message.toolCallId : "").slice(-2),
    ["exclusive-1", "exclusive-2"].map((id) => ToolCallId(id)),
    "exclusive result order must follow call order",
  );

  reset();
  await runTurn(agent, adapter, [
    { id: "conditional-1", name: "conditional_epsilon", args: { mode: "read" } },
    { id: "conditional-2", name: "conditional_epsilon", args: { mode: "read" } },
  ]);
  assert.equal(maxActive, 1, "conditional safety must stay exclusive (fail-closed boundary)");

  const allResults = toolResultEvents(agent);
  assert.equal(allResults.length, 6);
  assert(allResults.every((event) => event.type === "tool/result" && event.data.message.isError === false));

  await handle.dispose();
  console.log("[tool-pathway] c. parallel/serial classification and durable result order verified");
}

// ------------------------------------------------------------------
// d. 拒绝与取消不旁路
// ------------------------------------------------------------------

async function gateProbe(): Promise<void> {
  const { ctx, adapter } = await mount();
  let sideEffects = 0;
  let preExecute = 0;
  let abortObserved = false;
  const started = Promise.withResolvers<void>();

  ctx.tools.register(defineProbeTool("denied_tool", async () => {
    sideEffects += 1;
    return { ok: true };
  }, { render: () => [{ type: "text", text: "denied_tool ran" }] }));
  ctx.tools.register(defineProbeTool("cancel_probe", (_args, exec) => new Promise<never>((_resolve, reject) => {
    started.resolve();
    const onAbort = () => {
      abortObserved = true;
      reject(new Error("cancel_probe aborted"));
    };
    if (exec.signal.aborted) onAbort();
    else exec.signal.addEventListener("abort", onAbort, { once: true });
  }), { render: () => [{ type: "text", text: "cancel_probe done" }] }));

  ctx.on("tools/pre-execute", async (exec, next) => {
    preExecute += 1;
    if (exec.name === "denied_tool") return { kind: "deny", reason: "blocked by probe policy" };
    return next();
  });

  const { handle, agent } = await createAgent(ctx, "tool-gates");
  await runTurn(agent, adapter, [{ id: "denied-1", name: "denied_tool" }]);
  assert.equal(sideEffects, 0, "a denied tool must not execute");
  const denied = lastToolResult(agent);
  assert.equal(denied.isError, true);
  assert.match(contentText(denied.content), /blocked by probe policy/);
  assert(preExecute >= 1, "pre-execute must own the gate");

  adapter.steps.push(() => toolCallChunks([{ id: "cancel-1", name: "cancel_probe" }]));
  agent.followup(userMessage("run cancellable tool"));
  await started.promise;
  agent.cancel({ kind: "user" });
  await agent.whenIdle();
  assert.equal(abortObserved, true, "cancellation must reach the dsh cooperative signal");
  assert(preExecute >= 2, "the cancelled call still crosses pre-execute (no bypass)");
  const turnEnd = agent.session.snapshotEvents().filter((event) => event.type === "turn/end").at(-1);
  assert(turnEnd?.type === "turn/end", "cancelled turn must close durably");
  assert.equal(turnEnd.data.reason.kind, "aborted", `turn/end reason must be aborted: ${JSON.stringify(turnEnd.data.reason)}`);

  await handle.dispose();
  console.log("[tool-pathway] d. deny and in-flight cancel stay inside the dsh pipeline");
}

// ------------------------------------------------------------------
// e. 动态工具与 toolHistory
// ------------------------------------------------------------------

async function dynamicToolProbe(): Promise<void> {
  const { ctx, adapter } = await mount();
  let removeMidTurn: (() => void) | undefined;
  const initial = defineProbeTool("initial_tool", async () => ({ ok: "initial" }), {
    render: () => [{ type: "text", text: "initial" }],
  });
  const midTurn = defineProbeTool("mid_turn_tool", async () => ({ ok: "mid" }), {
    render: () => [{ type: "text", text: "mid" }],
  });
  ctx.tools.register(initial);

  const { handle, agent } = await createAgent(ctx, "tool-dynamic");
  const names = (request: GenerateOptions) => (request.tools ?? []).map((tool) => tool.name).sort();
  const headerNames = () => (agent.session.requestHeader()?.tools ?? []).map((tool) => tool.name).sort();

  adapter.steps.push(
    (request) => {
      assert.deepEqual(names(request), ["initial_tool"]);
      removeMidTurn = ctx.tools.register(midTurn);
      return toolCallChunks([{ id: "dynamic-1", name: "initial_tool" }]);
    },
    (request) => {
      assert.deepEqual(names(request), ["initial_tool", "mid_turn_tool"], "new tool must be visible on the next step");
      assert.deepEqual(headerNames(), ["initial_tool", "mid_turn_tool"], "header tools must match the actual dispatch surface");
      return toolCallChunks([{ id: "dynamic-2", name: "mid_turn_tool" }]);
    },
    () => {
      const result = lastToolResult(agent);
      assert.equal(contentText(result.content), "mid", "the mid-turn tool must actually dispatch");
      removeMidTurn?.();
      return textChunks("turn one done");
    },
  );
  agent.followup(userMessage("dynamic tools"));
  await agent.whenIdle();

  adapter.steps.push((request) => {
    assert.deepEqual(names(request), ["initial_tool"], "removed tool must disappear on the next request");
    assert.deepEqual(headerNames(), ["initial_tool"], "header must record the removal");
    return textChunks("turn two done");
  });
  agent.followup(userMessage("dynamic tools again"));
  await agent.whenIdle();

  const updates = agent.session.toolHistory().updates;
  assert(
    updates.some((entry) => entry.additions.some((tool) => tool.name === "mid_turn_tool")),
    "toolHistory must record the addition",
  );
  // toolHistory 只物化 additions；removal 由 developer/message + 新 header 表达。
  const toolUpdates = agent.session.snapshotEvents().filter(
    (event) => event.type === "developer/message",
  );
  assert(
    toolUpdates.some((event) => event.type === "developer/message"
      && event.data.message.content.some(
        (block) => block.type === "tool-removal" && block.toolName === "mid_turn_tool",
      )),
    "durable developer/message must record the removal",
  );
  const headerReasons = agent.session
    .snapshotEvents()
    .filter((event) => event.type === "request/header")
    .map((event) => event.data.reason);
  assert(headerReasons.includes("change"), `header changes must be durable: ${headerReasons.join(",")}`);

  await handle.dispose();
  console.log("[tool-pathway] e. same-turn additions/removals reach dispatch, header and toolHistory");
}

// ------------------------------------------------------------------
// f. content 保真
// ------------------------------------------------------------------

async function contentProbe(): Promise<void> {
  const { ctx, adapter } = await mount();
  const image = {
    type: "image" as const,
    attachment: {
      attachmentId: "probe-image",
      mediaType: "image/png" as const,
      bytes: 68,
      width: 1,
      height: 1,
      name: "pixel.png",
    },
  };
  ctx.tools.register(defineProbeTool("structured_tool", async () => ({ ok: true }), {
    render: () => [
      { type: "text", text: "first block" },
      image as unknown as ContentBlock,
      { type: "text", text: "last block" },
    ],
  }));

  const { handle, agent } = await createAgent(ctx, "tool-content");
  await runTurn(agent, adapter, [{ id: "content-1", name: "structured_tool" }]);

  const durable = lastToolResult(agent);
  assert.equal(durable.isError, false);
  assert(Array.isArray(durable.content), "durable tool/result must keep the block structure");
  assert.deepEqual(
    durable.content.map((block) => block.type),
    ["text", "image", "text"],
    "durable content must keep order and structure",
  );
  assert.equal(contentText(durable.content), "first block\n[image probe-image]\nlast block");

  const second = adapter.requests[1];
  assert(second, "expected the post-tool request");
  const toolMessage = second.messages.filter((message) => message.role === "tool").at(-1);
  assert(toolMessage, "post-tool request must include the structured result");
  assert.deepEqual(toolMessage.content.map((block) => block.type), ["text", "image", "text"]);
  const texts = toolMessage.content.filter((block) => block.type === "text").map((block) => block.text);
  assert.deepEqual(texts, ["first block", "last block"], "text blocks must not be lost");

  await handle.dispose();
  console.log("[tool-pathway] f. multi-block content survives durable projection and the next request");
}

// ------------------------------------------------------------------

const watchdog = setTimeout(() => {
  console.error("[tool-pathway] FAIL: watchdog expired");
  process.exit(1);
}, 60_000);
watchdog.unref();

try {
  await timeoutProbe();
  await oversizedProbe();
  await concurrencyProbe();
  await gateProbe();
  await dynamicToolProbe();
  await contentProbe();
  clearTimeout(watchdog);
  console.log("[tool-pathway] PASS: timeout, oversized/spill, concurrency, gates, dynamic tools and content fidelity");
  process.exit(0);
} catch (error) {
  console.error("[tool-pathway] FAIL:", error);
  process.exit(1);
}
