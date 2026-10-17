/**
 * subagent 与选区侧聊集成探针（T11）。
 *
 * 语义口径来自钉版插件源码（node_modules 0.2.1-alpha.5），不是任务假设：
 * - subagent-spawn-in-process：`prepareContinuable()` 返回空 → 全新子会话；
 *   `inheritsParentContext=false`。
 * - subagent-fork-in-process：`prepareContinuable()` 取父日志最后一条 `turn/end`
 *   （含）之前的前缀 → 子会话继承已完成轮次；进行中的 turn 被排除。
 * - subagent manager：本地子级一律 `ctx.agents.create/resume` 并带
 *   `meta.parentSession/origin:"subagent"`；因此应命已注册的 ZCode 工厂。
 * - tool-subagent：spawn/fork 工具启动 activation 后立即返回 child id；完成时向
 *   父会话投递 `subagent-settled` user 消息（含 closing text / structured）。
 * - tool-subagent-control：`send_message` 对运行中子级按 steer 投递到最近 step；
 *   空闲子级开新一轮，缺席的直接子级可冷恢复。`interrupt_agent` 只发取消，
 *   被子级 `turn/end` 记为 aborted（cause kind=parent 来自 manager）。
 *
 * 外部 SDK 子进程场景本仓没有部署形态，不在本探针伪造；报告记为不适用。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import LlmRuntime, {
  LlmAdapter,
  ToolCallId as DshToolCallId,
  createUserMessage,
  type GenerateOptions,
  type RequestMessage,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SqliteSessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import SubagentRuntime from "@deepseek-ai/dsh-subagent";
import * as ForkInProcess from "@deepseek-ai/dsh-subagent-fork-in-process";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import * as ToolSubagent from "@deepseek-ai/dsh-tool-subagent";
import * as ToolSubagentControl from "@deepseek-ai/dsh-tool-subagent-control";
import type { ObjectJsonSchema } from "@deepseek-ai/dsh-tools";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";

import ZcodeLoop, { ZcodeLoopAgent } from "../src/index.js";

const PROVIDER = "mock";
/** 临时 workspace/JSONL 全部放系统临时目录，探针不污染仓库工作区。 */
const EVIDENCE_ROOT = join(tmpdir(), "dsh-subagent-sidechat");

function fail(message: string): never {
  console.error(`[subagent-sidechat] FAIL: ${message}`);
  process.exit(1);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  fail(`timeout waiting for ${what}`);
}

const tcid = (id: string) => DshToolCallId(id);

interface ScriptedCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

function response(text: string, calls: ScriptedCall[] = []): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
  ];
  let index = 1;
  for (const call of calls) {
    const argumentsJson = JSON.stringify(call.args);
    chunks.push({ type: "block-start", index, blockType: "tool-call" });
    chunks.push({
      type: "tool-call-delta",
      index,
      id: tcid(call.callId),
      name: call.name,
      argumentsDelta: argumentsJson,
    });
    chunks.push({
      type: "block-end",
      index,
      block: { type: "tool-call", id: tcid(call.callId), name: call.name, arguments: argumentsJson },
    });
    index += 1;
  }
  chunks.push({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
  chunks.push({ type: "finish", reason: calls.length > 0 ? { kind: "tool-calls" } : { kind: "stop" } });
  return chunks;
}

type Handler = (request: GenerateOptions, count: number) => StreamChunk[] | Promise<StreamChunk[]>;

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  private readonly handlers = new Map<string, Handler>();
  private readonly counts = new Map<string, number>();
  private fallback: Handler | undefined;

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  on(sessionId: string, handler: Handler): void {
    this.handlers.set(sessionId, handler);
  }

  /** 非显式注册的会话（spawn/fork 生成的随机子会话 id）走此 handler。 */
  onOther(handler: Handler): void {
    this.fallback = handler;
  }

  count(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const sessionId = String(request.sessionId);
    const count = (this.counts.get(sessionId) ?? 0) + 1;
    this.counts.set(sessionId, count);
    const handler = this.handlers.get(sessionId) ?? this.fallback;
    if (handler === undefined) throw new Error(`unexpected model request for session "${sessionId}"`);
    const chunks = await handler(request, count);
    for (const chunk of chunks) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

interface Hold {
  readonly started: Promise<void>;
  release(): void;
  readonly callCount: () => number;
}

/** 可在模型 step 中挂起、并在 abort 时拒绝的工具；用于 steer/取消/冷恢复竞态。 */
function createHoldTool(): { tool: ReturnType<typeof defineTool>; hold: Hold } {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const tool = defineTool({
    name: "hold",
    description: "Hold the current step until the probe releases it.",
    parameters: {
      marker: { type: "string", description: "probe marker" },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { released: { type: "boolean", required: true } } },
      render: () => [{ type: "text", text: "hold released" }],
    },
    async execute(_args, exec) {
      calls += 1;
      started.resolve();
      await Promise.race([
        gate.promise,
        new Promise<never>((_resolve, reject) => {
          if (exec.signal.aborted) reject(new Error("hold aborted"));
          exec.signal.addEventListener("abort", () => reject(new Error("hold aborted")), { once: true });
        }),
      ]);
      return { released: true };
    },
  });
  return {
    tool,
    hold: {
      started: started.promise,
      release: () => gate.resolve(),
      callCount: () => calls,
    },
  };
}

interface Host {
  ctx: Context;
  adapter: ScriptedAdapter;
  workspace: string;
  hold: Hold;
  dispose(): Promise<void>;
}

async function createHost(options: { root?: string; workspace?: string } = {}): Promise<Host> {
  // realpath 避免 macOS /var→/private/var 在子级启动时注入多余的 working-directory 变更轮。
  const workspace = realpathSync(options.workspace ?? resolve(mkdtempSync(join(EVIDENCE_ROOT, "subagent-sidechat-workspace-"))));
  const root = options.root ?? resolve(mkdtempSync(join(EVIDENCE_ROOT, "subagent-sidechat-sessions-")));
  mkdirSync(workspace, { recursive: true });
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(SessionProjection);
  await ctx.plugin(LocalFileSystem, { cwd: workspace });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace });
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(SqliteSessionQuery, { path: ":memory:", openAt: "never" });
  await ctx.plugin(Jsonl, { root, compression: "none" });
  const { tool, hold } = createHoldTool();
  ctx.tools.register(tool);
  await ctx.plugin(SubagentRuntime, {});
  await ctx.plugin(SpawnInProcess as unknown as Plugin);
  await ctx.plugin(ForkInProcess as unknown as Plugin);
  await ctx.plugin(ToolSubagent as unknown as Plugin.Object<{ provider: string; toolName?: string }>, {
    provider: "spawn",
    toolName: "subagent",
  });
  await ctx.plugin(ToolSubagent as unknown as Plugin.Object<{ provider: string; toolName?: string }>, {
    provider: "fork",
    toolName: "subagent_fork",
  });
  await ctx.plugin(ToolSubagentControl as unknown as Plugin);
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter([PROVIDER], adapter);
  await ctx.plugin(ZcodeLoop as Plugin, { provider: PROVIDER, model: "mock" });
  return { ctx, adapter, workspace, hold, dispose: () => ctx.fiber.dispose() };
}

function createAgent(host: Host, id: string): Promise<AgentHandle> {
  return host.ctx.agents.create({
    sessionId: DshSessionId(id),
    meta: { cwd: host.workspace },
    agentOptions: { provider: PROVIDER, model: "mock" },
  });
}

function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

function messageText(message: RequestMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

function requestText(request: GenerateOptions): string {
  return JSON.stringify(request.messages);
}

function eventsText(agent: Agent): string {
  return JSON.stringify(agent.session.snapshotEvents());
}

function completedBoundary(agent: Agent): number {
  const last = agent.session.snapshotEvents().findLast((event) => event.type === "turn/end");
  check(last !== undefined, `session ${agent.id} has no completed turn`);
  return last.seq;
}

function toolNames(request: GenerateOptions): string[] {
  return (request.tools ?? []).map((tool) => (tool as { name: string }).name);
}

function latestTurnEnd(agent: Agent): { kind?: string; reason?: { kind?: string } } {
  const event = agent.session.snapshotEvents().filter((candidate) => candidate.type === "turn/end").at(-1) as
    | { data: { reason: { kind?: string; reason?: { kind?: string } } } }
    | undefined;
  check(event !== undefined, `session ${agent.id} has no turn/end`);
  return event.data.reason;
}

/** 等待一个 agent 的请求稳定：idle 后留观察窗，防止 extra step 被误计入。 */
async function settle(agent: Agent, label: string): Promise<void> {
  await waitFor(() => agent.status === "idle", `${label}: idle`);
  await sleep(300);
  check(agent.status === "idle", `${label}: agent not idle`);
}

/** a. spawn 子 agent 经 ZcodeLoop 工厂；新鲜会话；结构化结果回父会话。 */
async function spawnScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "subagent-spawn-parent");
    const parent = parentHandle.agent;
    let childId = "";
    let childAgent: Agent | undefined;
    let noticeSeen = false;

    host.adapter.on(parent.id, async (request, count) => {
      const text = requestText(request);
      if (count === 1) {
        return response("delegating", [
          {
            callId: "spawn-call",
            name: "subagent",
            args: { description: "spawn probe", prompt: "CHILD-PROMPT: reply with the final marker" },
          },
        ]);
      }
      if (text.includes("CHILD-FINAL")) {
        check(text.includes("Background subagent"), "spawn: parent notice must identify the child activation");
        noticeSeen = true;
      }
      return response("parent observed delegation");
    });
    host.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      check(sessionId !== parent.id, "spawn: child request must use a distinct session");
      if (childId === "") {
        childId = sessionId;
        childAgent = host.ctx.agents.get(DshSessionId(sessionId));
      }
      check(sessionId === childId, `spawn: unexpected extra child ${sessionId}`);
      check(count === 1, `spawn: fresh child must run one turn, got request #${count}`);
      const text = requestText(request);
      check(text.includes("CHILD-PROMPT"), "spawn: child did not receive the delegation prompt");
      check(!text.includes("SPAWN-PARENT-PREFIX"), "spawn: fresh child must not inherit parent context");
      check(toolNames(request).includes("send_message"), "spawn: continuable child must see send_message");
      check(
        text.includes("You are a delegated subagent"),
        "spawn: child runtime context must carry the fixed delegation permission scope",
      );
      return response("CHILD-FINAL: spawn completed");
    });

    parent.followup(userMessage("SPAWN-PARENT-PREFIX: delegate this task"));
    await waitFor(() => noticeSeen && childId !== "", "spawn: settlement notice");
    await settle(parent, "spawn-parent");

    const child = childAgent;
    check(child !== undefined, "spawn: child agent was not captured while live");
    check(child instanceof ZcodeLoopAgent, "spawn: child must be constructed by the ZcodeLoop factory");
    check(child.session.header.parentSession === parent.id, "spawn: child header must record the parent session");
    check(child.session.header.origin === "subagent", "spawn: child header must carry the subagent origin");
    check(child.session.header.isSeeded === false, "spawn: a spawn child must not be seeded");
    check(!eventsText(child).includes("SPAWN-PARENT-PREFIX"), "spawn: child log must not contain parent context");
    check(eventTextHas(parent, "subagent/catalog", childId), "spawn: parent catalog must record the child");
    check(
      parent.session.snapshotEvents().every((event) => event.type !== "subagent/descriptor"),
      "spawn: descriptor must live in the child log",
    );
    check(eventTextHas(child, "subagent/descriptor", "spawn"), "spawn: child log must carry its durable descriptor");
    check(
      parent.session
        .snapshotEvents()
        .some((event) => event.type === "user/message" && (event.data as { source?: { kind?: string } }).source?.kind === "subagent-settled"),
      "spawn: parent log must contain the settlement notice",
    );
    console.log("[subagent-sidechat] a.1 ✓ spawn 全新子会话经 ZcodeLoopAgent，父子会话分离，结果以 settlement notice 回到父上下文");

    // 结构化结果：直接走 service activation（spawn 支持 outputSchema），子级仍由同一工厂构造。
    const structuredId = "spawn-structured-child";
    const outputSchema: ObjectJsonSchema = {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    let structuredRequestSeen = false;
    let structuredAgent: Agent | undefined;
    host.adapter.on(structuredId, async (request, count) => {
      if (count === 1) {
        structuredAgent = host.ctx.agents.get(DshSessionId(structuredId));
        check(toolNames(request).includes("structured_output"), "structured: child must see structured_output tool");
        structuredRequestSeen = true;
        return response("", [
          { callId: "structured-call", name: "structured_output", args: { answer: "42" } },
        ]);
      }
      return response("structured answer submitted");
    });
    const signal = new AbortController().signal;
    const activation = await host.ctx.subagents.startActivation({
      provider: "spawn",
      label: "structured probe",
      childId: DshSessionId(structuredId),
      delivery: "parent",
      signal,
      request: {
        parent,
        prompt: [{ type: "text", text: "STRUCTURED-PROMPT" }],
        outputSchema,
      },
    });
    const result = await activation.result;
    check(structuredRequestSeen, "structured: child request was not observed");
    check(result.stopReason === "completed", `structured: expected completed, got ${result.stopReason}`);
    assert.deepEqual(result.structured, { answer: "42" }, "structured: result value mismatch");
    check(structuredAgent instanceof ZcodeLoopAgent, "structured: child must use the ZcodeLoop factory");
    await settle(parent, "structured-parent");
    check(
      settledNoticeHas(parent, "Structured result"),
      "structured: structured value must reach the parent settlement notice",
    );
    console.log("[subagent-sidechat] a.2 ✓ outputSchema 结构化结果由同一工厂子级产出并进入父会话 notice");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

function eventTextHas(agent: Agent, type: string, needle: string): boolean {
  return agent.session.snapshotEvents().some((event) => event.type === type && JSON.stringify(event.data).includes(needle));
}

function settledNoticeHas(agent: Agent, needle: string): boolean {
  return agent.session.snapshotEvents().some(
    (event) =>
      event.type === "user/message" &&
      (event.data as { source?: { kind?: string } }).source?.kind === "subagent-settled" &&
      JSON.stringify(event.data).includes(needle),
  );
}

/** b. fork 子 agent：继承已完成前缀，排除进行中的 turn；父子互不污染。 */
async function forkScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "subagent-fork-parent");
    const parent = parentHandle.agent;
    let childId = "";
    let childAgent: Agent | undefined;
    let boundaryAtFork = -1;
    let childSeen = false;
    let parentToolCount = 0;

    host.adapter.on(parent.id, async (request, count) => {
      const text = requestText(request);
      if (count === 1) return response("PARENT-COMPLETED-PREFIX");
      if (count === 2) {
        parentToolCount += 1;
        boundaryAtFork = completedBoundary(parent);
        return response("forking from the completed prefix", [
          {
            callId: "fork-call",
            name: "subagent_fork",
            args: { description: "fork probe", prompt: "CHILD-FORK-PROMPT: continue from the prefix" },
          },
        ]);
      }
      return response("PARENT-INFLIGHT-MARKER: current turn is not part of the fork seed");
    });
    host.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      check(sessionId !== parent.id, "fork: child request must use a distinct session");
      if (childId === "") {
        childId = sessionId;
        childAgent = host.ctx.agents.get(DshSessionId(sessionId));
      }
      check(sessionId === childId, `fork: unexpected extra child ${sessionId}`);
      check(count === 1, `fork: child should run one turn, got #${count}`);
      const text = requestText(request);
      check(text.includes("PARENT-COMPLETED-PREFIX"), "fork: child must inherit the completed parent prefix");
      check(text.includes("CHILD-FORK-PROMPT"), "fork: child did not receive the delegation prompt");
      check(!text.includes("PARENT-INFLIGHT-MARKER"), "fork: child must not inherit the in-flight turn");
      childSeen = true;
      return response("FORK-CHILD-FINAL");
    });

    parent.followup(userMessage("PARENT-TURN-ONE"));
    await settle(parent, "fork-parent-turn-one");
    parent.followup(userMessage("PARENT-TURN-TWO-INFLIGHT"));
    await waitFor(() => childSeen && childId !== "", "fork: child first request");
    await settle(parent, "fork-parent");

    const child = childAgent;
    check(child !== undefined, "fork: child agent was not captured while live");
    check(child instanceof ZcodeLoopAgent, "fork: fork child must use the ZcodeLoop factory");
    check(child.session.header.parentSession === parent.id, "fork: child header must record the parent session");
    check(child.session.header.origin === "subagent", "fork: fork child header must carry the subagent origin");
    check(child.session.header.isSeeded === true, "fork: fork child must be marked seeded");
    check(
      parentToolCount === 1,
      `fork: expected one fork tool call, got ${parentToolCount}`,
    );
    check(boundaryAtFork >= 0, "fork: boundary was not captured");
    check(
      child.session.inheritedEventCount === boundaryAtFork + 1,
      `fork: inherited count must be the completed prefix, got ${child.session.inheritedEventCount} vs ${boundaryAtFork + 1}`,
    );
    const seedEnd = child.session.snapshotEvents()[child.session.inheritedEventCount - 1];
    check(seedEnd?.type === "turn/end", "fork: the inherited prefix must end at a completed turn");
    check(!eventsText(child).includes("PARENT-INFLIGHT-MARKER"), "fork: in-flight parent turn leaked into the child");
    check(
      !parent.session
        .snapshotEvents()
        .some((event) => event.type === "user/message" && JSON.stringify(event.data).includes("CHILD-FORK-PROMPT")),
      "fork: child prompt leaked into the parent surface",
    );
    check(eventsText(child).includes("CHILD-FORK-PROMPT"), "fork: child log lost its delegation prompt");
    check(eventTextHas(parent, "subagent/catalog", childId), "fork: parent catalog must record the child");
    check(eventTextHas(child, "subagent/descriptor", "fork"), "fork: child log must carry its durable descriptor");
    console.log("[subagent-sidechat] b ✓ fork 子会话继承已完成前缀（排除 in-flight turn），父子日志/状态互不污染");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

/** c. 父中断运行中子 agent：turn/end aborted、cause kind=parent、无重试副作用。 */
async function interruptScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "subagent-interrupt-parent");
    const parent = parentHandle.agent;
    let childId = "";
    let childAgent: Agent | undefined;
    const toolStarted = Promise.withResolvers<void>();
    let childRequestCount = 0;
    let noticeSeen = false;

    host.adapter.on(parent.id, async (request, count) => {
      const text = requestText(request);
      if (count === 1) {
        return response("delegating", [
          {
            callId: "interrupt-spawn",
            name: "subagent",
            args: { description: "interrupt probe", prompt: "CHILD-HOLD: run until interrupted" },
          },
        ]);
      }
      if (text.includes("was stopped before it finished")) noticeSeen = true;
      return response("parent step");
    });
    host.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      if (childId === "") {
        childId = sessionId;
        childAgent = host.ctx.agents.get(DshSessionId(sessionId));
      }
      check(sessionId === childId, "interrupt: unexpected child session");
      childRequestCount += 1;
      check(count === 1, `interrupt: blocked child must not start another request (got #${count})`);
      return response("", [{ callId: "interrupt-hold", name: "hold", args: { marker: "interrupt" } }]);
    });

    host.hold.started.then(() => toolStarted.resolve());
    parent.followup(userMessage("INTERRUPT-PARENT: start a blocking child"));
    await toolStarted.promise;
    await waitFor(() => childId !== "", "interrupt: child id");
    await settle(parent, "interrupt-parent-start");

    const child = childAgent;
    check(child !== undefined, "interrupt: child missing before interrupt");
    let queuedParentCall: ScriptedCall | undefined = {
      callId: "interrupt-agent-call",
      name: "interrupt_agent",
      args: { agent_id: childId },
    };
    host.adapter.on(parent.id, async (request) => {
      const text = requestText(request);
      if (text.includes("was stopped before it finished")) noticeSeen = true;
      const call = queuedParentCall;
      queuedParentCall = undefined;
      return response("parent step", call === undefined ? [] : [call]);
    });
    parent.followup(userMessage("INTERRUPT-NOW"));
    await waitFor(() => noticeSeen, "interrupt: settlement notice");
    await settle(parent, "interrupt-parent-end");

    const reason = latestTurnEnd(child);
    check(reason.kind === "aborted", `interrupt: child turn/end must be aborted, got ${reason.kind}`);
    check(reason.reason?.kind === "parent", `interrupt: cancel cause must be parent, got ${reason.reason?.kind}`);
    check(childRequestCount === 1, `interrupt: aborted child must not retry, got ${childRequestCount} requests`);
    check(host.hold.callCount() === 1, "interrupt: side-effecting tool must not be re-executed");
    check(!eventsText(child).includes("CHILD-HOLD-COMPLETE"), "interrupt: aborted child must not fabricate completion");
    console.log("[subagent-sidechat] c ✓ interrupt_agent 结算为 aborted(parent)，不重做未知副作用");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

/** d. 冷恢复：父/子 JSONL 重启后恢复，父子链接一致，子会话续聊可用。 */
async function coldResumeScenario(): Promise<void> {
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const root = resolve(mkdtempSync(join(EVIDENCE_ROOT, "subagent-sidechat-resume-")));
  const parentId = "subagent-resume-parent";
  const workspace = resolve(mkdtempSync(join(EVIDENCE_ROOT, "subagent-sidechat-resume-workspace-")));
  const first = await createHost({ root: join(root, "sessions"), workspace });
  let parentHandle: AgentHandle | undefined;
  let childId = "";
  try {
    parentHandle = await createAgent(first, parentId);
    const parent = parentHandle.agent;
    let childStarted = Promise.withResolvers<void>();
    first.adapter.on(parent.id, async (_request, count) => {
      if (count === 1) {
        return response("delegating", [
          {
            callId: "resume-spawn",
            name: "subagent",
            args: { description: "resume probe", prompt: "CHILD-COLD-PROMPT: hold before restart" },
          },
        ]);
      }
      return response("parent step");
    });
    first.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      if (childId === "") childId = sessionId;
      check(sessionId === childId, "resume: unexpected child session");
      check(count === 1, `resume: first process child should have one request, got #${count}`);
      check(requestText(request).includes("CHILD-COLD-PROMPT"), "resume: child lost its initial prompt");
      childStarted.resolve();
      return response("", [{ callId: "resume-hold", name: "hold", args: { marker: "resume" } }]);
    });

    parent.followup(userMessage("COLD-RESUME-PARENT-PREFIX"));
    await first.hold.started;
    await childStarted.promise;
    await waitFor(() => childId !== "", "resume: child id");
    const child = first.ctx.agents.get(DshSessionId(childId));
    check(child instanceof ZcodeLoopAgent, "resume: first-process child must use the ZcodeLoop factory");
    // 模拟进程重启前 flush：父/子会话都落 JSONL（子 turn 仍打开，resume 时由 closers 收口）。
    await first.ctx.sessions.flush(parent.session);
    await first.ctx.sessions.flush(child.session);
  } finally {
    await parentHandle?.dispose();
    await first.dispose();
  }

  const second = await createHost({ root: join(root, "sessions"), workspace });
  let resumedParent: AgentHandle | undefined;
  let resumedChild: AgentHandle | undefined;
  try {
    resumedParent = await second.ctx.agents.resume({
      resumeSessionId: DshSessionId(parentId),
      agentOptions: { provider: PROVIDER, model: "mock" },
    });
    check(
      resumedParent.agent instanceof ZcodeLoopAgent,
      "resume: parent must be rebuilt through the ZcodeLoop factory",
    );
    const parent = resumedParent.agent;
    resumedChild = await second.ctx.agents.resume({
      resumeSessionId: DshSessionId(childId),
      parentAgent: parent,
      agentOptions: { provider: PROVIDER, model: "mock" },
    });
    const child = resumedChild.agent;
    check(child instanceof ZcodeLoopAgent, "resume: child must be rebuilt through the ZcodeLoop factory");
    check(child.session.header.parentSession === parent.id, "resume: child parent link changed across restart");
    check(child.session.header.origin === "subagent", "resume: child origin changed across restart");
    check(!eventsText(child).includes("CHILD-COLD-FINAL"), "resume: interrupted child must not claim completion");

    second.adapter.on(child.id, async (request, count) => {
      const text = requestText(request);
      check(text.includes("CHILD-COLD-PROMPT"), "resume: child history lost its pre-restart prompt");
      check(text.includes("CHILD-COLD-CONTINUE"), "resume: child did not receive the new turn input");
      check(count === 1, `resume: expected one resumed child turn, got #${count}`);
      return response("CHILD-COLD-FINAL: resumed");
    });
    second.adapter.on(parent.id, async () => response("parent idle"));
    child.followup(userMessage("CHILD-COLD-CONTINUE"));
    await waitFor(() => second.adapter.count(child.id) === 1, "resume: resumed child request");
    await settle(child, "resume-child");
    check(eventTextHas(parent, "subagent/catalog", childId), "resume: parent catalog lost the child link");
    console.log("[subagent-sidechat] d ✓ 父子 JSONL 冷恢复：链接/身份保持，histories 续聊可用");
  } finally {
    await resumedChild?.dispose();
    await resumedParent?.dispose();
    await second.dispose();
  }
}

/** e. 选区 side chat：命令创建 seeded 子会话，只含已完成前缀 + 选区。 */
async function sideChatScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "sidechat-parent");
    const parent = parentHandle.agent;
    let boundary = -1;
    let parentTurn = 0;

    host.adapter.on(parent.id, async (_request, count) => {
      parentTurn = count;
      if (count === 1) return response("SIDECHAT-PARENT-COMPLETED-PREFIX");
      if (count === 2) {
        boundary = completedBoundary(parent);
        return response("", [{ callId: "sidechat-hold", name: "hold", args: { marker: "sidechat-inflight" } }]);
      }
      return response("parent resumed");
    });

    parent.followup(userMessage("SIDECHAT-PARENT-TURN-ONE"));
    await settle(parent, "sidechat-parent-turn-one");
    parent.followup(userMessage("SIDECHAT-INFLIGHT-USER-MARKER"));
    await host.hold.started;
    check(parentTurn === 2, `sidechat: expected parent turn 2 in flight, got ${parentTurn}`);
    check(boundary >= 0, "sidechat: completed prefix boundary missing");

    const commands = host.ctx.get("commands") as unknown as {
      execute(
        agent: Agent,
        line: string,
        attachments: readonly unknown[],
        signal: AbortSignal,
      ): Promise<{ result: { kind: string; text?: string } } | undefined>;
    };
    const execution = await commands.execute(
      parent,
      "/sidechat SELECTED-SIDECHAT-TEXT",
      [],
      new AbortController().signal,
    );
    check(execution !== undefined, "sidechat: command did not resolve");
    check(execution.result.kind === "success", `sidechat: command failed: ${execution.result.text}`);
    const match = /Side chat (\S+) created/.exec(execution.result.text ?? "");
    check(match !== null, "sidechat: command result did not expose the child id");
    const childId = DshSessionId(match[1]!);

    const child = host.ctx.agents.get(childId);
    check(child !== undefined, "sidechat: child session did not publish");
    check(child instanceof ZcodeLoopAgent, "sidechat: child must be constructed by the ZcodeLoop factory");
    check(child.session.header.parentSession === parent.id, "sidechat: child must record its parent session");
    check(child.session.header.isSeeded === true, "sidechat: child must be seeded");
    check(child.session.header.origin === undefined, "sidechat: a side chat is not a subagent delegation");
    check(child.status === "idle", "sidechat: child must not auto-drive");
    check(
      child.session.inheritedEventCount === boundary + 1,
      `sidechat: inherited count must equal the completed prefix (${child.session.inheritedEventCount} vs ${boundary + 1})`,
    );
    const ownText = JSON.stringify(child.session.snapshotEvents().slice(child.session.inheritedEventCount));
    check(ownText.includes("SELECTED-SIDECHAT-TEXT"), "sidechat: selection text is missing from the child");
    const allText = eventsText(child);
    check(allText.includes("SIDECHAT-PARENT-COMPLETED-PREFIX"), "sidechat: child lost the completed parent prefix");
    check(!allText.includes("SIDECHAT-INFLIGHT-USER-MARKER"), "sidechat: in-flight parent input leaked into the child");
    check(!allText.includes("sidechat-hold"), "sidechat: in-flight parent tool call leaked into the child");
    const inheritedMarker = child.session.snapshotEvents()[child.session.inheritedEventCount];
    check(inheritedMarker?.type === "session/end-seed", "sidechat: inherited cut marker missing");
    check(
      JSON.stringify(child.session.snapshotEvents()[child.session.inheritedEventCount + 1]?.data ?? {}).includes(
        "SELECTED-SIDECHAT-TEXT",
      ),
      "sidechat: selection must be the first child-owned event after the inherited cut",
    );
    check(
      child.session.snapshotEvents().filter((event) => event.type === "user/message").at(-1) !== undefined,
      "sidechat: selection must be a user/message",
    );
    check(
      !parent.session
        .snapshotEvents()
        .some((event) => event.type === "user/message" && JSON.stringify(event.data).includes("SELECTED-SIDECHAT-TEXT")),
      "sidechat: selection must not enter the parent surface",
    );
    console.log("[subagent-sidechat] e ✓ /sidechat 命令从已完成前缀 + 选区创建独立子会话，不含 in-flight 工具");

    // 子会话可继续：续聊时继承前缀 + 选区，且不会把父会话未完成输入带进来。
    let childRequests = 0;
    host.adapter.on(child.id, async (request, count) => {
      childRequests = count;
      const text = requestText(request);
      check(text.includes("SELECTED-SIDECHAT-TEXT"), "sidechat: continued child lost the selection seed");
      check(!text.includes("SIDECHAT-INFLIGHT-USER-MARKER"), "sidechat: continued child inherited in-flight parent input");
      return response("SIDECHAT-CHILD-REPLY");
    });
    child.followup(userMessage("SIDECHAT-CHILD-CONTINUE"));
    await waitFor(() => childRequests === 1, "sidechat: child continuation request");
    await settle(child, "sidechat-child");
    host.hold.release();
    await settle(parent, "sidechat-parent");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

/** f. continuation/control：send_message steer 运行中子级；空闲后续聊；子→父消息。 */
async function controlScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "subagent-control-parent");
    const parent = parentHandle.agent;
    let childId = "";
    let childRequest = 0;
    const parentCalls: ScriptedCall[] = [];
    let parentNotice = false;

    host.adapter.on(parent.id, async (request, count) => {
      const text = requestText(request);
      if (text.includes("CHILD-DONE")) parentNotice = true;
      if (count === 1) {
        return response("delegating", [
          {
            callId: "control-spawn",
            name: "subagent",
            args: { description: "control probe", prompt: "CONTROL-CHILD: hold for a steer" },
          },
        ]);
      }
      const calls = parentCalls.splice(0);
      return response("parent step", calls);
    });
    host.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      if (childId === "") childId = sessionId;
      check(sessionId === childId, "control: unexpected child session");
      childRequest = count;
      const text = requestText(request);
      if (count === 1) {
        return response("", [{ callId: "control-hold", name: "hold", args: { marker: "control" } }]);
      }
      if (count === 2) {
        check(text.includes("STEER-MESSAGE"), "control: running child did not receive the steer at the next step");
        return response("", [
          {
            callId: "control-child-message",
            name: "send_message",
            args: { agent_id: parent.id, message: "CHILD-TO-PARENT-MARKER" },
          },
        ]);
      }
      if (text.includes("CONTINUE-MESSAGE")) {
        check(count >= 4, `control: continuation must be a new turn, got request #${count}`);
        return response("CHILD-CONTINUED");
      }
      return response("CHILD-DONE");
    });

    // 第一轮：父调用 spawn，子进入 hold。
    parent.followup(userMessage("CONTROL-PARENT: spawn a child"));
    await host.hold.started;
    await waitFor(() => childId !== "", "control: child id");
    await settle(parent, "control-parent-start");
    const child = host.ctx.agents.get(DshSessionId(childId));
    check(child instanceof ZcodeLoopAgent, "control: child must use the ZcodeLoop factory");

    // steer 到运行中子级；消息进入 next-step 后放行 hold。
    parentCalls.push({
      callId: "control-send-steer",
      name: "send_message",
      args: { agent_id: childId, message: "STEER-MESSAGE" },
    });
    parent.followup(userMessage("CONTROL-SEND-STEER"));
    await waitFor(() => child.inbox.nextStep.length > 0, "control: child inbox next-step");
    host.hold.release();
    await waitFor(() => childRequest >= 2, "control: child step 2 after steer");
    await waitFor(() => parentNotice, "control: parent settlement notice");
    await settle(child, "control-child");
    check(
      parent.session
        .snapshotEvents()
        .some(
          (event) =>
            event.type === "user/message" &&
            (event.data as { source?: { kind?: string } }).source?.kind === "agent-message" &&
            JSON.stringify(event.data).includes("CHILD-TO-PARENT-MARKER"),
        ),
      "control: child-to-parent message missing from the parent log",
    );

    // 空闲 continuation：父再次 send_message，子开新 turn。
    await settle(parent, "control-parent-after-notice");
    parentCalls.push({
      callId: "control-send-continue",
      name: "send_message",
      args: { agent_id: childId, message: "CONTINUE-MESSAGE" },
    });
    parent.followup(userMessage("CONTROL-SEND-CONTINUE"));
    await waitFor(() => childRequest >= 3, "control: child continuation turn");
    await settle(child, "control-child-continued");
    check(settledNoticeHas(parent, "CHILD-CONTINUED"), "control: continuation settlement notice missing");
    console.log("[subagent-sidechat] f ✓ send_message steer/continuation 与子→父消息按源码语义工作");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const watchdog = setTimeout(() => fail("watchdog: probe did not finish in 240s"), 240000);
  watchdog.unref?.();
  try {
    await spawnScenario();
    await forkScenario();
    await interruptScenario();
    await coldResumeScenario();
    await sideChatScenario();
    await controlScenario();
  } finally {
    rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
  }
  console.log("[subagent-sidechat] PASS: spawn/fork/取消/冷恢复/选区侧聊/control 全部绿");
  clearTimeout(watchdog);
  process.exit(0);
}

main().catch((error: unknown) => fail(`unhandled: ${error instanceof Error ? error.stack : String(error)}`));
