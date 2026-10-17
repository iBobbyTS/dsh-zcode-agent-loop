/**
 * 本插件的窄运行时接缝：按 dsh Agent 解析本工厂铸造的引擎 runtime，并广播
 * 创建/释放通知。
 *
 * 职责只有两件事，刻意不做通用 DI、能力注册或 native 工具白名单：
 * - `resolve(agent)`：仅接受本工厂的 `ZcodeLoopAgent`，返回最小视图
 *   `{ agentId, runtime }`；其他工厂/手工 Agent 明确报错，不猜认。
 * - `zcode-loop/runtime-created` / `zcode-loop/runtime-released` 事件：
 *   监听方在自身上下文注册（`ctx.on(...)`），随其插件卸载自动注销。
 *
 * 生命周期约束：视图只在发布完成后登记；agent dispose（scope 释放）或工厂
 * teardown 时显式释放。服务本身随工厂 fiber 卸载自动注销，内部映射为 WeakMap，
 * 不会留下旧 agent/runtime 引用；inject 本服务的扩展由 cordis 随服务注销卸载。
 */
import type { Context } from "@deepseek-ai/cordis";
import { Service } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

import type { AgentRuntime } from "./engine-facade.js";
import { ZcodeLoopAgent } from "./agent.js";

/** 扩展可见的最小句柄：身份 + 引擎 runtime，不承诺其他公共面。 */
export interface ZcodeLoopRuntimeView {
  /** dsh agent/session 身份（字符串形式，避免扩展依赖 session 品牌类型）。 */
  readonly agentId: string;
  /** 本工厂为该 agent 装配的引擎 runtime 句柄。 */
  readonly runtime: AgentRuntime;
}

/** 释放通知只带身份，避免把已释放 runtime 再交给监听方。 */
export interface ZcodeLoopRuntimeRelease {
  readonly agentId: string;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    zcodeLoopRuntimes: ZcodeLoopRuntimes;
  }

  interface Events {
    /** 本工厂 agent 已发布，runtime 可经 resolve 取得。 */
    "zcode-loop/runtime-created"(view: ZcodeLoopRuntimeView): void;
    /** runtime 已从服务移除（agent dispose、创建回滚或工厂卸载）。 */
    "zcode-loop/runtime-released"(release: ZcodeLoopRuntimeRelease): void;
  }
}

export class ZcodeLoopRuntimes extends Service {
  private readonly views = new WeakMap<ZcodeLoopAgent, ZcodeLoopRuntimeView>();

  constructor(ctx: Context) {
    super(ctx, "zcodeLoopRuntimes");
  }

  /**
   * 解析本工厂 agent 的 runtime 视图。
   * 非本工厂 agent 与未发布/已释放的 agent 都明确报错；禁止跨工厂猜认。
   */
  resolve(agent: Agent): ZcodeLoopRuntimeView {
    if (!(agent instanceof ZcodeLoopAgent)) {
      throw new Error(
        "zcodeLoopRuntimes.resolve: not a zcode-loop agent (only agents created by this factory are supported)",
      );
    }
    const view = this.views.get(agent);
    if (view === undefined) {
      throw new Error(
        "zcodeLoopRuntimes.resolve: zcode-loop agent is not published or has been released",
      );
    }
    return view;
  }

  /**
   * 发布后登记（工厂在 announce 完成后调用）。
   * agent scope 释放时自动释放，覆盖直接 `agent.dispose()` 与工厂 teardown。
   */
  publish(agent: ZcodeLoopAgent, runtime: AgentRuntime): ZcodeLoopRuntimeView {
    const existing = this.views.get(agent);
    if (existing !== undefined) return existing;
    const view: ZcodeLoopRuntimeView = Object.freeze({ agentId: String(agent.id), runtime });
    this.views.set(agent, view);
    agent.ctx.effect(() => () => this.release(agent), `zcodeLoopRuntimes.release(${view.agentId})`);
    this.notify("zcode-loop/runtime-created", view);
    return view;
  }

  /** 幂等释放；只有真正登记过的 agent 才发释放通知。 */
  release(agent: ZcodeLoopAgent | undefined): void {
    if (agent === undefined) return;
    const view = this.views.get(agent);
    if (view === undefined) return;
    this.views.delete(agent);
    this.notify("zcode-loop/runtime-released", { agentId: view.agentId });
  }

  /**
   * 通知失败不得回滚已发布的 agent；监听方自己的异常由日志暴露。
   * emit 是同步派发，单个监听方抛错会中断后续派发，故在此收口。
   */
  private notify(
    name: "zcode-loop/runtime-created" | "zcode-loop/runtime-released",
    payload: ZcodeLoopRuntimeView | ZcodeLoopRuntimeRelease,
  ): void {
    try {
      (this.ctx.emit as unknown as (event: string, payload: unknown) => void)(name, payload);
    } catch (error) {
      this.ctx.logger.warn("zcode-loop runtime seam notification failed: %s", error);
    }
  }
}
