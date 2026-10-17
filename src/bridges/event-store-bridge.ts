/**
 * event-store-bridge — 共享边界样例 2（事件落盘）的 S02 实现。
 *
 * ZCode `SessionEventStorePort` 的 dsh 实现：引擎把 ZCode `SessionEvent` 交给
 * `append()`，桥按最小翻译表写成 **合法 dsh `SessionEvent`** 并 `Session.append()`
 * 进注入的 dsh Session —— dsh session log 是唯一落盘真相，桥不做任何持久化决策。
 *
 * 翻译表（ZCode → dsh；排序满足 dsh durable format v4 的关系校验——消息与
 * 工具事件必须落在 open turn+step 内，step/end 收口时工具必须全部解析）：
 * - turn_started            → turn/start{turn}（+ 缓冲 user/message，等首个 model_request 落）
 * - model_request           → [上一步 assistant 缓冲落定 → step/end（若 open）] + step/start
 *                               + [system/message（仅首次）] + user/message + request/header
 * - model_streaming         → 累积为该步 assistant 的紧凑流（AssistantStreamAccumulator）
 * - model_complete          → 缓冲 assistant/message（等工具结果或下一边界落）
 * - tool_call_scheduled     → 落缓冲的 assistant/message（含 tool-call 块）+ tool/call
 * - tool_call_result/error  → tool/result（surfaceOp append，sourceEventSeqs 配对 tool/call）
 * - turn_complete/error     → 落缓冲 assistant/message + step/end（若 open）+ turn/end{reason}
 * - 其余（流式/进度/生命周期杂项）与未知事件 → 丢弃并计数，不炸会话。
 *
 * 缓冲只是翻译排序（assistant/message 必须先于它的 tool 结果进入 surface），
 * 所有事件最终都经 `Session.append()` 进入同一份 dsh log，不存在第二落盘点。
 */
import type {
  AssistantStreamRecord,
  ContentBlock,
  StreamChunk,
  TokenUsage,
} from "@deepseek-ai/dsh-llm";
import {
  AssistantStreamAccumulator,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { Session as DshSession } from "@deepseek-ai/dsh-session";
import { SessionSeq } from "@deepseek-ai/dsh-session";

import type {
  Logger,
  SessionEvent,
  SessionEventStorePort,
  SessionEventStoreStats,
  SessionId,
} from "../engine-facade.js";

// ------------------------------------------------------------------
// 引擎载荷的本地结构视图（只取翻译所需字段，与 contracts 载荷形状对齐）
// ------------------------------------------------------------------

interface TurnStartedPayload {
  turnNumber: number;
  input: string;
}

interface RequestMessageView {
  role: string;
  content?: unknown;
}

interface ModelRequestPayload {
  messages: RequestMessageView[];
  providerId: string;
  modelId: string;
}

interface ModelStreamingPayload {
  delta: string;
  done: boolean;
  kind?:
    | "start"
    | "text_start"
    | "text_delta"
    | "text_end"
    | "reasoning_start"
    | "reasoning_delta"
    | "reasoning_end"
    | "tool_input_start"
    | "tool_input_delta"
    | "tool_input_end"
    | "tool_call"
    | "finish"
    | "error";
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
}

interface ModelCompletePayload {
  content: string;
  stopReason: string;
  toolCallCount?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

interface ToolCallScheduledPayload {
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

interface ToolCallResultPayload {
  toolCallId: string;
  result: { success: boolean; content: string };
  duration?: number;
}

interface ToolCallErrorPayload {
  toolCallId: string;
  error?: { type?: string; code?: string; message?: string };
}

interface TurnCompletePayload {
  response?: string;
}

interface TurnErrorPayload {
  error?: { type?: string; code?: string; message?: string };
}

// ------------------------------------------------------------------
// 桥状态与翻译
// ------------------------------------------------------------------

interface PendingToolCall {
  callId: string;
  name: string;
  arguments: string;
  /** dsh `tool/call` 事件的 seq（tool/result 的 sourceEventSeqs 配对用）。 */
  callSeq?: number;
}

interface PendingAssistant {
  turn: number;
  step: number;
  text: string;
  stopReason: string;
  usage: ModelCompletePayload["usage"];
  toolCalls: PendingToolCall[];
  stream: AssistantStreamAccumulator;
}

/** 单个 model 块的流累积状态（对应 ModelStreaming 的 start/delta/end 序列）。 */
interface OpenBlock {
  kind: "text" | "reasoning" | "tool-call";
  index: number;
  text: string;
  toolCallId?: string;
  toolName?: string;
  toolNameSent?: boolean;
  arguments?: string;
}

/** 丢弃计数的只读快照。 */
export interface DshBridgeDropStats {
  /** 丢弃事件总数（含未知）。 */
  dropped: number;
  /** 按引擎事件类型计数。 */
  droppedByType: Record<string, number>;
  /** 其中不在任何已知词表里的类型计数。 */
  unknownTypes: Record<string, number>;
}

export interface DshEventStoreBridgeOptions {
  /** dsh Session（唯一落盘真相）。由调用方（S03 外壳 / 测试）创建并注入。 */
  session: DshSession;
  /** 期望的引擎 session id；不一致的事件按丢弃计数处理。 */
  sessionId?: SessionId;
  logger?: Logger;
  now?: () => number;
}

const KNOWN_ZCODE_EVENT_TYPES = new Set<string>([
  "session_created",
  "session_resumed",
  "session_forked",
  "session_compacted",
  "session_title_updated",
  "session_mode_changed",
  "session_ended",
  "turn_started",
  "turn_input_received",
  "turn_steer_queued",
  "turn_steer_delivery_changed",
  "turn_steer_dispatch_changed",
  "turn_steer_drained",
  "turn_steer_rejected",
  "turn_steer_discarded",
  "session_input_promoted",
  "turn_steer_reordered",
  "queue_auto_drain_changed",
  "followup_mode_changed",
  "turn_complete",
  "turn_error",
  "user_message",
  "assistant_message",
  "assistant_feedback_updated",
  "highspeed_metrics_updated",
  "system_message",
  "model_request",
  "model_selected",
  "turn_execution_model_fallback",
  "model_streaming",
  "streaming_tool_ledger_updated",
  "stream_recovery_anchor_created",
  "stream_recovery_started",
  "stream_recovery_anchor_selected",
  "stream_recovery_tail_discarded",
  "stream_recovery_retry_started",
  "stream_recovery_blocked",
  "model_network_status",
  "model_anomaly_warning",
  "network_request_status",
  "model_complete",
  "model_error",
  "tool_call_scheduled",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_result",
  "tool_call_error",
  "tool_batch_complete",
  "background_task_started",
  "background_task_updated",
  "background_task_completed",
  "dynamic_workflow_run_progress",
  "permission_requested",
  "permission_resolved",
  "permission_denied",
  "plugin_ui_resource_updated",
  "plugin_ui_resource_list_changed",
  "plugin_ui_app_tool_call_requested",
  "user_input_auto_resolution_updated",
  "workspace_hook_review_requested",
  "workspace_hook_review_settled",
  "workspace_hook_review_superseded",
  "workspace_hook_admission_updated",
  "hook_run_started",
  "hook_run_progress",
  "hook_run_completed",
  "hook_run_failed",
  "hook_run_blocked",
  "compact_started",
  "compact_completed",
  "compact_failed",
  "compact_boundary",
  "microcompact_boundary",
  "rewind_triggered",
  "checkpoint_created",
  "target_changed",
  "target_completion_verification",
  "subagent_spawned",
  "subagent_message",
  "subagent_stopped",
  "interrupt",
  "cancel",
  "resume",
  "error",
]);


/** 引擎 turnNumber 从 0 起，dsh durable format 要求 turn 正数（stock loop 1-based）。 */
function dshTurn(turn: number | undefined): number {
  return (turn ?? 0) + 1;
}

function dshFinishKindFromStopReason(stopReason: string): Extract<StreamChunk, { type: "finish" }>["reason"] {
  if (stopReason === "tool-calls" || stopReason === "tool_use" || stopReason === "tool_calls") {
    return { kind: "tool-calls" };
  }
  if (stopReason === "length" || stopReason === "max_tokens" || stopReason === "max-tokens") {
    return { kind: "max-tokens" };
  }
  return { kind: "stop" };
}

/** 累积流里是否已有内容记录（text/reasoning/tool-call 运行或任何完整块）。 */
function streamHasContentRecord(accumulator: AssistantStreamAccumulator | undefined): boolean {
  if (accumulator === undefined) return false;
  return accumulator.snapshot().some((record) =>
    record.type === "text-chunks"
    || record.type === "reasoning-chunks"
    || record.type === "tool-call-chunks"
    || (record.type === "chunk" && record.chunk.type === "block-end"));
}

/** 按已定型的 assistant 内容合成等价紧凑流（引擎未发布 ModelStreaming 时的回退）。 */
function synthesizeStreamChunks(assistant: PendingAssistant): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  let index = 0;
  if (assistant.text.length > 0) {
    chunks.push({ type: "block-start", index, blockType: "text" });
    chunks.push({ type: "text-delta", index, text: assistant.text });
    chunks.push({ type: "block-end", index, block: { type: "text", text: assistant.text } });
    index += 1;
  }
  for (const toolCall of assistant.toolCalls) {
    chunks.push({ type: "block-start", index, blockType: "tool-call" });
    chunks.push({
      type: "tool-call-delta",
      index,
      id: ToolCallId(toolCall.callId),
      name: toolCall.name,
      argumentsDelta: toolCall.arguments,
    });
    chunks.push({
      type: "block-end",
      index,
      block: {
        type: "tool-call",
        id: ToolCallId(toolCall.callId),
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    });
    index += 1;
  }
  return chunks;
}

/**
 * ZCode `SessionEventStorePort` 的 dsh 翻译实现。
 * 一个桥实例服务一个 (ZCode session, dsh Session) 对。
 */
export class DshSessionEventStoreBridge implements SessionEventStorePort {
  private readonly zcodeEvents = new Map<SessionId, SessionEvent[]>();
  private readonly latestSequence = new Map<SessionId, number>();

  private turn: number | undefined;
  private step = 0;
  /** dsh `step/start` 已落、`step/end` 未落（v4 关系校验要求消息类事件在 open step 内）。 */
  private stepOpen = false;
  private pendingUserText: string | undefined;
  private pendingAssistant: PendingAssistant | undefined;
  private openBlock: OpenBlock | undefined;
  private nextBlockIndex = -1;
  private streamAccumulator: AssistantStreamAccumulator | undefined;
  private streamFinished = false;
  private streamErrorCount = 0;
  private systemMessageLogged = false;
  private lastRequest: { provider: string; model: string } | undefined;
  private toolCallSeqs = new Map<string, number>();
  private translatedCount = 0;
  private droppedByType = new Map<string, number>();
  private unknownTypes = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: DshEventStoreBridgeOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** dsh session（唯一落盘真相）。 */
  get session(): DshSession {
    return this.options.session;
  }

  /** 翻译统计快照（AC：丢弃可见、会话不炸）。 */
  dropStats(): DshBridgeDropStats {
    const droppedByType: Record<string, number> = {};
    for (const [type, count] of this.droppedByType) droppedByType[type] = count;
    const unknownTypes: Record<string, number> = {};
    for (const type of this.unknownTypes) {
      unknownTypes[type] = this.droppedByType.get(type) ?? 0;
    }
    return {
      dropped: [...this.droppedByType.values()].reduce((sum, count) => sum + count, 0),
      droppedByType,
      unknownTypes,
    };
  }

  /** 已翻译（触发至少一次 dsh append 决策）的引擎事件数。 */
  get translated(): number {
    return this.translatedCount;
  }

  async append(event: SessionEvent): Promise<SessionEvent> {
    const state = this.stateFor(event.sessionId);
    const sequenceNumber =
      event.sequenceNumber > 0 ? event.sequenceNumber : (this.latestSequence.get(event.sessionId) ?? 0) + 1;
    this.latestSequence.set(event.sessionId, Math.max(this.latestSequence.get(event.sessionId) ?? 0, sequenceNumber));
    const stored: SessionEvent = { ...event, sequenceNumber };
    state.push(stored);
    this.translate(stored);
    return stored;
  }

  async getEvents(sessionId: SessionId): Promise<SessionEvent[]> {
    return [...(this.zcodeEvents.get(sessionId) ?? [])];
  }

  async getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]> {
    return (this.zcodeEvents.get(sessionId) ?? []).filter(
      (event) => event.sequenceNumber > sequenceNumber,
    );
  }

  async getLatestSequenceNumber(sessionId: SessionId): Promise<number> {
    return this.latestSequence.get(sessionId) ?? 0;
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.zcodeEvents.delete(sessionId);
    this.latestSequence.delete(sessionId);
  }

  getStats(): SessionEventStoreStats {
    let events = 0;
    for (const list of this.zcodeEvents.values()) events += list.length;
    return { sessions: this.zcodeEvents.size, events, evictedEvents: 0, retainedTransient: 0 };
  }

  // ----------------------------------------------------------------
  // 内部：引擎事件 → dsh Session.append
  // ----------------------------------------------------------------

  private stateFor(sessionId: SessionId): SessionEvent[] {
    let list = this.zcodeEvents.get(sessionId);
    if (!list) {
      list = [];
      this.zcodeEvents.set(sessionId, list);
    }
    return list;
  }

  private drop(event: SessionEvent, reason?: string): void {
    const count = this.droppedByType.get(event.type) ?? 0;
    this.droppedByType.set(event.type, count + 1);
    if (!KNOWN_ZCODE_EVENT_TYPES.has(event.type)) this.unknownTypes.add(event.type);
    if (reason !== undefined) {
      this.options.logger?.debug(`event-store-bridge dropped ${event.type}: ${reason}`);
    }
  }

  private translate(event: SessionEvent): void {
    if (this.options.sessionId !== undefined && event.sessionId !== this.options.sessionId) {
      this.drop(event, "session id mismatch");
      return;
    }
    switch (event.type) {
      case "turn_started": {
        this.translateTurnStarted(event.payload as TurnStartedPayload);
        this.translatedCount += 1;
        return;
      }
      case "model_request": {
        this.translateModelRequest(event.payload as ModelRequestPayload);
        this.translatedCount += 1;
        return;
      }
      case "model_streaming": {
        this.accumulateStreaming(event.payload as ModelStreamingPayload);
        this.translatedCount += 1;
        return;
      }
      case "model_complete": {
        this.translateModelComplete(event.payload as ModelCompletePayload);
        this.translatedCount += 1;
        return;
      }
      case "tool_call_scheduled": {
        this.translateToolCallScheduled(event.payload as ToolCallScheduledPayload);
        this.translatedCount += 1;
        return;
      }
      case "tool_call_result": {
        this.translateToolCallResult(event.payload as ToolCallResultPayload);
        this.translatedCount += 1;
        return;
      }
      case "tool_call_error": {
        this.translateToolCallError(event.payload as ToolCallErrorPayload);
        this.translatedCount += 1;
        return;
      }
      case "turn_complete": {
        this.translateTurnComplete(event.payload as TurnCompletePayload);
        this.translatedCount += 1;
        return;
      }
      case "turn_error": {
        this.translateTurnError(event.payload as TurnErrorPayload);
        this.translatedCount += 1;
        return;
      }
      default:
        this.drop(event);
        return;
    }
  }

  private requireTurn(): number | undefined {
    return this.turn;
  }

  private resetStepStream(): void {
    this.openBlock = undefined;
    this.nextBlockIndex = -1;
    this.streamAccumulator = new AssistantStreamAccumulator();
    this.streamFinished = false;
    this.streamErrorCount = 0;
  }

  private translateTurnStarted(payload: TurnStartedPayload): void {
    const turn = payload.turnNumber;
    this.turn = turn;
    this.step = 0;
    this.stepOpen = false;
    this.pendingAssistant = undefined;
    this.toolCallSeqs = new Map();
    this.resetStepStream();
    this.options.session.append("turn/start", { turn: dshTurn(turn) });
    // user/message 等首个 model_request 再落：system/message 必须是 surface 节点 0，
    // 而引擎在 turn_started 才给出 input、首个 model_request 才给出 system prompt。
    this.pendingUserText = payload.input;
  }

  private translateModelRequest(payload: ModelRequestPayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) {
      // 没有.turn_started 的请求无法放进 dsh turn 配对里：丢弃计数。
      this.pendingUserText = undefined;
      return;
    }
    const step = this.step + 1;
    // 上一缓冲（无工具的中间步）先在仍打开的上一步里落定（S04 修复：v4 关系校验
    // 要求 assistant/message 在 open step 内、step/end 收口前）。
    this.flushPendingAssistant();
    // 上一 open step 收口（其 tool/result 已全部到达）再开新步：v4 关系校验要求
    // system/user/assistant/tool 事件落在 open turn+step 内、turn/end 前无 open step。
    // S04 修复（最小改动，报告声明）：原实现 system/user 先于 step/start、step/end
    // 先于 assistant/tool 落盘，durable format 读取时全部拒绝。
    if (this.stepOpen) {
      this.options.session.append("step/end", { turn: dshTurn(turn), step: this.step });
      this.stepOpen = false;
    }
    this.options.session.append("step/start", { turn: dshTurn(turn), step });
    this.stepOpen = true;
    // system prompt 只在首次请求落（原型：后续变化丢弃计数，不做 in-history 归一化）。
    // S03 修复（最小改动，报告声明）：custom system prompt 路径下引擎会发**多条**前导
    // system 消息（cli_prefix 身份行 + stable custom body），全部都是模型可见内容；
    // 原实现只落 messages[0] 会让第二条（dsh 装配文本）绕过落盘，违反
    // "Model-visible means logged"。现在把全部前导 system 拼接为一条 dsh
    // system/message；单条 system 的 S02 行为不变（拼接结果 === 原文）。
    if (!this.systemMessageLogged) {
      const leadingSystemText: string[] = [];
      for (const message of payload.messages) {
        if (message.role === "system" && typeof message.content === "string") {
          leadingSystemText.push(message.content);
        } else {
          break;
        }
      }
      const systemText = leadingSystemText.join("\n\n");
      if (systemText.length > 0) {
        this.options.session.append(
          "system/message",
          { turn: dshTurn(turn), step, message: createSystemMessage(systemText) },
          { surfaceOp: "append" },
        );
        this.systemMessageLogged = true;
      }
    }
    if (this.pendingUserText !== undefined) {
      this.options.session.append(
        "user/message",
        createUserMessage({
          content: [{ type: "text", text: this.pendingUserText }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append" },
      );
      this.pendingUserText = undefined;
    }
    this.step = step;
    this.options.session.append("request/header", {
      header: { config: { provider: payload.providerId, model: payload.modelId } },
      reason: this.lastRequest === undefined ? "initial" : "change",
    });
    this.lastRequest = { provider: payload.providerId, model: payload.modelId };
    this.resetStepStream();
  }

  /** 把 ModelStreaming 事件累积成 dsh 紧凑流（assistant/message 的 `stream` 字段）。 */
  private accumulateStreaming(payload: ModelStreamingPayload): void {
    const accumulator = this.streamAccumulator;
    if (accumulator === undefined) return;
    const time = this.now();
    const push = (chunk: StreamChunk): void => {
      accumulator.push({ time, chunk });
    };
    switch (payload.kind) {
      case undefined:
      case "start":
        return;
      case "text_start": {
        this.openBlock = { kind: "text", index: ++this.nextBlockIndex, text: "" };
        push({ type: "block-start", index: this.openBlock.index, blockType: "text" });
        return;
      }
      case "text_delta": {
        const block = this.expectBlock("text");
        block.text += payload.delta;
        push({ type: "text-delta", index: block.index, text: payload.delta });
        return;
      }
      case "text_end": {
        const block = this.expectBlock("text");
        push({ type: "block-end", index: block.index, block: { type: "text", text: block.text } });
        this.openBlock = undefined;
        return;
      }
      case "reasoning_start": {
        this.openBlock = { kind: "reasoning", index: ++this.nextBlockIndex, text: "" };
        push({ type: "block-start", index: this.openBlock.index, blockType: "reasoning" });
        return;
      }
      case "reasoning_delta": {
        const block = this.expectBlock("reasoning");
        block.text += payload.delta;
        push({ type: "reasoning-delta", index: block.index, text: payload.delta });
        return;
      }
      case "reasoning_end": {
        const block = this.expectBlock("reasoning");
        push({
          type: "block-end",
          index: block.index,
          block: { type: "reasoning", text: block.text },
        });
        this.openBlock = undefined;
        return;
      }
      case "tool_input_start": {
        this.openBlock = {
          kind: "tool-call",
          index: ++this.nextBlockIndex,
          text: "",
          toolCallId: payload.toolCallId ?? "",
          toolName: payload.toolName ?? "",
          toolNameSent: false,
          arguments: "",
        };
        push({ type: "block-start", index: this.openBlock.index, blockType: "tool-call" });
        return;
      }
      case "tool_input_delta": {
        const block = this.expectBlock("tool-call");
        block.arguments = (block.arguments ?? "") + payload.delta;
        push({
          type: "tool-call-delta",
          index: block.index,
          id: ToolCallId(block.toolCallId ?? ""),
          ...(block.toolNameSent ? {} : { name: block.toolName ?? "" }),
          argumentsDelta: payload.delta,
        });
        block.toolNameSent = true;
        return;
      }
      case "tool_input_end":
        return;
      case "tool_call": {
        const block = this.expectBlock("tool-call");
        const blockId = payload.toolCallId ?? block.toolCallId ?? "";
        const blockName = payload.toolName ?? block.toolName ?? "";
        const args = payload.input === undefined ? (block.arguments ?? "") : JSON.stringify(payload.input);
        push({
          type: "block-end",
          index: block.index,
          block: { type: "tool-call", id: ToolCallId(blockId), name: blockName, arguments: args },
        });
        this.openBlock = undefined;
        return;
      }
      case "finish": {
        this.streamFinished = true;
        return;
      }
      case "error": {
        this.streamErrorCount += 1;
        return;
      }
    }
  }

  /** 当前打开块；缺失时建一个哑块保证流合法（防引擎乱序）。 */
  private expectBlock(kind: OpenBlock["kind"]): OpenBlock {
    if (this.openBlock === undefined || this.openBlock.kind !== kind) {
      this.openBlock = { kind, index: ++this.nextBlockIndex, text: "" };
      this.streamAccumulator?.push({
        time: this.now(),
        chunk: { type: "block-start", index: this.openBlock.index, blockType: kind },
      });
    }
    return this.openBlock;
  }

  private translateModelComplete(payload: ModelCompletePayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) return;
    // S04 修复：step/end 不在此落——v4 关系校验要求 assistant/message 与其
    // tool/call、tool/result 留在 open step 内，step 由下一个 model_request
    // 或 turn 收口事件负责关闭。
    // 关闭尚未 block-end 的开块，保证流结构完整。
    this.closeOpenBlock();
    const assistant: PendingAssistant = {
      turn,
      step: this.step,
      text: payload.content,
      stopReason: payload.stopReason,
      usage: payload.usage,
      toolCalls: [],
      stream: this.streamAccumulator ?? new AssistantStreamAccumulator(),
    };
    this.pendingAssistant = assistant;
    this.streamAccumulator = undefined;
  }

  private closeOpenBlock(): void {
    const block = this.openBlock;
    const accumulator = this.streamAccumulator;
    if (block === undefined || accumulator === undefined) {
      this.openBlock = undefined;
      return;
    }
    const time = this.now();
    if (block.kind === "text") {
      accumulator.push({
        time,
        chunk: { type: "block-end", index: block.index, block: { type: "text", text: block.text } },
      });
    } else if (block.kind === "reasoning") {
      accumulator.push({
        time,
        chunk: {
          type: "block-end",
          index: block.index,
          block: { type: "reasoning", text: block.text },
        },
      });
    } else {
      accumulator.push({
        time,
        chunk: {
          type: "block-end",
          index: block.index,
          block: {
            type: "tool-call",
            id: ToolCallId(block.toolCallId ?? ""),
            name: block.toolName ?? "",
            arguments: block.arguments ?? "",
          },
        },
      });
    }
    this.openBlock = undefined;
  }

  /** 落缓冲的 assistant/message（若有）。`newToolCall` 先入 tool-call 块列表再落。 */
  private flushPendingAssistant(newToolCall?: PendingToolCall): void {
    const assistant = this.pendingAssistant;
    if (assistant === undefined) return;
    if (newToolCall !== undefined) assistant.toolCalls.push(newToolCall);
    const content: ContentBlock[] = [];
    if (assistant.text.length > 0) content.push({ type: "text", text: assistant.text });
    for (const toolCall of assistant.toolCalls) {
      content.push({
        type: "tool-call",
        id: ToolCallId(toolCall.callId),
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
    }
    // 终态 usage + finish 收口紧凑流。引擎未发布任何 ModelStreaming 内容时
    // （无 live sink 的最小装配），按已定型的 assistant 内容确定性合成等价紧凑流。
    const time = this.now();
    const usage = assistant.usage;
    let accumulator = assistant.stream;
    if (!streamHasContentRecord(accumulator)) {
      accumulator = new AssistantStreamAccumulator();
      const chunks = synthesizeStreamChunks(assistant);
      for (const chunk of chunks) accumulator.push({ time, chunk });
    }
    if (usage !== undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
      accumulator.push({
        time,
        chunk: {
          type: "usage",
          usage: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
          },
        },
      });
    }
    if (!this.streamFinished) {
      accumulator.push({
        time,
        chunk: { type: "finish", reason: dshFinishKindFromStopReason(assistant.stopReason) },
      });
    }
    const stream: AssistantStreamRecord[] = accumulator.snapshot().map((record) => ({ ...record }));
    const source = this.lastRequest ?? { provider: "dsh", model: "unknown" };
    const usageField: TokenUsage = {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(usage?.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    };
    this.options.session.append(
      "assistant/message",
      {
        turn: dshTurn(assistant.turn),
        step: assistant.step,
        message: createAssistantMessage({ content, source }),
        stream,
        usage: usageField,
      },
      { surfaceOp: "append" },
    );
    this.pendingAssistant = undefined;
    this.streamFinished = false;
  }

  private translateToolCallScheduled(payload: ToolCallScheduledPayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) return;
    const toolCall: PendingToolCall = {
      callId: payload.toolCallId,
      name: payload.toolName,
      arguments: JSON.stringify(payload.input ?? {}),
    };
    // assistant/message（含至今的 tool-call 块）先于首个 tool/call 落进 surface。
    this.flushPendingAssistant(toolCall);
    const event = this.options.session.append("tool/call", {
      turn: dshTurn(turn),
      step: this.step,
      callId: ToolCallId(payload.toolCallId),
      name: payload.toolName,
      arguments: toolCall.arguments,
    });
    this.toolCallSeqs.set(payload.toolCallId, event.seq);
  }

  private translateToolCallResult(payload: ToolCallResultPayload): void {
    const turn = this.requireTurn();
    const callSeq = this.toolCallSeqs.get(payload.toolCallId);
    if (turn === undefined || callSeq === undefined) return;
    const success = payload.result.success;
    this.options.session.append(
      "tool/result",
      {
        turn: dshTurn(turn),
        step: this.step,
        message: createToolResultMessage({
          callId: ToolCallId(payload.toolCallId),
          content: [{ type: "text", text: payload.result.content }],
          isError: !success,
        }),
      },
      { surfaceOp: "append", sourceEventSeqs: [SessionSeq(callSeq)] },
    );
  }

  private translateToolCallError(payload: ToolCallErrorPayload): void {
    const turn = this.requireTurn();
    const callSeq = this.toolCallSeqs.get(payload.toolCallId);
    if (turn === undefined || callSeq === undefined) return;
    const message = payload.error?.message ?? "tool call failed";
    this.options.session.append(
      "tool/result",
      {
        turn: dshTurn(turn),
        step: this.step,
        message: createToolResultMessage({
          callId: ToolCallId(payload.toolCallId),
          content: [{ type: "text", text: message }],
          isError: true,
        }),
        error: {
          name: payload.error?.type ?? "ToolError",
          code: payload.error?.code ?? "TOOL_ERROR",
          reason: message,
        },
      },
      { surfaceOp: "append", sourceEventSeqs: [SessionSeq(callSeq)] },
    );
  }

  private translateTurnComplete(_payload: TurnCompletePayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) return;
    this.flushPendingAssistant();
    // v4 关系校验：turn/end 前不允许 open step（消息类事件已在其内落定）。
    if (this.stepOpen) {
      this.options.session.append("step/end", { turn: dshTurn(turn), step: this.step });
      this.stepOpen = false;
    }
    this.options.session.append("turn/end", { turn: dshTurn(turn), reason: { kind: "completed" } });
  }

  private translateTurnError(payload: TurnErrorPayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) return;
    this.flushPendingAssistant();
    // v4 关系校验：turn/end 前不允许 open step。（错误路径若还有未解析的
    // tool/call，durable 读取会拒绝——原型接受，见 S04 报告缺口。）
    if (this.stepOpen) {
      this.options.session.append("step/end", { turn: dshTurn(turn), step: this.step });
      this.stepOpen = false;
    }
    this.options.session.append("turn/end", {
      turn: dshTurn(turn),
      reason: {
        kind: "error",
        error: {
          message: payload.error?.message ?? "turn failed",
          code: payload.error?.code ?? "UNKNOWN",
        },
      },
    });
  }
}
