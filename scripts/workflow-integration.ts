/**
 * dsh workflow（PTC）集成探针。
 *
 * 语义口径来自钉版插件源码（node_modules 0.2.1-alpha.5）与 reference 快照：
 * - workflow-ptc：`ctx.workflowEngine.start` 在 Node PTC 进程里执行脚本；
 *   `agent()` 经 `ctx.subagents.startActivation` 启动子级（delivery="caller"），
 *   每个子级都是 continuable catalog 成员；普通子级失败（stopReason≠completed）
 *   解析为 `null`，子级 result 拒绝才是 fatal AGENT_RESULT。
 * - 运行结束时引擎 dispose 全部子级；本地子级按 manager 语义以 cause
 *   kind="parent" 结算，`delivery="caller"` 不向父模型投递 settlement notice。
 * - tool-workflow：前台调用把 `exec.signal` 桥到 `run.cancel()`；完成后在父
 *   session 落 `tool-workflow/run-start|agent-start|agent-end|run-end` 四个
 *   log-only 记录；phase/log 只有 `workflow/*` 事件面，不落盘。
 * - 子级 provider/model 选项原样进入 dsh agentOptions（现有 llm 路由），
 *   outputSchema 走 subagent 的 structured_output 机制。
 *
 * 宿主按插件真实最小契约装配：fs + subprocess + sandbox + sandboxPolicy +
 * ptcRuntime + workingDirectory + subagents。探针使用 danger-full-access
 * 以复用 T11 的进程内子级路径；未在此验证 read-only/workspace-write 的
 * 文件收敛，报告如实记录。
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
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import NodePtcRuntime from "@deepseek-ai/dsh-ptc-runtime-node";
import SandboxLocal from "@deepseek-ai/dsh-sandbox-local";
import SandboxPolicy from "@deepseek-ai/dsh-sandbox-policy";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SqliteSessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import SubagentRuntime from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import SubprocessLocal from "@deepseek-ai/dsh-subprocess-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import * as ToolWorkflow from "@deepseek-ai/dsh-tool-workflow";
import PtcWorkflowEngine from "@deepseek-ai/dsh-workflow-ptc";
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowResultInfo,
  WorkflowRunInfo,
} from "@deepseek-ai/dsh-workflow";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";

import ZcodeLoop, { ZcodeLoopAgent } from "../src/index.js";

const PROVIDER = "mock";
/** 临时 workspace/JSONL 全部放系统临时目录，探针不污染仓库工作区。 */
const EVIDENCE_ROOT = join(tmpdir(), "dsh-workflow");

function fail(message: string): never {
  console.error(`[workflow] FAIL: ${message}`);
  process.exit(1);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30000): Promise<void> {
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
  private readonly handlers = new Map<string, Handler>();
  private readonly counts = new Map<string, number>();
  private fallback: Handler | undefined;

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  on(sessionId: string, handler: Handler): void {
    this.handlers.set(sessionId, handler);
  }

  /** 非显式注册的会话（workflow 子级的随机 id）走此 handler。 */
  onOther(handler: Handler): void {
    this.fallback = handler;
  }

  count(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
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
  release(): void;
  callCount(): number;
}

/** 可挂起并随 exec.signal 拒绝的工具；用于取消场景。 */
function createHoldTool(): { tool: ReturnType<typeof defineTool>; hold: Hold } {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const tool = defineTool({
    name: "hold",
    description: "Hold the current step until the probe releases it.",
    parameters: {
      marker: { type: "string", description: "probe marker" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { released: { type: "boolean", required: true } },
      },
      render: () => [{ type: "text", text: "hold released" }],
    },
    async execute(_args, exec) {
      calls += 1;
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
  return { tool, hold: { release: () => gate.resolve(), callCount: () => calls } };
}

interface WorkflowEvents {
  starts: WorkflowRunInfo[];
  phases: string[];
  logs: string[];
  agentStarts: WorkflowAgentInfo[];
  agentEnds: WorkflowAgentEndInfo[];
  ends: Array<{ info: WorkflowRunInfo; result: WorkflowResultInfo }>;
  order: string[];
}

function captureWorkflowEvents(ctx: Context): WorkflowEvents {
  const events: WorkflowEvents = {
    starts: [],
    phases: [],
    logs: [],
    agentStarts: [],
    agentEnds: [],
    ends: [],
    order: [],
  };
  ctx.on("workflow/start", (info) => {
    events.starts.push(info);
    events.order.push("start");
  });
  ctx.on("workflow/phase", (_info, title) => {
    events.phases.push(title);
    events.order.push("phase");
  });
  ctx.on("workflow/log", (_info, message) => {
    events.logs.push(message);
    events.order.push("log");
  });
  ctx.on("workflow/agent-start", (_info, agent) => {
    events.agentStarts.push(agent);
    events.order.push("agent-start");
  });
  ctx.on("workflow/agent-end", (_info, agent) => {
    events.agentEnds.push(agent);
    events.order.push("agent-end");
  });
  ctx.on("workflow/end", (info, result) => {
    events.ends.push({ info, result });
    events.order.push("end");
  });
  return events;
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
  const workspace = realpathSync(
    options.workspace ?? resolve(mkdtempSync(join(EVIDENCE_ROOT, "workflow-workspace-"))),
  );
  const root = options.root ?? resolve(mkdtempSync(join(EVIDENCE_ROOT, "workflow-sessions-")));
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
  // workflow 的真实最小执行宿主：PTC Node runtime 需要 fs/subprocess/sandbox/sandboxPolicy。
  await ctx.plugin(SandboxPolicy, { mode: "danger-full-access", workspaceRoot: workspace });
  await ctx.plugin(SandboxLocal as unknown as Plugin);
  await ctx.plugin(SubprocessLocal as unknown as Plugin);
  await ctx.plugin(NodePtcRuntime as unknown as Plugin, { graceMs: 100 });
  await ctx.plugin(PtcWorkflowEngine as unknown as Plugin, {});
  await ctx.plugin(
    ToolWorkflow as unknown as Plugin.Object<{ enableRunInBackground: boolean }>,
    { enableRunInBackground: false },
  );
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

function requestText(request: GenerateOptions): string {
  return JSON.stringify(request.messages);
}

function eventsText(agent: Agent): string {
  return JSON.stringify(agent.session.snapshotEvents());
}

function toolNames(request: GenerateOptions): string[] {
  return (request.tools ?? []).map((tool) => (tool as { name: string }).name);
}

function sessionEvents(agent: Agent, type: string): Array<{ seq: number; data: unknown }> {
  // 参数取 string：tool-workflow 的 SessionEventMap 扩增依赖 peer 实例同一性，
  // 探针只按事件名读取结构化数据，不依赖类型表。
  return agent.session
    .snapshotEvents()
    .filter((event) => event.type === type)
    .map((event) => ({ seq: event.seq, data: (event as { data: unknown }).data }));
}

function latestTurnEnd(agent: Agent): { kind?: string; reason?: { kind?: string } } {
  const event = agent.session.snapshotEvents().filter((candidate) => candidate.type === "turn/end").at(-1) as
    | { data: { reason: { kind?: string; reason?: { kind?: string } } } }
    | undefined;
  check(event !== undefined, `session ${agent.id} has no turn/end`);
  return event.data.reason;
}

function turnBalanced(agent: Agent): boolean {
  const events = agent.session.snapshotEvents();
  return (
    events.filter((event) => event.type === "turn/start").length ===
    events.filter((event) => event.type === "turn/end").length
  );
}

/** 等待一个 agent 的请求稳定：idle 后留观察窗，防止 extra step 被误计入。 */
async function settle(agent: Agent, label: string): Promise<void> {
  await waitFor(() => agent.status === "idle", `${label}: idle`);
  await sleep(300);
  check(agent.status === "idle", `${label}: agent not idle`);
}

function workflowCall(callId: string, script: string): ScriptedCall {
  return {
    callId,
    name: "workflow",
    args: {
      meta: {
        name: "probe-workflow",
        description: "probe fan-out",
        phases: [{ title: "Review" }],
      },
      script,
    },
  };
}

/**
 * a. 真实扇出与汇总；d. 进度/作用域；外加完成后的子会话续聊。
 */
async function fanoutScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "workflow-fanout-parent");
    const parent = parentHandle.agent;
    const events = captureWorkflowEvents(host.ctx);
    const childIds = new Set<string>();
    const childAgents = new Map<string, Agent>();
    const childPrompts = new Map<string, "A" | "B">();
    const childRequests = new Map<string, number>();
    let parentSawResult = "";
    const bothStarted = Promise.withResolvers<void>();
    let started = 0;

    host.adapter.on(parent.id, async (request, count) => {
      if (count === 1) {
        return response(
          "running the review workflow",
          [
            workflowCall(
              "fanout-call",
              `phase('Review')
log('fan-out started')
const results = await parallel([
  () => agent('CHILD-A-PROMPT: review alpha'),
  () => agent('CHILD-B-PROMPT: review beta'),
])
return { results }`,
            ),
          ],
        );
      }
      parentSawResult = requestText(request);
      return response("parent observed the aggregated workflow result");
    });
    host.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      check(sessionId !== parent.id, "fanout: child request must use a distinct session");
      if (!childIds.has(sessionId)) {
        childIds.add(sessionId);
        const agent = host.ctx.agents.get(DshSessionId(sessionId));
        check(agent !== undefined, "fanout: child agent must be live while it runs");
        childAgents.set(sessionId, agent);
      }
      childRequests.set(sessionId, count);
      const text = requestText(request);
      check(text.includes("You are a delegated subagent"), "fanout: child must carry the delegation scope");
      check(!text.includes("FANOUT-PARENT-PREFIX"), "fanout: fresh child must not inherit parent context");
      let marker: "A" | "B";
      if (text.includes("CHILD-A-PROMPT")) marker = "A";
      else if (text.includes("CHILD-B-PROMPT")) marker = "B";
      else fail(`fanout: unexpected child prompt on ${sessionId}`);
      childPrompts.set(sessionId, marker);
      started += 1;
      if (started === 2) bothStarted.resolve();
      // 两个子级都进入模型请求后才放行，证明真实并发而非串行复用。
      await bothStarted.promise;
      if (marker === "B") await sleep(50);
      return response(`CHILD-${marker}-RESULT`);
    });

    parent.followup(userMessage("FANOUT-PARENT-PREFIX: run the workflow"));
    await waitFor(() => childIds.size === 2, "fanout: two children");
    await bothStarted.promise;
    await settle(parent, "fanout-parent");

    check(childIds.size === 2, `fanout: expected 2 children, got ${childIds.size}`);
    check(events.starts.length === 1, "fanout: expected one workflow/start");
    check(events.starts[0]!.meta.name === "probe-workflow", "fanout: meta name was not preserved");
    check(events.phases.includes("Review"), "fanout: phase() did not reach workflow/phase");
    check(events.logs.includes("fan-out started"), "fanout: log() did not reach workflow/log");
    check(events.agentStarts.length === 2, "fanout: expected two workflow/agent-start");
    check(events.agentEnds.length === 2, "fanout: expected two workflow/agent-end");
    check(
      events.agentStarts.every((agent) => childIds.has(String(agent.childId))),
      "fanout: agent-start child ids must match the live child sessions",
    );
    check(
      events.agentEnds.every((agent) => agent.outcome === "completed"),
      "fanout: both children must settle completed",
    );
    check(events.ends.length === 1, "fanout: expected one workflow/end");
    check(events.ends[0]!.result.stopReason === "completed", "fanout: workflow must complete");
    check(events.ends[0]!.result.agentsStarted === 2, "fanout: agentsStarted must be 2");
    check(
      events.order[0] === "start" && events.order[1] === "phase" && events.order[2] === "log",
      `fanout: lifecycle order mismatch (${events.order.slice(0, 4).join(",")})`,
    );
    check(events.order.at(-1) === "end", "fanout: workflow/end must be last");

    // 汇总回父会话：tool result 渲染包含运行身份、子级数量与两个结果，且保持 parallel 顺序。
    check(parentSawResult.includes("probe-workflow"), "fanout: parent request lost the workflow name");
    check(parentSawResult.includes("completed (2 agents)"), "fanout: parent request lost the completion envelope");
    const resultA = parentSawResult.indexOf("CHILD-A-RESULT");
    const resultB = parentSawResult.indexOf("CHILD-B-RESULT");
    check(resultA >= 0 && resultB >= 0, "fanout: both child results must reach the parent turn");
    check(resultA < resultB, "fanout: parallel results must preserve input order");

    // 子级身份与作用域：同一 ZcodeLoop 工厂、父链接、非 seeded、cwd/depth 不扩权。
    for (const [sessionId, child] of childAgents) {
      check(child instanceof ZcodeLoopAgent, `fanout: child ${sessionId} must use the ZcodeLoop factory`);
      check(child.session.header.parentSession === parent.id, "fanout: child must record its parent session");
      check(child.session.header.origin === "subagent", "fanout: child must carry the subagent origin");
      check(child.session.header.isSeeded === false, "fanout: workflow child is fresh, not seeded");
      check(child.session.header.cwd === host.workspace, "fanout: child cwd must stay in the parent workspace");
      check(child.session.header.delegationDepth === 1, "fanout: child delegation depth must be parent + 1");
    }
    const catalog = sessionEvents(parent, "subagent/catalog").map(
      (event) => event.data as { childId?: string; mode?: string },
    );
    check(catalog.length === 2, `fanout: expected two catalog entries, got ${catalog.length}`);
    check(catalog.every((entry) => entry.mode === "continuable"), "fanout: workflow children must stay continuable");
    check(
      catalog.every((entry) => entry.childId !== undefined && childIds.has(String(entry.childId))),
      "fanout: catalog entries must name the workflow children",
    );

    // d. 进度按插件实际形态进父会话：workflow/* 事件 + 四条 log-only 记录；phase/log 不落盘。
    const parentTypes: string[] = parent.session.snapshotEvents().map((event) => event.type);
    const runStart = parentTypes.indexOf("tool-workflow/run-start");
    const firstAgentStart = parentTypes.indexOf("tool-workflow/agent-start");
    const lastAgentEnd = parentTypes.lastIndexOf("tool-workflow/agent-end");
    const runEnd = parentTypes.indexOf("tool-workflow/run-end");
    check(runStart >= 0 && firstAgentStart > runStart, "progress: run-start must precede member start");
    check(lastAgentEnd > firstAgentStart, "progress: member end must follow member start");
    check(runEnd > lastAgentEnd, "progress: run-end must follow every member");
    check(
      sessionEvents(parent, "tool-workflow/agent-start").length === 2 &&
        sessionEvents(parent, "tool-workflow/agent-end").length === 2,
      "progress: parent session must record both members",
    );
    const runEndData = sessionEvents(parent, "tool-workflow/run-end")[0]?.data as
      | { runId?: string; stopReason?: string }
      | undefined;
    check(runEndData?.stopReason === "completed", "progress: durable run-end must record completion");
    check(
      events.starts[0] !== undefined && String(runEndData.runId) === String(events.starts[0].id),
      "progress: durable run id must match the live run id",
    );
    check(
      !parent.session
        .snapshotEvents()
        .some(
          (event) =>
            event.type === "user/message" &&
            (event.data as { source?: { kind?: string } }).source?.kind === "subagent-settled",
        ),
      "progress: workflow children must not post settlement notices into the parent model",
    );
    console.log(
      "[workflow] a ✓ 模型经 workflow 工具扇出 2 个 ZcodeLoopAgent 子级，并发/顺序聚合回父会话",
    );
    console.log("[workflow] d ✓ phase/log 走 workflow/* 事件面，成员生命周期落父 session 记录，作用域不扩权");

    // a 续：父完成且子级已 dispose 后，子会话仍可从 JSONL 冷恢复并独立续聊。
    const childIdA = [...childIds].find((sessionId) => childPrompts.get(sessionId) === "A");
    check(childIdA !== undefined, "fanout: could not identify child A");
    check(host.ctx.agents.get(DshSessionId(childIdA)) === undefined, "fanout: child must be disposed after the run");

    let continued = false;
    host.adapter.on(childIdA, async (request) => {
      const text = requestText(request);
      check(text.includes("CHILD-A-PROMPT"), "continuation: child history lost its original prompt");
      check(text.includes("CHILD-A-CONTINUE"), "continuation: child did not receive the new turn input");
      continued = true;
      return response("CHILD-A-CONTINUED");
    });
    const resumedHandle = await host.ctx.agents.resume({
      resumeSessionId: DshSessionId(childIdA),
      parentAgent: parent,
      agentOptions: { provider: PROVIDER, model: "mock" },
    });
    try {
      check(
        resumedHandle.agent instanceof ZcodeLoopAgent,
        "continuation: resumed child must use the ZcodeLoop factory",
      );
      check(
        resumedHandle.agent.session.header.parentSession === parent.id,
        "continuation: parent link changed across resume",
      );
      resumedHandle.agent.followup(userMessage("CHILD-A-CONTINUE"));
      await waitFor(() => continued, "continuation: child model request");
      await settle(resumedHandle.agent, "continuation-child");
      check(
        eventsText(resumedHandle.agent).includes("CHILD-A-CONTINUED"),
        "continuation: child did not persist the continued turn",
      );
    } finally {
      await resumedHandle.dispose();
    }
    console.log("[workflow] a.2 ✓ 运行结束后子会话可独立冷恢复续聊，父链接保持");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

/** b. 普通子级失败按插件语义解析 null；workflow 完成且无悬挂子会话/turn。 */
async function failureScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "workflow-failure-parent");
    const parent = parentHandle.agent;
    const events = captureWorkflowEvents(host.ctx);
    const childAgents = new Map<string, Agent>();
    const childRequests = new Map<string, number>();
    let parentSawResult = "";

    host.adapter.on(parent.id, async (request, count) => {
      if (count === 1) {
        return response("running the failure workflow", [
          workflowCall(
            "failure-call",
            `return await parallel([
  () => agent('CHILD-OK-PROMPT: succeed'),
  () => agent('CHILD-FAIL-PROMPT: fail'),
])`,
          ),
        ]);
      }
      parentSawResult = requestText(request);
      return response("parent observed the failure result");
    });
    host.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      if (!childAgents.has(sessionId)) {
        const agent = host.ctx.agents.get(DshSessionId(sessionId));
        check(agent !== undefined, "failure: child agent must be live while it runs");
        childAgents.set(sessionId, agent);
      }
      childRequests.set(sessionId, count);
      const text = requestText(request);
      if (text.includes("CHILD-FAIL-PROMPT")) throw new Error("scripted adapter failure for CHILD-FAIL");
      check(text.includes("CHILD-OK-PROMPT"), "failure: unexpected child prompt");
      return response("CHILD-OK-RESULT");
    });

    parent.followup(userMessage("FAILURE-PARENT: run the workflow"));
    await waitFor(() => childAgents.size === 2, "failure: two children");
    await settle(parent, "failure-parent");

    check(events.ends.length === 1, "failure: expected one workflow/end");
    check(events.ends[0]!.result.stopReason === "completed", "failure: an ordinary child failure must not fail the run");
    check(events.ends[0]!.result.agentsStarted === 2, "failure: agentsStarted must be 2");
    check(
      events.agentEnds.some((agent) => agent.outcome === "completed") &&
        events.agentEnds.some((agent) => agent.outcome === "failed"),
      `failure: agent outcomes must be completed+failed, got ${events.agentEnds.map((agent) => agent.outcome).join(",")}`,
    );
    check(parentSawResult.includes("CHILD-OK-RESULT"), "failure: successful child result must reach the parent");
    check(parentSawResult.includes("null"), "failure: failed child must reach the script as null");
    check(
      sessionEvents(parent, "tool-workflow/run-end")[0]?.data !== undefined &&
        (sessionEvents(parent, "tool-workflow/run-end")[0]!.data as { stopReason?: string }).stopReason === "completed",
      "failure: durable run-end must record completion",
    );

    for (const [sessionId, child] of childAgents) {
      check(turnBalanced(child), `failure: child ${sessionId} left an unbalanced turn`);
      check(child.status === "idle", `failure: child ${sessionId} must be idle after disposal`);
      check(host.ctx.agents.get(DshSessionId(sessionId)) === undefined, "failure: no child agent may remain live");
      const end = latestTurnEnd(child);
      if (childRequests.get(sessionId) === 1) {
        // 失败子级：adapter 抛错收口为 error turn；成功子级为 completed。
        check(
          end.kind === "completed" || end.kind === "error",
          `failure: unexpected child turn end ${String(end.kind)}`,
        );
      }
    }
    const failed = [...childAgents].find(([sessionId]) =>
      eventsText(childAgents.get(sessionId)!).includes("CHILD-FAIL-PROMPT"),
    );
    check(failed !== undefined, "failure: failed child session not identified");
    check(latestTurnEnd(failed[1]).kind === "error", "failure: failed child turn must settle as error");
    check(turnBalanced(parent), "failure: parent left an unbalanced turn");
    console.log("[workflow] b ✓ 子级 adapter 失败按语义变 null，run 正常完成，子级/turn 全部收口");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

/** c. 父取消 → workflow cancelled，子级 aborted(parent)，无重做副作用。 */
async function cancelScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "workflow-cancel-parent");
    const parent = parentHandle.agent;
    const events = captureWorkflowEvents(host.ctx);
    const childAgents = new Map<string, Agent>();
    const childRequests = new Map<string, number>();

    host.adapter.on(parent.id, async (_request, count) => {
      if (count === 1) {
        return response("starting a blocking workflow", [
          workflowCall(
            "cancel-call",
            `return await parallel([
  () => agent('CANCEL-CHILD-A: hold'),
  () => agent('CANCEL-CHILD-B: hold'),
])`,
          ),
        ]);
      }
      return response("parent step after cancellation");
    });
    host.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      if (!childAgents.has(sessionId)) {
        const agent = host.ctx.agents.get(DshSessionId(sessionId));
        check(agent !== undefined, "cancel: child agent must be live while it runs");
        childAgents.set(sessionId, agent);
      }
      childRequests.set(sessionId, count);
      const text = requestText(request);
      check(text.includes("CANCEL-CHILD-"), "cancel: unexpected child prompt");
      return response("", [{ callId: `cancel-hold-${sessionId}`, name: "hold", args: { marker: "cancel" } }]);
    });

    parent.followup(userMessage("CANCEL-PARENT: run the workflow"));
    await waitFor(() => childAgents.size === 2, "cancel: two children");
    await waitFor(() => host.hold.callCount() === 2, "cancel: both children parked in hold");
    parent.cancel({ kind: "user" });
    await settle(parent, "cancel-parent");

    const parentEnd = latestTurnEnd(parent);
    check(parentEnd.kind === "aborted", `cancel: parent turn must abort, got ${String(parentEnd.kind)}`);
    check(parentEnd.reason?.kind === "user", `cancel: parent abort cause must be user, got ${String(parentEnd.reason?.kind)}`);
    check(events.ends.length === 1, "cancel: expected one workflow/end");
    check(events.ends[0]!.result.stopReason === "cancelled", "cancel: workflow must settle cancelled");
    // 取消竞态下子级自己的 result 可能先按 aborted 结算，workflow 层因此把该次
    // agent() 记为 failed（源码只把 completed 记为 completed）；已发布但未结算的
    // 子级由 settle-reap 合成 cancelled。两者都不是 completed。
    check(events.agentEnds.length === 2, `cancel: expected two agent-end, got ${events.agentEnds.length}`);
    check(
      events.agentEnds.every((agent) => agent.outcome === "cancelled" || agent.outcome === "failed"),
      `cancel: no child may settle completed (${events.agentEnds.map((agent) => agent.outcome).join(",")})`,
    );
    check(turnBalanced(parent), "cancel: parent left an unbalanced turn");
    const durableEnd = sessionEvents(parent, "tool-workflow/run-end")[0]?.data as { stopReason?: string } | undefined;
    check(durableEnd?.stopReason === "cancelled", "cancel: durable run-end must record cancellation");

    for (const [sessionId, child] of childAgents) {
      const end = latestTurnEnd(child);
      check(end.kind === "aborted", `cancel: child turn must abort, got ${String(end.kind)}`);
      check(end.reason?.kind === "parent", `cancel: child abort cause must be parent, got ${String(end.reason?.kind)}`);
      check(childRequests.get(sessionId) === 1, `cancel: child must not retry after abort (${sessionId})`);
      check(turnBalanced(child), `cancel: child ${sessionId} left an unbalanced turn`);
      check(host.ctx.agents.get(DshSessionId(sessionId)) === undefined, "cancel: no child agent may remain live");
    }
    check(host.hold.callCount() === 2, `cancel: hold must not re-execute, got ${host.hold.callCount()} calls`);
    check(!eventsText(parent).includes("CANCEL-CHILD-OK"), "cancel: aborted children must not fabricate completion");
    console.log("[workflow] c ✓ 父取消收口 workflow=cancelled，子级 aborted(parent)，副作用不重做");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

/** e. 结构化交付与模型选择走现有 dsh 机制（outputSchema + agentOptions.model）。 */
async function structuredScenario(): Promise<void> {
  const host = await createHost();
  let parentHandle: AgentHandle | undefined;
  try {
    parentHandle = await createAgent(host, "workflow-structured-parent");
    const parent = parentHandle.agent;
    const events = captureWorkflowEvents(host.ctx);
    let childId = "";
    let childRequests = 0;
    let parentSawResult = "";
    let modelOverrideSeen = false;

    host.adapter.on(parent.id, async (request, count) => {
      if (count === 1) {
        return response("running the structured workflow", [
          workflowCall(
            "structured-call",
            `return await agent('STRUCTURED-CHILD-PROMPT: judge', {
  model: 'mock-structured',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { verdict: { type: 'string' }, confidence: { type: 'number' } },
    required: ['verdict', 'confidence'],
  },
})`,
          ),
        ]);
      }
      parentSawResult = requestText(request);
      return response("parent observed the structured result");
    });
    host.adapter.onOther(async (request, count) => {
      const sessionId = String(request.sessionId);
      if (childId === "") childId = sessionId;
      check(sessionId === childId, "structured: unexpected child session");
      childRequests = count;
      check(request.model === "mock-structured", `structured: model override lost, got ${String(request.model)}`);
      modelOverrideSeen = true;
      if (count === 1) {
        check(
          toolNames(request).includes("structured_output"),
          "structured: outputSchema must expose the dsh structured_output tool",
        );
        return response("", [
          {
            callId: "structured-call",
            name: "structured_output",
            args: { verdict: "ok", confidence: 0.9 },
          },
        ]);
      }
      return response("structured answer submitted");
    });

    parent.followup(userMessage("STRUCTURED-PARENT: run the workflow"));
    await waitFor(() => parentSawResult !== "", "structured: parent tool result");
    await settle(parent, "structured-parent");

    check(childId !== "", "structured: child was not observed");
    check(childRequests === 2, `structured: expected two child requests, got ${childRequests}`);
    check(modelOverrideSeen, "structured: per-child model override was not observed");
    check(events.ends.length === 1 && events.ends[0]!.result.stopReason === "completed", "structured: run must complete");
    check(
      events.agentEnds.length === 1 && events.agentEnds[0]!.outcome === "completed",
      "structured: schema child must settle completed",
    );
    for (const needle of ["verdict", "ok", "confidence", "0.9"]) {
      check(parentSawResult.includes(needle), `structured: parent result lost "${needle}"`);
    }
    console.log("[workflow] e ✓ outputSchema 经 dsh structured_output 交付，model 选项经 agentOptions 路由");
  } finally {
    await parentHandle?.dispose();
    await host.dispose();
  }
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const watchdog = setTimeout(() => fail("watchdog: probe did not finish in 300s"), 300000);
  watchdog.unref?.();
  try {
    await fanoutScenario();
    await failureScenario();
    await cancelScenario();
    await structuredScenario();
  } finally {
    rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
  }
  console.log("[workflow] PASS: 扇出/汇总/失败/取消/进度/作用域/结构化全部绿");
  clearTimeout(watchdog);
  process.exit(0);
}

main().catch((error: unknown) => fail(`unhandled: ${error instanceof Error ? error.stack : String(error)}`));
