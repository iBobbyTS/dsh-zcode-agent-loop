/**
 * S06 集成脚本：dsh goal 工具链（create/update_goal + goal-round-driver 自动
 * 续轮 + todo_write）经桥的端到端验收——host 版（tsx 直跑 src，秒级迭代）。
 *
 * 阶段 8b 的容器 probe（.agent-work/tmp/stage8-goal/goal-probe.mjs，真插件 +
 * mock adapter）验证过同一套断言；勘误后确认 goal 族 0.2.1-alpha.5 在 npm 可
 * 钉版本安装（dist-tag latest 的 0.0.1-rc.1 坏代际只是默认解析的坑），故本
 * 脚本把该验收固化进回归套件。容器 probe 仍保留：验的是部署进 web 的同字节
 * bundle。
 *
 * 场景（4 个 mock 请求，第 5 个即失败）：
 *  R1 人类轮 step1：create_goal(objective, max_goal_rounds=3) + todo_write(2 项)
 *  R2 人类轮 step2：纯文本收口 → turn 1 完成，驱动器 quiescence 续轮
 *  R3 goal 轮 step1：从 goals 服务取当前 goal → update_goal(action:"complete")
 *  R4 goal 轮 step2：纯文本收口 → turn 2 完成，goal complete，不再续轮
 *
 * 断言（与容器 probe 一致）：
 *  1. 恰 4 个请求（续轮真实发生且无第 3 轮）；goals 服务状态 complete。
 *  2. R3 请求携带 <goal_round> 续轮提示（驱动器经 followup 注入成功）。
 *  3. surface source 保真（阶段 8a）：人类轮 source={kind:"user"}；goal 轮
 *     source={kind:"goal", goalId, revision, round:1}。
 *  4. goal 工具零 GOAL_TOOL_* 拒绝（authority：开轮内输入 + withInitiator +
 *     turnBoundary 投影）。
 *  5. turn/start 恰 2 次；todo/write 落盘且含 2 项清单。
 *
 * 装配注意（容器调试踩坑记录）：dsh-tool-* 的 inject 依赖 sessionProjections
 * 服务（dsh-session-projection），缺席则 cordis 挂起插件激活、工具不注册
 * （症状 "Tool not found: create_goal"）——本脚本显式装载。
 */
import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import GoalPlugin from "@deepseek-ai/dsh-goal";
import * as GoalRoundDriver from "@deepseek-ai/dsh-goal-round-driver";
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId as DshToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as ToolGoal from "@deepseek-ai/dsh-tool-goal";
import * as ToolTodo from "@deepseek-ai/dsh-tool-todo";

import ZcodeLoop from "../src/index.js";

function fail(message: string): never {
  console.error(`[s06] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
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

/** goal 剧本 adapter：按请求序号派发；R3 从 goals 服务取当前 goal（勿解析转义 JSON）。 */
class GoalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  /** 由 main 注入：R3 时直接从 goals 服务取当前 goal。 */
  getGoal: () => GoalView | undefined = () => undefined;

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const n = this.requests.length;
    if (n === 1) {
      yield* response("好的：先创建目标并写入任务清单。", [
        { callId: "call-goal-create", name: "create_goal", args: { objective: "完成S06验收", max_goal_rounds: 3 } },
        {
          callId: "call-todo-1",
          name: "todo_write",
          args: {
            todos: [
              { content: "创建目标", status: "in_progress" },
              { content: "完成目标", status: "pending" },
            ],
          },
        },
      ]);
      return;
    }
    if (n === 2) {
      yield* response("第一轮完成：目标已创建，任务清单已写入。");
      return;
    }
    if (n === 3) {
      const goal = this.getGoal();
      if (goal === undefined) {
        throw new Error("round-2 request arrived but no live goal found in goals service");
      }
      yield* response("目标续轮：读取到当前目标，现在标记完成。", [
        { callId: "call-goal-complete", name: "update_goal", args: { goal_id: goal.id, revision: goal.revision, action: "complete" } },
      ]);
      return;
    }
    if (n === 4) {
      yield* response("目标已完成，不再续轮。");
      return;
    }
    throw new Error(`unexpected request #${n} (round 3 must not fire)`);
  }
}

interface GoalView {
  id: string;
  revision: number;
  phase: string;
  roundsStarted: number;
  maxGoalRounds: number;
}

interface GoalMessageSource {
  kind: "goal";
  goalId: string;
  revision: number;
  round: number;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`timeout waiting for ${what}`);
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => fail("watchdog: probe did not finish in 60s"), 60000);
  watchdog.unref?.();

  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  // sessionProjections 服务必须先于 tool-goal/todo 在场（inject 语义）。
  // 这两个包的 Config 推断把 config 参数推成 undefined——不传即可。
  await ctx.plugin(SessionProjection);
  await ctx.plugin(GoalPlugin, {});
  await ctx.plugin(GoalRoundDriver);
  // namespace 导出（无 default）的 Config 推断不进 cordis 泛型：cast 成
  // Plugin.Object 带显式 config 类型（运行时 apply 形状等价）。
  await ctx.plugin(ToolTodo as unknown as Plugin.Object<{ allowParallelInProgress: boolean }>, {
    allowParallelInProgress: true,
  });
  await ctx.plugin(ToolGoal as unknown as Plugin);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ZcodeLoop, { provider: "mock", model: "mock" });

  const adapter = new GoalAdapter();
  ctx.llm.registerAdapter(["mock"], adapter);

  const sessionId = DshSessionId("s6-goal-probe");
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: "mock", model: "mock" },
  });
  const agent: Agent = handle.agent;
  const goals = ctx.get("goals") as unknown as { get(agent: Agent): GoalView | undefined };
  adapter.getGoal = () => goals.get(agent);

  // ---- 人类轮：create_goal + todo_write → 驱动器自动续轮 ----
  agent.followup(
    createUserMessage({ content: [{ type: "text", text: "请建立目标并推进到完成" }], source: { kind: "user" } }),
  );
  await waitFor(() => adapter.requests.length >= 2, "turn-1 model requests");
  await agent.whenIdle();
  await waitFor(() => adapter.requests.length >= 3, "goal round 2 to be queued and claimed", 20000);
  await waitFor(() => adapter.requests.length >= 4, "turn-2 second model request");
  await agent.whenIdle();
  // 稳定窗口：若误开第 3 轮，adapter 第 5 次调用即抛错
  await new Promise((resolve) => setTimeout(resolve, 800));

  // ---- 断言 1：恰 4 请求 + goal complete ----
  assert(adapter.requests.length === 4, `expected exactly 4 model requests, got ${adapter.requests.length}`);
  const goal = goals.get(agent);
  assert(goal !== undefined, "goal must exist after create_goal");
  assert(goal.phase === "complete", `goal phase must be complete, got ${goal?.phase}`);
  console.log(`[s06] 断言1 ✓ 4 请求（人类轮 2 + goal 轮 2），goal ${goal.id} phase=complete`);

  // ---- 断言 2：goal 轮请求携带 <goal_round> ----
  const round2Json = JSON.stringify(adapter.requests[2]!.messages ?? []);
  assert(round2Json.includes("<goal_round>"), `round-2 request must carry goal_round prompt, got: ${round2Json.slice(0, 400)}`);
  console.log("[s06] 断言2 ✓ goal 轮请求携带 <goal_round> 续轮提示");

  // ---- 断言 3：surface source 保真 ----
  const events = agent.session.snapshotEvents();
  const userMessages = events.filter((event) => event.type === "user/message");
  const humanMessages = userMessages.filter((event) => (event.data as { source?: { kind?: string } }).source?.kind === "user");
  const goalMessages = userMessages.filter(
    (event) => (event.data as { source?: { kind?: string } }).source?.kind === "goal",
  );
  assert(humanMessages.length === 1, `expected 1 human user/message, got ${humanMessages.length}`);
  assert(goalMessages.length === 1, `expected 1 goal user/message, got ${goalMessages.length} (source fidelity broken?)`);
  const goalSource = (goalMessages[0]!.data as { source: GoalMessageSource }).source;
  assert(goalSource.goalId === goal.id, `goal source goalId mismatch: ${goalSource.goalId} vs ${goal.id}`);
  assert(goalSource.round === 1, `goal source round must be 1, got ${goalSource.round}`);
  assert(Number.isInteger(goalSource.revision) && goalSource.revision >= 1, `goal source revision invalid: ${goalSource.revision}`);
  console.log(`[s06] 断言3 ✓ 人类轮 source=user；goal 轮 source=goal{goalId, revision=${goalSource.revision}, round=1}`);

  // ---- 断言 4：goal 工具零 authority 拒绝 ----
  const toolEventsJson = JSON.stringify(events.filter((event) => event.type.startsWith("tool/")));
  assert(!toolEventsJson.includes("GOAL_TOOL_"), `goal tools rejected by authority checks: ${toolEventsJson.slice(0, 800)}`);
  assert(toolEventsJson.includes(goal.id), "create_goal result must reach the durable surface");
  console.log("[s06] 断言4 ✓ create_goal/update_goal 无 GOAL_TOOL_* 拒绝，结果落 surface");

  // ---- 断言 5：turn 计数 + todo ----
  const turnStarts = events.filter((event) => event.type === "turn/start");
  assert(turnStarts.length === 2, `expected exactly 2 turn/start, got ${turnStarts.length}`);
  const todoWrites = events.filter((event) => event.type === "todo/write");
  assert(todoWrites.length === 1, `expected 1 todo/write, got ${todoWrites.length}`);
  const todos = (todoWrites[0]!.data as { todos: Array<{ content: string }> }).todos;
  assert(
    Array.isArray(todos) && todos.length === 2 && todos[0]!.content === "创建目标",
    `todo list mismatch: ${JSON.stringify(todos)}`,
  );
  console.log("[s06] 断言5 ✓ turn/start ×2；todo/write 落盘 2 项清单");

  console.log("[s06] PASS: goal 续轮 + todo_write + source 保真 + authority 全部断言绿");
  clearTimeout(watchdog);
  process.exit(0);
}

main().catch((error: unknown) => fail(`unhandled: ${error instanceof Error ? error.stack : String(error)}`));
