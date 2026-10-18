/**
 * 引用、产物与诊断集成探针（T21）。
 *
 * 用真实钉版 dsh 插件 + mock adapter 验证：
 * a. session 引用（sessionQuery + session-reference）：canonical mention 进入请求，
 *    快照以 durable user/message 记录引用目标；
 * b. file 引用回归：@mention 保真 + read 跟进（T09 手法抽样）；
 * c. present 产物：dsh 工具管线可见、调用成功、`deliverables/presented` 可回溯；
 * d. 日志关联：引擎日志的 traceId/queryId/turnId/turnNumber 原样进入 dsh 日志上下文，
 *    并可按 sessionId + turn 映射到 dsh 请求记录（request/header、step）；
 * e. 未知引擎事件：真实事件桥计数、经 dsh 日志面可见、会话不炸；
 * f. 无消费者决策：本仓不注册 sample/connectivity 宿主辅助命令。
 *
 * 边界：不接 ZCode 原生 collector/trace UI 协议。本探针只证明同一请求在
 * 引擎日志（trace 字段）与 dsh 请求记录（session/turn/step）之间可互查。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import LocalFileReference, {
  FILE_REFERENCE_PROMPT,
  formatFileMention,
} from "@deepseek-ai/dsh-file-reference-local";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, RequestMessage, StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SqliteSessionQuery from "@deepseek-ai/dsh-session-query-sqlite";
import SessionReferenceResolver, {
  formatSessionReferenceMention,
} from "@deepseek-ai/dsh-session-reference";
import * as ToolPresent from "@deepseek-ai/dsh-tool-present";
import type {} from "@deepseek-ai/dsh-tool-present/types";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";

import ZcodeLoop from "../src/index.js";

// ------------------------------------------------------------------
// scripted adapter
// ------------------------------------------------------------------

interface Step {
  /** 本步模型可见工具名（顺序无关）。 */
  tools: readonly string[];
  /** 以该工具调用收步；缺席则输出文本。 */
  call?: { name: string; input?: Record<string, unknown> };
  /** 对本次模型请求的断言。 */
  check?: (request: GenerateOptions) => void;
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly failures: string[] = [];
  steps: Step[] = [];

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const step = this.steps.shift();
    assert(step, "unexpected model request");
    try {
      assert.deepEqual(
        (options.tools ?? []).map((tool) => tool.name).sort(),
        [...step.tools].sort(),
        "model must see exactly the current dsh tool surface",
      );
      step.check?.(options);
    } catch (error) {
      this.failures.push(String(error));
      throw error;
    }
    if (step.call !== undefined) {
      const id = ToolCallId(`references-call-${this.requests.length}`);
      const args = JSON.stringify(step.call.input ?? {});
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index: 0,
        id,
        name: step.call.name,
        argumentsDelta: args,
      };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id, name: step.call.name, arguments: args },
      };
    } else {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "references step complete" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "text", text: "references step complete" },
      };
    }
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", reason: { kind: step.call === undefined ? "stop" : "tool-calls" } };
  }
}

// ------------------------------------------------------------------
// harness
// ------------------------------------------------------------------

interface HarnessOptions {
  sessionReference?: boolean;
  fileReference?: boolean;
  present?: boolean;
  commands?: boolean;
  captureLogs?: boolean;
}

interface CapturedLog {
  name: string;
  type: string;
  line: string;
}

interface Harness {
  ctx: Context;
  adapter: ScriptedAdapter;
  logs: CapturedLog[];
}

/** 最小 dsh 服务栈；各能力插件按场景独立挂载。 */
async function createHarness(workspace: string, options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context();
  const logs: CapturedLog[] = [];
  if (options.captureLogs === true) {
    ctx.logger.exporter({
      levels: { default: 3 },
      export(message) {
        logs.push({
          name: message.name,
          type: message.type,
          line: message.args
            .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
            .join(" "),
        });
      },
    });
  }
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(SessionProjection);
  await ctx.plugin(LocalFileSystem, { cwd: workspace });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace });
  await ctx.plugin(AgentRegistry);
  if (options.commands === true) await ctx.plugin(CommandRuntime);
  if (options.sessionReference === true) {
    await ctx.plugin(SqliteSessionQuery, { path: ":memory:", openAt: "never" });
    await ctx.plugin(
      SessionReferenceResolver as unknown as Plugin.Object<{ maxReferenceBytes: number }>,
      { maxReferenceBytes: 65_536 },
    );
  }
  if (options.fileReference === true) await ctx.plugin(LocalFileReference, { maxResults: 20 });
  if (options.present === true) await ctx.plugin(ToolPresent as unknown as Plugin);
  await ctx.plugin(ZcodeLoop, { provider: "mock", model: "mock" });
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter(["mock"], adapter);
  return { ctx, adapter, logs };
}

async function createAgent(
  ctx: Context,
  id: string,
  workspace: string,
): Promise<AgentHandle> {
  return ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: workspace },
    agentOptions: { provider: "mock", model: "mock" },
  });
}

function messageText(message: RequestMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

function textOf(request: GenerateOptions, role?: RequestMessage["role"]): string {
  return request.messages
    .filter((message) => role === undefined || message.role === role)
    .map(messageText)
    .join("\n");
}

/** 跑一个 turn：脚本必须正好消费 steps，且 adapter 未记录断言失败。 */
async function runTurn(
  agent: Agent,
  adapter: ScriptedAdapter,
  steps: Step[],
  input: string,
): Promise<GenerateOptions[]> {
  adapter.steps = [...steps];
  const before = adapter.requests.length;
  agent.followup(createUserMessage({ content: [{ type: "text", text: input }], source: { kind: "user" } }));
  await agent.whenIdle();
  assert.equal(adapter.failures.length, 0, adapter.failures.join("\n"));
  assert.equal(adapter.steps.length, 0, `script must drain exactly; ${adapter.steps.length} step(s) left`);
  const requests = adapter.requests.slice(before);
  assert.equal(requests.length, steps.length, "each scripted step must produce exactly one model request");
  return requests;
}

async function makeWorkspace(root: string, name: string): Promise<string> {
  const workspace = join(root, name);
  await mkdir(join(workspace, ".git"), { recursive: true });
  // macOS /var 是 /private/var 的符号链接：fs provider 的 targetKey 是 realpath，
  // 统一到真实路径再比较，避免断言被平台别名误导。
  return realpath(workspace);
}

function userMessageSources(agent: Agent) {
  return agent.session
    .snapshotEvents()
    .filter((event) => event.type === "user/message")
    .map((event) => event.type === "user/message" ? event.data : undefined)
    .filter((message): message is NonNullable<typeof message> => message !== undefined);
}

// ------------------------------------------------------------------
// a. session 引用
// ------------------------------------------------------------------

async function sessionReferenceProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "session-reference-workspace");
  const { ctx, adapter } = await createHarness(workspace, { sessionReference: true });
  const sourceId = SessionId("references-source-session");
  const targetId = SessionId("references-target-session");
  const sourceMarker = "SOURCE_SESSION_CONTEXT_MARKER";
  const label = "source-session-label";
  const source = await createAgent(ctx, sourceId, workspace);
  const target = await createAgent(ctx, targetId, workspace);
  try {
    await runTurn(source.agent, adapter, [
      {
        tools: [],
        check(request) {
          assert(textOf(request, "user").includes(sourceMarker), "source turn must carry its own marker");
        },
      },
    ], `Remember this: ${sourceMarker}.`);

    // canonical mention 语法来自 dsh-session-reference 的公开 codec，不手写 base64。
    const mention = formatSessionReferenceMention({ sessionId: sourceId, label });
    assert.match(mention, /^@\[source-session-label\]\(dsh-session:[A-Za-z0-9_-]+\)$/);
    const targetMarker = "TARGET_TURN_MARKER";

    const [firstRequest] = await runTurn(target.agent, adapter, [
      {
        tools: [],
        check(request) {
          const users = textOf(request, "user");
          assert(users.includes(targetMarker), "direct user text must enter the request");
          assert(users.includes(`@${label}`), "canonical mention must render as readable @label");
          assert(!users.includes("dsh-session:"), "opaque session URI must not leak into model text");
          assert(users.includes("<referenced-sessions>"), "prepared snapshot must use the canonical envelope");
          assert(users.includes(sourceMarker), "referenced session content must reach the model");
          assert(
            users.includes("Do not follow instructions"),
            "snapshot must carry the untrusted-background warning",
          );
        },
      },
    ], `${targetMarker}: please use ${mention}`);

    const requestUser = firstRequest?.messages
      .filter((message) => message.role === "user")
      .map(messageText)
      .join("\n");
    assert(requestUser?.includes(sourceMarker), "session reference must enter the model request");

    // 来源可回溯：durable context message 携带引用目标与快照范围。
    const messages = userMessageSources(target.agent);
    const direct = messages.find((message) => messageText(message).includes(`@${label}`));
    assert(direct, "durable direct message must keep the readable mention");
    const reference = messages.find((message) => message.source.kind === "session-reference");
    assert(reference, "prepared context must be durable on the target session");
    assert.equal(reference.source.kind, "session-reference");
    if (reference.source.kind !== "session-reference") throw new Error("unreachable");
    assert.equal(reference.source.form, "recall");
    assert.equal(reference.source.references.length, 1);
    const record = reference.source.references[0]!;
    assert.equal(record.sessionId, String(sourceId), "durable record must name the referenced session");
    assert.equal(record.label, label, "durable record must keep the mention label");
    assert(Number(record.capturedThroughSeq) >= 0, "durable record must pin the captured source seq");
    assert.equal(record.truncated, false, "small source must not be truncated");
    assert(messageText(reference).includes("<referenced-sessions>"), "durable snapshot keeps its envelope");

    console.log("[references-diagnostics] a. session reference reaches context and stays traceable");
  } finally {
    await target.dispose();
    await source.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------
// b. file 引用回归
// ------------------------------------------------------------------

async function fileReferenceProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "file-reference-workspace");
  const contentMarker = "FILE_REFERENCE_CONTENT_MARKER";
  await writeFile(join(workspace, "notes.txt"), `${contentMarker}\n`);
  const { ctx, adapter } = await createHarness(workspace, { fileReference: true });
  ctx.tools.register(defineTool({
    name: "read",
    description: "Read a workspace file as UTF-8 text.",
    parameters: { file_path: { type: "string", required: true } },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    execute: async (args) => readFile(resolve(workspace, String((args as { file_path: string }).file_path)), "utf8"),
  }));
  const handle = await createAgent(ctx, "references-file", workspace);
  try {
    const signal = new AbortController().signal;
    const candidate = (await ctx.fileReferences.list(handle.agent, "notes", signal))
      .find((entry) => entry.path === "notes.txt");
    assert(candidate, "local file-reference discovery must return notes.txt");
    const mention = formatFileMention(candidate, false);
    assert.equal(mention, "@notes.txt");

    await runTurn(handle.agent, adapter, [
      {
        tools: ["read"],
        call: { name: "read", input: { file_path: "notes.txt" } },
        check(request) {
          const users = textOf(request, "user");
          assert(users.includes(mention), "plain @mention must enter the request verbatim");
          assert(
            textOf(request, "system").includes(FILE_REFERENCE_PROMPT),
            "the provider's reference guidance must be present while read is visible",
          );
        },
      },
      {
        tools: ["read"],
        check(request) {
          assert(
            textOf(request, "tool").includes(contentMarker),
            "the referenced file content must remain usable in the next request",
          );
        },
      },
    ], `Please inspect ${mention}.`);
    console.log("[references-diagnostics] b. file reference mention and read follow-up passed");
  } finally {
    await handle.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------
// c. present 产物
// ------------------------------------------------------------------

async function presentProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "present-workspace");
  const absolute = join(workspace, "deliverable.md");
  const description = "probe deliverable";
  await writeFile(absolute, "# Deliverable\n\nPRESENT_CONTENT_MARKER\n");
  const { ctx, adapter } = await createHarness(workspace, { present: true });
  const handle = await createAgent(ctx, "references-present", workspace);
  try {
    const [firstRequest] = await runTurn(handle.agent, adapter, [
      {
        tools: ["present"],
        call: {
          name: "present",
          input: { files: [{ path: "deliverable.md", description }] },
        },
        check(request) {
          const schema = (request.tools ?? []).find((tool) => tool.name === "present");
          assert(schema, "present must be visible on the dsh tool surface");
          assert.match(schema.description ?? "", /final deliverables/);
        },
      },
      {
        tools: ["present"],
        check(request) {
          const toolText = textOf(request, "tool");
          assert(toolText.includes(`Presented ${absolute}`), "present result must name the absolute source path");
        },
      },
    ], "present the deliverable");
    assert(firstRequest, "present call must produce a request");

    const toolResults = handle.agent.session
      .snapshotEvents()
      .filter((event) => event.type === "tool/result");
    const result = toolResults.at(-1);
    assert(result?.type === "tool/result", "present must produce a durable tool/result");
    assert.equal(result.data.message.isError, false);
    assert.equal(
      messageText(result.data.message as unknown as RequestMessage),
      `Presented ${absolute}`,
      "durable result must keep the plugin's render text",
    );

    const delivered = handle.agent.session
      .snapshotEvents()
      .filter((event) => event.type === "deliverables/presented");
    assert.equal(delivered.length, 1, "successful final present result must append one declaration");
    const event = delivered[0]!;
    assert.equal(event.type, "deliverables/presented");
    assert.equal(Number(event.data.turn), 1, "delivery belongs to the open turn");
    assert.equal(String(event.data.callId), String(result.data.message.toolCallId));
    assert.deepEqual(event.data.files, [{ path: absolute, description }]);
    await readFile(event.data.files[0]!.path, "utf8");

    console.log("[references-diagnostics] c. present delivery goes through the dsh tool pipeline");
  } finally {
    await handle.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------
// d. 日志关联
// ------------------------------------------------------------------

/** 从日志行尾部解析结构化 context（adapter 以单行 JSON 拼接）。 */
function contextOf(line: string): Record<string, unknown> | undefined {
  const start = line.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(line.slice(start)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function logCorrelationProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "log-correlation-workspace");
  const { ctx, adapter, logs } = await createHarness(workspace, { captureLogs: true });
  const handle = await createAgent(ctx, "references-log", workspace);
  try {
    await runTurn(handle.agent, adapter, [{ tools: [] }], "log correlation turn");

    const engineSessionId = `sess_${String(handle.agent.id)}`;
    const requestLogs = logs
      .map((entry) => ({ entry, context: contextOf(entry.line) }))
      .filter(({ context }) => context?.event === "model.request.started");
    assert.equal(requestLogs.length, 1, "one model step must emit one model-request log line");
    const context = requestLogs[0]!.context!;
    assert.equal(context.sessionId, engineSessionId, "engine log must carry the session correlation id");
    assert.equal(typeof context.traceId, "string", "engine log must carry traceId");
    assert.equal(typeof context.queryId, "string", "engine log must carry queryId");
    assert.equal(typeof context.turnId, "string", "engine log must carry turnId");
    assert.equal(context.turnNumber, 0, "engine turnNumber must stay verbatim (zero-based)");
    assert.equal(typeof context.spanId, "string", "engine log must carry spanId");
    assert.equal(
      requestLogs[0]!.entry.name,
      `zcode-loop:${String(handle.agent.id).slice(0, 8)}`,
      "engine logs must use the plugin's dsh logger name",
    );

    // 同一请求的后续日志行共享 traceId/queryId/turnId（trace 关联，而非 collector 协议）。
    const sameTurn = logs
      .map((entry) => contextOf(entry.line))
      .filter((value): value is Record<string, unknown> =>
        value !== undefined
        && value.sessionId === engineSessionId
        && value.turnId === context.turnId);
    assert(
      sameTurn.length >= 2,
      "the same engine turn must produce several correlated log lines",
    );
    assert(
      sameTurn.every((value) => value.traceId === context.traceId && value.queryId === context.queryId),
      "traceId/queryId must be stable across one turn's log lines",
    );

    // dsh 侧请求记录：engine turnNumber 0 ↔ dsh turn 1；request/header 落在该 turn 的 step 内。
    const events = handle.agent.session.snapshotEvents();
    const turnStart = events.find((event) => event.type === "turn/start");
    assert(turnStart?.type === "turn/start");
    assert.equal(turnStart.data.turn, Number(context.turnNumber) + 1, "engine turnNumber maps to dsh turn");
    const stepStart = events.find((event) => event.type === "step/start");
    assert(stepStart?.type === "step/start");
    assert.equal(stepStart.data.turn, turnStart.data.turn);
    assert.equal(stepStart.data.step, 1);
    const header = events.find((event) => event.type === "request/header");
    assert(header?.type === "request/header", "the same model step must log a request/header");
    assert(header.seq > stepStart.seq && header.seq < (events.find((event) =>
      event.type === "step/end" && event.data.turn === turnStart.data.turn)?.seq ?? Infinity),
      "request/header must sit inside the same dsh step");
    assert.equal(header.data.header.config.provider, "mock");
    assert.equal(header.data.header.config.model, "mock");

    console.log("[references-diagnostics] d. engine trace fields and dsh request records correlate one turn");
  } finally {
    await handle.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------
// e. 未知引擎事件
// ------------------------------------------------------------------

async function unknownEventProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "unknown-event-workspace");
  const { ctx, adapter, logs } = await createHarness(workspace, { captureLogs: true });
  const handle = await createAgent(ctx, "references-unknown", workspace);
  const unknownType = "probe_unknown_engine_event";
  try {
    await runTurn(handle.agent, adapter, [{ tools: [] }], "turn before the unknown event");

    const view = ctx.zcodeLoopRuntimes.resolve(handle.agent);
    const engineSessionId = `sess_${String(handle.agent.id)}`;
    const traceId = "trace_unknown_probe";
    const turnId = "turn_unknown_probe";
    const unknownEvent = {
      id: "evt_unknown_probe",
      sessionId: engineSessionId,
      turnId,
      type: unknownType,
      timestamp: new Date(),
      traceId,
      sequenceNumber: 0,
      payload: { marker: "UNKNOWN_EVENT_MARKER" },
    };
    // 未知类型不属于引擎 closed union；探针按真实事件形状注入，验证桥的丢弃计数。
    await view.runtime.appendEvent(unknownEvent as never, {
      traceId,
      turnId,
      sessionId: engineSessionId,
    } as never);

    const eventsAfterInjection = handle.agent.session.snapshotEvents();
    assert(
      !eventsAfterInjection.some((event) => (event.type as string) === unknownType),
      "unknown engine events must never reach the dsh session log",
    );

    // 下一 turn 收口时 drain 会把 dropStats 打到 dsh 日志面，且会话继续可用。
    await runTurn(handle.agent, adapter, [{ tools: [] }], "turn after the unknown event");
    const dropStats = logs
      .map((entry) => contextOf(entry.line))
      .filter((value): value is Record<string, unknown> =>
        value !== undefined && "unknownTypes" in value);
    assert(dropStats.length >= 1, "drop stats must be visible on the dsh log surface");
    const unknownTypes = dropStats.at(-1)!.unknownTypes as Record<string, number>;
    assert.equal(unknownTypes[unknownType], 1, "unknownTypes must count the injected event");

    const ends = handle.agent.session.snapshotEvents().filter((event) => event.type === "turn/end");
    assert.equal(ends.length, 2, "both turns must close durably");
    assert(
      ends.every((event) => event.type === "turn/end" && event.data.reason.kind === "completed"),
      "the unknown event must not break the session",
    );

    console.log("[references-diagnostics] e. unknown engine event is counted, logged and harmless");
  } finally {
    await handle.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------
// f. 无消费者决策
// ------------------------------------------------------------------

async function hostHelperCommandProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "host-helper-workspace");
  const { ctx } = await createHarness(workspace, { commands: true });
  const handle = await createAgent(ctx, "references-commands", workspace);
  try {
    const names = ctx.commands.list(handle.agent).map((command) => command.name);
    // sample/connectivity 等宿主辅助调用复用 dsh llm；无消费者时不注册命令。
    assert(!names.includes("sample"), "sample command must not be registered without a consumer");
    assert(!names.includes("connectivity"), "connectivity command must not be registered without a consumer");
    assert(
      !names.some((name) => /sample|connectivity/i.test(name)),
      `host helper commands must stay absent: ${names.join(",")}`,
    );
    console.log("[references-diagnostics] f. no sample/connectivity host-helper command is registered");
  } finally {
    await handle.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("[references-diagnostics] FAIL: watchdog expired");
    process.exit(1);
  }, 90_000);
  watchdog.unref();
  const root = await mkdtemp(join(tmpdir(), "dsh-references-diagnostics-"));
  try {
    await sessionReferenceProbe(root);
    await fileReferenceProbe(root);
    await presentProbe(root);
    await logCorrelationProbe(root);
    await unknownEventProbe(root);
    await hostHelperCommandProbe(root);
  } finally {
    clearTimeout(watchdog);
    await rm(root, { recursive: true, force: true });
  }
  console.log("[references-diagnostics] PASS: a-f references, present, logs and diagnostics verified");
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error("[references-diagnostics] FAIL:", error);
  process.exit(1);
});
