/**
 * goal/todo/plan 生命周期集成自证（T10）：在 goal-chain happy path 之外，
 * 覆盖失败不越权续轮、中止、冷恢复、fork、plan 进入退出与 round 预算停止。
 *
 * 断言口径来自钉版插件源码（node_modules 0.2.1-alpha.5），不是任务假设：
 *  - dsh-goal-round-driver：`agent/error` → `goals.disarm`（只失活，不改 phase）；
 *    `turn/end` reason=aborted 且本轮回已 claimed/admitted → 下一 idle 时
 *    `goals.pause`。round 预算耗尽 → `goals.block({code:"round-limit"})`。
 *  - dsh-goal：resume 允许 active+disarmed（失败后的手动恢复），pause 后模型
 *    不可自行 resume；round 从 `roundsStarted + 1` 继续，revision 逐次 +1。
 *  - dsh-tool-todo：`todos` 投影 last-write-wins，`turn/start` 清空。
 *  - dsh-plan-mode：`/plan`、`/plan off` 是入口，状态是 log-only `plan/mode`；
 *    `exit_plan_mode` 工具在两种状态下都注册；`plan:policy` 段仅在 active 渲染；
 *    投影随 resume/fork 折叠恢复（active），pending 是进程内选择。
 *  - fork 语义：controller 用 `buildForkSeed(events, boundary)` +
 *    `inheritedEventCount = boundary + 1` seeded create；子会话折叠父前缀，
 *    goal 激活态在新 agent 上重新 disarmed。
 *
 * twin：goal-round-driver/goal 是共享插件，中止用例在 stock agent-loop 上跑
 * 同一组插件断言，zcode 侧只做等价对照。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  SessionLogOffset,
  SessionSeq,
  type Session as DshSession,
} from "@deepseek-ai/dsh-session";
import { buildForkSeed } from "@deepseek-ai/dsh-session/fork";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as ToolGoal from "@deepseek-ai/dsh-tool-goal";
import * as ToolTodo from "@deepseek-ai/dsh-tool-todo";

import ZcodeLoop from "../src/index.js";
import { installedRequire } from "./contract-verification/oracle.js";

const stock = (await import(pathToFileURL(installedRequire.resolve("@deepseek-ai/dsh-agent-loop")).href))
  .default as Plugin;

const PLAN_SECTION = "PLAN PROBE POLICY: explore and design before presenting the complete plan through exit_plan_mode.";
const PROVIDER = "mock";

function fail(message: string): never {
  console.error(`[goal-plan] FAIL: ${message}`);
  process.exit(1);
}
function check(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}
/** 非收窄断言：用于随后还要与其他字面量比较的计数。 */
function requireTrue(condition: boolean, message: string): void {
  if (!condition) fail(message);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
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

type Handler = (number: number, request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>;

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  handler: Handler = () => response("probe reply");

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const chunks = await this.handler(this.requests.length, request);
    for (const chunk of chunks) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

interface GoalView {
  id: string;
  revision: number;
  phase: "active" | "paused" | "blocked" | "complete";
  activation: "armed" | "disarmed";
  roundsStarted: number;
  maxGoalRounds: number;
  blockedReason?: { code: string; message: string };
}

interface HostOptions {
  engine: "zcode" | "stock";
  root?: string;
  plan?: boolean;
  commands?: boolean;
}

interface Host {
  ctx: Context;
  adapter: ScriptedAdapter;
  dispose(): Promise<void>;
}

async function createHost(options: HostOptions): Promise<Host> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjection);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  if (options.commands === true) await ctx.plugin(CommandRuntime);
  if (options.plan === true) await ctx.plugin(PlanMode, { section: PLAN_SECTION });
  await ctx.plugin(GoalPlugin, {});
  await ctx.plugin(GoalRoundDriver);
  // Config 推断不进 cordis 泛型：namespace 导出按显式 Plugin.Object cast（goal-chain 同款）。
  await ctx.plugin(ToolTodo as unknown as Plugin.Object<{ allowParallelInProgress: boolean }>, {
    allowParallelInProgress: true,
  });
  await ctx.plugin(ToolGoal as unknown as Plugin);
  if (options.root !== undefined) await ctx.plugin(Jsonl, { root: options.root, compression: "none" });
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter([PROVIDER], adapter);
  await ctx.plugin((options.engine === "stock" ? stock : ZcodeLoop) as Plugin, {
    provider: PROVIDER,
    model: "mock",
  });
  return { ctx, adapter, dispose: () => ctx.fiber.dispose() };
}

function createAgent(host: Host, id: string): Promise<AgentHandle> {
  return host.ctx.agents.create({
    sessionId: DshSessionId(id),
    agentOptions: { provider: PROVIDER, model: "mock" },
  });
}

function goalsOf(ctx: Context): {
  get(agent: Agent): GoalView | undefined;
  disarm(agent: Agent): GoalView | undefined;
} {
  return ctx.get("goals") as unknown as {
    get(agent: Agent): GoalView | undefined;
    disarm(agent: Agent): GoalView | undefined;
  };
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

interface PlanUnitStateHost {
  active: boolean;
  wanted: boolean | null;
  running: unknown;
  activeAtLastHeader: boolean | null;
}

function planLogged(ctx: Context, session: DshSession): PlanUnitStateHost | undefined {
  return projectionState<PlanUnitStateHost>(ctx, session, "plan");
}

function planView(ctx: Context, agent: Agent): { active: boolean; pending?: boolean } {
  const service = ctx.get("planMode") as unknown as {
    get(agent: Agent): { active: boolean; pending?: boolean };
  };
  return service.get(agent);
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

function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

interface GoalSource {
  kind: "goal";
  goalId: string;
  revision: number;
  round: number;
}

function goalSources(agent: Agent): GoalSource[] {
  return agent.session
    .snapshotEvents()
    .filter((event) => event.type === "user/message" && event.data.source.kind === "goal")
    .map((event) => (event as { data: { source: GoalSource } }).data.source);
}

function requestJson(request: GenerateOptions): string {
  return JSON.stringify(request.messages);
}

function toolNames(request: GenerateOptions): string[] {
  return (request.tools ?? []).map((tool) => (tool as { name: string }).name);
}

function sessionOwnsText(session: DshSession, text: string): boolean {
  return JSON.stringify(session.snapshotEvents()).includes(text);
}

function latestCompletedPrefixBoundary(events: readonly { type: string; seq: number; data?: unknown }[]): number {
  const lastTurnEnd = events.findLast((event) => event.type === "turn/end");
  if (lastTurnEnd === undefined) throw new Error("fork source has no completed turn");
  let boundary = lastTurnEnd.seq;
  for (const next of events.slice(boundary + 1)) {
    if (
      next.type === "turn/start" ||
      (next.type === "user/message" && (next.data as { surfaceOp?: string }).surfaceOp === "append") ||
      next.type === "agent/inbox/spliced"
    ) {
      break;
    }
    boundary = next.seq;
  }
  return boundary;
}

/** a. goal 失败不越权续轮；排队输入被 T06 收容；手动恢复后 round 语义连续。 */
async function failureScenario(): Promise<void> {
  const host = await createHost({ engine: "zcode" });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "goal-plan-failure");
    const agent = handle.agent;
    const goals = goalsOf(host.ctx);
    const queued = userMessage("FAILURE-QUEUED：这一条必须留在 inbox");
    let queuedObservedPending = false;
    let goalAfterFailure: GoalView | undefined;

    host.adapter.handler = (n) => {
      if (n === 1) {
        return response("先建立目标与清单。", [
          { callId: "failure-create", name: "create_goal", args: { objective: "失败收容验收", max_goal_rounds: 3 } },
          {
            callId: "failure-todo",
            name: "todo_write",
            args: { todos: [{ content: "失败收容", status: "in_progress" }] },
          },
        ]);
      }
      if (n === 2) return response("人类轮完成，等待自动续轮。");
      if (n === 3) {
        // 目标轮进行中输入到达：错误后 driver 必须停止且不得消费它（T06）。
        agent.followup(queued);
        throw new Error("adapter failure inside goal round 1");
      }
      if (n === 4) {
        const goal = goals.get(agent);
        check(goal !== undefined, "manual resume turn must still see the goal");
        return response("用户手动恢复目标。", [
          {
            callId: "failure-resume",
            name: "update_goal",
            args: { goal_id: goal.id, revision: goal.revision, action: "resume" },
          },
        ]);
      }
      if (n === 5) return response("目标已重新激活。");
      if (n === 6) {
        const goal = goals.get(agent);
        check(goal !== undefined, "goal round 2 must still see the goal");
        return response("续轮推进并标记完成。", [
          {
            callId: "failure-complete",
            name: "update_goal",
            args: { goal_id: goal.id, revision: goal.revision, action: "complete" },
          },
        ]);
      }
      if (n === 7) return response("目标完成收口。");
      throw new Error(`unexpected request #${n} (failure round must not auto-continue)`);
    };

    agent.followup(userMessage("请建立目标并推进"));
    await waitFor(() => host.adapter.requests.length >= 3, "failure: goal round request");
    // 稳定窗口：失败后 driver 不得自动开下一轮，排队输入也不得被消费。
    await waitFor(() => agent.status === "idle", "failure: agent idle after error");
    await sleep(600);
    requireTrue(host.adapter.requests.length === 3, `failure: expected 3 requests, got ${host.adapter.requests.length}`);
    queuedObservedPending = agent.inbox.nextTurn.some((message) => message.id === queued.id);
    check(queuedObservedPending, "failure: queued input was consumed by the failed driver");
    goalAfterFailure = goals.get(agent);
    check(goalAfterFailure !== undefined, "failure: goal disappeared");
    check(goalAfterFailure.phase === "active", `failure: phase must stay active, got ${goalAfterFailure.phase}`);
    check(goalAfterFailure.activation === "disarmed", `failure: agent/error must disarm, got ${goalAfterFailure.activation}`);
    check(goalAfterFailure.roundsStarted === 1, `failure: first round must be recorded, got ${goalAfterFailure.roundsStarted}`);
    const failureTurnEnd = agent.session
      .snapshotEvents()
      .filter((event) => event.type === "turn/end")
      .at(-1) as { data: { reason: { kind: string; error?: { message?: string } } } };
    check(failureTurnEnd.data.reason.kind === "error", `failure: turn/end must be error, got ${failureTurnEnd.data.reason.kind}`);
    check(
      String(failureTurnEnd.data.reason.error?.message ?? "").includes("adapter failure inside goal round 1"),
      "failure: turn/end lost the adapter root cause",
    );
    console.log("[goal-plan] a.1 ✓ 失败轮后无自动续轮；goal active+disarmed；排队输入留在 inbox；turn/end=error 保留根因");

    // 清掉被收容的输入，用新的人类输入恢复（不依赖旧队列）。
    agent.inbox.clear();
    agent.followup(userMessage("手动恢复目标"));
    await waitFor(() => host.adapter.requests.length >= 7, "failure: manual resume + goal round 2");
    await harness(agent, "failure");
    check(host.adapter.requests.length === 7, `failure: expected exactly 7 requests, got ${host.adapter.requests.length}`);

    const goal = goals.get(agent);
    check(goal !== undefined, "failure: goal vanished after completion");
    check(goal.phase === "complete", `failure: phase must be complete, got ${goal.phase}`);
    check(goal.roundsStarted === 2, `failure: roundsStarted must be 2, got ${goal.roundsStarted}`);
    check(goal.revision === 3, `failure: revision must advance create→resume→complete (3), got ${goal.revision}`);
    const sources = goalSources(agent);
    check(sources.length === 2, `failure: expected 2 goal rounds, got ${sources.length}`);
    check(sources[0]!.round === 1 && sources[0]!.revision === 1, `failure: round 1 source mismatch ${JSON.stringify(sources[0])}`);
    check(sources[1]!.round === 2 && sources[1]!.revision === 2, `failure: round 2 source mismatch ${JSON.stringify(sources[1])}`);
    check(requestJson(host.adapter.requests[2]!).includes("<goal_round>"), "failure: failing round must carry <goal_round>");
    check(requestJson(host.adapter.requests[2]!).includes("Round: 1/3"), "failure: failing round number mismatch");
    check(requestJson(host.adapter.requests[5]!).includes("<goal_round>"), "failure: resumed round must carry <goal_round>");
    check(requestJson(host.adapter.requests[5]!).includes("Round: 2/3"), "failure: resumed round must continue at 2/3");
    const toolEvents = JSON.stringify(agent.session.snapshotEvents().filter((event) => event.type.startsWith("tool/")));
    check(!toolEvents.includes("GOAL_TOOL_"), "failure: goal tool authority rejected");
    console.log("[goal-plan] a.2 ✓ 手动 resume 后 round 2/3 续轮且 source revision/round 连续；goal complete");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** f. goal round 预算停止：dsh-goal 只有 maxGoalRounds（无 token 预算配置面）。 */
async function budgetScenario(): Promise<void> {
  const host = await createHost({ engine: "zcode" });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "goal-plan-budget");
    const agent = handle.agent;
    host.adapter.handler = (n) => {
      if (n === 1) {
        return response("预算验收：目标最多一轮。", [
          { callId: "budget-create", name: "create_goal", args: { objective: "预算停止验收", max_goal_rounds: 1 } },
        ]);
      }
      if (n === 2) return response("人类轮完成。");
      if (n === 3) return response("目标轮推进但故意不完成。");
      throw new Error(`unexpected request #${n} (round budget must stop continuation)`);
    };
    agent.followup(userMessage("请建立单轮目标"));
    await waitFor(() => host.adapter.requests.length >= 3, "budget: goal round 1");
    await agent.whenIdle();
    await sleep(600);
    check(host.adapter.requests.length === 3, `budget: expected 3 requests, got ${host.adapter.requests.length}`);
    const goal = goalsOf(host.ctx).get(agent);
    check(goal !== undefined, "budget: goal missing");
    check(goal.phase === "blocked", `budget: phase must be blocked, got ${goal.phase}`);
    check(goal.blockedReason?.code === "round-limit", `budget: block reason must be round-limit, got ${goal.blockedReason?.code}`);
    check(goal.activation === "disarmed", `budget: blocked goal must be disarmed, got ${goal.activation}`);
    check(goal.roundsStarted === 1, `budget: one round must be recorded, got ${goal.roundsStarted}`);
    console.log("[goal-plan] f ✓ maxGoalRounds=1 触发 round-limit block，无第 4 次请求");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

interface AbortMetrics {
  phase: string;
  activation: string;
  revision: number;
  nextTurn: number;
  nextStep: number;
  requests: number;
  turnEndKind: string;
  turnEndReasonKind: string;
}

/** b. goal round 中止：分别断言 default 清 inbox 与 keepInbox 保留，与 stock twin 对照。 */
async function abortCase(engine: "zcode" | "stock", keepInbox: boolean): Promise<AbortMetrics> {
  const host = await createHost({ engine });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, `goal-plan-abort-${engine}-${keepInbox ? "keep" : "clear"}`);
    const agent = handle.agent;
    const queued = userMessage(`ABORT-QUEUED-${engine}-${keepInbox ? "keep" : "clear"}`);
    const started = Promise.withResolvers<void>();

    host.adapter.handler = async (n, request) => {
      if (n === 1) {
        return response("中止验收：创建目标。", [
          { callId: `abort-create-${engine}`, name: "create_goal", args: { objective: "中止验收", max_goal_rounds: 3 } },
        ]);
      }
      if (n === 2) return response("人类轮完成。");
      if (n === 3) {
        started.resolve();
        await new Promise<void>((resolveAbort) => {
          if (request.signal?.aborted === true) return resolveAbort();
          request.signal?.addEventListener("abort", () => resolveAbort(), { once: true });
        });
        throw new Error("goal round cancelled by probe");
      }
      throw new Error(`unexpected request #${n} (aborted round must not continue)`);
    };

    agent.followup(userMessage("请建立目标并进入目标轮"));
    await waitFor(() => host.adapter.requests.length >= 2, `${engine}: human turn`);
    await started.promise;
    agent.followup(queued);
    agent.cancel({ kind: "user" }, keepInbox ? { keepInbox: true } : undefined);
    await agent.whenIdle();
    await sleep(600);
    check(host.adapter.requests.length === 3, `${engine}: aborted round must not continue (${host.adapter.requests.length})`);
    const goal = goalsOf(host.ctx).get(agent);
    check(goal !== undefined, `${engine}: goal missing after abort`);
    check(goal.phase === "paused", `${engine}: abort of a claimed round must pause the goal, got ${goal.phase}`);
    check(goal.activation === "disarmed", `${engine}: paused goal must be disarmed, got ${goal.activation}`);
    const turnEnd = agent.session
      .snapshotEvents()
      .filter((event) => event.type === "turn/end")
      .at(-1) as { data: { reason: { kind: string; reason?: { kind?: string } } } };
    check(turnEnd.data.reason.kind === "aborted", `${engine}: turn/end must be aborted, got ${turnEnd.data.reason.kind}`);
    const expectedQueued = keepInbox ? 1 : 0;
    check(
      agent.inbox.nextTurn.length === expectedQueued,
      `${engine}: keepInbox=${keepInbox} expected nextTurn=${expectedQueued}, got ${agent.inbox.nextTurn.length}`,
    );
    check(agent.inbox.nextStep.length === 0, `${engine}: abort must leave no next-step input`);
    return {
      phase: goal.phase,
      activation: goal.activation,
      revision: goal.revision,
      nextTurn: agent.inbox.nextTurn.length,
      nextStep: agent.inbox.nextStep.length,
      requests: host.adapter.requests.length,
      turnEndKind: turnEnd.data.reason.kind,
      turnEndReasonKind: turnEnd.data.reason.reason?.kind ?? "",
    };
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

async function abortTwin(): Promise<void> {
  for (const keepInbox of [false, true]) {
    const zcode = await abortCase("zcode", keepInbox);
    const stockMetrics = await abortCase("stock", keepInbox);
    assert.deepEqual(zcode, stockMetrics, `abort twin mismatch (keepInbox=${keepInbox})`);
    console.log(
      `[goal-plan] b ✓ twin keepInbox=${keepInbox}: pause+disarm, requests=${zcode.requests}, inbox(nextTurn=${zcode.nextTurn},nextStep=${zcode.nextStep})`,
    );
  }
}

/** c. 重启/冷恢复：goal + todo + plan 投影恢复，下一轮从恢复态继续且不越权。 */
async function coldResumeScenario(): Promise<void> {
  mkdirSync(".agent-work/evidence/integration", { recursive: true });
  const root = resolve(mkdtempSync(".agent-work/evidence/integration/goal-plan-resume-"));
  const sessionId = DshSessionId("goal-plan-cold-resume");
  const todosAfter = [
    { content: "恢复清单 A", status: "in_progress" as const },
    { content: "恢复清单 B", status: "pending" as const },
  ];

  const first = await createHost({ engine: "zcode", root: join(root, "sessions"), plan: true, commands: true });
  let firstHandle: AgentHandle | undefined;
  let goalId = "";
  try {
    firstHandle = await createAgent(first, "goal-plan-cold-resume");
    const agent = firstHandle.agent;
    const entered = await executeCommand(first.ctx, agent, "/plan");
    check(entered.kind === "success", `resume: /plan failed: ${entered.text}`);
    // 冷恢复要停在“进行中而非终态”：第 1 轮收口后由宿主 disarm（与 shutdown
    // 时 driver 卸载的失活语义一致），避免自动开第 2 轮写进持久日志。
    let disarmedForResume = false;
    first.ctx.on("session/event" as never, ((session: DshSession, event: { type: string }) => {
      if (session !== agent.session || event.type !== "turn/end" || disarmedForResume) return;
      const goal = goalsOf(first.ctx).get(agent);
      if (goal !== undefined && goal.phase === "active" && goal.roundsStarted === 1) {
        goalsOf(first.ctx).disarm(agent);
        disarmedForResume = true;
      }
    }) as never);
    first.adapter.handler = (n) => {
      if (n === 1) {
        return response("冷恢复前半段：建立目标与清单。", [
          { callId: "resume-create", name: "create_goal", args: { objective: "冷恢复验收", max_goal_rounds: 3 } },
          {
            callId: "resume-todo-1",
            name: "todo_write",
            args: { todos: [{ content: "初始清单", status: "in_progress" }] },
          },
        ]);
      }
      if (n === 2) return response("人类轮完成。");
      if (n === 3) {
        return response("目标轮更新清单后暂停推进。", [
          { callId: "resume-todo-2", name: "todo_write", args: { todos: todosAfter } },
        ]);
      }
      if (n === 4) return response("目标轮 1 结束，保持 active。");
      throw new Error(`unexpected request #${n} before resume`);
    };
    agent.followup(userMessage("请建立目标并进入目标轮"));
    await waitFor(() => first.adapter.requests.length >= 4, "resume: pre-resume goal round");
    await agent.whenIdle();
    await sleep(400);
    check(first.adapter.requests.length === 4, `resume: pre-resume requests must be 4, got ${first.adapter.requests.length}`);
    const liveGoal = goalsOf(first.ctx).get(agent);
    check(liveGoal !== undefined, "resume: pre-resume goal missing");
    check(liveGoal.phase === "active" && liveGoal.roundsStarted === 1, "resume: pre-resume state must be active round 1");
    check(disarmedForResume && liveGoal.activation === "disarmed", "resume: probe disarm did not stop automatic round 2");
    goalId = liveGoal.id;
    const todos = projectionState<TodoItem[]>(first.ctx, agent.session, "todos");
    assert.deepEqual(todos, todosAfter, "resume: todo projection before flush mismatch");
    await first.ctx.sessions.flush(agent.session);
  } finally {
    await firstHandle?.dispose();
    await first.dispose();
  }

  const second = await createHost({ engine: "zcode", root: join(root, "sessions"), plan: true, commands: true });
  let secondHandle: AgentHandle | undefined;
  try {
    secondHandle = await second.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: PROVIDER, model: "mock" },
    });
    const agent = secondHandle.agent;
    await sleep(600);
    requireTrue(second.adapter.requests.length === 0, "resume: cold resume must not auto-drive a disarmed goal");
    const resumedGoal = goalsOf(second.ctx).get(agent);
    check(resumedGoal !== undefined, "resume: goal projection did not restore");
    check(resumedGoal.id === goalId, "resume: goal id changed across resume");
    check(resumedGoal.phase === "active", `resume: phase must restore active, got ${resumedGoal.phase}`);
    check(resumedGoal.activation === "disarmed", `resume: resumed goal must be disarmed, got ${resumedGoal.activation}`);
    check(resumedGoal.roundsStarted === 1, `resume: roundsStarted must restore 1, got ${resumedGoal.roundsStarted}`);
    check(resumedGoal.revision === 1, `resume: revision must restore 1, got ${resumedGoal.revision}`);
    assert.deepEqual(
      projectionState<TodoItem[]>(second.ctx, agent.session, "todos"),
      todosAfter,
      "resume: todo projection did not restore",
    );
    const resumedPlan = planLogged(second.ctx, agent.session);
    check(resumedPlan?.active === true, "resume: plan projection did not restore");
    check(resumedPlan.wanted === null && resumedPlan.running === null, "resume: plan projection restored a stray pending selection");
    check(planView(second.ctx, agent).active, "resume: plan service did not restore active");
    console.log("[goal-plan] c.1 ✓ 冷恢复：goal active+disarmed/roundsStarted=1、todo 与 plan 投影恢复，且无自动续轮");

    second.adapter.handler = (n) => {
      if (n === 1) {
        const goal = goalsOf(second.ctx).get(agent);
        check(goal !== undefined, "resume: manual resume turn lost the goal");
        return response("用户要求继续目标。", [
          { callId: "resume-rearm", name: "update_goal", args: { goal_id: goal.id, revision: goal.revision, action: "resume" } },
        ]);
      }
      if (n === 2) return response("目标已恢复。");
      if (n === 3) {
        const goal = goalsOf(second.ctx).get(agent);
        check(goal !== undefined, "resume: goal round lost the goal");
        return response("目标续轮完成。", [
          { callId: "resume-complete", name: "update_goal", args: { goal_id: goal.id, revision: goal.revision, action: "complete" } },
        ]);
      }
      if (n === 4) return response("冷恢复后的目标完成。");
      throw new Error(`unexpected request #${n} after resume (no overreach allowed)`);
    };
    agent.followup(userMessage("请继续这个目标"));
    await waitFor(() => second.adapter.requests.length >= 4, "resume: manual resume + round 2");
    await harness(agent, "resume");
    check(second.adapter.requests.length === 4, `resume: expected exactly 4 requests, got ${second.adapter.requests.length}`);
    const completed = goalsOf(second.ctx).get(agent);
    check(completed !== undefined, "resume: goal vanished after completion");
    check(completed.phase === "complete", `resume: phase must be complete, got ${completed.phase}`);
    check(completed.roundsStarted === 2, `resume: roundsStarted must continue at 2, got ${completed.roundsStarted}`);
    check(completed.revision === 3, `resume: revision must continue 1→2→3, got ${completed.revision}`);
    check(requestJson(second.adapter.requests[0]!).includes(PLAN_SECTION), "resume: restored plan policy missing from request");
    check(requestJson(second.adapter.requests[2]!).includes("<goal_round>"), "resume: round 2 must carry <goal_round>");
    check(requestJson(second.adapter.requests[2]!).includes("Round: 2/3"), "resume: round 2 number must continue from state");
    const sources = goalSources(agent);
    // seed 继承第 1 轮 source；恢复后的新一轮必须是 round=2/revision=2。
    check(sources.length === 2, `resume: expected inherited round 1 plus round 2, got ${JSON.stringify(sources)}`);
    check(sources[0]!.round === 1 && sources[0]!.revision === 1, `resume: inherited source mismatch ${JSON.stringify(sources[0])}`);
    check(sources[1]!.round === 2 && sources[1]!.revision === 2, `resume: continued source mismatch ${JSON.stringify(sources[1])}`);
    console.log("[goal-plan] c.2 ✓ 恢复后手动 resume → round 2/3（revision 2, round=2），最终 complete（revision 3）");
  } finally {
    await secondHandle?.dispose();
    await second.dispose();
  }
}

/** d. fork：子会话折叠父前缀（goal/todo/plan），父子 goal 状态互不污染。 */
async function forkScenario(): Promise<void> {
  const host = await createHost({ engine: "zcode", plan: true, commands: true });
  let parent: AgentHandle | undefined;
  let child: AgentHandle | undefined;
  try {
    parent = await createAgent(host, "goal-plan-fork-parent");
    const parentAgent = parent.agent;
    const entered = await executeCommand(host.ctx, parentAgent, "/plan");
    check(entered.kind === "success", `fork: /plan failed: ${entered.text}`);
    const parentTodos = [
      { content: "父会话清单", status: "in_progress" as const },
      { content: "子会话继承项", status: "pending" as const },
    ];
    const parentRelease = Promise.withResolvers<void>();
    let parentRoundStarted = false;
    let childCount = 0;
    let parentCount = 0;
    let childAgentRef: Agent | undefined;
    const childRequests: GenerateOptions[] = [];

    host.adapter.handler = async (_n, request) => {
      const isChild = String(request.sessionId) === "goal-plan-fork-child";
      if (isChild) {
        childCount += 1;
        childRequests.push(request);
        const goals = goalsOf(host.ctx);
        check(childAgentRef !== undefined, "fork: child request arrived before child publication");
        if (childCount === 1) {
          const goal = goals.get(childAgentRef);
          check(goal !== undefined, "fork: child lost its inherited goal");
          return response("子会话手动恢复继承目标。", [
            { callId: "fork-child-resume", name: "update_goal", args: { goal_id: goal.id, revision: goal.revision, action: "resume" } },
          ]);
        }
        if (childCount === 2) return response("子会话恢复完成。");
        if (childCount === 3) {
          const goal = goals.get(childAgentRef);
          check(goal !== undefined, "fork: child goal round lost the goal");
          return response("子会话目标轮完成。", [
            { callId: "fork-child-complete", name: "update_goal", args: { goal_id: goal.id, revision: goal.revision, action: "complete" } },
          ]);
        }
        if (childCount === 4) return response("子会话目标完成。");
        throw new Error(`fork: unexpected child request #${childCount}`);
      }
      parentCount += 1;
      if (parentCount === 1) {
        return response("父会话建立目标与清单。", [
          { callId: "fork-parent-create", name: "create_goal", args: { objective: "fork 验收", max_goal_rounds: 3 } },
          { callId: "fork-parent-todo", name: "todo_write", args: { todos: parentTodos } },
        ]);
      }
      if (parentCount === 2) return response("父会话人类轮完成。");
      if (parentCount === 3) {
        parentRoundStarted = true;
        await parentRelease.promise;
        const goal = goalsOf(host.ctx).get(parentAgent);
        check(goal !== undefined, "fork: parent lost the goal");
        return response("父会话目标轮完成。", [
          { callId: "fork-parent-complete", name: "update_goal", args: { goal_id: goal.id, revision: goal.revision, action: "complete" } },
        ]);
      }
      if (parentCount === 4) return response("父会话目标完成。");
      throw new Error(`fork: unexpected parent request #${parentCount}`);
    };

    parentAgent.followup(userMessage("PARENT-TURN：建立目标并保持目标轮运行"));
    await waitFor(() => host.adapter.requests.length >= 2, "fork: parent human turn");
    await waitFor(() => parentRoundStarted, "fork: parent goal round in flight");
    const parentGoalBefore = goalsOf(host.ctx).get(parentAgent);
    check(parentGoalBefore !== undefined, "fork: parent goal missing before fork");
    check(parentGoalBefore.roundsStarted === 1 && parentGoalBefore.phase === "active", "fork: parent must be mid goal round 1");

    const events = parentAgent.session.snapshotEvents();
    const boundary = latestCompletedPrefixBoundary(events);
    const seed = buildForkSeed(events, SessionSeq(boundary));
    child = await host.ctx.agents.create({
      sessionId: DshSessionId("goal-plan-fork-child"),
      seed,
      inheritedEventCount: SessionLogOffset(boundary + 1),
      meta: { isSeeded: true, parentSession: parentAgent.id },
      agentOptions: { provider: PROVIDER, model: "mock" },
    });
    const childAgent = child.agent;
    childAgentRef = childAgent;
    await sleep(300);
    requireTrue(childCount === 0, "fork: child must not auto-drive a disarmed inherited goal");
    const childGoal = goalsOf(host.ctx).get(childAgent);
    check(childGoal !== undefined, "fork: child goal projection missing");
    check(childGoal.id === parentGoalBefore.id, "fork: child must inherit the parent's goal id");
    check(childGoal.phase === "active", `fork: child phase must be active, got ${childGoal.phase}`);
    check(childGoal.activation === "disarmed", `fork: child goal must be disarmed, got ${childGoal.activation}`);
    check(childGoal.roundsStarted === 0, `fork: child must inherit pre-round state, got ${childGoal.roundsStarted}`);
    check(childGoal.revision === 1, `fork: child must inherit revision 1, got ${childGoal.revision}`);
    assert.deepEqual(
      projectionState<TodoItem[]>(host.ctx, childAgent.session, "todos"),
      parentTodos,
      "fork: child todo projection must fold the inherited turn",
    );
    const childPlan = planLogged(host.ctx, childAgent.session);
    check(childPlan?.active === true, "fork: child plan projection must fold the inherited plan/mode");
    check(childPlan.wanted === null && childPlan.running === null, "fork: child plan projection inherited a pending selection");
    check(planView(host.ctx, childAgent).active, "fork: child plan service missing active state");
    console.log("[goal-plan] d.1 ✓ fork 子会话继承 goal(id/rev-1/rounds-0)+todo+plan；激活态重新 disarmed");

    childAgent.followup(userMessage("CHILD-TURN：从继承状态继续"));
    await waitFor(() => childCount >= 4, "fork: child resume + round 1");
    await harness(childAgent, "fork-child");
    requireTrue(childCount === 4, `fork: expected exactly 4 child requests, got ${childCount}`);
    const childDone = goalsOf(host.ctx).get(childAgent);
    check(childDone !== undefined, "fork: child goal vanished");
    check(childDone.phase === "complete", `fork: child phase must be complete, got ${childDone.phase}`);
    check(childDone.roundsStarted === 1, `fork: child roundsStarted must be 1, got ${childDone.roundsStarted}`);
    check(childDone.revision === 3, `fork: child revision must be 3 (resume+complete), got ${childDone.revision}`);
    const parentMid = goalsOf(host.ctx).get(parentAgent);
    check(parentMid !== undefined && parentMid.phase === "active" && parentMid.roundsStarted === 1, "fork: child must not mutate parent goal");
    check(
      childRequests.some((request) => requestJson(request).includes("<goal_round>") && requestJson(request).includes("Round: 1/3")),
      "fork: child round must start at 1/3",
    );

    parentRelease.resolve();
    await waitFor(() => parentCount >= 4, "fork: parent goal completion");
    await harness(parentAgent, "fork-parent");
    requireTrue(parentCount === 4, `fork: expected exactly 4 parent requests, got ${parentCount}`);
    const parentDone = goalsOf(host.ctx).get(parentAgent);
    check(parentDone !== undefined && parentDone.phase === "complete", "fork: parent did not complete independently");
    check(parentDone.revision === 2, `fork: parent revision must be 2 (no inherited child changes), got ${parentDone.revision}`);
    check(childDone.revision === 3, "fork: parent completion must not mutate child goal");
    check(sessionOwnsText(childAgent.session, "CHILD-TURN"), "fork: child session lost its own input");
    check(!sessionOwnsText(childAgent.session, "父会话目标轮完成"), "fork: parent round leaked into child session");
    check(!sessionOwnsText(parentAgent.session, "CHILD-TURN"), "fork: child input leaked into parent session");
    check(!sessionOwnsText(parentAgent.session, "子会话目标轮完成"), "fork: child round leaked into parent session");
    console.log("[goal-plan] d.2 ✓ 父子各自续轮/完成（子 rev3、父 rev2），会话与 goal 状态互不污染");
  } finally {
    await child?.dispose();
    await parent?.dispose();
    await host.dispose();
  }
}

/** plan 进入/退出：命令入口、工具可见性、prompt 段、退出后无残留。 */
async function planScenario(): Promise<void> {
  const host = await createHost({ engine: "zcode", plan: true, commands: true });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "goal-plan-mode");
    const agent = handle.agent;
    host.adapter.handler = (n) => {
      if (n === 1) return response("plan 模式下的方案。");
      if (n === 2) return response("默认模式下的回复。");
      if (n === 3) return response("带消息进入 plan 模式的方案。");
      throw new Error(`unexpected plan request #${n}`);
    };

    const entered = await executeCommand(host.ctx, agent, "/plan");
    check(entered.kind === "success" && /Plan mode on/.test(entered.text ?? ""), `plan: /plan failed: ${entered.text}`);
    const activePlan = planLogged(host.ctx, agent.session);
    check(activePlan?.active === true, "plan: /plan projection mismatch");
    check(activePlan.wanted === null && activePlan.running === null, "plan: /plan left a pending selection");
    check(planView(host.ctx, agent).active, "plan: service not active after /plan");
    const planEvents = agent.session.snapshotEvents().filter((event) => event.type === "plan/mode");
    check(planEvents.length === 1 && (planEvents[0]!.data as { active: boolean }).active, "plan: durable plan/mode missing");

    agent.followup(userMessage("PLAN-TURN：先给方案"));
    await waitFor(() => host.adapter.requests.length >= 1, "plan: active request");
    await harness(agent, "plan-active");
    const activeRequest = host.adapter.requests[0]!;
    check(requestJson(activeRequest).includes(PLAN_SECTION), "plan: active request lost plan:policy section");
    check(toolNames(activeRequest).includes("exit_plan_mode"), "plan: exit_plan_mode must stay registered while active");

    const off = await executeCommand(host.ctx, agent, "/plan off");
    check(off.kind === "success", `plan: /plan off failed: ${off.text}`);
    const inactivePlan = planLogged(host.ctx, agent.session);
    check(inactivePlan?.active === false, "plan: /plan off projection mismatch");
    check(inactivePlan.wanted === null && inactivePlan.running === null, "plan: /plan off left a pending selection");
    agent.followup(userMessage("DEFAULT-TURN：退出后回复"));
    await waitFor(() => host.adapter.requests.length >= 2, "plan: inactive request");
    await harness(agent, "plan-inactive");
    const inactiveRequest = host.adapter.requests[1]!;
    check(!requestJson(inactiveRequest).includes(PLAN_SECTION), "plan: plan:policy section leaked after exit");
    check(toolNames(inactiveRequest).includes("exit_plan_mode"), "plan: tool catalog must stay stable after exit");

    const enterWithMessage = await executeCommand(host.ctx, agent, "/plan 请先给出方案");
    check(enterWithMessage.kind === "success", `plan: /plan <message> failed: ${enterWithMessage.text}`);
    await waitFor(() => host.adapter.requests.length >= 3, "plan: entry-with-message request");
    await harness(agent, "plan-enter-message");
    check(host.adapter.requests.length === 3, `plan: expected exactly 3 requests, got ${host.adapter.requests.length}`);
    const messageRequest = host.adapter.requests[2]!;
    check(requestJson(messageRequest).includes(PLAN_SECTION), "plan: /plan <message> did not render policy");
    check(requestJson(messageRequest).includes("请先给出方案"), "plan: /plan <message> did not steer the instruction");
    check(planView(host.ctx, agent).active, "plan: /plan <message> did not activate");
    console.log("[goal-plan] e ✓ /plan、/plan off、/plan <message>：prompt 段进出干净，exit_plan_mode 工具目录稳定");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** 等一个用例稳定：idle + 观察窗，防止误开新轮次（调用方随后断言请求数）。 */
async function harness(agent: Agent, label: string): Promise<void> {
  await waitFor(() => agent.status === "idle", `${label}: idle`);
  await sleep(600);
  check(agent.status === "idle", `${label}: agent not idle`);
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => fail("watchdog: probe did not finish in 120s"), 120000);
  watchdog.unref?.();
  await failureScenario();
  await budgetScenario();
  await abortTwin();
  await coldResumeScenario();
  await forkScenario();
  await planScenario();
  console.log("[goal-plan] PASS: 失败不越权续轮、中止 twin、冷恢复、fork、plan 进入退出、round 预算停止全部绿");
  clearTimeout(watchdog);
  process.exit(0);
}

main().catch((error: unknown) => fail(`unhandled: ${error instanceof Error ? error.stack : String(error)}`));
