/**
 * S02 集成自证脚本（AC 1–4，边界样例 1/2）：
 *
 * 环境：`new Context()`（npm @deepseek-ai/cordis）+ npm 装 `dsh-llm`/`dsh-session`
 * + fake llm adapter（注册写法照抄 reference 下 dsh agent-loop 测试的 MockAdapter）。
 *
 * AC1 fake adapter 脚本化「文本+工具调用」→ 文本；工具经最小 registry 执行；turn 完成。
 * AC2 dsh Session log 事件序列合法（turn 配对、tool call/result 配对）。
 * AC3 session.deriveMessages() 与引擎实际发出的 provider 请求消息结构一致
 *     （角色/顺序/tool_call 配对；原型不做 token 级）。
 * AC4 未知事件注入 → 丢弃计数 > 0 且会话不炸。
 *
 * 附加 probe：dsh `finish{kind:'error'}` → 桥抛 `DshModelError` 且保 providerCode
 * （共享边界样例 1 的失败样例）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, {
  expandAssistantStream,
  LlmAdapter,
  ToolCallId as DshToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Session as DshSession, SessionId as DshSessionId } from "@deepseek-ai/dsh-session";

import { createDshModelBridge, DshModelError } from "../src/bridges/model-bridge.js";
import { DshSessionEventStoreBridge } from "../src/bridges/event-store-bridge.js";
import {
  createEmbeddedEngine,
  createSessionId,
  createToolRegistry,
  SessionEventType,
  type ModelRequest,
  type RuntimeModelFactory,
  type SessionEvent,
} from "../src/engine-facade.js";

// ------------------------------------------------------------------
// fake llm adapter（照抄 reference agent-loop tests/mock-adapter.ts 的写法）
// ------------------------------------------------------------------

class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];

  constructor(private readonly script: StreamChunk[][]) {
    super();
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const chunks = this.script.shift();
    if (!chunks) throw new Error("ScriptedAdapter: script exhausted");
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error("aborted");
      yield chunk;
    }
  }
}

function textThenToolCallChunks(text: string, callId: string, name: string, args: object): StreamChunk[] {
  const argumentsJson = JSON.stringify(args);
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "tool-call-delta",
      index: 1,
      id: DshToolCallId(callId),
      name,
      argumentsDelta: argumentsJson.slice(0, 5),
    },
    { type: "tool-call-delta", index: 1, id: DshToolCallId(callId), argumentsDelta: argumentsJson.slice(5) },
    {
      type: "block-end",
      index: 1,
      block: { type: "tool-call", id: DshToolCallId(callId), name, arguments: argumentsJson },
    },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    ...Array.from(text, (char): StreamChunk => ({ type: "text-delta", index: 0, text: char })),
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

// ------------------------------------------------------------------
// 引擎事件的本地结构视图（断言用）
// ------------------------------------------------------------------

interface RecordedToolCall {
  id: string;
  name: string;
  input?: unknown;
}

interface RecordedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  toolCalls?: RecordedToolCall[];
  toolCallId?: string;
  isError?: boolean;
}

function fail(message: string): never {
  console.error(`[s02] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

async function main(): Promise<void> {
  // ---- dsh 侧装配（npm 包，独立拉取）----
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  const adapter = new ScriptedAdapter([
    textThenToolCallChunks("Calling the echo tool.", "call-1", "echo_tool", { text: "hi" }),
    textChunks("Tool says: hi"),
  ]);
  ctx.llm.registerAdapter(["mock"], adapter);

  const dshSession = DshSession.create(DshSessionId("s02-zcode-loop-bridge"));

  // ---- ZCode 侧装配（全经门面 + S02 桥）----
  const sessionId = createSessionId("s02-zcode-loop");
  const bridge = new DshSessionEventStoreBridge({ session: dshSession, sessionId });
  const workingDirectory = mkdtempSync(join(tmpdir(), "zcode-loop-s02-"));

  const registry = createToolRegistry();
  const echoInputs: unknown[] = [];
  registry.register({
    capability: "test.echo",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    outputSchema: {},
    permission: {
      permission: "test.echo",
      reason: "S02 test tool",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["none"],
      denyPriority: "afterStaticAllow",
    },
    resultBudget: {
      maxInlineBytes: 65_536,
      maxModelBytes: 65_536,
      strategy: "inline",
    },
    timeout: { kind: "timed", defaultMs: 10_000, allowCallOverride: true },
    cancellation: { supported: false, cleanup: "none", userVisibleMessage: "" },
    trace: { required: true, propagateToAdapters: false, recordInput: "none", recordOutput: "none" },
    metadata: {
      name: "echo_tool",
      description: "Echo the given text back.",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      needsApproval: false,
      riskLevel: "low",
      sideEffectScope: "none",
    },
    handler: async (input: unknown) => {
      echoInputs.push(input);
      return `echo:${JSON.stringify((input as { text: string }).text)}`;
    },
  });

  const modelFactory: RuntimeModelFactory = createDshModelBridge({ ctx, provider: "mock", model: "mock" });
  const runtime = createEmbeddedEngine({
    sessionId,
    eventStore: bridge,
    modelFactory,
    workingDirectory,
    config: { modelSelection: { providerId: "mock", modelId: "mock" } },
    deps: { toolRegistry: registry },
  });

  // ---- AC1：文本 + 工具调用 + 工具执行 + turn 完成 ----
  const result = await runtime.executeTurn("please call the echo tool");
  assert(result.response === "Tool says: hi", `unexpected response: ${JSON.stringify(result.response)}`);
  assert(echoInputs.length === 1, `expected exactly one tool execution, got ${echoInputs.length}`);
  console.log(`[s02] AC1 turn completed: response=${JSON.stringify(result.response)}, tool executions=${echoInputs.length}`);

  // 引擎视角的 ZCode 事件序列（经桥进入 store 的原始事件）。
  const zcodeEvents: SessionEvent[] = await bridge.getEvents(sessionId);
  const zcodeTypes = zcodeEvents.map((event) => event.type);
  console.log(`[s02] zcode event sequence: ${zcodeTypes.join(" -> ")}`);
  assert(zcodeTypes[0] === SessionEventType.TurnStarted, "first ZCode event must be turn_started");
  assert(zcodeTypes.at(-1) === SessionEventType.TurnComplete, "last ZCode event must be turn_complete");
  const adapterCalls = adapter.requests.length;
  assert(adapterCalls === 2, `expected exactly 2 provider calls, got ${adapterCalls}`);

  // ---- AC2：dsh log 事件序列合法（turn 配对、tool call/result 配对）----
  const log = dshSession.snapshotEvents();
  const logTypes = log.map((event) => event.type);
  console.log(`[s02] dsh log sequence: ${logTypes.join(" -> ")}`);
  assert(log[0]?.type === "turn/start", "dsh log must open with turn/start");
  const turnStarts = log.filter((event) => event.type === "turn/start");
  const turnEnds = log.filter((event) => event.type === "turn/end");
  assert(
    turnStarts.length === 1 && turnEnds.length === 1,
    `turn must be paired, got ${turnStarts.length} starts / ${turnEnds.length} ends`,
  );
  if (turnStarts[0]?.type !== "turn/start" || turnEnds[0]?.type !== "turn/end") fail("unreachable");
  assert(
    turnStarts[0].data.turn === turnEnds[0].data.turn,
    `turn numbers must match: ${String(turnStarts[0].data.turn)} vs ${String(turnEnds[0].data.turn)}`,
  );
  assert(
    turnEnds[0].data.reason.kind === "completed",
    `turn must end completed, got ${JSON.stringify(turnEnds[0].data.reason)}`,
  );

  const toolCalls = log.filter((event) => event.type === "tool/call");
  const toolResults = log.filter((event) => event.type === "tool/result");
  assert(toolCalls.length === 1 && toolResults.length === 1, "exactly one tool/call and one tool/result expected");
  const toolCallEvent = toolCalls[0];
  const toolResultEvent = toolResults[0];
  if (toolCallEvent?.type !== "tool/call" || toolResultEvent?.type !== "tool/result") fail("unreachable");
  assert(
    toolCallEvent.data.callId === toolResultEvent.data.message.toolCallId,
    `tool call/result callId mismatch: ${toolCallEvent.data.callId} vs ${String(toolResultEvent.data.message.toolCallId)}`,
  );
  assert(
    toolResultEvent.sourceEventSeqs?.includes(toolCallEvent.seq) === true,
    "tool/result must cite its tool/call seq via sourceEventSeqs",
  );
  assert(
    toolCallEvent.seq < toolResultEvent.seq,
    "tool/call must be appended before its tool/result",
  );
  assert(
    toolResultEvent.data.message.isError !== true && toolResultEvent.data.error === undefined,
    "successful tool result must not carry error facts",
  );

  const assistantMessages = log.filter((event) => event.type === "assistant/message");
  assert(assistantMessages.length === 2, `expected 2 assistant/message events, got ${assistantMessages.length}`);

  // 紧凑流可展开并重组出同一内容（assistant/message 含 tool-call block 与紧凑流）。
  if (assistantMessages[0]?.type !== "assistant/message") fail("unreachable");
  const firstAssistantStream = assistantMessages[0].data.stream;
  const expanded = expandAssistantStream(firstAssistantStream);
  const blockEnds = expanded
    .map((member) => member.chunk)
    .filter((chunk): chunk is Extract<StreamChunk, { type: "block-end" }> => chunk.type === "block-end");
  const textBlock = blockEnds.find((block) => block.block.type === "text");
  const toolBlock = blockEnds.find((block) => block.block.type === "tool-call");
  assert(textBlock?.block.type === "text" && textBlock.block.text === "Calling the echo tool.", "stream must reassemble the step text");
  assert(toolBlock?.block.type === "tool-call" && toolBlock.block.name === "echo_tool", "stream must reassemble the tool-call block");
  assert(
    expanded.some((member) => member.chunk.type === "finish"),
    "assistant stream must carry a terminal finish chunk",
  );
  console.log(`[s02] AC2 dsh log legal: turn paired, tool call/result paired via sourceEventSeqs (callSeq=${String(toolCallEvent.seq)}, resultSeq=${String(toolResultEvent.seq)})`);

  // ---- AC3：deriveMessages 与引擎实际发出的 provider 请求消息结构一致 ----
  // 引擎每个请求会注入合成的 system/user 运行时附件（runtime reminder 等，
  // 只进内存请求轨迹、明确不落 session）。dsh log 持有的是持久对话骨干，因此
  // 断言形式为：derived 的消息（除末条新响应外）是请求消息的有序子序列，
  // 角色/顺序一致，assistant 的 tool_call 与 tool 的 callId 一一配对。
  const modelRequests = zcodeEvents.filter((event) => event.type === SessionEventType.ModelRequest);
  assert(modelRequests.length === 2, `expected 2 model_request events, got ${modelRequests.length}`);
  const lastRequest = modelRequests.at(-1);
  if (lastRequest === undefined) fail("unreachable");
  const recordedMessages = (lastRequest.payload as { messages: RecordedMessage[] }).messages;

  const derived = dshSession.deriveMessages();
  const derivedRoles = derived.map((message) => message.role);
  const recordedRoles = recordedMessages.map((message) => message.role);
  console.log(`[s02] provider request roles: ${recordedRoles.join(" -> ")}`);
  console.log(`[s02] dsh derived roles:      ${derivedRoles.join(" -> ")}`);

  // 末条 derived 是本轮新响应（不在请求里）；其余必须按序出现在请求中。
  assert(derived.length >= 1, "derived history must not be empty");
  const backbone = derived.slice(0, -1);
  let cursor = 0;
  for (const [derivedIndex, message] of backbone.entries()) {
    let found = -1;
    for (let i = cursor; i < recordedMessages.length; i += 1) {
      if (recordedMessages[i]?.role === message.role) {
        found = i;
        break;
      }
    }
    assert(
      found >= 0,
      `derived #${String(derivedIndex)} (role ${message.role}) has no matching request message at/after index ${String(cursor)}`,
    );
    cursor = found + 1;
  }

  // system prompt 一致：dsh system/message 的文本 = 请求首条 system 消息的文本。
  const derivedSystem = derived.find((message) => message.role === "system");
  const recordedSystem = recordedMessages.find((message) => message.role === "system");
  assert(derivedSystem !== undefined && recordedSystem !== undefined, "both sides must carry a system prompt");
  if (derivedSystem?.role === "system" && recordedSystem !== undefined) {
    const derivedSystemText = derivedSystem.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const recordedSystemText = typeof recordedSystem.content === "string" ? recordedSystem.content : "";
    assert(
      derivedSystemText === recordedSystemText,
      `system prompt mismatch: derived ${JSON.stringify(derivedSystemText.slice(0, 80))}... vs recorded ${JSON.stringify(recordedSystemText.slice(0, 80))}...`,
    );
  }

  // assistant 的 tool_call 配对 + tool 的 callId 配对（按角色在两侧各自对齐）。
  const derivedAssistants = backbone.filter((message) => message.role === "assistant");
  const recordedAssistants = recordedMessages.filter((message) => message.role === "assistant");
  assert(
    derivedAssistants.length === recordedAssistants.length,
    `assistant count mismatch: derived ${String(derivedAssistants.length)} vs recorded ${String(recordedAssistants.length)}`,
  );
  for (const [index, recorded] of recordedAssistants.entries()) {
    const message = derivedAssistants[index];
    if (message?.role !== "assistant") fail("unreachable");
    const expected = recorded.toolCalls ?? [];
    const actual = message.content.filter((block) => block.type === "tool-call");
    assert(
      actual.length === expected.length,
      `assistant #${String(index)}: tool-call block count ${String(actual.length)} != request toolCalls ${String(expected.length)}`,
    );
    for (const [callIndex, toolCall] of expected.entries()) {
      const block = actual[callIndex];
      if (block?.type !== "tool-call") fail("unreachable");
      assert(
        block.id === toolCall.id && block.name === toolCall.name,
        `assistant #${String(index)} tool-call #${String(callIndex)}: (${block.id},${block.name}) != (${toolCall.id},${toolCall.name})`,
      );
    }
  }
  const derivedTools = derived.filter((message) => message.role === "tool");
  const recordedTools = recordedMessages.filter((message) => message.role === "tool");
  assert(
    derivedTools.length === recordedTools.length,
    `tool message count mismatch: derived ${String(derivedTools.length)} vs recorded ${String(recordedTools.length)}`,
  );
  for (const [index, recorded] of recordedTools.entries()) {
    const message = derivedTools[index];
    if (message?.role !== "tool") fail("unreachable");
    assert(
      "toolCallId" in message && message.toolCallId === recorded.toolCallId,
      `tool message #${String(index)}: toolCallId ${"toolCallId" in message ? String(message.toolCallId) : "<missing>"} != ${String(recorded.toolCallId)}`,
    );
  }
  // 终轮文本：最后一条 assistant 的文本与 TurnComplete.response 一致。
  const lastDerived = derived.at(-1);
  if (lastDerived?.role !== "assistant") fail("last derived message must be the final assistant message");
  const derivedText = lastDerived.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  assert(
    derivedText === result.response,
    `final assistant text mismatch: ${JSON.stringify(derivedText)} vs ${JSON.stringify(result.response)}`,
  );
  console.log("[s02] AC3 deriveMessages matches provider request structure (roles/order/tool_call pairing)");

  // ---- AC4：未知事件注入 → 丢弃计数 > 0 且会话不炸 ----
  const statsBefore = bridge.dropStats().dropped;
  const logLengthBefore = dshSession.snapshotEvents().length;
  await bridge.append({
    id: "injected-unknown-event" as SessionEvent["id"],
    sessionId,
    type: "totally_unknown_event" as SessionEvent["type"],
    timestamp: new Date(),
    traceId: "injected-trace" as SessionEvent["traceId"],
    sequenceNumber: 0,
    payload: { nonsense: true },
  });
  const stats = bridge.dropStats();
  assert(
    stats.dropped > statsBefore,
    `unknown event must be dropped (dropped=${String(stats.dropped)}, before=${String(statsBefore)})`,
  );
  assert(stats.unknownTypes["totally_unknown_event"] === 1, "unknown type must be counted");
  assert(
    dshSession.snapshotEvents().length === logLengthBefore,
    "unknown event must not reach the dsh log",
  );
  assert(
    dshSession.deriveMessages().length === derived.length,
    "unknown event must not change derived history",
  );
  console.log(`[s02] AC4 unknown event dropped: dropped=${String(stats.dropped)}, dsh log unchanged (${String(logLengthBefore)} events)`);

  // ---- 附加 probe：dsh 终态 error finish → DshModelError 保 providerCode ----
  const errorCtx = new Context();
  await errorCtx.plugin(LlmRuntime);
  const errorAdapter = new ScriptedAdapter([
    [
      {
        type: "finish",
        reason: { kind: "error", failure: { message: "probe boom", code: "RATE_LIMIT_PROBE", status: 429 } },
      },
    ],
  ]);
  errorCtx.llm.registerAdapter(["mock"], errorAdapter);
  const errorBridge = createDshModelBridge({ ctx: errorCtx, provider: "mock", model: "mock" });
  const errorModel = errorBridge({ selection: { providerId: "mock", modelId: "mock" } });
  let caught: DshModelError | undefined;
  try {
    const request: ModelRequest = { messages: [{ role: "user", content: "probe" }] };
    for await (const _event of errorModel.streamText(request)) {
      void _event;
    }
  } catch (error) {
    if (error instanceof DshModelError) caught = error;
  }
  assert(caught !== undefined, "error finish must surface as DshModelError");
  const probeCode = caught.code;
  const probeStatus = caught.status;
  assert(probeCode === "RATE_LIMIT_PROBE" && caught.providerCode === "RATE_LIMIT_PROBE", `providerCode must survive, got ${probeCode}`);
  console.log(`[s02] probe error finish -> DshModelError providerCode=${caught.providerCode} (status=${String(probeStatus)})`);

  console.log(`[s02] dsh log total events: ${String(dshSession.snapshotEvents().length)}, bridge drops: ${String(stats.dropped)}`);
  console.log("[s02] PASS: AC1-AC4 + error-finish probe all green");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
