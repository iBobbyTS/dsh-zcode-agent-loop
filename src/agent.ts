/**
 * agent — ZCode 引擎驱动的最小 dsh Agent。
 *
 * 实现 `@deepseek-ai/dsh-agent` 的运行时 Agent 面（followup/steer/inject/cancel/
 * whenIdle/runMaintenance/status/inbox）。驱动模型（原型 v0）：
 *
 * - `followup` / `send(wakeup=true)` → 入 next-turn inbox 并唤醒；唤醒后 drain
 *   循环逐条 claim（一条 followup 独占一个 turn），每 turn 前
 *   `toolBridge.syncTools()`（任务合同"每 turn 前同步 schemas"），再
 *   `runtime.executeTurn(text, { abortSignal })`。
 * - `steer`/`inject`（阶段 6 真语义，stock 对齐 `send(next-step)`）：busy 时经
 *   steerActive 立即喂引擎 `runtime.steerTurn({delivery:"guide"})`（内联当前轮，
 *   不切轮；留痕 + surface user/message 落盘）；steer 空闲时降级 next-turn+
 *   wake（引擎空闲会 rejected，保输入不丢），inject 空闲时排 next-step 不唤醒
 *   （由 drain 的 claim 拼接消费）。steerTurn 的 promise 链吞错（同步契约）。
 * - `cancel` → abort 当前 turn 的 AbortController（引擎收口事件流）；
 *   除非 `keepInbox`，先持久清空 inbox。
 * - 事件：`agent/status`（idle⇄running）、`agent/error` 与 inbox live 词表
 *   （`agent/inbox/inserted|claimed|discarded`，经 inbox 的 emitLive 回调转发）
 *   均经 dsh-agent 的 `agentEvents` 派发面发声。
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
} from "@deepseek-ai/dsh-agent";
import { agentEvents } from "@deepseek-ai/dsh-agent";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { Scope } from "@deepseek-ai/dsh-scope";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import type { Session as DshSession, SessionId as DshSessionId } from "@deepseek-ai/dsh-session";

import type { AgentRuntime } from "./engine-facade.js";
import { ZcodeLoopInbox, userMessageText } from "./inbox.js";
import type { DshSessionEventStoreBridge } from "./bridges/event-store-bridge.js";
import type { DshToolBridge } from "./bridges/tool-bridge.js";

export interface ZcodeLoopAgentDeps {
  /**
   * 晚绑定：createAgent 先构造 agent（dsh system prompt 装配需要读
   * agent.options/agent.session 的真实对象），再创建引擎并回填本字段；
   * 引擎就绪前 agent 不会进入任何 turn（构造→装配→挂载→发布后才可被驱动）。
   */
  runtime?: AgentRuntime;
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
}

type Phase = { kind: "idle" } | { kind: "busy" };

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

  constructor(
    loopCtx: Context,
    public readonly id: DshSessionId,
    public readonly options: AgentOptions,
    public readonly session: DshSession,
    private readonly deps: ZcodeLoopAgentDeps,
  ) {
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx;
    this.dispatch = agentEvents(loopCtx, this);
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
    return this.scope.dispose();
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

  get status(): AgentStatus {
    return this.phase.kind === "idle" ? "idle" : "running";
  }

  // ----------------------------------------------------------------
  // 输入面（阶段 6：steer/inject 走 next-step 真语义，见 steerActive）
  // ----------------------------------------------------------------

  followup(message: UserMessage): void {
    this.inbox.append("next-turn", message);
    this.wake();
  }

  /**
   * steering（阶段 6）：busy 时经 steerActive 内联当前轮（引擎 `steerTurn`
   * delivery "guide"，同一 turn 内生效不切轮）；idle（或 runtime 缺席/竞态
   * 丢批）→ 维持 next-turn followup 降级（等价下一 turn，输入不丢）。
   */
  steer(message: UserMessage): void {
    if (this.phase.kind === "busy" && this.steerActive(message)) return;
    this.inbox.append("next-turn", message);
    this.wake();
  }

  /**
   * 注入（阶段 6 修正 v0 的 next-turn）：一律 next-step、不唤醒。busy 时立即
   * 内联当前轮（busy 中 wake 本就无操作）；idle 时排队等下一次唤醒由 drain 的
   * `claim("next-turn")` 拼接消费（stock inject 的 next-step 语义）。
   */
  inject(message: UserMessage): void {
    if (this.phase.kind === "busy" && this.steerActive(message)) return;
    this.inbox.append("next-step", message);
  }

  /**
   * dsh web 不用显式 target：维持忽略 target 仅按 wakeup（备注：stock 按
   * target 入队，此处分叉未被任何调用方依赖——PLAN 阶段 6 排除项）。
   */
  send(message: UserMessage, _target: InboxTarget, wakeup: boolean): void {
    this.inbox.append("next-turn", message);
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
    // 1) 持久留痕（spliced insert + live inserted）——引擎侧注入结果如何，
    //    输入已在账本上（steering 审计面，stock 的 inbox 语义）。
    this.inbox.append("next-step", message);
    // 2) 消费性留痕（live claimed，记到当前 turn）：拿走全部 next-step——含
    //    此前 inject 的残留，逐条处理。空数组只在理论竞态下出现，直接放弃。
    const claimed = this.inbox.claim("next-step", this.turnCounter);
    if (claimed.length === 0) return false;
    for (const claimedMessage of claimed) {
      // 3) surface 落盘（stock 对齐：steering 输入对 dsh surface 可见）。busy
      //    时 open turn 已在场（turn/start 已落），直接 append 合法；阶段 8a
      //    起落 claim 的原消息对象（producer source 与原始 content 块保真，
      //    不再重建 {kind:"user"}）。text 只作引擎侧输入投影（非 text 块占位）。
      const text = userMessageText(claimedMessage);
      this.session.append("user/message", claimedMessage, { surfaceOp: "append" });
      // 4) 喂引擎：delivery "guide" = 对进行中工作的补充引导，内联当前轮不切
      //    轮（next-step 语义）。steer()/inject() 是同步契约——promise 必须
      //    void 吞错：accepted 无事可做；rejected（no_active_turn 等空闲竞态/
      //    维护窗口，result 不抛错）打 debug 日志；链上异常同样吞进日志，绝不
      //    冒进同步调用栈。
      void runtime
        .steerTurn({ input: text, delivery: "guide" })
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
    }
    return true;
  }

  // ----------------------------------------------------------------
  // 生命周期面
  // ----------------------------------------------------------------

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    if (options?.keepInbox !== true) this.inbox.clear();
    const reason = new Error(`agent "${this.id}" cancelled: ${cause.kind}`);
    this.currentTurnAbort?.abort(reason);
  }

  whenIdle(): Promise<void> {
    return this.activity;
  }

  /**
   * 从 idle 起跑一个非 turn 维护任务；turn 驱动中同步抛错（stock 契约）。
   * 任务信号随 {@link cancel} 中止。
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== "idle") {
      throw new Error(`agent "${this.id}" cannot run maintenance while busy`);
    }
    const controller = new AbortController();
    this.currentTurnAbort = controller;
    this.setPhase(true);
    const run = (async () => {
      try {
        return await task(controller.signal);
      } finally {
        this.currentTurnAbort = undefined;
        this.setPhase(false);
        // 任务期间 followup 式到达的输入由结尾 wake() 收割（steer/inject 在
        // busy 期间已走 steerActive，不依赖本次唤醒）。
        this.wake();
      }
    })();
    this.activity = this.activity.then(
      () => run.then(() => undefined, () => undefined),
      () => undefined,
    );
    return run;
  }

  // ----------------------------------------------------------------
  // 驱动
  // ----------------------------------------------------------------

  private setPhase(busy: boolean): void {
    const previous = this.status;
    this.phase = busy ? { kind: "busy" } : { kind: "idle" };
    const status = this.status;
    if (status !== previous) {
      this.dispatch.emit("agent/status", { status });
    }
  }

  /** idle 时启动 drain；busy 中到达的输入由循环下一轮 claim。 */
  private wake(): void {
    if (this.phase.kind !== "idle" || !this.inbox.hasPending) return;
    // 阶段 8b：drain 包进 initiator 边界（goal 工具 authority 依赖
    // currentInitiator；stock loop 同款包装）。
    const run = this.deps.runWithInitiator?.(() => this.drain()) ?? this.drain();
    this.activity = this.activity.then(
      () => run,
      () => run,
    );
  }

  private async drain(): Promise<void> {
    this.setPhase(true);
    try {
      while (this.inbox.hasPending) {
        const turn = ++this.turnCounter;
        const batch = this.inbox.claim("next-turn", turn);
        if (batch.length === 0) break;
        // 阶段 8a：claim 的原始消息批交给事件桥——model_request 落盘时逐条
        // append 原消息对象（producer source 保真）；turn 收口由桥自清。
        this.deps.eventBridge?.setPendingUserMessages(batch);
        // 每 turn 同步 agent 可见工具；引擎另缓存模型 contract，须一起失效，
        // 否则后续 preset 工具增删虽已更新 registry，模型仍收到上一轮工具表。
        this.deps.toolBridge.syncTools();
        this.deps.runtime?.invalidateToolCache();
        const input = batch.map(userMessageText).join("\n\n");
        const controller = new AbortController();
        this.currentTurnAbort = controller;
        try {
          const runtime = this.deps.runtime;
          if (runtime === undefined) {
            throw new Error(`agent "${this.id}" has no runtime attached`);
          }
          await runtime.executeTurn(input, undefined, { abortSignal: controller.signal });
        } catch (error: unknown) {
          this.dispatch.emit("agent/error", { turn, step: 0, error });
        } finally {
          this.currentTurnAbort = undefined;
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
        }
      }
    } finally {
      this.setPhase(false);
    }
  }
}
