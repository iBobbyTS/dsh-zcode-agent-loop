/**
 * event-store-bridge — 事件落盘桥（共享边界样例 2 的实现）。
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
 *                               （live：有 publisher 时逐 chunk 发 agent/assistant-stream frame）
 * - model_complete          → 缓冲 assistant/message（等工具结果或下一边界落）
 * - tool_call_scheduled     → 暂存至完整 assistant 可落盘，再依次写 tool/call
 * - tool_call_result/error  → tool/result（surfaceOp append，sourceEventSeqs 配对 tool/call）
 * - turn_complete/error     → 落缓冲 assistant/message + step/end（若 open）+ turn/end{reason}
 * - compact_started/completed/failed、model_anomaly_warning → 不落盘，logger 镜像
 *   + 丢弃计数（阶段 5：dsh compaction/* 是 surface 修剪事务族，不手工构造）
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
  UserMessage,
} from "@deepseek-ai/dsh-llm";
import {
  AssistantStreamAccumulator,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAttemptId,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { Session as DshSession } from "@deepseek-ai/dsh-session";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import type { AssistantStreamFrame } from "@deepseek-ai/dsh-agent";

import type {
  LogContext,
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

/** live end frame 的终局结果（stock settle/abandon 的 committed/abandoned 二态）。 */
type AssistantStreamEndOutcome = Extract<AssistantStreamFrame, { type: "end" }>["outcome"];

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
  expectedToolCalls: number;
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
  /** dsh Session（唯一落盘真相）。由调用方（外壳 / 测试）创建并注入。 */
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


/** 引擎 turnNumber 从 0 起，dsh durable format 要求 turn 正数（stock loop 1-based）；
 *  resume 会话的 turn 号经 setTurnBase 对齐偏移（见类内方法）。 */

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
  /** 本 turn claim 的原始消息批（agent drain 注入，见 setPendingUserMessages）。 */
  private pendingUserMessages: readonly UserMessage[] | undefined;
  private pendingAssistant: PendingAssistant | undefined;
  private openBlock: OpenBlock | undefined;
  private nextBlockIndex = -1;
  private streamAccumulator: AssistantStreamAccumulator | undefined;
  private streamedToolCalls: PendingToolCall[] = [];
  private pendingToolEvents: { type: "scheduled" | "result" | "error"; payload: ToolCallScheduledPayload | ToolCallResultPayload | ToolCallErrorPayload }[] = [];
  private committedToolResults: string[] = [];
  private toolResultListener: ((callId: string) => Promise<void>) | undefined;
  private streamErrorCount = 0;
  private systemMessageLogged = false;
  private lastRequest: { provider: string; model: string } | undefined;
  private toolCallSeqs = new Map<string, number>();
  private translatedCount = 0;
  private droppedByType = new Map<string, number>();
  private unknownTypes = new Set<string>();
  private readonly now: () => number;
  /** resume 场景的 turn 号偏移（见 setTurnBase；create 会话恒 0）。 */
  private turnBase = 0;
  /** 引擎 auto-compact 进行中（摘要 sidecar 请求的翻译门，见 translate）。 */
  private compacting = false;

  // live 通路状态（stock AssistantStreamAttempt 语义；无 publisher 时全部静止）。
  /** 晚绑定：bridge 在 agent 之前创建，agent 构造后由外壳回填（index.ts）。 */
  private streamPublisher: ((frame: AssistantStreamFrame) => void) | undefined;
  /** session 内单调递增的 model attempt 计数（attemptId 后缀，stock 同款从 1 起）。 */
  private attemptCounter = 0;
  /** frame revision：agent 生命周期内单调递增（每 frame +1，stock 同款从 1 起）。 */
  private frameRevision = 0;
  private currentAttemptId: LlmAttemptId | undefined;
  private frameIndex = 0;
  private attemptLive = false;

  constructor(private readonly options: DshEventStoreBridgeOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** dsh session（唯一落盘真相）。 */
  get session(): DshSession {
    return this.options.session;
  }

  /**
   * resume 会话的 turn 号对齐：引擎恢复后 turnNumber 从「历史用户消息数」起，
   * 而 dsh seed 的已有 turn 数可能更多（失败 turn 未必落过 user/message——引擎
   * 在 model_request 前的持久化点就会抛）。base = seed 最大 turn 号 − 引擎历史
   * 用户消息数，让新 turn 落在已有最大 turn 之后，避免重复 turn 号。
   */
  setTurnBase(base: number): void {
    this.turnBase = Math.max(0, Math.trunc(base));
  }

  /** 引擎 turnNumber（0 起）→ dsh turn 号（1 起，含 resume 偏移）。 */
  private dshTurn(turn: number | undefined): number {
    return this.turnBase + (turn ?? 0) + 1;
  }

  /**
   * 晚绑定 live frame publisher（agent 的 dsh AgentEventDispatch 面）。缺席时桥
   * 只累积落盘、不发任何 frame（直用 bridge 的装配保持原行为）。
   */
  setStreamPublisher(publish: (frame: AssistantStreamFrame) => void): void {
    this.streamPublisher = publish;
  }

  /** Tool contexts may enter the owning turn only after their durable result. */
  setToolResultListener(listener: (callId: string) => Promise<void>): void {
    this.toolResultListener = listener;
  }

  /**
   * 注入本 turn claim 的原始 user 消息批（agent.drain 在 executeTurn 前调用）：
   * translateModelRequest 落盘时逐条 append 原消息对象（producer source 保真，
   * stock 逐条语义）；turn 收口由 translateTurnComplete/Error 清理。
   */
  setPendingUserMessages(messages: readonly UserMessage[] | undefined): void {
    this.pendingUserMessages = messages;
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
    // Take the batch before awaiting: steerTurn itself appends engine events.
    const committed = this.committedToolResults.splice(0);
    for (const callId of committed) await this.toolResultListener?.(callId);
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
    // 压缩摘要 sidecar 请求（model_*）不进翻译表（compact 门，见 switch 内注释）。
    if (
      this.compacting
      && (event.type === "model_request"
        || event.type === "model_complete"
        || event.type === "model_streaming")
    ) {
      this.drop(event, "compact sidecar model request");
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
      case "compact_started":
      case "compact_completed":
      case "compact_failed":
      case "model_anomaly_warning": {
        // 阶段 5：压缩/异常事件不落盘（dsh compaction/* 是驱动 surface 修剪的
        // 事务族，手工构造错序会损坏 session log；引擎 auto-compact 的 dsh 等价
        // 物由 dsh-compaction-* 承担），但经 logger 镜像——压缩真发生时容器
        // 日志与 dropStats 同时可见（PROJECTION.md 的实测校验建议）。
        // 压缩门（compacting）：compact_started 到 completed/failed 之间的
        // model_request/complete/streaming 是摘要 sidecar 请求，不属主 turn——
        // 翻译会把摘要文本落成 assistant/message 污染 surface（实测 seq 结构
        // turn/start→user→[摘要]→[真回复]，见 stage5 归档）。
        if (event.type === "compact_started") this.compacting = true;
        else if (event.type === "compact_completed" || event.type === "compact_failed") {
          this.compacting = false;
        }
        this.options.logger?.warn(
          `engine ${event.type} (not projected)`,
          event.payload as LogContext | undefined,
        );
        this.drop(event);
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
    // 上个 attempt 没走到 flushPendingAssistant（如流错误后直接到边界）：先发
    // abandoned 终局再清（endLiveAttempt 自查 attemptLive，正常路径为空操作）。
    this.endLiveAttempt({ kind: "abandoned" });
    this.openBlock = undefined;
    this.nextBlockIndex = -1;
    this.streamAccumulator = new AssistantStreamAccumulator();
    this.streamedToolCalls = [];
    this.streamErrorCount = 0;
  }

  private translateTurnStarted(payload: TurnStartedPayload): void {
    const turn = payload.turnNumber;
    this.turn = turn;
    this.step = 0;
    this.stepOpen = false;
    this.pendingAssistant = undefined;
    this.pendingToolEvents = [];
    this.toolCallSeqs = new Map();
    this.resetStepStream();
    this.options.session.append("turn/start", { turn: this.dshTurn(turn) });
    // user/message 等首个 model_request 再落：system/message 必须是 surface 节点 0，
    // 而引擎在 turn_started 才给出 input、首个 model_request 才给出 system prompt。
    // claim 批在场（agent drain 注入）时不缓冲 text——批为权威，防双写。
    this.pendingUserText = this.pendingUserMessages !== undefined ? undefined : payload.input;
  }

  private translateModelRequest(payload: ModelRequestPayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) {
      // 没有.turn_started 的请求无法放进 dsh turn 配对里：丢弃计数。
      this.pendingUserText = undefined;
      return;
    }
    const step = this.step + 1;
    // 上一缓冲（无工具的中间步）先在仍打开的上一步里落定（修复：v4 关系校验
    // 要求 assistant/message 在 open step 内、step/end 收口前）。
    this.flushPendingAssistant();
    // 上一 open step 收口（其 tool/result 已全部到达）再开新步：v4 关系校验要求
    // system/user/assistant/tool 事件落在 open turn+step 内、turn/end 前无 open step。
    // 修复（最小改动，报告声明）：原实现 system/user 先于 step/start、step/end
    // 先于 assistant/tool 落盘，durable format 读取时全部拒绝。
    if (this.stepOpen) {
      this.options.session.append("step/end", { turn: this.dshTurn(turn), step: this.step });
      this.stepOpen = false;
    }
    this.options.session.append("step/start", { turn: this.dshTurn(turn), step });
    this.stepOpen = true;
    // system prompt 只在首次请求落（原型：后续变化丢弃计数，不做 in-history 归一化）。
    // 修复（最小改动，报告声明）：custom system prompt 路径下引擎会发**多条**前导
    // system 消息（cli_prefix 身份行 + stable custom body），全部都是模型可见内容；
    // 原实现只落 messages[0] 会让第二条（dsh 装配文本）绕过落盘，违反
    // "Model-visible means logged"。现在把全部前导 system 拼接为一条 dsh
    // system/message；单条 system 的旧行为不变（拼接结果 === 原文）。
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
          { turn: this.dshTurn(turn), step, message: createSystemMessage(systemText) },
          { surfaceOp: "append" },
        );
        this.systemMessageLogged = true;
      }
    }
    if (this.pendingUserMessages !== undefined && this.pendingUserMessages.length > 0) {
      // claim 批在场：逐条 append 原消息对象（producer source 与原始 content 块
      // 保真，stock 同款逐条语义——goal 续轮等非人类 producer 的入口）。
      for (const message of this.pendingUserMessages) {
        this.options.session.append("user/message", message, { surfaceOp: "append" });
      }
      this.pendingUserMessages = undefined;
    } else if (this.pendingUserText !== undefined) {
      // 引擎 text 输入（resume 后首轮等无批场景）回退：重建为人类轮 {kind:"user"}。
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

  /** 首个 chunk 前铸 attempt 并发 start frame（stock AssistantStreamAttempt.start 语义）。 */
  private ensureLiveAttempt(): LlmAttemptId {
    if (this.attemptLive && this.currentAttemptId !== undefined) return this.currentAttemptId;
    this.attemptCounter += 1;
    const attemptId = LlmAttemptId(`${this.options.session.id}:${this.attemptCounter}`);
    this.currentAttemptId = attemptId;
    this.frameIndex = 0;
    this.attemptLive = true;
    this.streamPublisher?.({
      type: "start",
      attemptId,
      revision: ++this.frameRevision,
      turn: this.dshTurn(this.turn),
      step: this.step,
    });
    return attemptId;
  }

  /** 每个 StreamChunk 一条 chunk frame（index 稠密递增，time 与 durable 记录同值）。 */
  private emitLiveChunk(chunk: StreamChunk, time: number): void {
    if (this.streamPublisher === undefined) return;
    this.streamPublisher({
      type: "chunk",
      attemptId: this.ensureLiveAttempt(),
      revision: ++this.frameRevision,
      index: this.frameIndex++,
      time,
      chunk,
    });
  }

  /** attempt 终局：仅当 attempt 在场。发完即清，revision 继续单调。 */
  private endLiveAttempt(outcome: AssistantStreamEndOutcome): void {
    const publisher = this.streamPublisher;
    if (!this.attemptLive || publisher === undefined || this.currentAttemptId === undefined) return;
    publisher({
      type: "end",
      attemptId: this.currentAttemptId,
      revision: ++this.frameRevision,
      index: this.frameIndex,
      outcome,
    });
    this.attemptLive = false;
    this.currentAttemptId = undefined;
  }

  /** 把 ModelStreaming 事件累积成 dsh 紧凑流（assistant/message 的 `stream` 字段）。 */
  private accumulateStreaming(payload: ModelStreamingPayload): void {
    const accumulator = this.streamAccumulator;
    if (accumulator === undefined) return;
    const time = this.now();
    const push = (chunk: StreamChunk): void => {
      accumulator.push({ time, chunk });
      // live 与 durable 喂同一条 chunk、同一个 time（stock push 语义）。
      this.emitLiveChunk(chunk, time);
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
        if (!this.streamedToolCalls.some((call) => call.callId === blockId)) {
          this.streamedToolCalls.push({ callId: blockId, name: blockName, arguments: args });
        }
        push({
          type: "block-end",
          index: block.index,
          block: { type: "tool-call", id: ToolCallId(blockId), name: blockName, arguments: args },
        });
        this.openBlock = undefined;
        return;
      }
      case "finish": {
        // Engine finish events omit the reason. ModelComplete supplies it;
        // flushPendingAssistant emits the one terminal chunk to both paths.
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
      const time = this.now();
      const chunk: StreamChunk = { type: "block-start", index: this.openBlock.index, blockType: kind };
      this.streamAccumulator?.push({ time, chunk });
      this.emitLiveChunk(chunk, time);
    }
    return this.openBlock;
  }

  private translateModelComplete(payload: ModelCompletePayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) return;
    // 修复：step/end 不在此落——v4 关系校验要求 assistant/message 与其
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
      toolCalls: [...this.streamedToolCalls],
      expectedToolCalls: payload.toolCallCount ?? this.streamedToolCalls.length,
      stream: this.streamAccumulator ?? new AssistantStreamAccumulator(),
    };
    this.pendingAssistant = assistant;
    this.streamAccumulator = undefined;
    for (const event of this.pendingToolEvents) {
      if (event.type === "scheduled") this.addPendingToolCall(event.payload as ToolCallScheduledPayload);
    }
    if (assistant.toolCalls.length >= assistant.expectedToolCalls && assistant.expectedToolCalls > 0) {
      this.flushPendingAssistant();
    }
  }

  private closeOpenBlock(): void {
    const block = this.openBlock;
    const accumulator = this.streamAccumulator;
    if (block === undefined || accumulator === undefined) {
      this.openBlock = undefined;
      return;
    }
    const time = this.now();
    const push = (entry: { time: number; chunk: StreamChunk }): void => {
      accumulator.push(entry);
      this.emitLiveChunk(entry.chunk, entry.time);
    };
    if (block.kind === "text") {
      push({
        time,
        chunk: { type: "block-end", index: block.index, block: { type: "text", text: block.text } },
      });
    } else if (block.kind === "reasoning") {
      push({
        time,
        chunk: {
          type: "block-end",
          index: block.index,
          block: { type: "reasoning", text: block.text },
        },
      });
    } else {
      push({
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

  /** Commit the complete assistant before replaying any dependent tool journal. */
  private flushPendingAssistant(): void {
    const assistant = this.pendingAssistant;
    if (assistant === undefined) return;
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
      for (const chunk of chunks) {
        accumulator.push({ time, chunk });
        this.emitLiveChunk(chunk, time);
      }
    }
    if (usage !== undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
      const chunk: StreamChunk = {
        type: "usage",
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        },
      };
      accumulator.push({ time, chunk });
      this.emitLiveChunk(chunk, time);
    }
    const finish: StreamChunk = { type: "finish", reason: dshFinishKindFromStopReason(assistant.stopReason) };
    accumulator.push({ time, chunk: finish });
    this.emitLiveChunk(finish, time);
    const stream: AssistantStreamRecord[] = accumulator.snapshot().map((record) => ({ ...record }));
    const source = this.lastRequest ?? { provider: "dsh", model: "unknown" };
    const usageField: TokenUsage = {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(usage?.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    };
    const appended = this.options.session.append(
      "assistant/message",
      {
        turn: this.dshTurn(assistant.turn),
        step: assistant.step,
        message: createAssistantMessage({ content, source }),
        stream,
        usage: usageField,
      },
      { surfaceOp: "append" },
    );
    // live 终局在 durable 落盘之后（stock settle 语义）：end frame 带 committed seq。
    this.endLiveAttempt({
      kind: "committed",
      eventType: "assistant/message",
      seq: appended.seq,
    });
    this.pendingAssistant = undefined;
    const pending = this.pendingToolEvents.splice(0);
    for (const event of pending) {
      if (event.type === "scheduled") this.translateToolCallScheduled(event.payload as ToolCallScheduledPayload);
      else if (event.type === "result") this.translateToolCallResult(event.payload as ToolCallResultPayload);
      else this.translateToolCallError(event.payload as ToolCallErrorPayload);
    }
  }

  private addPendingToolCall(payload: ToolCallScheduledPayload): void {
    const assistant = this.pendingAssistant;
    if (assistant !== undefined && !assistant.toolCalls.some((call) => call.callId === payload.toolCallId)) {
      assistant.toolCalls.push({ callId: payload.toolCallId, name: payload.toolName, arguments: JSON.stringify(payload.input ?? {}) });
    }
  }

  private translateToolCallScheduled(payload: ToolCallScheduledPayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) return;
    // Streaming execution may schedule/result before ModelComplete. Non-stream
    // execution only reveals the complete call set through scheduled events.
    if (this.pendingAssistant !== undefined || this.streamAccumulator !== undefined) {
      this.pendingToolEvents.push({ type: "scheduled", payload });
      this.addPendingToolCall(payload);
      if (this.pendingAssistant !== undefined && this.pendingAssistant.toolCalls.length >= this.pendingAssistant.expectedToolCalls) {
        this.flushPendingAssistant();
      }
      return;
    }
    const toolCall: PendingToolCall = {
      callId: payload.toolCallId,
      name: payload.toolName,
      arguments: JSON.stringify(payload.input ?? {}),
    };
    const event = this.options.session.append("tool/call", {
      turn: this.dshTurn(turn),
      step: this.step,
      callId: ToolCallId(payload.toolCallId),
      name: payload.toolName,
      arguments: toolCall.arguments,
    });
    this.toolCallSeqs.set(payload.toolCallId, event.seq);
  }

  private translateToolCallResult(payload: ToolCallResultPayload): void {
    if (this.pendingAssistant !== undefined || this.streamAccumulator !== undefined) {
      this.pendingToolEvents.push({ type: "result", payload });
      return;
    }
    const turn = this.requireTurn();
    const callSeq = this.toolCallSeqs.get(payload.toolCallId);
    if (turn === undefined || callSeq === undefined) return;
    const success = payload.result.success;
    this.options.session.append(
      "tool/result",
      {
        turn: this.dshTurn(turn),
        step: this.step,
        message: createToolResultMessage({
          callId: ToolCallId(payload.toolCallId),
          content: [{ type: "text", text: payload.result.content }],
          isError: !success,
        }),
      },
      { surfaceOp: "append", sourceEventSeqs: [SessionSeq(callSeq)] },
    );
    this.committedToolResults.push(payload.toolCallId);
  }

  private translateToolCallError(payload: ToolCallErrorPayload): void {
    if (this.pendingAssistant !== undefined || this.streamAccumulator !== undefined) {
      this.pendingToolEvents.push({ type: "error", payload });
      return;
    }
    const turn = this.requireTurn();
    const callSeq = this.toolCallSeqs.get(payload.toolCallId);
    if (turn === undefined || callSeq === undefined) return;
    const message = payload.error?.message ?? "tool call failed";
    this.options.session.append(
      "tool/result",
      {
        turn: this.dshTurn(turn),
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
    this.committedToolResults.push(payload.toolCallId);
  }

  private translateTurnComplete(_payload: TurnCompletePayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) return;
    this.flushPendingAssistant();
    // turn 收口清理：未被本 turn 消费的 claim 批（未到 model_request）不得泄漏到下一 turn。
    this.pendingUserMessages = undefined;
    // v4 关系校验：turn/end 前不允许 open step（消息类事件已在其内落定）。
    if (this.stepOpen) {
      this.options.session.append("step/end", { turn: this.dshTurn(turn), step: this.step });
      this.stepOpen = false;
    }
    this.options.session.append("turn/end", { turn: this.dshTurn(turn), reason: { kind: "completed" } });
  }

  private translateTurnError(payload: TurnErrorPayload): void {
    const turn = this.requireTurn();
    if (turn === undefined) return;
    this.flushPendingAssistant();
    // turn 收口清理：未被本 turn 消费的 claim 批（未到 model_request）不得泄漏到下一 turn。
    this.pendingUserMessages = undefined;
    // v4 关系校验：turn/end 前不允许 open step。（错误路径若还有未解析的
    // tool/call，durable 读取会拒绝——原型接受，见冒烟报告缺口。）
    if (this.stepOpen) {
      this.options.session.append("step/end", { turn: this.dshTurn(turn), step: this.step });
      this.stepOpen = false;
    }
    this.options.session.append("turn/end", {
      turn: this.dshTurn(turn),
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
