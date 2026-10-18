/**
 * 项目记忆集成探针。
 *
 * 用真实 dsh 栈（llm/session/systemPrompt/tools/agents/commands + ZcodeLoop）
 * 与受控 adapter 验证 TASK a–h：
 * - 受控 adapter 以 system prompt 里的 PROJECT_MEMORY_EXTRACTION_MARKER 区分
 *   主轮请求与提取辅助请求；主轮按队列返回脚本响应，提取请求返回固定事实。
 * - workspace 身份用探针内最小 workspaceRegistry stub（`list()` 返回稳定 id
 *   与 canonical path），覆盖 dsh-workspace 的消费面；服务缺席的路径退回
 *   canonical cwd（degradation 场景不注册 registry）。
 * - 不宣称与 ZCode 原生 extraction/dream 等价；不验证向量/语义检索。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type RequestMessage,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";

import ZcodeLoop from "../src/index.js";
import ProjectMemory, {
  PROJECT_MEMORY_EXTRACTION_MARKER,
  type ProjectMemoryConfig,
  type ProjectMemoryState,
} from "../src/project-memory.js";

const PROVIDER = "mock";
const EVIDENCE_ROOT = join(tmpdir(), "dsh-project-memory");

function fail(message: string): never {
  console.error(`[project-memory] FAIL: ${message}`);
  process.exit(1);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  fail(`timeout waiting for ${what}`);
}
function makeWorkspace(root: string, name: string): string {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  return realpathSync(workspace);
}
function textChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}
function isExtraction(request: GenerateOptions): boolean {
  return request.system?.includes(PROJECT_MEMORY_EXTRACTION_MARKER) ?? false;
}
function requestText(request: GenerateOptions): string {
  return request.messages
    .map((message: RequestMessage) => {
      if (!("content" in message) || !Array.isArray(message.content)) return "";
      return message.content
        .filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
        .map(block => block.text)
        .join("\n");
    })
    .join("\n");
}

/** 受控 adapter：主轮走脚本队列，提取辅助请求按 handler 返回/抛错。 */
class ControlledAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  extractionCalls = 0;
  throwExtraction = false;
  extractionGate: ((request: GenerateOptions) => Promise<void>) | undefined;
  extractionOutput: (request: GenerateOptions) => string = () => "";
  private readonly steps: StreamChunk[][] = [];

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  queue(steps: StreamChunk[][]): void {
    this.steps.push(...steps);
  }

  pending(): number {
    return this.steps.length;
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    if (isExtraction(request)) {
      this.extractionCalls += 1;
      if (this.throwExtraction) throw new Error("extraction auxiliary request failed");
      if (this.extractionGate !== undefined) await this.extractionGate(request);
      const output = this.extractionOutput(request);
      for (const chunk of textChunks(output)) {
        request.signal?.throwIfAborted();
        yield chunk;
      }
      return;
    }
    const step = this.steps.shift();
    if (step === undefined) throw new Error(`unexpected main model request: ${requestText(request)}`);
    for (const chunk of step) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

interface RegistryEntry {
  id: string;
  path: string;
}

interface Host {
  ctx: Context;
  adapter: ControlledAdapter;
  workspace: string;
  service: ProjectMemory;
  plugin: Awaited<ReturnType<Context["plugin"]>>;
  dispose(): Promise<void>;
}

interface HostOptions {
  workspace: string;
  registry?: RegistryEntry[];
  commands?: boolean;
  memory?: ProjectMemoryConfig;
}

async function createHost(options: HostOptions): Promise<Host> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(SessionProjection);
  await ctx.plugin(LocalFileSystem, { cwd: options.workspace });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: options.workspace });
  await ctx.plugin(AgentRegistry);
  if (options.commands !== false) await ctx.plugin(CommandRuntime);
  if (options.registry !== undefined) {
    const entries = options.registry;
    // dsh-workspace 的稳定身份消费面：list() 返回 id + canonical path。
    ctx.provide("workspaceRegistry", { list: () => entries });
  }
  await ctx.plugin(ZcodeLoop, { provider: PROVIDER, model: "mock" });
  const plugin = await ctx.plugin(
    ProjectMemory as unknown as Plugin.Object<Record<string, unknown>>,
    {
      dshHome: process.env.DSH_HOME,
      ...options.memory,
    },
  );
  const adapter = new ControlledAdapter();
  ctx.llm.registerAdapter([PROVIDER], adapter);
  const service = ctx.get("projectMemory") as ProjectMemory | undefined;
  check(service !== undefined, "projectMemory service must be registered");
  return {
    ctx,
    adapter,
    workspace: options.workspace,
    service,
    plugin,
    dispose: () => ctx.fiber.dispose(),
  };
}

function createAgent(host: Host, id: string, cwd = host.workspace): Promise<AgentHandle> {
  return host.ctx.agents.create({
    sessionId: DshSessionId(id),
    meta: { cwd },
    agentOptions: { provider: PROVIDER, model: "mock" },
  });
}

function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

/** 主轮请求列表（排除提取辅助请求）。 */
function mainRequests(host: Host, before: number): GenerateOptions[] {
  return host.adapter.requests.slice(before).filter(request => !isExtraction(request));
}

async function runTurn(host: Host, agent: Agent, input: string): Promise<GenerateOptions[]> {
  const before = host.adapter.requests.length;
  host.adapter.queue([textChunks(`ack: ${input}`)]);
  agent.followup(userMessage(input));
  await waitFor(() => agent.status === "idle", `turn idle for ${agent.id}`);
  await host.service.whenIdle();
  check(host.adapter.pending() === 0, "main scripted steps must drain exactly");
  return mainRequests(host, before);
}

function requestSystem(request: GenerateOptions): string {
  return request.system ?? "";
}

function requestSurfaceSystem(request: GenerateOptions): string {
  // loop-built 主轮请求的系统提示在首条 system message 里；提取请求走 request.system。
  return request.messages
    .filter(message => message.role === "system")
    .flatMap(message =>
      Array.isArray(message.content)
        ? message.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map(block => block.text)
        : [],
    )
    .join("\n");
}

async function executeCommand(
  ctx: Context,
  agent: Agent,
  line: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ kind: string; text?: string }> {
  const commands = ctx.get("commands") as unknown as {
    execute(
      agent: Agent,
      line: string,
      attachments: readonly unknown[],
      signal: AbortSignal,
    ): Promise<{ result: { kind: string; text?: string } } | undefined>;
  };
  const execution = await commands.execute(agent, line, [], signal);
  check(execution !== undefined, `command "${line}" was not resolved`);
  return execution.result;
}

function readStateFile(path: string): ProjectMemoryState {
  return JSON.parse(readFileSync(path, "utf8")) as ProjectMemoryState;
}

function factTexts(state: ProjectMemoryState): string[] {
  return state.entries.map(entry => entry.text);
}

/** a：A 提取 → B 同 workspace 召回；条数有界。 */
async function extractionAndRecallScenario(root: string): Promise<string> {
  const workspace = makeWorkspace(root, "alpha-workspace");
  const registry = [{ id: "ws-alpha", path: workspace }];
  const host = await createHost({ workspace, registry, memory: { maxEntries: 4 } });
  let a: AgentHandle | undefined;
  try {
    a = await createAgent(host, "memory-alpha-a");
    const on = await executeCommand(host.ctx, a.agent, "/memory on");
    check(on.kind === "success", `memory on must succeed: ${on.text}`);

    host.adapter.extractionOutput = () =>
      "- Favorite color is teal\n- Project uses pnpm\n- Project uses TypeScript";
    const first = await runTurn(host, a.agent, "Remember: favorite color teal, pnpm, TypeScript");
    check(first.length === 1, "first turn must issue exactly one main request");
    check(!isExtraction(first[0]!), "main request must not be the extraction request");
    check(requestSystem(first[0]!).length === 0, "extraction marker must never enter the main request");

    host.adapter.extractionOutput = () =>
      "- Tests run with vitest\n- Builds with tsup\n- Node 24";
    await runTurn(host, a.agent, "More facts: vitest, tsup, Node 24");

    const snapshot = await host.service.snapshot(a.agent.session);
    check(snapshot.workspace.id === "ws-alpha", "workspace identity must come from the registry id");
    check(snapshot.workspace.path === workspace, "workspace root must be the canonical registry path");
    check(snapshot.path.startsWith(host.service.rootPath), "memory file must live under the plugin root");
    check(existsSync(snapshot.path), "memory file must exist");
    check(snapshot.state.enabled, "memory must be enabled after /memory on");
    check(snapshot.state.entries.length === 4, `expected 4 bounded entries, got ${snapshot.state.entries.length}`);
    check(!factTexts(snapshot.state).includes("Favorite color is teal"), "oldest entries must be dropped");
    check(factTexts(snapshot.state).includes("Node 24"), "newest entry must be retained");

    const b = await createAgent(host, "memory-alpha-b");
    try {
      const bTurns = await runTurn(host, b.agent, "What do you remember?");
      check(bTurns.length === 1, "B must issue one main request");
      const system = requestSurfaceSystem(bTurns[0]!);
      check(system.includes("## Project memory"), "B must receive the project memory section");
      check(system.includes("Node 24"), "B must recall the newest retained fact");
      check(!system.includes("Favorite color is teal"), "B must not recall dropped facts");
      console.log("[project-memory] a ✓ A 提取、条数有界、B 同 workspace 召回");
    } finally {
      await b.dispose();
    }
  } finally {
    await a?.dispose();
    await host.dispose();
  }
  return workspace;
}

/** b：不同 workspace 互不可见。 */
async function isolationScenario(root: string, alpha: string): Promise<void> {
  const beta = makeWorkspace(root, "beta-workspace");
  const host = await createHost({
    workspace: alpha,
    registry: [
      { id: "ws-alpha", path: alpha },
      { id: "ws-beta", path: beta },
    ],
  });
  let alphaAgent: AgentHandle | undefined;
  let betaAgent: AgentHandle | undefined;
  try {
    alphaAgent = await createAgent(host, "memory-isolation-alpha", alpha);
    betaAgent = await createAgent(host, "memory-isolation-beta", beta);
    const betaOn = await executeCommand(host.ctx, betaAgent.agent, "/memory on");
    check(betaOn.kind === "success", "beta memory on must succeed");

    host.adapter.extractionOutput = () => "- Beta-only fact";
    await runTurn(host, betaAgent.agent, "BETA-SECRET-MARKER");

    host.adapter.extractionOutput = () => "";
    const turns = await runTurn(host, betaAgent.agent, "recall beta");
    const system = requestSurfaceSystem(turns[0]!);
    check(system.includes("Beta-only fact"), "beta workspace must recall its own fact");
    check(!system.includes("Node 24"), "beta workspace must not recall alpha facts");
    check(!system.includes("Tests run with vitest"), "beta workspace must not recall alpha facts");

    const alphaTurns = await runTurn(host, alphaAgent.agent, "recall alpha");
    const alphaSystem = requestSurfaceSystem(alphaTurns[0]!);
    check(alphaSystem.includes("Node 24"), "alpha workspace keeps its own recall");
    check(!alphaSystem.includes("Beta-only fact"), "alpha workspace must not recall beta facts");
    console.log("[project-memory] b ✓ 不同 workspace 的提取与召回互不可见");
  } finally {
    await alphaAgent?.dispose();
    await betaAgent?.dispose();
    await host.dispose();
  }
}

/** c：off 停止提取/注入，on 恢复，clear 清空。 */
async function toggleScenario(root: string, workspace: string): Promise<void> {
  const host = await createHost({
    workspace,
    registry: [{ id: "ws-alpha", path: workspace }],
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "memory-toggle");
    const off = await executeCommand(host.ctx, handle.agent, "/memory off");
    check(off.kind === "success", "memory off must succeed");
    const callsAfterOff = host.adapter.extractionCalls;
    host.adapter.extractionOutput = () => "- must not be extracted";
    const offTurns = await runTurn(host, handle.agent, "OFF-TURN-MARKER");
    check(host.adapter.extractionCalls === callsAfterOff, "off must not issue extraction requests");
    check(!requestSurfaceSystem(offTurns[0]!).includes("## Project memory"), "off must not inject recall");

    const on = await executeCommand(host.ctx, handle.agent, "/memory on");
    check(on.kind === "success", "memory on must succeed");
    host.adapter.extractionOutput = () => "- reenabled fact";
    await runTurn(host, handle.agent, "ON-TURN-MARKER");
    check(host.adapter.extractionCalls > callsAfterOff, "on must resume extraction");
    host.adapter.extractionOutput = () => "";
    const onTurns = await runTurn(host, handle.agent, "recall reenabled");
    check(requestSurfaceSystem(onTurns[0]!).includes("reenabled fact"), "on must inject recall");

    const clear = await executeCommand(host.ctx, handle.agent, "/memory clear");
    check(clear.kind === "success", "memory clear must succeed");
    const cleared = await host.service.snapshot(handle.agent.session);
    check(cleared.state.entries.length === 0, "clear must empty entries");
    const afterClear = await runTurn(host, handle.agent, "recall after clear");
    const system = requestSurfaceSystem(afterClear[0]!);
    check(!system.includes("reenabled fact"), "clear must remove injected facts");
    check(!system.includes("## Project memory"), "clear must remove the section when no entries remain");
    console.log("[project-memory] c ✓ off 停止提取/注入、on 恢复、clear 清空");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** d：提取辅助请求失败不阻断主轮。 */
async function failureScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "failure-workspace");
  const host = await createHost({
    workspace,
    registry: [{ id: "ws-failure", path: workspace }],
  });
  let handle: AgentHandle | undefined;
  const errors: string[] = [];
  host.ctx.on("agent/error", payload => errors.push(String(payload.turn)));
  try {
    handle = await createAgent(host, "memory-failure");
    await executeCommand(host.ctx, handle.agent, "/memory on");
    host.adapter.throwExtraction = true;
    const turns = await runTurn(host, handle.agent, "FAILURE-TURN-MARKER");
    check(turns.length === 1, "main turn must complete despite extraction failure");
    const ends = handle.agent.session.snapshotEvents().filter(event => event.type === "turn/end");
    const lastEnd = ends.at(-1);
    check(lastEnd?.type === "turn/end" && lastEnd.data.reason.kind === "completed", "turn must end completed");
    check(errors.length === 0, "extraction failure must not emit agent/error");
    const snapshot = await host.service.snapshot(handle.agent.session);
    check(snapshot.state.entries.length === 0, "failed extraction must not persist entries");

    host.adapter.throwExtraction = false;
    host.adapter.extractionOutput = () => "- recovered fact";
    await runTurn(host, handle.agent, "RECOVERY-TURN-MARKER");
    const recovered = await host.service.snapshot(handle.agent.session);
    check(factTexts(recovered.state).includes("recovered fact"), "later extraction must still work");
    console.log("[project-memory] d ✓ 辅助请求抛错时主轮 completed、无 agent/error，后续提取恢复");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** e：同一 DSH_HOME 新宿主仍可读取并召回。 */
async function restartScenario(root: string, workspace: string): Promise<void> {
  const host = await createHost({
    workspace,
    registry: [{ id: "ws-alpha", path: workspace }],
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "memory-restart-reader");
    host.adapter.extractionOutput = () => "";
    const turns = await runTurn(host, handle.agent, "recall after restart");
    const system = requestSurfaceSystem(turns[0]!);
    check(system.includes("## Project memory"), "new host must inject persisted memory");
    check(system.includes("Node 24"), "new host must recall persisted facts");
    const status = await executeCommand(host.ctx, handle.agent, "/memory status");
    check(status.kind === "success" && (status.text ?? "").includes("Project memory: on"), "persisted switch must survive restart");
    check((status.text ?? "").includes("ws-alpha"), "status must show the stable workspace id");
    console.log("[project-memory] e ✓ 新宿主同 DSH_HOME 下记忆与开关仍在，B 可召回");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** f：/rerun 子会话只提取自己的新 turn。 */
async function rerunScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "rerun-workspace");
  const host = await createHost({
    workspace,
    registry: [{ id: "ws-rerun", path: workspace }],
  });
  let parent: AgentHandle | undefined;
  try {
    parent = await createAgent(host, "memory-rerun-parent");
    await executeCommand(host.ctx, parent.agent, "/memory on");
    host.adapter.extractionOutput = () => "- parent old fact";
    await runTurn(host, parent.agent, "PARENT-OLD-MARKER keep this");
    host.adapter.extractionOutput = () => "- discarded target fact";
    await runTurn(host, parent.agent, "DISCARDED-TARGET-MARKER must not be re-extracted");

    const rerun = await executeCommand(host.ctx, parent.agent, "/rerun 2 CHILD-NEW-MARKER edited input");
    check(rerun.kind === "success", `rerun must succeed: ${rerun.text}`);
    const match = /Rerun branch (\S+) created/u.exec(rerun.text ?? "");
    check(match !== null, `rerun text must name the child session: ${rerun.text}`);
    const childId = DshSessionId(match[1]!);
    const childAgent = host.ctx.agents.get(childId);
    check(childAgent !== undefined, "rerun child must be live");

    host.adapter.extractionOutput = request => {
      const transcript = requestText(request);
      return transcript.includes("CHILD-NEW-MARKER") ? "- child new fact" : "- unexpected inherited extraction";
    };
    await runTurn(host, childAgent, "CHILD-NEW-MARKER own turn");

    const extractionRequests = host.adapter.requests.filter(
      request => isExtraction(request) && requestText(request).includes("CHILD-NEW-MARKER"),
    );
    check(extractionRequests.length === 1, "child own turn must issue one extraction request");
    const transcript = requestText(extractionRequests[0]!);
    check(transcript.includes("CHILD-NEW-MARKER"), "child extraction must include its own input");
    check(!transcript.includes("DISCARDED-TARGET-MARKER"), "child extraction must exclude the discarded parent turn");
    check(!transcript.includes("PARENT-OLD-MARKER"), "child extraction must exclude the inherited prefix");

    const snapshot = await host.service.snapshot(childAgent.session);
    const texts = factTexts(snapshot.state);
    check(texts.includes("child new fact"), "child fact must be persisted");
    check(texts.filter(text => text === "discarded target fact").length === 1, "discarded content must not be re-extracted");
    check(texts.filter(text => text === "parent old fact").length === 1, "inherited prefix must not be re-extracted");
    console.log("[project-memory] f ✓ /rerun 子会话只提取新 turn，继承前缀/被舍弃 turn 不再入库");
  } finally {
    await parent?.dispose();
    await host.dispose();
  }
}

/** g：同 workspace 两个 agent 同时完成 turn，两条事实都落盘且 JSON 完好。 */
async function concurrencyScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "concurrency-workspace");
  const host = await createHost({
    workspace,
    registry: [{ id: "ws-concurrent", path: workspace }],
  });
  let a: AgentHandle | undefined;
  let b: AgentHandle | undefined;
  try {
    a = await createAgent(host, "memory-concurrent-a");
    b = await createAgent(host, "memory-concurrent-b");
    await executeCommand(host.ctx, a.agent, "/memory on");
    host.adapter.extractionOutput = request => {
      const transcript = requestText(request);
      if (transcript.includes("CONCURRENT-A")) return "- concurrent fact A";
      if (transcript.includes("CONCURRENT-B")) return "- concurrent fact B";
      return "";
    };
    host.adapter.queue([textChunks("ack A"), textChunks("ack B")]);
    a.agent.followup(userMessage("CONCURRENT-A"));
    b.agent.followup(userMessage("CONCURRENT-B"));
    await Promise.all([
      waitFor(() => a!.agent.status === "idle", "agent A idle"),
      waitFor(() => b!.agent.status === "idle", "agent B idle"),
    ]);
    await host.service.whenIdle();

    const snapshot = await host.service.snapshot(a.agent.session);
    const texts = factTexts(snapshot.state);
    check(texts.includes("concurrent fact A"), "agent A fact must land");
    check(texts.includes("concurrent fact B"), "agent B fact must land");
    // JSON 结构完好：再次解析独立文件。
    const reread = readStateFile(snapshot.path);
    check(reread.entries.length >= 2, "memory file must remain valid JSON with both entries");
    console.log("[project-memory] g ✓ 并发 turn 两条事实都落盘，memory.json 结构完好");
  } finally {
    await a?.dispose();
    await b?.dispose();
    await host.dispose();
  }
}

/** h1：dispose 中止在途提取、等待收口、移除 section，无悬挂写。 */
async function unloadScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "unload-workspace");
  const host = await createHost({
    workspace,
    registry: [{ id: "ws-unload", path: workspace }],
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "memory-unload");
    await executeCommand(host.ctx, handle.agent, "/memory on");
    host.adapter.extractionOutput = () => "- settled fact";
    await runTurn(host, handle.agent, "SETTLED-TURN-MARKER");

    let releaseGate: (() => void) | undefined;
    host.adapter.extractionGate = request =>
      new Promise((resolveGate, rejectGate) => {
        releaseGate = resolveGate;
        request.signal?.addEventListener("abort", () => rejectGate(new Error("aborted")), { once: true });
        if (request.signal?.aborted) rejectGate(new Error("aborted"));
      });
    host.adapter.extractionOutput = () => "- in-flight fact";
    host.adapter.queue([textChunks("ack slow")]);
    handle.agent.followup(userMessage("SLOW-TURN-MARKER"));
    await waitFor(() => handle!.agent.status === "idle", "slow turn idle");
    await waitFor(() => host.adapter.extractionCalls >= 2, "in-flight extraction started");

    const disposed = await Promise.race([
      host.plugin.dispose().then(() => true),
      sleep(3_000).then(() => false),
    ]);
    check(disposed, "plugin dispose must settle while extraction is in flight");
    releaseGate?.();

    const snapshot = await host.service.snapshot(handle.agent.session);
    check(!factTexts(snapshot.state).includes("in-flight fact"), "aborted extraction must not write");
    check(factTexts(snapshot.state).includes("settled fact"), "earlier settled fact must remain");
    const reread = readStateFile(snapshot.path);
    check(reread.entries.length === snapshot.state.entries.length, "memory file must stay structurally valid after dispose");

    const afterDispose = await runTurn(host, handle.agent, "AFTER-DISPOSE-MARKER");
    check(!requestSurfaceSystem(afterDispose[0]!).includes("## Project memory"), "disposed plugin must remove its prompt section");
    const calls = host.adapter.extractionCalls;
    await runTurn(host, handle.agent, "AFTER-DISPOSE-TURN-2");
    check(host.adapter.extractionCalls === calls, "disposed plugin must not extract");
    console.log("[project-memory] h1 ✓ dispose 中止在途提取并收口、无悬挂写、section 移除");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** h2：commands 缺席时提取/召回仍可工作（配置显式 enabled）。 */
async function degradationScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "degraded-workspace");
  const host = await createHost({
    workspace,
    commands: false,
    memory: { enabled: true },
  });
  let handle: AgentHandle | undefined;
  try {
    check(host.ctx.get("commands") === undefined, "commands service must be absent");
    handle = await createAgent(host, "memory-degraded");
    host.adapter.extractionOutput = () => "- no commands fact";
    await runTurn(host, handle.agent, "DEGRADED-TURN-MARKER");
    const snapshot = await host.service.snapshot(handle.agent.session);
    check(snapshot.state.enabled, "explicit config enabled must turn extraction on");
    check(factTexts(snapshot.state).includes("no commands fact"), "extraction must work without commands");

    host.adapter.extractionOutput = () => "";
    const turns = await runTurn(host, handle.agent, "recall without commands");
    check(
      requestSurfaceSystem(turns[0]!).includes("no commands fact"),
      "recall must work without commands",
    );
    console.log("[project-memory] h2 ✓ commands 缺席时提取/召回照常，仅斜杠命令不可用");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

mkdirSync(EVIDENCE_ROOT, { recursive: true });
process.env.DSH_HOME = mkdtempSync(join(EVIDENCE_ROOT, "home-"));
console.log(`[project-memory] DSH_HOME=${process.env.DSH_HOME}`);
try {
  const root = mkdtempSync(join(tmpdir(), "dsh-project-memory-work-"));
  const alpha = await extractionAndRecallScenario(root);
  await isolationScenario(root, alpha);
  await restartScenario(root, alpha);
  await toggleScenario(root, alpha);
  await failureScenario(root);
  await rerunScenario(root);
  await concurrencyScenario(root);
  await unloadScenario(root);
  await degradationScenario(root);
  rmSync(root, { recursive: true, force: true });
  console.log("[project-memory] PASS: a–h 全部通过");
} catch (error) {
  console.error("[project-memory] FAIL:", error);
  process.exit(1);
}
