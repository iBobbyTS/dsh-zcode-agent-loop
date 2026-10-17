/**
 * 目标边界重跑（/rerun）集成自证。
 *
 * 语义口径：
 * - 目标 = 父会话第 N 条 user/message（或 last）；边界 = 目标 turn 的 turn/start
 *   之前最近的 turn/end（包含式）。目标 turn 及之后的任何内容都不进入 seed。
 * - seed 由 `buildForkSeed` 收口；编辑文本是子会话第一条 own user/message。
 * - 子会话与 /sidechat 同构：独立 seeded create、idle、不自动驱动、不截断父 log。
 * - goal/plan/todo/preset 的状态按 dsh fork 折叠规则从继承前缀派生；goal 激活
 *   态在 agent/created 时重新 disarmed（dsh-goal 源码语义）。
 * - 本入口不触发任何文件快照/回滚。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import GoalPlugin from "@deepseek-ai/dsh-goal";
import * as GoalRoundDriver from "@deepseek-ai/dsh-goal-round-driver";
import LlmRuntime, {
  LlmAdapter,
  ToolCallId as DshToolCallId,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import PlanMode from "@deepseek-ai/dsh-plan-mode";
import SessionStore, {
  SessionId as DshSessionId,
  pluginRecordOf,
  type Session as DshSession,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as ToolGoal from "@deepseek-ai/dsh-tool-goal";
import * as ToolTodo from "@deepseek-ai/dsh-tool-todo";

import ZcodeLoop, { ZcodeLoopAgent } from "../src/index.js";

const PROVIDER = "mock";
const PLAN_SECTION = "PLAN PROBE POLICY: explore before presenting the plan.";
const EVIDENCE_ROOT = join(tmpdir(), "dsh-branch-rerun");
const PRESET = "rerun-probe-preset";

function fail(message: string): never {
  console.error(`[branch-rerun] FAIL: ${message}`);
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
      argumentsDelta: argumentsJson.slice(0, 5),
    });
    chunks.push({ type: "tool-call-delta", index, id: tcid(call.callId), argumentsDelta: argumentsJson.slice(5) });
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

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  on(sessionId: string, handler: Handler): void {
    this.handlers.set(sessionId, handler);
  }

  count(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const sessionId = String(request.sessionId);
    const count = (this.counts.get(sessionId) ?? 0) + 1;
    this.counts.set(sessionId, count);
    const handler = this.handlers.get(sessionId);
    if (handler === undefined) throw new Error(`unexpected model request for session "${sessionId}"`);
    const chunks = await handler(request, count);
    for (const chunk of chunks) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

interface Host {
  ctx: Context;
  adapter: ScriptedAdapter;
  workspace: string;
  root: string;
  dispose(): Promise<void>;
}

async function createHost(): Promise<Host> {
  const workspace = realpathSync(resolve(mkdtempSync(join(EVIDENCE_ROOT, "workspace-"))));
  const root = resolve(mkdtempSync(join(EVIDENCE_ROOT, "sessions-")));
  mkdirSync(workspace, { recursive: true });
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjection);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(PlanMode, { section: PLAN_SECTION });
  await ctx.plugin(GoalPlugin, {});
  await ctx.plugin(GoalRoundDriver);
  await ctx.plugin(ToolTodo as unknown as Plugin.Object<{ allowParallelInProgress: boolean }>, {
    allowParallelInProgress: true,
  });
  await ctx.plugin(ToolGoal as unknown as Plugin);
  await ctx.plugin(Jsonl, { root, compression: "none" });
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter([PROVIDER], adapter);
  await ctx.plugin(ZcodeLoop as Plugin, { provider: PROVIDER, model: "mock" });
  return { ctx, adapter, workspace, root, dispose: () => ctx.fiber.dispose() };
}

function createAgent(host: Host, id: string, options: { agentPreset?: string } = {}): Promise<AgentHandle> {
  return host.ctx.agents.create({
    sessionId: DshSessionId(id),
    meta: {
      cwd: host.workspace,
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    },
    agentOptions: { provider: PROVIDER, model: "mock" },
  });
}

function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

async function executeCommand(ctx: Context, agent: Agent, line: string): Promise<{ kind: string; text?: string }> {
  const commands = ctx.get("commands") as unknown as {
    execute(
      agent: Agent,
      line: string,
      attachments: readonly unknown[],
      signal: AbortSignal,
    ): Promise<{ result: { kind: string; text?: string } } | undefined>;
  };
  const execution = await commands.execute(agent, line, [], new AbortController().signal);
  check(execution !== undefined, `command "${line}" was not resolved`);
  return execution.result;
}

async function settle(agent: Agent, label: string): Promise<void> {
  await waitFor(() => agent.status === "idle", `${label}: idle`);
  await sleep(300);
  check(agent.status === "idle", `${label}: agent not idle`);
}

function eventsText(events: readonly SessionEvent[]): string {
  return JSON.stringify(events);
}

/** 事件 seq 必须从 0 连续递增，且没有任何 removed/截断记录。 */
function assertContiguous(events: readonly { type: string; seq: number; surfaceOp?: unknown }[], label: string): void {
  events.forEach((event, index) => {
    check(event.seq === index, `${label}: event seq gap at index ${index} (seq ${event.seq})`);
    check(!event.type.includes("removed"), `${label}: removed event at seq ${event.seq}`);
    const op = event.surfaceOp;
    if (op !== undefined && typeof op === "object" && op !== null) {
      check((op as { op?: unknown }).op !== "removed", `${label}: removed surface op at seq ${event.seq}`);
    }
  });
}

function firstOwnUserMessage(events: readonly SessionEvent[], inheritedEventCount: number): SessionEvent | undefined {
  return events.slice(inheritedEventCount).find((event) => event.type === "user/message");
}

interface GoalView {
  id: string;
  revision: number;
  phase: "active" | "paused" | "blocked" | "complete";
  activation: "armed" | "disarmed";
  roundsStarted: number;
}

function goalsOf(ctx: Context): { get(agent: Agent): GoalView | undefined } {
  return ctx.get("goals") as unknown as { get(agent: Agent): GoalView | undefined };
}

function projectionState<T>(ctx: Context, session: DshSession, key: string): T | undefined {
  const service = ctx.get("sessionProjections") as unknown as {
    stateOf(session: unknown, key: string): unknown;
  };
  return service.stateOf(session, key) as T | undefined;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface PlanState {
  active: boolean;
  wanted: boolean | null;
  running: unknown;
}

function planView(ctx: Context, agent: Agent): { active: boolean } {
  const service = ctx.get("planMode") as unknown as { get(agent: Agent): { active: boolean } };
  return service.get(agent);
}

async function readDurable(
  ctx: Context,
  session: DshSession,
): Promise<{ header: { parentSession?: string; isSeeded: boolean; agentPreset?: string }; events: readonly SessionEvent[] }> {
  await ctx.sessions.flush(session);
  const reader = await ctx.sessionPersistence.open(session.id, "read");
  try {
    const result = await reader.read(0);
    return { header: reader.header, events: result.events };
  } finally {
    await reader.close();
  }
}

/** a + c + d：边界包含关系、父 log 只读、入口标记与 durable meta。 */
async function boundaryScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "branch-rerun-boundary-parent", { agentPreset: PRESET });
    const parent = parentHandle.agent;
    host.adapter.on(parent.id, (_request, count) => {
      if (count === 1) return response("T1-REPLY");
      if (count === 2) return response("T2-REPLY");
      if (count === 3) return response("T3-REPLY");
      if (count === 4) return response("T4-REPLY");
      throw new Error(`boundary: unexpected parent request #${count}`);
    });

    for (const [index, text] of ["T1-USER", "T2-USER", "T3-USER"].entries()) {
      parent.followup(userMessage(text));
      await settle(parent, `boundary-turn-${index + 1}`);
      check(host.adapter.count(parent.id) === index + 1, `boundary: turn ${index + 1} request count`);
    }

    const preEvents = parent.session.snapshotEvents();
    const sentinel = join(host.workspace, "rerun-sentinel.txt");
    writeFileSync(sentinel, "untouched");
    const sentinelStat = statSync(sentinel);
    const listing = readdirSync(host.workspace).sort();

    const result = await executeCommand(host.ctx, parent, "/rerun 2 EDITED-BOUNDARY-TEXT");
    check(result.kind === "success", `boundary: /rerun failed: ${result.text}`);
    const output = result.text ?? "";
    check(output.includes("parentSession="), "boundary: command output must expose parentSession");
    check(/rerunFrom=message:\d+,boundary:\d+/u.test(output), "boundary: command output must expose rerunFrom");
    check(output.includes("new session"), "boundary: command output must state it creates a new session");
    check(output.includes("parent log unchanged"), "boundary: command output must state the parent log is unchanged");
    check(output.includes("not a same-session rewind"), "boundary: command output must distinguish same-session rewind");
    const match = /Rerun branch (\S+) created/u.exec(output);
    check(match !== null, "boundary: command result did not expose the branch id");
    const childId = DshSessionId(match[1]!);
    const boundaryMatch = /boundary:(\d+)/u.exec(output);
    check(boundaryMatch !== null, "boundary: command result did not expose the boundary");
    const boundary = Number(boundaryMatch[1]);

    const child = host.ctx.agents.get(childId);
    check(child !== undefined, "boundary: child session did not publish");
    check(child instanceof ZcodeLoopAgent, "boundary: child must be constructed by the ZCode loop factory");
    check(child.session.header.parentSession === parent.id, "boundary: child must record parentSession");
    check(child.session.header.isSeeded === true, "boundary: child must be seeded");
    check(child.session.header.origin === undefined, "boundary: a rerun branch is not a subagent delegation");
    check(child.session.header.agentPreset === PRESET, "boundary: child must inherit the parent agent preset");
    check(child.status === "idle", "boundary: child must not auto-drive");
    check(host.adapter.count(String(childId)) === 0, "boundary: child must not issue a request");

    const childEvents = child.session.snapshotEvents();
    const inheritedEventCount = child.session.inheritedEventCount;
    check(inheritedEventCount === boundary + 1, `boundary: inherited count ${inheritedEventCount} != ${boundary + 1}`);
    const inheritedText = eventsText(childEvents.slice(0, inheritedEventCount));
    check(inheritedText.includes("T1-USER"), "boundary: child lost T1 input");
    check(inheritedText.includes("T1-REPLY"), "boundary: child lost T1 reply");
    check(!inheritedText.includes("T2-USER"), "boundary: T2 input leaked into the inherited prefix");
    check(!inheritedText.includes("T2-REPLY"), "boundary: T2 reply leaked into the inherited prefix");
    check(!inheritedText.includes("T3-USER"), "boundary: T3 input leaked into the inherited prefix");
    check(!inheritedText.includes("T3-REPLY"), "boundary: T3 reply leaked into the inherited prefix");
    check(childEvents[inheritedEventCount]?.type === "session/end-seed", "boundary: inherited cut marker missing");
    const ownUser = firstOwnUserMessage(childEvents, inheritedEventCount);
    check(ownUser !== undefined, "boundary: child has no own user message");
    check(
      JSON.stringify(ownUser.data).includes("EDITED-BOUNDARY-TEXT"),
      "boundary: edited text must be the first own user message",
    );
    // 命令运行本身会追加 command/run + command/done（宿主审计）；父对话前缀必须逐事件不变。
    const afterRerun = parent.session.snapshotEvents();
    assert.deepEqual(
      afterRerun.slice(0, preEvents.length),
      preEvents,
      "boundary: /rerun rewrote the parent conversation log",
    );
    check(
      afterRerun
        .slice(preEvents.length)
        .every((event) => event.type === "command/run" || event.type === "command/done"),
      "boundary: /rerun appended non-command events to the parent log",
    );
    check(
      !afterRerun.some(
        (event) => event.type === "user/message" && JSON.stringify(event.data).includes("EDITED-BOUNDARY-TEXT"),
      ),
      "boundary: edited text must not enter the parent conversation",
    );
    console.log("[branch-rerun] a ✓ /rerun 2 只继承 T1 完成前缀（含回复），T2/T3 不进入子会话；首条 own 消息=编辑文本");

    // c. 父会话继续可用；父 log seq 连续且无 removed/截断。
    parent.followup(userMessage("T4-USER"));
    await settle(parent, "boundary-turn-4");
    check(host.adapter.count(parent.id) === 4, "boundary: parent continuation missing");
    const parentText = eventsText(parent.session.snapshotEvents());
    check(parentText.includes("T4-USER") && parentText.includes("T4-REPLY"), "boundary: parent continuation failed");
    assertContiguous(parent.session.snapshotEvents(), "boundary parent live");
    const durable = await readDurable(host.ctx, parent.session);
    assert.deepEqual(durable.events.slice(0, preEvents.length), preEvents, "boundary: durable parent prefix was rewritten");
    assertContiguous(durable.events, "boundary parent durable");
    console.log("[branch-rerun] c ✓ rerun 后父会话继续输入正常；durable log 前缀逐事件不变、seq 连续、无 removed");

    // d. durable meta：header + rerunFrom plugin record；无文件回滚副作用。
    check(readFileSync(sentinel, "utf8") === "untouched", "boundary: rerun changed a workspace file");
    check(statSync(sentinel).mtimeMs === sentinelStat.mtimeMs, "boundary: rerun touched a workspace file mtime");
    assert.deepEqual(readdirSync(host.workspace).sort(), listing, "boundary: rerun changed the workspace listing");
    const childDurable = await readDurable(host.ctx, child.session);
    check(childDurable.header.parentSession === parent.id, "boundary: durable header lost parentSession");
    check(childDurable.header.isSeeded === true, "boundary: durable header lost isSeeded");
    check(childDurable.header.agentPreset === PRESET, "boundary: durable header lost agentPreset");
    const record = childDurable.events
      .map((event) => pluginRecordOf(event))
      .find((candidate) => candidate?.type === "plugin:zcode-loop/rerun");
    check(record !== undefined, "boundary: durable rerunFrom record missing");
    const recordData = record.data as {
      parentSession: string;
      messageNumber: number;
      boundarySeq: number;
    };
    check(recordData.parentSession === parent.id, "boundary: rerunFrom record lost parentSession");
    check(recordData.messageNumber === 2, `boundary: rerunFrom messageNumber=${recordData.messageNumber}`);
    check(recordData.boundarySeq === boundary, "boundary: rerunFrom boundary mismatch");
    check(
      !eventsText(durable.events).includes("plugin:zcode-loop/rerun"),
      "boundary: rerunFrom record must not enter the parent log",
    );
    console.log("[branch-rerun] d ✓ 命令输出含 parentSession/rerunFrom；header+plugin record 落盘；父 log 无写入、工作区无文件变化");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

/** b. 继承前缀中的 goal/todo/plan/preset 按 fork 规则派生。 */
async function derivedStateScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "branch-rerun-state-parent", { agentPreset: PRESET });
    const parent = parentHandle.agent;
    const todos: TodoItem[] = [
      { content: "继承清单", status: "in_progress" },
      { content: "第二项", status: "pending" },
    ];
    host.adapter.on(parent.id, (_request, count) => {
      if (count === 1) return response("T1-REPLY");
      if (count === 2) {
        return response("T2-CREATE", [
          { callId: "state-create-goal", name: "create_goal", args: { objective: "rerun 派生验收", max_goal_rounds: 3 } },
          { callId: "state-todo", name: "todo_write", args: { todos } },
        ]);
      }
      if (count === 3) {
        const goal = goalsOf(host.ctx).get(parent);
        check(goal !== undefined, "state: goal missing after create");
        return response("T2-COMPLETE", [
          {
            callId: "state-complete-goal",
            name: "update_goal",
            args: { goal_id: goal.id, revision: goal.revision, action: "complete" },
          },
        ]);
      }
      if (count === 4) return response("T2-DONE");
      if (count === 5) return response("T3-REPLY");
      throw new Error(`state: unexpected parent request #${count}`);
    });

    parent.followup(userMessage("T1-USER"));
    await settle(parent, "state-turn-1");
    const planEntered = await executeCommand(host.ctx, parent, "/plan");
    check(planEntered.kind === "success", `state: /plan failed: ${planEntered.text}`);
    parent.followup(userMessage("T2-USER"));
    await waitFor(() => host.adapter.count(parent.id) >= 4, "state: T2 goal steps");
    await settle(parent, "state-turn-2");
    const parentGoal = goalsOf(host.ctx).get(parent);
    check(parentGoal !== undefined, "state: parent goal missing");
    check(parentGoal.phase === "complete", `state: parent goal phase ${parentGoal.phase}`);
    const goalBefore = { id: parentGoal.id, revision: parentGoal.revision };
    parent.followup(userMessage("T3-USER"));
    await settle(parent, "state-turn-3");

    const result = await executeCommand(host.ctx, parent, "/rerun 3 EDITED-STATE-TEXT");
    check(result.kind === "success", `state: /rerun failed: ${result.text}`);
    const match = /Rerun branch (\S+) created/u.exec(result.text ?? "");
    check(match !== null, "state: command result did not expose the branch id");
    const child = host.ctx.agents.get(DshSessionId(match[1]!));
    check(child !== undefined, "state: child session did not publish");
    check(child instanceof ZcodeLoopAgent, "state: child must be constructed by the ZCode loop factory");
    check(child.status === "idle", "state: child must not auto-drive");

    const childEvents = child.session.snapshotEvents();
    const ownUser = firstOwnUserMessage(childEvents, child.session.inheritedEventCount);
    check(ownUser !== undefined, "state: child has no own user message");
    check(
      JSON.stringify(ownUser.data).includes("EDITED-STATE-TEXT"),
      "state: edited text must be the first own user message",
    );

    const childGoal = goalsOf(host.ctx).get(child);
    check(childGoal !== undefined, "state: child goal projection missing");
    check(childGoal.id === goalBefore.id, "state: child must inherit the parent goal id");
    check(childGoal.revision === goalBefore.revision, "state: child must inherit the parent goal revision");
    check(childGoal.phase === "complete", `state: child goal phase ${childGoal.phase}`);
    check(childGoal.activation === "disarmed", `state: child goal activation ${childGoal.activation}`);
    check(childGoal.roundsStarted === 0, `state: child goal roundsStarted ${childGoal.roundsStarted}`);
    assert.deepEqual(
      projectionState<TodoItem[]>(host.ctx, child.session, "todos"),
      todos,
      "state: child todo projection must fold the inherited turn",
    );
    const childPlan = projectionState<PlanState>(host.ctx, child.session, "plan");
    check(childPlan?.active === true, "state: child plan projection must fold the inherited /plan");
    check(childPlan.wanted === null && childPlan.running === null, "state: child plan inherited pending selection");
    check(planView(host.ctx, child).active, "state: child plan service missing active state");
    check(child.session.header.agentPreset === PRESET, "state: child must inherit the parent agent preset");
    console.log("[branch-rerun] b ✓ 目标前 T2 的 goal(id/revision)/todo/plan 按 fork 折叠继承；goal 激活态 disarmed；preset 继承");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

/** e. 缺失/非法目标与缺参：明确 usage 错误，且不产生会话。 */
async function errorScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "branch-rerun-error-parent");
    const parent = parentHandle.agent;
    host.adapter.on(parent.id, () => response("ONLY-REPLY"));
    parent.followup(userMessage("ONLY-USER"));
    await settle(parent, "error-turn");

    const sessionsBefore = host.ctx.sessions.list().length;
    const agentsBefore = host.ctx.agents.list().length;
    const noTarget = await executeCommand(host.ctx, parent, "/rerun 99 EDITED");
    check(noTarget.kind === "error", "error: /rerun 99 must fail");
    check((noTarget.text ?? "").includes("not found"), "error: /rerun 99 must report the missing target");
    check((noTarget.text ?? "").includes("Usage:"), "error: /rerun 99 must expose usage");
    const missingArgs = await executeCommand(host.ctx, parent, "/rerun");
    check(missingArgs.kind === "error", "error: /rerun without args must fail");
    check((missingArgs.text ?? "").includes("Usage:"), "error: /rerun without args must expose usage");
    const noBoundary = await executeCommand(host.ctx, parent, "/rerun 1 EDITED");
    check(noBoundary.kind === "error", "error: rerunning the first turn has no completed boundary");
    const badSelector = await executeCommand(host.ctx, parent, "/rerun nope EDITED");
    check(badSelector.kind === "error", "error: non-numeric selector must fail");
    check(host.ctx.sessions.list().length === sessionsBefore, "error: failed rerun must not create a session");
    check(host.ctx.agents.list().length === agentsBefore, "error: failed rerun must not create an agent");
    console.log("[branch-rerun] e ✓ 不存在目标/缺参/无前序边界/非法选择器均返回 usage 错误且不产生会话");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

mkdirSync(EVIDENCE_ROOT, { recursive: true });
try {
  await boundaryScenario();
  await derivedStateScenario();
  await errorScenario();
  console.log("[branch-rerun] PASS: 边界包含/派生状态/父会话可用/入口统计/错误路径全部绿");
} catch (error) {
  console.error("[branch-rerun] FAIL:", error);
  process.exit(1);
}
