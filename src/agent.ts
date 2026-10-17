/**
 * dsh Agent/Inbox owner around the embedded ZCode execution loop.
 * Every model step crosses dsh admission; requests consume the durable surface.
 * ZCode owns model/tool execution, continuation and stream recovery.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  AssistantStreamFrame,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
} from "@deepseek-ai/dsh-agent";
import { agentEvents } from "@deepseek-ai/dsh-agent";
import { LlmError, errorChain, markAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmCallConfig, PreparedLlmCall, StreamChunk } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { Scope } from "@deepseek-ai/dsh-scope";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import type { Session as DshSession, SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import { SessionLogOffset, appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";

import type { AgentRuntime, ModelRequest } from "./engine-facade.js";
import { createExternalTurnFaultError } from "./engine-facade.js";
import { ZcodeLoopInbox, userMessageText } from "./inbox.js";
import type { DshSessionEventStoreBridge } from "./bridges/event-store-bridge.js";
import type { DshToolBridge } from "./bridges/tool-bridge.js";
import { DshPromptAdmission } from "./bridges/system-prompt-bridge.js";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";

export interface ZcodeLoopAgentDeps {
  /**
   * 晚绑定：createAgent 先构造 agent（dsh system prompt 装配需要读
   * agent.options/agent.session 的真实对象），再创建引擎并回填本字段；
   * 引擎就绪前 agent 不会进入任何 turn（构造→装配→挂载→发布后才可被驱动）。
   */
  runtime?: AgentRuntime;
  refreshHistory?: () => Promise<void>;
  toolBridge: DshToolBridge;
  /** 阶段 2：事件桥句柄——drain 每 turn 收口时取 dropStats 快照打点；缺席时跳过。 */
  eventBridge?: DshSessionEventStoreBridge;
  /**
   * 阶段 2：agent 的 debug 打点出口。agent 自身没有 logger（cordis 日志面归外壳
   * 所有），由 index.ts 传 `(m, c) => dshLogger.debug(m, c)`；缺席时打点静默跳过。
   */
  logDebug?: (message: string, context?: Record<string, unknown>) => void;
  /**
   * 阶段 8b：把 drain 包进 dsh agents 的 initiator 边界（AsyncLocalStorage，
   * stock loop 的 `withInitiator(this, () => this.kick())` 同款）。goal 工具族
   * 执行期 authority 校验要求 `currentInitiator() === agent`；缺席时跳过包装
   * （host probe 无 goal 插件场景不受影响）。
   */
  runWithInitiator?: (operation: () => Promise<void>) => Promise<void>;
  /**
   * 装配期 dsh 路由元数据解析失败的明确错误。装配不阻塞（stock 同款），在首个
   * 模型请求处抛出，禁止带着硬编码默认预算发请求。
   */
  modelResolutionFailure?: Error;
  /**
   * 单 turn 内模型步数上限，桥准入层实施。vendored 引擎主循环不消费
   * `AgentRuntimeConfig.maxTurns`（仅 subagent/memory 路径读取），所以不能只靠
   * 引擎透传；超限的后续步按 pre-step 拒绝收口（blocked，不发 agent/error）。
   */
  maxTurns?: number;
}

type Phase = { kind: "idle" | "running" | "maintenance" };

/**
 * 本文件私有哨兵：`prepareModelStep` 因 dsh pre-step 拒绝而抛出外部 turn fault
 * 时打标。引擎会把它持久化成 TurnError，但 dsh 侧已把 turn 结束原因置为
 * blocked；drain 必须保留该语义且不得再报 agent/error。
 */
const stepRejection = Symbol("dsh-step-rejection");

function markStepRejection(error: Error): Error {
  return Object.assign(error, { [stepRejection]: true });
}

/** 引擎会把外部 fault 包进 CoreError（cause 链），逐层识别哨兵。 */
function isStepRejection(error: unknown): boolean {
  let current: unknown = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    if ((current as Record<symbol, unknown>)[stepRejection] === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface PluginRecordMap { "plugin:zcode-loop/queue-mode": { paused: boolean } }
}

export class ZcodeLoopAgent implements Agent {
  readonly inbox: ZcodeLoopInbox;
  /**
   * 每 agent 铸造的 scoped ctx（stock 同款 `createScope(loopCtx, this)`）：
   * `scopeOf(agent.ctx)` 必须在场 —— agent preset 绑定（web 建会话挂「标准
   * 模式」等 preset）与 `tools.presentAs/restrict` 等按 agent 注册的面都
   * 以它为 scope key；此前直接用插件 ctx 会在 preset 绑定时抛
   * "Agent preset binding requires a scoped context"。
   */
  readonly ctx: Context;
  private readonly scope: Scope;
  private phase: Phase = { kind: "idle" };
  private turnCounter = 0;
  private currentTurnAbort: AbortController | undefined;
  private activity: Promise<void> = Promise.resolve();
  private readonly dispatch: AgentEventDispatch;
  private readonly toolContexts = new Map<string, readonly UserMessage[]>();
  private readonly promptAdmission: DshPromptAdmission;
  private stepAssembly?: PromptAssembly;
  private admittedMessages: readonly UserMessage[] = [];
  private engineSurfaceGeneration: number;
  private ready = false;
  private disposing = false;
  private disposal?: Promise<void>;
  private wakeRequested = false;
  private queueMode = { paused: false, offset: 0 };

  constructor(
    loopCtx: Context,
    public readonly id: DshSessionId,
    public readonly options: AgentOptions,
    public readonly session: DshSession,
    private readonly deps: ZcodeLoopAgentDeps,
  ) {
    this.scope = createScope(loopCtx, this);
    this.turnCounter = session.snapshotEvents().reduce((last, event) => event.type === "turn/start" ? Math.max(last, event.data.turn) : last, 0);
    this.ctx = this.scope.ctx;
    this.dispatch = agentEvents(loopCtx, this);
    this.promptAdmission = new DshPromptAdmission(loopCtx, this);
    this.engineSurfaceGeneration = session.surface.contentGeneration;
    // 阶段 6：inbox live 事件（inserted/claimed/discarded）转发进本 agent 的
    // 派发面（stock 同款词表）。闭包延迟读 dispatch，构造顺序无要求；
    // `agent/assistant-stream` 先例：事件声明不在本插件依赖集的类型面里，emit
    // 侧 `as never` 只传实际 payload（agent 字段由 Scoped dispatch 收窄）。
    this.inbox = new ZcodeLoopInbox(session, (event, payload) => {
      this.dispatch.emit(event as never, payload as never);
    });
  }

  /** 释放 agent scoped ctx（handle.dispose 与创建回滚时调用，对齐 stock teardown）。 */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposing = true;
    this.ready = false;
    this.deps.runtime?.beginShutdown();
    this.cancel({ kind: "disposed" }, { keepInbox: true });
    return this.disposal = (async () => { await this.whenIdle(); await this.scope.dispose(); })();
  }

  /** Adopt the public scope disposer under the factory's ordered teardown. */
  scopeDisposer(): () => Promise<void> | void { return this.scope.rawDispose; }

  /** Publication commits before queued setup/created-listener input may run. */
  start(): void { if (!this.disposing) { this.ready = true; this.wake(); } }

  /** Fold committed queue-control records, including seed/resume and reentrant observers. */
  get queuePaused(): boolean {
    const events = this.session.snapshotEvents(SessionLogOffset(this.queueMode.offset));
    for (const event of events) {
      const record = pluginRecordOf(event);
      if (record?.type !== "plugin:zcode-loop/queue-mode") continue;
      const data = record.data as { paused?: unknown } | null;
      if (!data || typeof data.paused !== "boolean") throw new Error(`Invalid queue mode at session seq ${event.seq}`);
      this.queueMode.paused = data.paused;
    }
    this.queueMode.offset += events.length;
    return this.queueMode.paused;
  }

  /** Pause later turns without cancelling the current model/tool turn. */
  setQueuePaused(paused: boolean): void {
    if (this.disposing) throw new Error("Cannot change the queue of a disposed agent");
    if (this.queuePaused !== paused) appendPluginRecord(this.session, "plugin:zcode-loop/queue-mode", { paused });
    if (!paused) this.wake();
  }

  /**
   * live 流式 frame 转 dsh AgentEventDispatch（stock 的 agent/assistant-stream 面，
   * web UI 据此逐字渲染）。`agent/assistant-stream` 的事件声明在 dsh-agent-loop
   * （本仓不依赖其类型面），emit 侧用 `as never` 对齐未增强的 Events 表；
   * 运行时 frame 形状与 stock 逐字段一致（由 event-store 桥构造）。
   */
  emitAssistantStream(frame: AssistantStreamFrame): void {
    this.dispatch.emit("agent/assistant-stream" as never, { frame } as never);
  }

  /** Called by this agent's tool bridge, including error results with contexts. */
  acceptToolContexts(callId: string, messages: readonly UserMessage[]): void {
    this.toolContexts.set(callId, messages);
  }

  /** Matching result is durable; enqueue a single guide for the next model step. */
  async deliverToolContexts(callId: string): Promise<void> {
    const messages = this.toolContexts.get(callId);
    if (messages === undefined || messages.length === 0) return;
    this.toolContexts.delete(callId);
    for (const message of messages) this.inbox.append("next-step", message);
    const runtime = this.deps.runtime;
    if (runtime === undefined) return;
    // Claim synchronously before awaiting the engine: external steering also
    // claims next-step, and must not submit these same contexts a second time.
    const claimed = this.inbox.claimMessages(messages.map((message) => message.id), this.turnCounter);
    const result = await runtime.steerTurn({ input: messages.map(userMessageText).join("\n\n"), delivery: "guide" });
    if (result.kind === "rejected") {
      this.deps.logDebug?.("tool context delivery rejected", { callId, reason: result.reason });
      for (const message of claimed) this.inbox.append("next-step", message);
      return;
    }
    for (const message of claimed) {
      this.session.append("user/message", message, { surfaceOp: "append" });
    }
  }

  get status(): AgentStatus {
    return this.phase.kind === "running" ? "running" : "idle";
  }

  // ----------------------------------------------------------------
  // 输入面（阶段 6：steer/inject 走 next-step 真语义，见 steerActive）
  // ----------------------------------------------------------------

  followup(message: UserMessage): void {
    this.send(message, "next-turn", true);
  }

  /**
   * steering（阶段 6）：busy 时经 steerActive 内联当前轮（引擎 `steerTurn`
   * delivery "guide"，同一 turn 内生效不切轮）；idle（或 runtime 缺席/竞态
   * 丢批）→ 维持 next-turn followup 降级（等价下一 turn，输入不丢）。
   */
  steer(message: UserMessage): void {
    this.send(message, "next-step", true);
  }

  /**
   * 注入（阶段 6 修正 v0 的 next-turn）：一律 next-step、不唤醒。busy 时立即
   * 内联当前轮（busy 中 wake 本就无操作）；idle 时排队等下一次唤醒由 drain 的
   * `claim("next-turn")` 拼接消费（stock inject 的 next-step 语义）。
   */
  inject(message: UserMessage): void {
    this.send(message, "next-step", false);
  }

  /**
   * Preserve the caller's inbox target; only waking input may release work
   * parked behind maintenance or a cancelled driver.
   */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (target === "next-step" && this.phase.kind === "running" && !this.currentTurnAbort?.signal.aborted && this.steerActive(message)) {
      if (wakeup) this.wake();
      return;
    }
    this.inbox.append(target, message);
    if (wakeup) this.wake();
  }

  /**
   * busy 时的统一 steering 消费点（steer 与 inject 共用）：留痕 → 消费留痕 →
   * 逐条落 surface + 喂引擎。返回是否成功喂给引擎（false = 没动 inbox 或空批，
   * 调用方按降级语义处理）。
   */
  private steerActive(message: UserMessage): boolean {
    // runtime 缺席守卫放最前：不动 inbox（不吞消息），调用方回退降级路径。
    const runtime = this.deps.runtime;
    if (runtime === undefined) return false;
    // Keep original input pending until the next host pre-step decides. The
    // engine guide only wakes its active loop; it is not surface admission.
    this.inbox.append("next-step", message);
      void runtime
        .steerTurn({ input: userMessageText(message), delivery: "guide" })
        .then(
          (result) => {
            if (result.kind === "rejected") {
              this.deps.logDebug?.("steerTurn rejected", {
                reason: result.reason,
                ...(result.activeTurnId === undefined
                  ? {}
                  : { activeTurnId: result.activeTurnId }),
              });
            }
          },
          (error: unknown) => {
            this.deps.logDebug?.("steerTurn failed", { error: String(error) });
          },
        );
    return true;
  }

  // ----------------------------------------------------------------
  // 生命周期面
  // ----------------------------------------------------------------

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    if (options?.keepInbox !== true) this.inbox.clear();
    if (this.currentTurnAbort && !this.currentTurnAbort.signal.aborted) {
      this.deps.eventBridge?.setTurnEndReason({ kind: "aborted", reason: { ...cause } });
      this.currentTurnAbort.abort(cause);
    }
  }

  async whenIdle(): Promise<void> {
    let observed: Promise<void>;
    do { await (observed = this.activity); } while (observed !== this.activity);
  }

  /**
   * 从 idle 起跑一个非 turn 维护任务；turn 驱动中同步抛错（stock 契约）。
   * 任务信号随 {@link cancel} 中止。
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposing || this.phase.kind !== "idle") {
      throw new Error(`agent "${this.id}" cannot run maintenance while busy`);
    }
    const controller = new AbortController();
    this.currentTurnAbort = controller;
    this.wakeRequested = false;
    const done = Promise.withResolvers<void>();
    this.activity = done.promise;
    this.setPhase("maintenance");
    const run = (async () => {
      try {
        return await task(controller.signal);
      } finally {
        const replay = this.wakeRequested && !this.disposing && !(controller.signal.aborted && (controller.signal.reason as AgentCancelCause)?.kind === "disposed");
        this.currentTurnAbort = undefined;
        this.wakeRequested = false;
        this.setPhase("idle");
        if (replay) this.wake();
        done.resolve();
      }
    })();
    return run;
  }

  // ----------------------------------------------------------------
  // 驱动
  // ----------------------------------------------------------------

  private setPhase(kind: Phase["kind"]): void {
    const previous = this.status;
    this.phase = { kind };
    const status = this.status;
    if (status !== previous) {
      this.dispatch.emit("agent/status", { status });
    }
  }

  /** idle 时启动 drain；busy 中到达的输入由循环下一轮 claim。 */
  private wake(): void {
    if (!this.ready || this.disposing || this.queuePaused) return;
    if (this.phase.kind !== "idle") {
      const signal = this.currentTurnAbort?.signal;
      if (!(signal?.aborted && (signal.reason as AgentCancelCause)?.kind === "disposed")
        && (this.phase.kind === "maintenance" || signal?.aborted)) this.wakeRequested = true;
      return;
    }
    if (!this.inbox.hasPending) return;
    const controller = new AbortController();
    this.currentTurnAbort = controller;
    this.wakeRequested = false;
    const done = Promise.withResolvers<void>();
    this.activity = done.promise;
    this.setPhase("running");
    // 阶段 8b：drain 包进 initiator 边界（goal 工具 authority 依赖
    // currentInitiator；stock loop 同款包装）。
    const run = this.deps.runWithInitiator?.(() => this.drain(controller)) ?? this.drain(controller);
    void run.then(done.resolve, error => { this.dispatch.emit("agent/error", { turn: this.turnCounter, step: 0, error }); done.resolve(); });
  }

  private async drain(controller: AbortController): Promise<void> {
    let first = true;
    try {
      while (first || this.inbox.hasPending) {
        if (controller.signal.aborted || this.disposing || this.queuePaused) break;
        first = false;
        const turn = this.turnCounter + 1;
        try {
          this.deps.eventBridge?.beginHostTurn(turn);
          this.turnCounter = turn;
          const batch = this.inbox.claim("next-turn", turn);
          if (batch.length === 0) { this.deps.eventBridge?.endHostTurn({ kind: "completed" }); break; }
          // 每 turn 同步 agent 可见工具；引擎另缓存模型 contract，须一起失效，
          // 否则后续 preset 工具增删虽已更新 registry，模型仍收到上一轮工具表。
          this.deps.toolBridge.syncTools();
          this.deps.runtime?.invalidateToolCache();
          const runtime = this.deps.runtime;
          if (runtime === undefined) {
            throw new Error(`agent "${this.id}" has no runtime attached`);
          }
          // The host owns explicit request-series boundaries (goal continuation,
          // for example). Preserve that decision at the same turn admission seam.
          const decision = await this.admitStep(batch, { turn, step: 1 }, controller.signal);
          controller.signal.throwIfAborted();
          // dsh 拒绝首步时 driver 结束，排队输入保持 pending，等待新输入唤醒。
          if (decision.kind === "reject") { this.deps.eventBridge?.endHostTurn({ kind: "blocked" }); break; }
          const generation = this.session.surface.contentGeneration;
          if (generation !== this.engineSurfaceGeneration && this.deps.refreshHistory) {
            await this.deps.refreshHistory();
            controller.signal.throwIfAborted();
            this.engineSurfaceGeneration = generation;
          }
          // Only admitted messages reach the durable user-message bridge.
          this.deps.eventBridge?.setPendingUserMessages(decision.messages);
          this.deps.eventBridge?.setStartsRequestSeries(decision.startsRequestSeries === true);
          const input = decision.messages.map(userMessageText).join("\n\n");
          await runtime.executeTurn(input, undefined, { abortSignal: controller.signal });
        } catch (error: unknown) {
          // 后续步被 dsh 拒绝：引擎的 TurnError 只是传递宿主决定，turn/end 的
          // blocked 已由 setTurnEndReason 落盘；保留它并停止，不重复报错。
          if (isStepRejection(error)) {
            this.deps.eventBridge?.endHostTurn({ kind: "blocked" });
            break;
          }
          // 开启段或 turn 内失败：保证 turn/end 收口后停止 driver；排队输入保持
          // pending，等待新输入唤醒。abort 是宿主显式取消（stock 同款：turn/end
          // 记 aborted 且不报 agent/error——goal-round-driver 依赖这一点先 pause
          // 后 disarm；若这里发 agent/error，它会先 disarm 而丢掉 pause 语义）。
          const aborted = controller.signal.aborted;
          this.deps.eventBridge?.endHostTurn(aborted
            ? { kind: "aborted", reason: { ...(controller.signal.reason as AgentCancelCause) } }
            // stock 同款：非 LlmError 一律 flatten cause 链到 UNKNOWN，避免 durable
            // turn/end 只剩引擎包装文案（如 "Turn execution failed"）而丢失 adapter 根因。
            : { kind: "error", error: { code: "UNKNOWN", message: errorChain(error) } });
          if (!aborted) this.dispatch.emit("agent/error", { turn, step: 0, error });
          break;
        } finally {
          this.toolContexts.clear();
          // 阶段 2 打点：每 turn 收口快照事件桥丢弃统计，经注入的 debug 出口进
          // dsh 日志面（PROJECTION.md 实测校验建议）；dropped === 0 不打（降噪）。
          const stats = this.deps.eventBridge?.dropStats();
          if (stats !== undefined && stats.dropped > 0) {
            this.deps.logDebug?.("event-bridge drop stats", {
              dropped: stats.dropped,
              droppedByType: stats.droppedByType,
              unknownTypes: stats.unknownTypes,
            });
          }
          if (!controller.signal.aborted) {
            controller = new AbortController();
            this.currentTurnAbort = controller;
          }
        }
      }
    } finally {
      const replay = this.wakeRequested && !this.disposing && !(controller.signal.aborted && (controller.signal.reason as AgentCancelCause)?.kind === "disposed");
      this.currentTurnAbort = undefined;
      this.wakeRequested = false;
      this.setPhase("idle");
      if (replay) this.wake();
    }
  }

  /** Every subsequent engine step crosses the same dsh admission boundary. */
  async prepareModelStep(position: { turn: number; step: number }): Promise<void> {
    if (position.step === 1) return; // The first batch is admitted by drain before executeTurn.
    const signal = this.currentTurnAbort!.signal;
    signal.throwIfAborted();
    // maxTurns 桥层实施：超限的后续步按 pre-step 拒绝收口（blocked），不发
    // agent/error——与 stock 第二步拒绝同族语义；引擎原生字段主循环不消费。
    const limit = this.deps.maxTurns;
    if (limit !== undefined && position.step > limit) {
      this.deps.eventBridge?.setTurnEndReason({ kind: "blocked" });
      throw markStepRejection(createExternalTurnFaultError("DSH_STEP_LIMIT",
        `agent "${this.id}" reached the maxTurns limit of ${limit} model step(s) in this turn`));
    }
    const messages = this.inbox.claim("next-step", position.turn);
    const decision = await this.admitStep(messages, position, signal);
    signal.throwIfAborted();
    if (decision.kind === "reject") {
      this.deps.eventBridge?.setTurnEndReason({ kind: "blocked" });
      throw markStepRejection(createExternalTurnFaultError("DSH_STEP_REJECTED", "dsh pre-step rejected the next model step"));
    }
    this.deps.eventBridge?.setPendingUserMessages(decision.messages);
    this.deps.eventBridge?.setStartsRequestSeries(decision.startsRequestSeries === true);
  }

  private async admitStep(messages: UserMessage[], position: { turn: number; step: number }, signal: AbortSignal): Promise<PreStepDecision> {
    this.stepAssembly = await this.promptAdmission.assemble(signal);
    signal.throwIfAborted();
    const context = this.promptAdmission.context(this.stepAssembly, signal);
    const decision = await this.dispatch.waterfall("agent/pre-step", { ...position, messages, signal },
      () => Promise.resolve({ kind: "enter" as const, messages: context ? [...messages, context] : messages }));
    signal.throwIfAborted();
    this.admittedMessages = decision.kind === "enter" ? decision.messages : [];
    return decision;
  }

  commitPrompt(prepared: PreparedLlmCall): void {
    if (!this.stepAssembly) throw new Error("Model request without dsh prompt assembly");
    const bridge = this.deps.eventBridge!;
    const context = this.promptAdmission.context(this.stepAssembly, this.currentTurnAbort!.signal);
    this.promptAdmission.commit(this.stepAssembly, bridge.requestPosition, prepared.systemPromptUpdate === "in-history", bridge.startsNewRequestSeries);
    bridge.setPendingUserMessages([...this.admittedMessages.filter(message => message.source.kind !== "runtime-context"), ...(context ? [context] : [])]);
    this.admittedMessages = [];
  }

  /**
   * dsh `AgentOptions.maxTokens` 是逐请求输出上限：在 agent/request waterfall
   * （含宿主改写）之后仍按 min(引擎请求预算, 上限) 收口，显式值不会抬高引擎
   * 按真实窗口声明/收缩的预算；未设置时保持引擎预算原样。
   */
  private capRequestMaxTokens(config: LlmCallConfig): LlmCallConfig {
    const cap = this.options.maxTokens;
    if (cap === undefined || (config.maxTokens !== undefined && config.maxTokens <= cap)) return config;
    return Object.freeze({ ...config, maxTokens: cap });
  }

  /** The dsh waterfall owns route changes and request-error recovery. */
  async *streamModelRequest(proposal: GenerateOptions, engineRequest: ModelRequest): AsyncIterable<StreamChunk> {
    // 装配期元数据解析失败（如 provider 无 adapter）在首个模型请求处显式抛出，
    // 不产生静默默认预算请求；路径与 stock 的延迟 NO_ADAPTER 失败一致。
    if (this.deps.modelResolutionFailure !== undefined) throw this.deps.modelResolutionFailure;
    const signal = this.currentTurnAbort!.signal;
    const position = this.deps.eventBridge!.requestPosition;
    let config: LlmCallConfig = {
      provider: proposal.provider, model: proposal.model,
      ...(proposal.maxTokens === undefined ? {} : { maxTokens: proposal.maxTokens }),
      ...(proposal.reasoningEffort === undefined ? {} : { reasoningEffort: proposal.reasoningEffort }),
    };
    while (true) {
      signal.throwIfAborted();
      config = await this.dispatch.waterfall("agent/request", { ...position, signal }, () => Promise.resolve(Object.freeze({ ...config })));
      signal.throwIfAborted();
      // 宿主改写之后仍受 dsh 请求级上限约束（见 capRequestMaxTokens）。
      config = this.capRequestMaxTokens(config);
      const prepared: PreparedLlmCall = await this.ctx.llm.prepareCall(config, signal);
      signal.throwIfAborted();
      this.deps.toolBridge.syncTools();
      this.deps.runtime?.invalidateToolCache();
      const request = markAgentLoopRequest({ ...proposal, tools: this.ctx.tools.schemas(this), ...prepared.config, sessionId: this.session.id, signal });
      this.deps.eventBridge!.recordPreparedRequest(prepared, request);
      const transient = this.deps.eventBridge!.requestOnlyMessages(engineRequest.messages).map(index => proposal.messages[index]!);
      request.messages = [...this.session.deriveMessages(), ...transient];
      request.toolHistory = this.session.toolHistory();
      let emitted = false;
      try {
        for await (const chunk of prepared.stream(request)) {
          signal.throwIfAborted();
          if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
            throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code, chunk.reason.failure);
          }
          emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        signal.throwIfAborted();
        const failure = error instanceof LlmError ? error.failure : { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };
        const action = await this.dispatch.waterfall("agent/request-error", {
          ...position, signal, provider: prepared.config.provider, failure, retryPolicy: prepared.retryPolicy,
        }, () => Promise.resolve(undefined));
        if (action?.kind !== "retry") throw error;
        // The public model error's retryable fact delegates partial-tail reset
        // to ZCode's bounded recovery; never concatenate a fresh stream here.
        if (emitted) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable: true });
        this.deps.eventBridge!.rearmPreparedRequest();
      }
    }
  }
}
