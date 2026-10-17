/**
 * agent — ZCode 引擎驱动的最小 dsh Agent（S03）。
 *
 * 实现 `@deepseek-ai/dsh-agent` 的运行时 Agent 面（followup/steer/inject/cancel/
 * whenIdle/runMaintenance/status/inbox）。驱动模型（原型 v0）：
 *
 * - `followup` / `send(wakeup=true)` / `steer` → 入 next-turn inbox 并唤醒；
 *   唤醒后 drain 循环逐条 claim（一条 followup 独占一个 turn），每 turn 前
 *   `toolBridge.syncTools()`（任务合同"每 turn 前同步 schemas"），再
 *   `runtime.executeTurn(text, { abortSignal })`。
 * - `steer`/`inject` v0 一律按 next-turn 处理（PLAN 排除项：steering 的
 *   next-step/inject 完整语义不做）；`inject` 不唤醒。
 * - `cancel` → abort 当前 turn 的 AbortController（引擎收口事件流）；
 *   除非 `keepInbox`，先持久清空 inbox。
 * - 事件：`agent/status`（idle⇄running）与 `agent/error` 经 dsh-agent 的
 *   `agentEvents` 派发面发声；inbox live 事件 v0 不发（见 inbox.ts 模块头）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
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
import type { DshToolBridge } from "./bridges/tool-bridge.js";

export interface ZcodeLoopAgentDeps {
  /**
   * 晚绑定：createAgent 先构造 agent（dsh system prompt 装配需要读
   * agent.options/agent.session 的真实对象），再创建引擎并回填本字段；
   * 引擎就绪前 agent 不会进入任何 turn（构造→装配→挂载→发布后才可被驱动）。
   */
  runtime?: AgentRuntime;
  toolBridge: DshToolBridge;
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
    this.inbox = new ZcodeLoopInbox(session);
    this.dispatch = agentEvents(loopCtx, this);
  }

  /** 释放 agent scoped ctx（handle.dispose 与创建回滚时调用，对齐 stock teardown）。 */
  dispose(): Promise<void> {
    return this.scope.dispose();
  }

  get status(): AgentStatus {
    return this.phase.kind === "idle" ? "idle" : "running";
  }

  // ----------------------------------------------------------------
  // 输入面（v0：一律 next-turn）
  // ----------------------------------------------------------------

  followup(message: UserMessage): void {
    this.inbox.append("next-turn", message);
    this.wake();
  }

  /** v0：steering 按 next-turn followup 处理（下一个 turn 生效）。 */
  steer(message: UserMessage): void {
    this.inbox.append("next-turn", message);
    this.wake();
  }

  /** v0：注入不唤醒，排进 next-turn 等待下一次 followup 唤醒。 */
  inject(message: UserMessage): void {
    this.inbox.append("next-turn", message);
  }

  send(message: UserMessage, _target: InboxTarget, wakeup: boolean): void {
    this.inbox.append("next-turn", message);
    if (wakeup) this.wake();
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
        // 任务期间到达的输入按 next-turn 语义唤醒。
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
    const run = this.drain();
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
        // 任务合同：每 turn 前把 ctx.tools 的 schemas 同步进 ZCode registry。
        this.deps.toolBridge.syncTools();
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
        }
      }
    } finally {
      this.setPhase(false);
    }
  }
}
