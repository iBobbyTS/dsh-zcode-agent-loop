/**
 * workspace hooks 集成探针。
 *
 * 用真实 dsh 栈（llm/session/systemPrompt/tools/agents + subprocess-local +
 * ZcodeLoop）验证 TASK a–h：
 * - hook command 全部经 dsh subprocess 服务执行；fixture 把实际 stdin 事件
 *   追加进日志，探针据此断言触发次数、事件名与 matcher。
 * - 信任/未知类型按导入结果断言；PermissionRequest 明确不可映射。
 * - 取消/卸载场景用 fixture 写出的 pid 断言进程已终止。
 *
 * 明确不宣称：tools/pre-execute 只承载 PreToolUse，不是全部 ZCode hooks 的
 * 等价物；Stop 在 turn/end 观测点无法阻止已完成的 turn。
 */
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import LlmRuntime, {
  LlmAdapter,
  ToolCallId as DshToolCallId,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SubprocessLocal from "@deepseek-ai/dsh-subprocess-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";

import ZcodeLoop from "../src/index.js";
import WorkspaceHooks, {
  WORKSPACE_HOOK_COVERAGE,
  WORKSPACE_HOOK_EVENT_NAMES,
  WORKSPACE_HOOK_SEAMS,
  WorkspaceHooksImportError,
  importWorkspaceHooks,
  type WorkspaceHookDefinition,
  type WorkspaceHookMatcherConfig,
  type WorkspaceHooksPluginConfig,
} from "../src/workspace-hooks.js";

const PROVIDER = "mock";
const FIXTURE = resolve(import.meta.dirname, "fixtures/workspace-hook.mjs");
const EVIDENCE_ROOT = join(tmpdir(), "dsh-workspace-hooks");

function fail(message: string): never {
  console.error(`[workspace-hooks] FAIL: ${message}`);
  process.exit(1);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  fail(`timeout waiting for ${what}`);
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
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
function toolCallChunks(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  let index = 0;
  for (const call of calls) {
    const argumentsJson = JSON.stringify(call.args);
    chunks.push({ type: "block-start", index, blockType: "tool-call" });
    chunks.push({
      type: "tool-call-delta",
      index,
      id: DshToolCallId(call.id),
      name: call.name,
      argumentsDelta: argumentsJson,
    });
    chunks.push({
      type: "block-end",
      index,
      block: {
        type: "tool-call",
        id: DshToolCallId(call.id),
        name: call.name,
        arguments: argumentsJson,
      },
    });
    index += 1;
  }
  chunks.push({ type: "usage", usage: { inputTokens: 6, outputTokens: 3 } });
  chunks.push({ type: "finish", reason: { kind: "tool-calls" } });
  return chunks;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requestText(request: GenerateOptions): string {
  return request.messages
    .map((message) => {
      if (!("content" in message) || !Array.isArray(message.content)) return "";
      return message.content
        .filter(
          (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
    })
    .join("\n");
}
function requestSystemText(request: GenerateOptions): string {
  return request.messages
    .filter((message) => message.role === "system")
    .map((message) =>
      Array.isArray(message.content)
        ? message.content
            .filter(
              (block): block is Extract<(typeof message.content)[number], { type: "text" }> =>
                block.type === "text",
            )
            .map((block) => block.text)
            .join("\n")
        : "",
    )
    .join("\n");
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly steps: StreamChunk[][] = [];

  override resolveModel(
    provider: string,
    model: string,
  ): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  queue(...steps: StreamChunk[][]): void {
    this.steps.push(...steps);
  }

  pending(): number {
    return this.steps.length;
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error(`unexpected model request: ${requestText(request)}`);
    }
    for (const chunk of step) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

interface ToolState {
  executions: number;
  failures: number;
  sideEffectPath: string;
}

function registerProbeTools(ctx: Context, state: ToolState): void {
  ctx.tools.register(
    defineTool({
      name: "probe_tool",
      description: "Probe tool that records a side effect",
      parameters: {},
      output: {
        schema: { type: "object", additionalProperties: true },
        render: () => [{ type: "text", text: "probe_tool executed" }],
      },
      execute: async () => {
        state.executions += 1;
        appendFileSync(state.sideEffectPath, "ran\n", "utf8");
        return { ok: true };
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "probe_fail",
      description: "Probe tool that always throws",
      parameters: {},
      output: {
        schema: { type: "object", additionalProperties: true },
        render: () => [{ type: "text", text: "unreachable" }],
      },
      execute: async () => {
        state.failures += 1;
        throw new Error("probe failure");
      },
    }),
  );
}

interface Host {
  ctx: Context;
  adapter: ScriptedAdapter;
  workspace: string;
  hooks: WorkspaceHooks;
  plugin: Awaited<ReturnType<Context["plugin"]>>;
  logs: Record<string, unknown>[];
  toolState: ToolState;
  dispose(): Promise<void>;
}

interface HostOptions {
  workspace: string;
  hooksConfig: WorkspaceHooksPluginConfig;
  /** false 时不加载 subprocess-local（降级场景）。 */
  subprocess?: boolean;
}

async function createHost(options: HostOptions): Promise<Host> {
  const ctx = new Context();
  const logs: Record<string, unknown>[] = [];
  ctx.logger.exporter({
    export(message) {
      const text = message.args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      for (const line of text.split("\n")) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isRecord(parsed) && typeof parsed.event === "string") logs.push(parsed);
        } catch {
          // 非 JSON 日志不是本探针的输出。
        }
      }
    },
  });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(SessionProjection);
  await ctx.plugin(LocalFileSystem, { cwd: options.workspace });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: options.workspace });
  await ctx.plugin(AgentRegistry);
  if (options.subprocess !== false) {
    await ctx.plugin(SubprocessLocal as unknown as Plugin);
  }
  const toolState: ToolState = {
    executions: 0,
    failures: 0,
    sideEffectPath: join(options.workspace, "tool-side-effect.txt"),
  };
  registerProbeTools(ctx, toolState);
  await ctx.plugin(ZcodeLoop as unknown as Plugin, { provider: PROVIDER, model: "mock" });
  const plugin = await ctx.plugin(
    WorkspaceHooks as unknown as Plugin.Object<Record<string, unknown>>,
    options.hooksConfig as unknown as Record<string, unknown>,
  );
  const hooks = ctx.get("workspaceHooks") as WorkspaceHooks | undefined;
  check(hooks !== undefined, "workspaceHooks service must be registered");
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter([PROVIDER], adapter);
  return {
    ctx,
    adapter,
    workspace: options.workspace,
    hooks,
    plugin,
    logs,
    toolState,
    dispose: () => ctx.fiber.dispose(),
  };
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

async function runTurn(host: Host, agent: Agent, input: string): Promise<GenerateOptions[]> {
  const before = host.adapter.requests.length;
  agent.followup(userMessage(input));
  await waitFor(() => agent.status === "idle", `turn idle for ${agent.id}`);
  await host.hooks.whenIdle();
  await sleep(60);
  return host.adapter.requests.slice(before);
}

function hookDefinition(logPath: string, label: string, extra: string[] = []): WorkspaceHookDefinition {
  const argv = [process.execPath, FIXTURE, "--log", logPath, "--label", label, ...extra];
  return { type: "command", command: argv.map(shellQuote).join(" ") };
}

function configWithEvents(
  logPath: string,
  events: Record<string, WorkspaceHookMatcherConfig[]>,
  trusted = true,
): WorkspaceHooksPluginConfig {
  return {
    sources: [
      {
        trusted,
        hooks: { enabled: true, events },
      },
    ],
  };
}

interface HookLogLine {
  label: string;
  hookEventName?: string;
  prompt?: string;
  source?: string;
  toolName?: string;
  turnId?: string;
}

function readHookLog(path: string): HookLogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HookLogLine);
}

function labels(lines: readonly HookLogLine[], label: string): HookLogLine[] {
  return lines.filter((line) => line.label === label);
}

function pluginLogs(host: Host, event: string): Record<string, unknown>[] {
  return host.logs.filter((entry) => entry.event === event);
}

function lastTurnEndReason(agent: Agent): string | undefined {
  const event = agent.session
    .snapshotEvents()
    .filter((candidate) => candidate.type === "turn/end")
    .at(-1);
  return event?.type === "turn/end" ? event.data.reason.kind : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** a：六类映射事件在对应动作各恰好触发一次，同时验证 stdin 事件名。 */
async function triggerScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "trigger-workspace");
  const log = join(root, "trigger-hook.log");
  const host = await createHost({
    workspace,
    hooksConfig: configWithEvents(log, {
      SessionStart: [{ hooks: [hookDefinition(log, "a-session-start")] }],
      UserPromptSubmit: [{ hooks: [hookDefinition(log, "a-user-prompt")] }],
      PreToolUse: [{ matcher: "probe_tool", hooks: [hookDefinition(log, "a-pre")] }],
      PostToolUse: [{ matcher: "probe_tool", hooks: [hookDefinition(log, "a-post")] }],
      PostToolUseFailure: [{ matcher: "probe_fail", hooks: [hookDefinition(log, "a-post-fail")] }],
      Stop: [{ hooks: [hookDefinition(log, "a-stop")] }],
    }),
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "hooks-trigger");
    host.adapter.queue(
      toolCallChunks([{ id: "call-1", name: "probe_tool", args: {} }]),
      textChunks("tool done"),
    );
    const first = await runTurn(host, handle.agent, "trigger turn");
    check(first.length === 2, `first turn must issue 2 requests, got ${first.length}`);
    check(host.toolState.executions === 1, "probe_tool must execute once");

    let lines = readHookLog(log);
    check(labels(lines, "a-session-start").length === 1, "SessionStart must fire exactly once");
    check(labels(lines, "a-user-prompt").length === 1, "UserPromptSubmit must fire once per turn");
    check(labels(lines, "a-pre").length === 1, "PreToolUse must fire exactly once");
    check(labels(lines, "a-post").length === 1, "PostToolUse must fire exactly once");
    check(labels(lines, "a-post-fail").length === 0, "PostToolUseFailure must not fire on success");
    check(labels(lines, "a-stop").length === 1, "Stop must fire exactly once per completed turn");
    check(labels(lines, "a-session-start")[0]!.hookEventName === "SessionStart", "stdin must carry SessionStart");
    check(labels(lines, "a-user-prompt")[0]!.hookEventName === "UserPromptSubmit", "stdin must carry UserPromptSubmit");
    check(labels(lines, "a-pre")[0]!.hookEventName === "PreToolUse", "stdin must carry PreToolUse");
    check(labels(lines, "a-pre")[0]!.toolName === "probe_tool", "PreToolUse must receive the tool name");
    check(labels(lines, "a-post")[0]!.hookEventName === "PostToolUse", "stdin must carry PostToolUse");
    check(labels(lines, "a-post-fail").length === 0, "PostToolUseFailure must remain silent");

    host.adapter.queue(
      toolCallChunks([{ id: "call-2", name: "probe_fail", args: {} }]),
      textChunks("failure done"),
    );
    const second = await runTurn(host, handle.agent, "failure turn");
    check(second.length === 2, `failure turn must issue 2 requests, got ${second.length}`);
    check(host.toolState.failures === 1, "probe_fail must execute once");
    lines = readHookLog(log);
    check(labels(lines, "a-post-fail").length === 1, "PostToolUseFailure must fire exactly once");
    check(labels(lines, "a-user-prompt").length === 2, "UserPromptSubmit must fire once per turn");
    check(labels(lines, "a-stop").length === 2, "Stop must fire once per completed turn");
    check(labels(lines, "a-post-fail")[0]!.hookEventName === "PostToolUseFailure", "stdin must carry PostToolUseFailure");
    console.log("[workspace-hooks] a ✓ SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/Stop 各触发一次");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** b：PreToolUse block 零副作用；UserPromptSubmit block 拒绝 step。 */
async function blockScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "block-workspace");
  const log = join(root, "block-hook.log");
  const host = await createHost({
    workspace,
    hooksConfig: configWithEvents(log, {
      PreToolUse: [
        { matcher: "probe_tool", hooks: [hookDefinition(log, "b-pre-block", ["--block"])] },
      ],
    }),
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "hooks-block-tool");
    host.adapter.queue(
      toolCallChunks([{ id: "blocked-call", name: "probe_tool", args: {} }]),
      textChunks("blocked tool done"),
    );
    const requests = await runTurn(host, handle.agent, "blocked tool turn");
    check(requests.length === 2, "blocked tool turn must still complete the model loop");
    check(host.toolState.executions === 0, "blocked tool must not execute");
    check(existsSync(host.toolState.sideEffectPath) === false, "blocked tool must leave no side effect");
    check(pluginLogs(host, "hook.action.blocked").length >= 1, "block must be logged");
    check(readHookLog(log).some((line) => line.label === "b-pre-block"), "PreToolUse hook must run");
    console.log("[workspace-hooks] b1 ✓ PreToolUse block：工具零执行、零副作用，日志记录");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }

  const exit2Log = join(root, "block-exit2-hook.log");
  const exit2Host = await createHost({
    workspace,
    hooksConfig: configWithEvents(exit2Log, {
      PreToolUse: [
        { matcher: "probe_tool", hooks: [hookDefinition(exit2Log, "b-exit2", ["--block-exit2"])] },
      ],
    }),
  });
  let exit2Handle: AgentHandle | undefined;
  try {
    exit2Handle = await createAgent(exit2Host, "hooks-block-exit2");
    exit2Host.adapter.queue(
      toolCallChunks([{ id: "exit2-call", name: "probe_tool", args: {} }]),
      textChunks("exit2 done"),
    );
    await runTurn(exit2Host, exit2Handle.agent, "exit2 turn");
    check(exit2Host.toolState.executions === 0, "exit 2 must deny the tool");
    console.log("[workspace-hooks] b2 ✓ exit 2 按 vendor 语义转成 PreToolUse deny");
  } finally {
    await exit2Handle?.dispose();
    await exit2Host.dispose();
  }

  // 模型请求接缝（pre-step）的 block：真实语义是拒绝 step，不发请求。
  const promptLog = join(root, "block-prompt-hook.log");
  const promptHost = await createHost({
    workspace,
    hooksConfig: configWithEvents(promptLog, {
      UserPromptSubmit: [{ hooks: [hookDefinition(promptLog, "b-prompt-block", ["--block"])] }],
    }),
  });
  let promptHandle: AgentHandle | undefined;
  try {
    promptHandle = await createAgent(promptHost, "hooks-block-prompt");
    promptHost.adapter.queue(textChunks("must not be requested"));
    const requests = await runTurn(promptHost, promptHandle.agent, "blocked prompt");
    check(requests.length === 0, "UserPromptSubmit block must reject the step before any model request");
    check(lastTurnEndReason(promptHandle.agent) === "blocked", "rejected step must end the turn as blocked");
    check(promptHost.adapter.pending() === 1, "scripted request must stay unconsumed");
    check(pluginLogs(promptHost, "hook.action.blocked").length >= 1, "prompt block must be logged");
    console.log("[workspace-hooks] b3 ✓ UserPromptSubmit block：pre-step 拒绝、零模型请求、turn blocked");
  } finally {
    await promptHandle?.dispose();
    await promptHost.dispose();
  }
}

/** c：cancel 终止 hook 子进程，主轮按 cancel 语义收口。 */
async function cancelScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "cancel-workspace");
  const log = join(root, "cancel-hook.log");
  const pidPath = join(root, "cancel-hook.pid");
  const host = await createHost({
    workspace,
    hooksConfig: configWithEvents(log, {
      PreToolUse: [
        {
          matcher: "probe_tool",
          hooks: [hookDefinition(log, "c-long", ["--pid", pidPath, "--sleep", "30000"])],
        },
      ],
    }),
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "hooks-cancel");
    const errors: unknown[] = [];
    host.ctx.on("agent/error", ({ error }) => errors.push(error));
    host.adapter.queue(
      toolCallChunks([{ id: "cancel-call", name: "probe_tool", args: {} }]),
      textChunks("must not be requested"),
    );
    handle.agent.followup(userMessage("cancel turn"));
    await waitFor(() => existsSync(pidPath), "long hook pid file");
    const pid = Number(readFileSync(pidPath, "utf8"));
    check(Number.isSafeInteger(pid) && pid > 0, "hook pid must be recorded");
    check(isProcessAlive(pid), "hook process must be alive before cancel");

    handle.agent.cancel({ kind: "user" });
    await waitFor(() => handle!.agent.status === "idle", "cancel turn idle", 30_000);
    await waitFor(() => !isProcessAlive(pid), "hook process terminated after cancel");
    await host.hooks.whenIdle();
    check(lastTurnEndReason(handle.agent) === "aborted", "cancelled turn must end aborted");
    check(errors.length === 0, "cancel must not emit agent/error");
    check(host.toolState.executions === 0, "cancelled hook must prevent tool execution");
    check(pluginLogs(host, "hook.run.failed").some((entry) => entry.outcome === "cancelled"), "cancel must be logged as cancelled");
    check(host.adapter.pending() === 1, "cancelled turn must not consume the next scripted request");
    console.log("[workspace-hooks] c ✓ agent.cancel 终止 hook 子进程，turn aborted、无 agent/error、工具零执行");
  } finally {
    handle?.agent.cancel({ kind: "user" });
    await handle?.dispose();
    await host.dispose();
  }

  // 超时同样必须 kill 子进程，且失败不阻断动作。
  const timeoutWorkspace = makeWorkspace(root, "timeout-workspace");
  const timeoutLog = join(root, "timeout-hook.log");
  const timeoutPidPath = join(root, "timeout-hook.pid");
  const timeoutHook = hookDefinition(timeoutLog, "c-timeout", [
    "--pid",
    timeoutPidPath,
    "--sleep",
    "30000",
  ]);
  timeoutHook.timeoutMs = 150;
  const timeoutHost = await createHost({
    workspace: timeoutWorkspace,
    hooksConfig: configWithEvents(timeoutLog, {
      PreToolUse: [{ matcher: "probe_tool", hooks: [timeoutHook] }],
    }),
  });
  let timeoutHandle: AgentHandle | undefined;
  try {
    timeoutHandle = await createAgent(timeoutHost, "hooks-timeout");
    timeoutHost.adapter.queue(
      toolCallChunks([{ id: "timeout-call", name: "probe_tool", args: {} }]),
      textChunks("timeout done"),
    );
    await runTurn(timeoutHost, timeoutHandle.agent, "timeout turn");
    const pid = existsSync(timeoutPidPath) ? Number(readFileSync(timeoutPidPath, "utf8")) : 0;
    check(pid > 0, "timeout hook pid must be recorded");
    await waitFor(() => !isProcessAlive(pid), "hook process terminated after timeout");
    check(timeoutHost.toolState.executions === 1, "timed-out hook must not block the tool");
    check(
      pluginLogs(timeoutHost, "hook.run.failed").some((entry) => entry.outcome === "timed_out"),
      "timeout must be logged",
    );
    console.log("[workspace-hooks] c2 ✓ hook 超时终止子进程，动作继续");
  } finally {
    await timeoutHandle?.dispose();
    await timeoutHost.dispose();
  }
}

/** d：未信任来源不执行，动作照常完成，日志记录拒绝。 */
async function untrustedScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "untrusted-workspace");
  const log = join(root, "untrusted-hook.log");
  const trustedLog = join(root, "trusted-hook.log");
  const host = await createHost({
    workspace,
    hooksConfig: {
      sources: [
        {
          trusted: true,
          hooks: {
            enabled: true,
            events: {
              SessionStart: [{ hooks: [hookDefinition(trustedLog, "d-trusted")] }],
            },
          },
        },
        {
          trusted: false,
          hooks: {
            enabled: true,
            events: {
              UserPromptSubmit: [
                { hooks: [hookDefinition(log, "d-untrusted", ["--block"])] },
              ],
            },
          },
        },
      ],
    },
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "hooks-untrusted");
    host.adapter.queue(textChunks("untrusted ignored"));
    const requests = await runTurn(host, handle.agent, "untrusted turn");
    check(requests.length === 1, "untrusted hook must not block the turn");
    check(lastTurnEndReason(handle.agent) === "completed", "turn must complete despite untrusted hook");
    check(readHookLog(log).length === 0, "untrusted hook command must never run");
    check(readHookLog(trustedLog).length === 1, "trusted source must still run");
    const rejected = pluginLogs(host, "hook.trust.rejected");
    check(rejected.length >= 1, "untrusted rejection must be logged");
    check(
      rejected.some((entry) => String(entry.hookEventName) === "UserPromptSubmit"),
      "trust rejection log must identify the hook event",
    );
    console.log("[workspace-hooks] d ✓ 未信任条目拒绝执行并记录，动作照常完成");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** e：未知事件/未知 type/非法 matcher/PermissionRequest 导入即拒绝并列出。 */
function importRejectionScenario(root: string): void {
  const cases: Array<{
    name: string;
    config: WorkspaceHooksPluginConfig;
    assert(error: WorkspaceHooksImportError): void;
  }> = [
    {
      name: "unknown event",
      config: {
        trusted: true,
        config: {
          enabled: true,
          events: { Notification: [{ hooks: [{ type: "command", command: "true" }] }] },
        },
      },
      assert(error) {
        check(error.unknownEventTypes.includes("Notification"), "error must list Notification");
        check(error.message.includes("Notification"), "error message must name Notification");
      },
    },
    {
      name: "unknown hook type",
      config: {
        trusted: true,
        config: {
          enabled: true,
          events: {
            PreToolUse: [{ hooks: [{ type: "webhook", command: "true" } as never] }],
          },
        },
      },
      assert(error) {
        check(error.unknownHookTypes.includes("webhook"), "error must list webhook");
        check(error.message.includes("webhook"), "error message must name webhook");
      },
    },
    {
      name: "invalid matcher",
      config: {
        trusted: true,
        config: {
          enabled: true,
          events: {
            PreToolUse: [{ matcher: "[unclosed", hooks: [{ type: "command", command: "true" }] }],
          },
        },
      },
      assert(error) {
        check(error.invalidMatchers.length === 1, "error must list the invalid matcher");
        check(error.message.includes("invalid matchers"), "error message must name invalid matchers");
      },
    },
    {
      name: "unmapped PermissionRequest",
      config: {
        trusted: true,
        config: {
          enabled: true,
          events: {
            PermissionRequest: [{ hooks: [{ type: "command", command: "true" }] }],
          },
        },
      },
      assert(error) {
        check(
          error.unmappedEventTypes.includes("PermissionRequest"),
          "error must list PermissionRequest as unmapped",
        );
        check(error.message.includes("PermissionRequest"), "error message must name PermissionRequest");
      },
    },
  ];

  for (const testCase of cases) {
    let captured: unknown;
    try {
      importWorkspaceHooks(testCase.config);
    } catch (error) {
      captured = error;
    }
    check(
      captured instanceof WorkspaceHooksImportError,
      `${testCase.name} must throw WorkspaceHooksImportError`,
    );
    testCase.assert(captured);
  }

  // 文件来源形态：受信 JSON 文件可导入，实际条目数可读。
  const configPath = join(root, "workspace-hooks.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      events: {
        PreToolUse: [{ matcher: "probe_tool", hooks: [{ type: "command", command: "true" }] }],
      },
    }),
    "utf8",
  );
  const imported = importWorkspaceHooks({ configPath, trusted: true });
  check(imported.enabled, "file config must import as enabled");
  check((imported.hooksByEvent.PreToolUse ?? []).length === 1, "file config must import one hook");
  check(imported.hooksByEvent.PreToolUse[0]!.trusted, "trusted file source must mark the hook trusted");
  const untrustedFile = importWorkspaceHooks({ configPath });
  check(!untrustedFile.hooksByEvent.PreToolUse[0]!.trusted, "default source trust must be false");
  console.log("[workspace-hooks] e ✓ 未知事件/未知 type/非法 matcher/PermissionRequest 拒绝并列出；文件来源可导入");
}

/** f：追加上下文进入下一请求，且不走 systemPrompt（与 T18 召回解耦）。 */
async function injectionScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "injection-workspace");
  const log = join(root, "injection-hook.log");
  const host = await createHost({
    workspace,
    hooksConfig: configWithEvents(log, {
      SessionStart: [
        { hooks: [hookDefinition(log, "f-session", ["--context", "SESSION-CONTEXT"])] },
      ],
      UserPromptSubmit: [
        { hooks: [hookDefinition(log, "f-prompt", ["--context", "USER-PROMPT-CONTEXT"])] },
      ],
      PostToolUse: [
        {
          matcher: "probe_tool",
          hooks: [hookDefinition(log, "f-post", ["--context", "POST-TOOL-CONTEXT"])],
        },
      ],
      Stop: [{ hooks: [hookDefinition(log, "f-stop", ["--context", "STOP-CONTEXT"])] }],
    }),
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "hooks-injection");
    host.adapter.queue(
      toolCallChunks([{ id: "inject-call", name: "probe_tool", args: {} }]),
      textChunks("post context done"),
    );
    const first = await runTurn(host, handle.agent, "injection turn");
    check(first.length === 2, `injection turn must issue 2 requests, got ${first.length}`);
    const firstText = requestText(first[0]!);
    check(firstText.includes("SESSION-CONTEXT"), "SessionStart context must enter the first request");
    check(firstText.includes("USER-PROMPT-CONTEXT"), "UserPromptSubmit context must enter the request");
    const secondText = requestText(first[1]!);
    check(secondText.includes("POST-TOOL-CONTEXT"), "PostToolUse context must enter the next request");
    check(!requestSystemText(first[1]!).includes("POST-TOOL-CONTEXT"), "injection must not use the systemPrompt seam");

    host.adapter.queue(textChunks("after stop"));
    const nextTurn = await runTurn(host, handle.agent, "after stop turn");
    check(nextTurn.length === 1, "next turn must issue one request");
    check(
      requestText(nextTurn[0]!).includes("STOP-CONTEXT"),
      "Stop context must reach the next turn's request",
    );
    console.log("[workspace-hooks] f ✓ SessionStart/UserPromptSubmit/PostToolUse/Stop 注入进入下一请求，且未使用 systemPrompt");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** g：覆盖声明验证 —— tools/pre-execute 只对应 PreToolUse。 */
function coverageScenario(): void {
  check(
    WORKSPACE_HOOK_SEAMS.PreToolUse === "tools/pre-execute",
    "PreToolUse must map to tools/pre-execute",
  );
  const mappedEvents = WORKSPACE_HOOK_COVERAGE.mapped.map((entry) => entry.event);
  const unmappedEvents = WORKSPACE_HOOK_COVERAGE.unmapped.map((entry) => entry.event);
  check(
    WORKSPACE_HOOK_EVENT_NAMES.every(
      (event) =>
        (mappedEvents as string[]).includes(event) ||
        (unmappedEvents as string[]).includes(event),
    ),
    "every ZCode hook event must be either mapped or explicitly unmapped",
  );
  check(
    unmappedEvents.includes("PermissionRequest"),
    "PermissionRequest must be declared unmapped",
  );
  check(
    WORKSPACE_HOOK_COVERAGE.statement.includes("only PreToolUse"),
    "coverage statement must deny whole-vocabulary equivalence",
  );
  check(
    (WORKSPACE_HOOK_SEAMS as Record<string, string>).PermissionRequest === undefined,
    "PermissionRequest must not be in the mapping table",
  );
  console.log("[workspace-hooks] g ✓ 覆盖声明：tools/pre-execute 只覆盖 PreToolUse，PermissionRequest 明确未映射");
}

/** h：subprocess 缺席降级；dispose 终止在途进程。 */
async function lifecycleScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "degraded-workspace");
  const log = join(root, "degraded-hook.log");
  const degradedHost = await createHost({
    workspace,
    subprocess: false,
    hooksConfig: configWithEvents(log, {
      UserPromptSubmit: [{ hooks: [hookDefinition(log, "h-degraded")] }],
      PreToolUse: [{ matcher: "probe_tool", hooks: [hookDefinition(log, "h-degraded-pre")] }],
    }),
  });
  let degradedHandle: AgentHandle | undefined;
  try {
    check(degradedHost.hooks.degraded, "plugin must degrade without subprocess");
    check(degradedHost.hooks.registeredSeams.length === 0, "degraded plugin must register no seams");
    check(
      pluginLogs(degradedHost, "hook.runtime.degraded").length === 1,
      "degradation must be logged",
    );
    degradedHandle = await createAgent(degradedHost, "hooks-degraded");
    degradedHost.adapter.queue(
      toolCallChunks([{ id: "degraded-call", name: "probe_tool", args: {} }]),
      textChunks("degraded done"),
    );
    const requests = await runTurn(degradedHost, degradedHandle.agent, "degraded turn");
    check(requests.length === 2, "turn must complete without hook execution");
    check(degradedHost.toolState.executions === 1, "tool must run normally when hooks degrade");
    check(!existsSync(log), "degraded plugin must not execute hook commands");
    const disposed = await Promise.race([
      degradedHost.plugin.dispose().then(() => true),
      sleep(3_000).then(() => false),
    ]);
    check(disposed, "degraded plugin dispose must settle");
    console.log("[workspace-hooks] h1 ✓ subprocess 缺席：不注册执行接缝、动作照常、dispose 收口");
  } finally {
    await degradedHandle?.dispose();
    await degradedHost.dispose();
  }

  const disposeWorkspace = makeWorkspace(root, "dispose-workspace");
  const disposeLog = join(root, "dispose-hook.log");
  const pidPath = join(root, "dispose-hook.pid");
  const disposeHost = await createHost({
    workspace: disposeWorkspace,
    hooksConfig: configWithEvents(disposeLog, {
      PreToolUse: [
        {
          matcher: "probe_tool",
          hooks: [hookDefinition(disposeLog, "h-dispose", ["--pid", pidPath, "--sleep", "30000"])],
        },
      ],
    }),
  });
  let disposeHandle: AgentHandle | undefined;
  try {
    disposeHandle = await createAgent(disposeHost, "hooks-dispose");
    disposeHost.adapter.queue(
      toolCallChunks([{ id: "dispose-call", name: "probe_tool", args: {} }]),
      textChunks("must not be requested"),
    );
    disposeHandle.agent.followup(userMessage("dispose turn"));
    await waitFor(() => existsSync(pidPath), "dispose long hook pid file");
    const pid = Number(readFileSync(pidPath, "utf8"));
    check(isProcessAlive(pid), "dispose hook process must be alive before unload");

    const disposed = await Promise.race([
      disposeHost.plugin.dispose().then(() => true),
      sleep(5_000).then(() => false),
    ]);
    check(disposed, "plugin dispose must settle while a hook process is running");
    await waitFor(() => !isProcessAlive(pid), "hook process terminated on dispose");
    console.log("[workspace-hooks] h2 ✓ dispose 终止在途 hook 进程并收口，无悬挂进程");
  } finally {
    disposeHandle?.agent.cancel({ kind: "user" });
    await disposeHandle?.dispose();
    await disposeHost.dispose();
  }
}

mkdirSync(EVIDENCE_ROOT, { recursive: true });
const root = mkdtempSync(join(EVIDENCE_ROOT, "run-"));
try {
  await triggerScenario(root);
  await blockScenario(root);
  await cancelScenario(root);
  await untrustedScenario(root);
  importRejectionScenario(root);
  await injectionScenario(root);
  coverageScenario();
  await lifecycleScenario(root);
  rmSync(root, { recursive: true, force: true });
  console.log("[workspace-hooks] PASS: a–h 全部通过");
} catch (error) {
  console.error("[workspace-hooks] FAIL:", error);
  process.exit(1);
}
