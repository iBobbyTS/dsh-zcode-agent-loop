/**
 * dsh jobs / schedule / off-peak 集成探针。
 *
 * 语义口径来自钉版插件源码（node_modules 0.2.1-alpha.5）：
 * - schedule：Host 级 durable 任务；投递经 `sessionController.resolveAgent` 解析
 *   原 Session，`agent.followup` 进入 inbox，`ctx.sessions.flush` 确认后才提交
 *   receipt/下次目标（`source.kind = "schedule"`）。重启后由 storageDomain 重开
 *   任务表，到期时恢复原 Session 再投递。
 * - jobs-local：进程内注册表，owner 按 Session id 隔离；完成事件只广播一次；
 *   进程退出后记录与输出环不跨重启。
 * - tool-jobs：`job_output`/`job_list`/`job_kill` + 完成通知（busy → next-step
 *   inject，idle → followup 唤醒；已 awaited/teardown/model-kill 不通知）。
 * - tool-workflow `run_in_background: true`：工作流注册为 workflow job，主 turn
 *   立即返回；完成结果随 job result 交付一次。
 * - off-peak：本仓命令层；本地时窗策略在写 dsh schedule 条目前折算目标时刻，
 *   窗口外重排到下一个开启，条目仍由 dsh schedule 持久化/恢复。
 *
 * 宿主按真实最小契约装配：Agent/Session/Llm/Tools/SystemPrompt/Commands +
 * Jsonl persistence + storage/storage-json/storage-domain + jobs-local/tool-jobs +
 * schedule/tool-schedule；`sessionController` 用探针内最小解析器（live 直接返回，
 * 冷 Session 经 `ctx.agents.resume` 恢复）替代 Web controller，仅覆盖本探针的
 * “原 Session 恢复投递”路径。
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
import SubagentRuntime from "@deepseek-ai/dsh-subagent";
import * as SpawnInProcess from "@deepseek-ai/dsh-subagent-spawn-in-process";
import * as StorageDomain from "@deepseek-ai/dsh-storage-domain";
import * as StorageJson from "@deepseek-ai/dsh-storage-json";
import Storage from "@deepseek-ai/dsh-storage";
import SubprocessLocal from "@deepseek-ai/dsh-subprocess-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import JobsLocal from "@deepseek-ai/dsh-jobs-local";
import type { JobId } from "@deepseek-ai/dsh-jobs";
import type { CommandResult } from "@deepseek-ai/dsh-commands";
import * as ToolJobs from "@deepseek-ai/dsh-tool-jobs";
import * as ToolSchedule from "@deepseek-ai/dsh-tool-schedule";
import ScheduleService from "@deepseek-ai/dsh-schedule";
import * as ToolWorkflow from "@deepseek-ai/dsh-tool-workflow";
import PtcWorkflowEngine from "@deepseek-ai/dsh-workflow-ptc";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";

import ZcodeLoop, { ZcodeLoopAgent } from "../src/index.js";
import {
  isWithinOffPeakWindow,
  nextOffPeakOpen,
  parseOffPeakTitle,
  parseOffPeakWindow,
  resolveOffPeakTarget,
} from "../src/off-peak.js";

const PROVIDER = "mock";
const EVIDENCE_ROOT = join(tmpdir(), "dsh-jobs-schedule");

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    probe: "probe";
  }
}

function fail(message: string): never {
  console.error(`[jobs-schedule] FAIL: ${message}`);
  process.exit(1);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
function successText(result: CommandResult): string {
  if (result.kind !== "success") fail(`expected success, got ${result.text}`);
  if (result.text === undefined) fail("expected command result text");
  return result.text;
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
/** 等 agent 空闲并留观察窗，避免误把下一 turn 计入当前断言。 */
async function settle(agent: Agent, label: string): Promise<void> {
  await waitFor(() => agent.status === "idle", `${label}: idle`);
  await sleep(150);
  check(agent.status === "idle", `${label}: agent not idle`);
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
  readonly requests = new Map<string, GenerateOptions[]>();

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  on(sessionId: string, handler: Handler): void {
    this.handlers.set(sessionId, handler);
  }
  onOther(handler: Handler): void {
    this.fallback = handler;
  }
  count(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }
  requestText(sessionId: string, index = -1): string {
    const requests = this.requests.get(sessionId) ?? [];
    const request = requests.at(index);
    return request === undefined ? "" : JSON.stringify(request.messages);
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(request.sessionId);
    const count = (this.counts.get(sessionId) ?? 0) + 1;
    this.counts.set(sessionId, count);
    const list = this.requests.get(sessionId) ?? [];
    list.push(request);
    this.requests.set(sessionId, list);
    const handler = this.handlers.get(sessionId) ?? this.fallback;
    if (handler === undefined) throw new Error(`unexpected model request for session "${sessionId}" (request ${count})`);
    const chunks = await handler(request, count);
    for (const chunk of chunks) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

function requestText(request: GenerateOptions): string {
  return JSON.stringify(request.messages);
}
function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}
function sessionEvents(agent: Agent, type: string): Array<{ seq: number; data: unknown }> {
  return agent.session
    .snapshotEvents()
    .filter((event) => event.type === type)
    .map((event) => ({ seq: event.seq, data: (event as { data: unknown }).data }));
}
function messagesFrom(agent: Agent, sourceKind: string): string[] {
  return agent.session
    .snapshotEvents()
    .filter(
      (event) =>
        event.type === "user/message" &&
        (event.data as { source?: { kind?: string } }).source?.kind === sourceKind,
    )
    .map((event) => (event.data as { content: Array<{ type: string; text?: string }> }).content.map((block) => block.text ?? "").join(""));
}
function toolResultTexts(agent: Agent): string[] {
  return agent.session
    .snapshotEvents()
    .filter((event) => event.type === "tool/result")
    .map((event) => {
      const message = (event.data as unknown as { message: { content: string | ReadonlyArray<{ type: string; text?: string }> } }).message;
      return typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.text ?? JSON.stringify(block)).join("\n");
    });
}
function toolCallNames(agent: Agent): string[] {
  return agent.session
    .snapshotEvents()
    .filter((event) => event.type === "tool/call")
    .map((event) => (event.data as { name: string }).name);
}

/** 最小 sessionController：live Agent 直取；冷 Session 走工厂 resume（重启恢复投递路径）。 */
interface SessionControllerShim {
  resolveAgent(sessionId: ReturnType<typeof DshSessionId>): Promise<{ agent: Agent } | { error: { code: string; message: string } }>;
  dispose(): Promise<void>;
}

interface ProbeJobControls {
  release(): void;
  cancel(reason?: string): void;
}

class ProbeJobs {
  private readonly controls = new Map<string, ProbeJobControls>();
  constructor(private readonly ctx: Context) {}

  start(owner: Agent, label: string): JobId {
    const gate = Promise.withResolvers<{ status: "completed" | "killed" | "failed"; detail?: string; result?: string }>();
    const id = this.ctx.jobs.start({
      kind: "probe",
      label,
      owner: owner.id,
      run: (job) => {
        job.append("PROBE-JOB-OUTPUT\n");
        return {
          cancel: (reason?: string) => {
            job.append("PROBE-JOB-CANCELLED\n");
            gate.resolve({ status: "killed", detail: reason ?? "cancelled" });
          },
          done: gate.promise.then((outcome) => {
            job.append("PROBE-JOB-DONE\n");
            return outcome;
          }),
        };
      },
    });
    this.controls.set(String(id), {
      release: () => gate.resolve({ status: "completed", result: "PROBE-JOB-RESULT" }),
      cancel: (reason?: string) => gate.resolve({ status: "killed", detail: reason ?? "cancelled" }),
    });
    return id;
  }
  release(id: string): void {
    const control = this.controls.get(id);
    check(control !== undefined, `probe job ${id} has no release control`);
    control.release();
  }
  cancel(id: string): void {
    this.controls.get(id)?.cancel();
  }
}

interface HoldTool {
  tool: ReturnType<typeof defineTool>;
  calls(): number;
  releaseAll(): void;
}

function createHoldTool(): HoldTool {
  const gates: Array<PromiseWithResolvers<void>> = [];
  let calls = 0;
  const tool = defineTool({
    name: "hold",
    description: "Hold the current step until the probe releases it.",
    parameters: { marker: { type: "string", description: "probe marker" } },
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
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
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
    calls: () => calls,
    releaseAll: () => {
      for (const gate of gates.splice(0)) gate.resolve();
    },
  };
}

interface Host {
  ctx: Context;
  adapter: ScriptedAdapter;
  controller: SessionControllerShim;
  jobs: ProbeJobs;
  hold: HoldTool;
  workspace: string;
  dispose(): Promise<void>;
}

interface HostOptions {
  root?: string;
  data?: string;
  workspace?: string;
  workflow?: boolean;
  /** false 时不加载 storage/schedule/tool-schedule（验证命令优雅降级）。 */
  schedule?: boolean;
  handlers?: Array<[string, Handler]>;
  fallback?: Handler;
}

async function createHost(options: HostOptions = {}): Promise<Host> {
  const workspace = realpathSync(
    options.workspace ?? resolve(mkdtempSync(join(EVIDENCE_ROOT, "workspace-"))),
  );
  const root = options.root ?? resolve(mkdtempSync(join(EVIDENCE_ROOT, "sessions-")));
  const data = options.data ?? resolve(mkdtempSync(join(EVIDENCE_ROOT, "data-")));
  mkdirSync(workspace, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });

  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(SessionProjection);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(Jsonl, { root, compression: "none" });
  const withSchedule = options.schedule !== false;
  if (withSchedule) {
    await ctx.plugin(Storage as unknown as Plugin);
    await ctx.plugin(StorageJson as unknown as Plugin, { root: data });
    await ctx.plugin(StorageDomain as unknown as Plugin, { backend: "json" });
  }

  const adapter = new ScriptedAdapter();
  for (const [sessionId, handler] of options.handlers ?? []) adapter.on(sessionId, handler);
  if (options.fallback !== undefined) adapter.onOther(options.fallback);
  ctx.llm.registerAdapter([PROVIDER], adapter);

  const resumeHandles = new Map<string, AgentHandle>();
  const controller: SessionControllerShim = {
    async resolveAgent(sessionId) {
      const live = ctx.agents.get(sessionId);
      if (live !== undefined) return { agent: live };
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: PROVIDER, model: "mock" },
        });
        resumeHandles.set(String(sessionId), handle);
        return { agent: handle.agent };
      } catch (error) {
        return { error: { code: "gateway/internal", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    async dispose() {
      for (const handle of resumeHandles.values()) await handle.dispose().catch(() => {});
      resumeHandles.clear();
    },
  };
  ctx.provide("sessionController", controller);

  await ctx.plugin(JobsLocal as unknown as Plugin);
  await ctx.plugin(ToolJobs as unknown as Plugin, { completionDelivery: "wakeup" });

  const jobs = new ProbeJobs(ctx);
  const hold = createHoldTool();
  ctx.tools.register(hold.tool);
  ctx.tools.register(
    defineTool({
      name: "start_probe_job",
      description: "Start a probe background job owned by the calling agent.",
      parameters: { label: { type: "string", required: true, description: "job label" } },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { job_id: { type: "string", required: true } },
        },
        render: (_args, value) => [{ type: "text", text: `probe job started: ${value.job_id}` }],
      },
      execute: async (args, exec) => {
        check(exec.agent !== undefined, "start_probe_job requires a calling agent");
        const jobId = jobs.start(exec.agent, args.label ?? "probe");
        return { job_id: String(jobId) };
      },
    }),
  );

  if (options.workflow === true) {
    await ctx.plugin(LocalFileSystem, { cwd: workspace });
    await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace });
    await ctx.plugin(SubagentRuntime, {});
    await ctx.plugin(SpawnInProcess as unknown as Plugin);
    await ctx.plugin(SandboxPolicy, { mode: "danger-full-access", workspaceRoot: workspace });
    await ctx.plugin(SandboxLocal as unknown as Plugin);
    await ctx.plugin(SubprocessLocal as unknown as Plugin);
    await ctx.plugin(NodePtcRuntime as unknown as Plugin, { graceMs: 100 });
    await ctx.plugin(PtcWorkflowEngine as unknown as Plugin, {});
    await ctx.plugin(ToolWorkflow as unknown as Plugin, { enableRunInBackground: true });
  }

  await ctx.plugin(ZcodeLoop as unknown as Plugin, { provider: PROVIDER, model: "mock" });
  if (withSchedule) {
    await ctx.plugin(ScheduleService as unknown as Plugin, {});
    await ctx.plugin(ToolSchedule as unknown as Plugin);
  }

  return {
    ctx,
    adapter,
    controller,
    jobs,
    hold,
    workspace,
    async dispose() {
      await controller.dispose();
      await ctx.fiber.dispose();
    },
  };
}

function createAgent(host: Host, id: string): Promise<AgentHandle> {
  return host.ctx.agents.create({
    sessionId: DshSessionId(id),
    meta: { cwd: host.workspace },
    agentOptions: { provider: PROVIDER, model: "mock" },
  });
}

// ------------------------------------------------------------------
// a. schedule：短延迟投递回原 Session、source.kind，list/update/delete。
// ------------------------------------------------------------------
async function scheduleBasics(): Promise<void> {
  const sessionId = "schedule-basic";
  let receivedReminder = false;
  const host = await createHost({
    handlers: [
      [
        sessionId,
        async (request, count) => {
          if (count === 1) {
            return response("creating a reminder", [
              {
                callId: "schedule-create",
                name: "schedule_create",
                args: {
                  prompt: "SCHEDULE-BASIC-REMINDER",
                  title: "probe reminder",
                  after_seconds: 1,
                },
              },
            ]);
          }
          if (count === 2) {
            return response("reminder created");
          }
          if (count === 3) {
            const text = requestText(request);
            check(text.includes("SCHEDULE-BASIC-REMINDER"), "a: reminder text did not reach the original session");
            check(text.includes("[SCHEDULE REMINDER]"), "a: reminder framing missing from the request");
            receivedReminder = true;
            return response("reminder acknowledged");
          }
          return response("unexpected");
        },
      ],
    ],
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, sessionId);
    const agent = handle.agent;
    // 预置一个远期条目，供模型工具 list/update/delete 使用。
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const future2 = new Date(Date.now() + 7_200_000).toISOString();
    const managed = await host.ctx.schedule.create(agent.id, {
      title: "managed reminder",
      prompt: "SCHEDULE-MANAGED",
      at: future,
    });

    agent.followup(userMessage("create a short reminder"));
    await waitFor(() => receivedReminder, "a: reminder turn");
    await settle(agent, "a-reminder");

    const scheduledMessages = messagesFrom(agent, "schedule");
    check(scheduledMessages.length === 1, `a: expected exactly one schedule message, got ${scheduledMessages.length}`);
    check(scheduledMessages[0]!.includes("SCHEDULE-BASIC-REMINDER"), "a: schedule message lost its prompt");
    check(toolCallNames(agent).includes("schedule_create"), "a: schedule_create tool did not run");

    const listed = await host.ctx.schedule.list({ sessionId: agent.id });
    check(listed.some((record) => record.id === managed.id && record.title === "managed reminder"), "a: managed reminder not listed");

    // 模型工具：list → update → list → delete → list。
    let toolStep = 0;
    host.adapter.on(sessionId, (request, count) => {
      if (count <= 3) return response("already done");
      toolStep += 1;
      const text = requestText(request);
      if (toolStep === 1) {
        return response("listing", [{ callId: "schedule-list-1", name: "schedule_list", args: {} }]);
      }
      if (toolStep === 2) {
        check(text.includes("managed reminder"), "a: schedule_list result missing the managed reminder");
        return response("updating", [
          {
            callId: "schedule-update",
            name: "schedule_update",
            args: {
              id: String(managed.id),
              expected: managed,
              at: future2,
            },
          },
        ]);
      }
      if (toolStep === 3) {
        check(text.includes(future2), "a: schedule_update result did not show the new target");
        return response("listing again", [{ callId: "schedule-list-2", name: "schedule_list", args: {} }]);
      }
      if (toolStep === 4) {
        check(text.includes(future2), "a: updated reminder missing from the second list");
        return response("deleting", [
          { callId: "schedule-delete", name: "schedule_delete", args: { id: String(managed.id) } },
        ]);
      }
      if (toolStep === 5) {
        check(text.includes("deleted"), "a: schedule_delete result missing deleted flag");
        return response("listing after delete", [{ callId: "schedule-list-3", name: "schedule_list", args: {} }]);
      }
      return response("management complete");
    });
    agent.followup(userMessage("manage the reminder"));
    await settle(agent, "a-management");

    const afterDelete = await host.ctx.schedule.list({ sessionId: agent.id });
    check(!afterDelete.some((record) => record.id === managed.id), "a: deleted reminder still present in dsh schedule");
    check(
      toolCallNames(agent).filter((name) => name === "schedule_list").length === 3,
      "a: expected three schedule_list model calls",
    );
    console.log("[jobs-schedule] a ✓ 短延迟提醒回到原 Session（source.kind=schedule）；模型工具 list/update/delete 生效");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

// ------------------------------------------------------------------
// b. 忙时投递：reminder 在 turn 中到达 → next-turn 排队，turn 结束后消费一次。
// ------------------------------------------------------------------
async function busyDelivery(): Promise<void> {
  const sessionId = "schedule-busy";
  const gate = Promise.withResolvers<void>();
  let reminderRequest = false;
  let requests = 0;
  let queuedWhileBusy = false;
  const host = await createHost({
    handlers: [
      [
        sessionId,
        async (request, count) => {
          requests = count;
          if (count === 1) {
            await gate.promise;
            return response("busy turn complete");
          }
          if (count === 2) {
            const text = requestText(request);
            check(text.includes("BUSY-REMINDER"), "b: queued reminder did not reach the next turn");
            reminderRequest = true;
            return response("busy reminder consumed");
          }
          return response("unexpected extra turn");
        },
      ],
    ],
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, sessionId);
    const agent = handle.agent;
    await host.ctx.schedule.create(agent.id, {
      title: "busy reminder",
      prompt: "BUSY-REMINDER",
      after_seconds: 1,
    });
    agent.followup(userMessage("BUSY-TURN"));
    await waitFor(() => agent.status === "running", "b: turn running");
    await waitFor(() => agent.inbox.nextTurn.length === 1, "b: reminder queued in inbox", 5000);
    const queued = agent.inbox.nextTurn[0]!;
    check((queued.source as { kind?: string }).kind === "schedule", "b: queued reminder lost its schedule source");
    queuedWhileBusy = agent.status === "running";
    check(queuedWhileBusy, "b: reminder was not queued while the agent was busy");
    gate.resolve();
    await waitFor(() => reminderRequest, "b: reminder consumed after the turn");
    await settle(agent, "b");

    const reminders = messagesFrom(agent, "schedule");
    check(reminders.length === 1, `b: reminder delivered ${reminders.length} times`);
    const turnStarts = sessionEvents(agent, "turn/start").length;
    check(turnStarts === 2, `b: expected two turns (busy + reminder), got ${turnStarts}`);
    check(requests === 2, `b: expected two model requests, got ${requests}`);
    console.log("[jobs-schedule] b ✓ busy turn 中 reminder 进 next-turn；turn 结束后消费一次，不丢不重");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

// ------------------------------------------------------------------
// c. 重启恢复：durable schedule 跨宿主；进程内 jobs 不跨重启（如实记录边界）。
// ------------------------------------------------------------------
async function restartRecovery(): Promise<void> {
  const sessionId = "schedule-restart";
  const root = resolve(mkdtempSync(join(EVIDENCE_ROOT, "restart-sessions-")));
  const data = resolve(mkdtempSync(join(EVIDENCE_ROOT, "restart-data-")));
  const firstRequests: number[] = [];
  const host1 = await createHost({
    root,
    data,
    handlers: [
      [
        sessionId,
        (_request, count) => {
          firstRequests.push(count);
          return response("before restart");
        },
      ],
    ],
  });
  let handle: AgentHandle | undefined;
  let jobId: JobId | undefined;
  try {
    handle = await createAgent(host1, sessionId);
    const agent = handle.agent;
    agent.followup(userMessage("BEFORE-RESTART"));
    await settle(agent, "c-first");
    await host1.ctx.sessions.flush(agent.session);
    jobId = host1.jobs.start(agent, "restart-boundary");
    await host1.ctx.schedule.create(agent.id, {
      title: "restart reminder",
      prompt: "SCHEDULE-RESTART-REMINDER",
      after_seconds: 2,
    });
  } finally {
    await handle?.dispose();
    await host1.dispose();
  }

  let delivered = false;
  const host2 = await createHost({
    root,
    data,
    handlers: [
      [
        sessionId,
        (request, count) => {
          const text = requestText(request);
          check(text.includes("BEFORE-RESTART"), "c: resumed session lost its prior history");
          check(text.includes("SCHEDULE-RESTART-REMINDER"), "c: reminder did not reach the resumed session");
          delivered = true;
          return response(`restart delivery ${count}`);
        },
      ],
    ],
  });
  try {
    await waitFor(() => delivered, "c: reminder delivered after restart", 10000);
    const agent = host2.ctx.agents.get(DshSessionId(sessionId));
    check(agent !== undefined, "c: reminder did not resume the original session");
    await settle(agent, "c-second");
    check(agent instanceof ZcodeLoopAgent, "c: resumed session must use the ZcodeLoop factory");
    check(messagesFrom(agent, "schedule").length === 1, "c: expected exactly one schedule message after restart");
    check(host2.ctx.jobs.list().length === 0, "c: process-local job records must not survive a restart");
    assert.throws(() => host2.ctx.jobs.get(jobId!), /unknown job/, "c: old job id must be unknown in the new host");
    console.log("[jobs-schedule] c ✓ durable schedule 跨宿主恢复原 Session 投递；jobs-local 记录不跨重启（源码边界）");
  } finally {
    await host2.dispose();
  }
}

function jobIdFromText(text: string): string {
  const matches = [...text.matchAll(/probe-[0-9a-z-]+/g)].map((match) => match[0]);
  check(matches.length > 0, "d: job id missing from the request");
  // 历史里可能有前一个 job 的 id；最新一次 tool result 在末尾。
  return matches.at(-1)!;
}

// ------------------------------------------------------------------
// d. jobs：模型工具、completion 只通知一次、owner 隔离。
// ------------------------------------------------------------------
async function jobsBasics(): Promise<void> {
  let firstJob = "";
  let secondJob = "";
  let noticeSeen = false;
  let foreignAttempts = 0;
  const host = await createHost({
    handlers: [
      [
        "jobs-a",
        async (request, count) => {
          const text = requestText(request);
          if (count === 1) {
            return response("starting first job", [
              { callId: "job-start-1", name: "start_probe_job", args: { label: "first" } },
            ]);
          }
          if (count === 2) {
            firstJob = jobIdFromText(text);
            setTimeout(() => host.jobs.release(firstJob), 100);
            return response("waiting for first job", [
              {
                callId: "job-output-1",
                name: "job_output",
                args: { job_id: firstJob, wait: true, timeout_ms: 5000 },
              },
            ]);
          }
          if (count === 3) {
            check(text.includes("PROBE-JOB-OUTPUT"), "d: job_output lost the job output");
            check(text.includes("PROBE-JOB-RESULT"), "d: job_output lost the terminal result");
            return response("listing jobs", [{ callId: "job-list-1", name: "job_list", args: {} }]);
          }
          if (count === 4) {
            check(text.includes(firstJob) && text.includes("completed"), "d: job_list did not show the completed job");
            return response("first job done");
          }
          if (count === 5) {
            return response("starting second job", [
              { callId: "job-start-2", name: "start_probe_job", args: { label: "second" } },
            ]);
          }
          if (count === 6) {
            secondJob = jobIdFromText(text);
            return response("second job running");
          }
          if (count === 7) {
            check(text.includes(`background job ${secondJob}`), "d: completion notice did not name the job");
            check(text.includes("finished"), "d: completion notice missing the settlement status");
            noticeSeen = true;
            return response("completion notice observed");
          }
          return response("unexpected");
        },
      ],
      [
        "jobs-b",
        (request, count) => {
          if (count === 1) {
            foreignAttempts += 1;
            return response("trying a foreign job", [
              { callId: "foreign-output", name: "job_output", args: { job_id: secondJob } },
            ]);
          }
          if (count === 2) {
            foreignAttempts += 1;
            return response("trying to kill", [
              { callId: "foreign-kill", name: "job_kill", args: { job_id: secondJob } },
            ]);
          }
          return response("foreign attempts done");
        },
      ],
    ],
  });
  let a: AgentHandle | undefined;
  let b: AgentHandle | undefined;
  try {
    a = await createAgent(host, "jobs-a");
    b = await createAgent(host, "jobs-b");
    a.agent.followup(userMessage("run the first job"));
    await settle(a.agent, "d-first");
    check(firstJob !== "", "d: first job id not observed");
    check(host.ctx.jobs.get(firstJob as JobId, a.agent.id).status === "completed", "d: first job did not complete");
    check(
      sessionEvents(a.agent, "job/settled").length === 1,
      "d: first job must record exactly one settlement",
    );

    a.agent.followup(userMessage("run the second job"));
    await settle(a.agent, "d-second");
    check(secondJob !== "", "d: second job id not observed");
    check(host.ctx.jobs.get(secondJob as JobId, a.agent.id).status === "running", "d: second job must stay running");
    // idle owner → tool-jobs followup 唤醒一次。
    host.jobs.release(secondJob);
    await waitFor(() => noticeSeen, "d: completion notice turn");
    await settle(a.agent, "d-notice");
    check(messagesFrom(a.agent, "tool-jobs").length === 1, "d: completion must notify exactly once");

    // owner 隔离：B 的模型工具与直接 registry 读取都必须被 fence 拒绝。
    check(b !== undefined, "d: agent B was not created");
    b.agent.followup(userMessage("try the foreign job"));
    await settle(b.agent, "d-foreign");
    check(foreignAttempts === 2, `d: expected two foreign attempts, got ${foreignAttempts}`);
    const foreignResults = toolResultTexts(b.agent);
    check(
      foreignResults.filter((text) => text.includes("belongs to another session")).length === 2,
      `d: foreign job access was not fenced (${foreignResults.join(" | ")})`,
    );
    assert.throws(
      () => host.ctx.jobs.get(secondJob as JobId, b!.agent.id),
      /belongs to another session/,
      "d: registry read must reject a foreign caller",
    );
    assert.throws(
      () => host.ctx.jobs.kill(secondJob as JobId, b!.agent.id),
      /belongs to another session/,
      "d: registry kill must reject a foreign caller",
    );
    console.log("[jobs-schedule] d ✓ job_output/job_list/job_kill 工作；completion 只通知一次；跨 owner 读取/终止被拒");
  } finally {
    await a?.dispose();
    await b?.dispose();
    await host.dispose();
  }
}

function workflowCall(callId: string, script: string): ScriptedCall {
  return {
    callId,
    name: "workflow",
    args: {
      meta: { name: "background-probe", description: "background workflow probe" },
      script,
      run_in_background: true,
    },
  };
}

function workflowJobId(text: string): string {
  const matches = [...text.matchAll(/started in the background as job ([^\s.]+)/g)].map((match) => match[1]!);
  check(matches.length > 0, "e: background workflow did not report a job id");
  // 历史里可能有前一个 workflow job；最新一次 tool result 在末尾。
  return matches.at(-1)!;
}

// ------------------------------------------------------------------
// e. 后台 workflow（T12 遗留）：run_in_background 经 jobs、一次通知、job_kill。
// ------------------------------------------------------------------
async function backgroundWorkflow(): Promise<void> {
  let firstJob = "";
  let secondJob = "";
  let noticeObserved = false;
  const host = await createHost({
    workflow: true,
    handlers: [
      [
        "workflow-bg-parent",
        (request, count) => {
          const text = requestText(request);
          if (count === 1) {
            return response("starting background workflow", [
              workflowCall(
                "bg-workflow-1",
                `return await agent('BG-WF-CHILD: hold')`,
              ),
            ]);
          }
          if (count === 2) {
            check(text.includes("started in the background"), "e: workflow tool did not return the background envelope");
            firstJob = workflowJobId(text);
            check(
              host.ctx.jobs.get(firstJob as JobId, DshSessionId("workflow-bg-parent")).status === "running",
              "e: background workflow must be running after the main turn",
            );
            return response("background workflow acknowledged");
          }
          if (count === 3) {
            check(text.includes(`background job ${firstJob}`), "e: completion notice did not name the workflow job");
            noticeObserved = true;
            return response("reading workflow result", [
              { callId: "bg-workflow-output", name: "job_output", args: { job_id: firstJob } },
            ]);
          }
          if (count === 4) {
            check(text.includes("BG-CHILD-DONE"), "e: job_output lost the background workflow result");
            return response("workflow result observed");
          }
          if (count === 5) {
            return response("starting second background workflow", [
              workflowCall("bg-workflow-2", `return await agent('BG-WF-CHILD: hold again')`),
            ]);
          }
          if (count === 6) {
            secondJob = workflowJobId(text);
            return response("second background workflow acknowledged");
          }
          if (count === 7) {
            return response("killing workflow", [
              { callId: "bg-workflow-kill", name: "job_kill", args: { job_id: secondJob } },
            ]);
          }
          if (count === 8) {
            check(text.includes(secondJob), "e: job_kill result did not name the workflow job");
            return response("kill requested");
          }
          return response("unexpected");
        },
      ],
    ],
    fallback: (request, count) => {
      const text = requestText(request);
      check(text.includes("BG-WF-CHILD"), "e: unexpected child prompt");
      if (count === 1) {
        return response("", [{ callId: "bg-child-hold", name: "hold", args: { marker: "bg" } }]);
      }
      return response("BG-CHILD-DONE");
    },
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "workflow-bg-parent");
    const agent = handle.agent;
    agent.followup(userMessage("run a background workflow"));
    await waitFor(() => host.adapter.count(agent.id) >= 2, "e: main turn returned from the background call", 20000);
    await settle(agent, "e-main");
    check(firstJob !== "", "e: workflow job id not observed");
    await waitFor(() => host.hold.calls() >= 1, "e: background child started", 20000);
    check(
      host.ctx.jobs.get(firstJob as JobId, agent.id).status === "running",
      "e: workflow must still be running while the parent turn is idle",
    );
    host.hold.releaseAll();
    await waitFor(() => noticeObserved, "e: workflow completion notice", 30000);
    await waitFor(
      () => host.ctx.jobs.get(firstJob as JobId, agent.id).status === "completed",
      "e: workflow job completed",
      30000,
    );
    await settle(agent, "e-notice");
    check(messagesFrom(agent, "tool-jobs").length === 1, "e: workflow completion must notify exactly once");

    // 第二条后台 workflow：模型 job_kill 收口，且不得再发完成通知。
    agent.followup(userMessage("run and kill a background workflow"));
    await waitFor(() => secondJob !== "", "e: second workflow job id", 30000);
    await waitFor(() => host.hold.calls() >= 2, "e: second workflow child started", 20000);
    agent.followup(userMessage("kill the background workflow"));
    await waitFor(
      () => host.ctx.jobs.get(secondJob as JobId, agent.id).status === "killed",
      "e: job_kill settled the workflow",
      30000,
    );
    await settle(agent, "e-killed");
    check(
      !messagesFrom(agent, "tool-jobs").some((text) => text.includes(secondJob)),
      "e: model-killed workflow must not post a completion notice",
    );
    const childTurns = agent.session
      .snapshotEvents()
      .filter((event) => event.type === "turn/end")
      .length;
    check(childTurns >= 3, "e: expected parent turns for both workflows");
    console.log("[jobs-schedule] e ✓ 后台 workflow 立即返回、结果经 job 一次交付、job_kill 可收口");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

// ------------------------------------------------------------------
// f. off-peak：时窗折算 + 命令 create/list/cancel + dsh schedule 存储。
// ------------------------------------------------------------------
async function offPeak(): Promise<void> {
  const now = new Date();
  const fullDay = parseOffPeakWindow("00:00-23:59");
  check(fullDay !== undefined, "f: 00:00-23:59 must parse");
  check(isWithinOffPeakWindow(now, fullDay), "f: full-day window must contain the current time");
  const immediate = resolveOffPeakTarget(now, fullDay);
  check(immediate.getTime() - now.getTime() <= 3_000, "f: inside-window target must stay near now");
  check(isWithinOffPeakWindow(immediate, fullDay), "f: inside-window target must remain inside the window");

  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const startMinute = (nowMinute + 120) % (24 * 60);
  const endMinute = (startMinute + 60) % (24 * 60);
  const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const outside = parseOffPeakWindow(`${clock(startMinute)}-${clock(endMinute)}`);
  check(outside !== undefined, "f: constructed window must parse");
  check(!isWithinOffPeakWindow(now, outside), "f: constructed window must exclude the current time");
  const nextOpen = nextOffPeakOpen(now, outside);
  check(nextOpen.getTime() > now.getTime(), "f: next opening must be in the future");
  check(isWithinOffPeakWindow(nextOpen, outside), "f: next opening must be inside the window");
  const deferred = resolveOffPeakTarget(now, outside);
  check(deferred.getTime() === nextOpen.getTime(), "f: outside-window trigger must move to the next opening");

  check(parseOffPeakWindow("24:00-01:00") === undefined, "f: 24:00 must be rejected");
  check(parseOffPeakWindow("10:00-10:00") === undefined, "f: empty window must be rejected");

  let handle: AgentHandle | undefined;
  const host = await createHost({ fallback: () => response("offpeak host") });
  try {
    handle = await createAgent(host, "offpeak-commands");
    const agent = handle.agent;
    const signal = new AbortController().signal;
    const run = async (line: string) => {
      const execution = await host.ctx.commands.execute(agent, line, [], signal);
      check(execution !== undefined, `f: command not registered: ${line}`);
      return execution.result;
    };

    const outsideLine = `/offpeak create ${clock(startMinute)}-${clock(endMinute)} OFFPEAK-DEFERRED`;
    const outsideResult = await run(outsideLine);
    check(outsideResult.kind === "success", `f: create outside window failed: ${outsideResult.text}`);
    check(
      successText(outsideResult).includes("moved to the next opening"),
      "f: outside-window create must report the reschedule",
    );

    const records = await host.ctx.schedule.list({ sessionId: agent.id });
    const deferredRecord = records.find((record) => record.prompt === "OFFPEAK-DEFERRED");
    check(deferredRecord !== undefined, "f: deferred record missing from dsh schedule");
    check(
      Math.abs(Date.parse(deferredRecord.scheduledAt) - nextOpen.getTime()) < 5_000,
      "f: stored target does not match the next window opening",
    );

    const listBeforeCreate = await run("/offpeak list");
    check(listBeforeCreate.kind === "success", `f: list failed: ${listBeforeCreate.text}`);
    check(
      successText(listBeforeCreate).includes("OFFPEAK-DEFERRED"),
      "f: list did not show the deferred reminder",
    );
    check(successText(listBeforeCreate).includes("next"), "f: list must include the next expected trigger");

    const inside = await run("/offpeak create 00:00-23:59 OFFPEAK-ALWAYS");
    check(inside.kind === "success", `f: create inside window failed: ${inside.text}`);
    check(successText(inside).includes("Off-peak reminder"), "f: create did not name the reminder");

    const withBoth = await host.ctx.schedule.list({ sessionId: agent.id });
    const offPeakRecords = withBoth.filter((record) => parseOffPeakTitle(record.title) !== undefined);
    check(offPeakRecords.length === 2, `f: expected two off-peak records, got ${offPeakRecords.length}`);
    const alwaysRecord = offPeakRecords.find((record) => record.prompt === "OFFPEAK-ALWAYS");
    check(alwaysRecord !== undefined, "f: inside-window record missing from dsh schedule");

    const listResult = await run("/offpeak list");
    check(listResult.kind === "success", `f: list failed: ${listResult.text}`);
    check(
      successText(listResult).includes("OFFPEAK-ALWAYS") && successText(listResult).includes("OFFPEAK-DEFERRED"),
      "f: list did not show both reminders",
    );

    const cancelResult = await run(`/offpeak cancel ${deferredRecord.id}`);
    check(cancelResult.kind === "success", `f: cancel failed: ${cancelResult.text}`);
    const afterCancel = await host.ctx.schedule.list({ sessionId: agent.id });
    check(!afterCancel.some((record) => record.id === deferredRecord.id), "f: cancelled record still stored");
    const unknown = await run("/offpeak cancel offpeak-not-there");
    check(unknown.kind === "error", "f: unknown cancel must fail");

    // 等待窗口内的短条目真实投递一次（dsh schedule 存储/投递路径）。
    await waitFor(() => messagesFrom(agent, "schedule").length === 1, "f: inside-window reminder delivery", 8000);
    console.log("[jobs-schedule] f ✓ 时窗折算（含窗口外重排）+ create/list/cancel + dsh schedule 存储/投递");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/**
 * f.degrade：schedule 缺席时命令不注册，ZcodeLoop/commands 其余面照常工作。
 */
async function offPeakDegradation(): Promise<void> {
  const host = await createHost({ schedule: false, fallback: () => response("degraded host") });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "offpeak-without-schedule");
    const agent = handle.agent;
    check(host.ctx.get("schedule") === undefined, "f: schedule service must be absent in the degradation host");
    check(host.ctx.commands.find(agent, "offpeak") === undefined, "f: /offpeak must not register without schedule");
    check(host.ctx.commands.find(agent, "queue") !== undefined, "f: existing commands must stay registered");
    const execution = await host.ctx.commands.execute(agent, "/offpeak list", [], new AbortController().signal);
    check(execution === undefined, "f: /offpeak without schedule must not dispatch");
    agent.followup(userMessage("DEGRADED-STILL-WORKS"));
    await settle(agent, "f-degraded");
    check(toolCallNames(agent).length === 0, "f: degraded agent should not need a tool call");
    console.log("[jobs-schedule] f.degrade ✓ schedule 缺席时 /offpeak 不注册，AgentFactory 与既有命令不受影响");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  const watchdog = setTimeout(() => fail("watchdog: probe did not finish in 300s"), 300000);
  watchdog.unref?.();
  try {
    await scheduleBasics();
    await busyDelivery();
    await restartRecovery();
    await jobsBasics();
    await backgroundWorkflow();
    await offPeak();
    await offPeakDegradation();
  } finally {
    rmSync(EVIDENCE_ROOT, { recursive: true, force: true });
  }
  console.log("[jobs-schedule] PASS: schedule/jobs/off-peak 全绿");
  clearTimeout(watchdog);
  process.exit(0);
}

main().catch((error: unknown) => fail(`unhandled: ${error instanceof Error ? error.stack : String(error)}`));
