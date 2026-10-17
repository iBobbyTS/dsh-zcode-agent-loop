/**
 * dsh-plugin-zcode-loop — Cordis 插件入口（S03）。
 *
 * 把 vendored ZCode `AgentRuntime` 作为外部插件装进 dsh，替换 stock
 * `dsh-agent-loop`（profile patch：disable agent-loop row + insert 本插件 row，
 * 见 `dsh.bundle` 声明与 `profile/cordis.patch.yml` 样例）。
 *
 * `AgentFactory.createAgent` 装配（结构照抄 stock loop 的 createAgent/createStoredSession
 * 路径；persistence backend 在场时 prepare→persistence.create→…→enter→announce
 * 让 session 事件经 live 路由落进写句柄，无 backend 时退化为纯内存发布）：
 *
 *   dsh session 创建/挂载 → event-store 桥（S02，唯一落盘真相）
 *   → 工具桥（dsh 工具面 → ZCode ToolRegistry；执行回 dsh 管线）
 *   → model-bridge（S02，经 dsh llm 路由）→ permissionBroker 直通 allow
 *   → systemPrompt = dsh `SystemPrompt.assemble()` 渲染文本（每轮存活的
 *     `config.systemPrompt` 接缝 + 构造期最小 contextBuilder，见
 *     `bridges/system-prompt-bridge.ts` 模块头）
 *   → `toolAllowlist: []` 关闭全部 ZCode 内建工具（工具面=dsh 管线，且
 *     TodoWrite 在场性关闭 todo reminder）
 *   → `AgentRuntime` + `ZcodeLoopAgent` → 注册/公告 → AgentHandle。
 *
 * `resume` 抛 `PrototypeUnsupportedError`（code `PROTOTYPE_UNSUPPORTED`）。
 */
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type {
  AgentFactory,
  AgentHandle,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type { LlmResolvedModelInfo } from "@deepseek-ai/dsh-llm";
import { SessionLogOffset } from "@deepseek-ai/dsh-session";

import { ZcodeLoopAgent } from "./agent.js";
import type { ZcodeLoopAgentDeps } from "./agent.js";
import { DshSessionEventStoreBridge } from "./bridges/event-store-bridge.js";
import { createDshModelBridge } from "./bridges/model-bridge.js";
import {
  assembleDshSystemPrompt,
  createDshContextBuilder,
} from "./bridges/system-prompt-bridge.js";
import { createDshToolBridge } from "./bridges/tool-bridge.js";
import {
  createAllowThroughPermissionBroker,
  createEmbeddedEngine,
  createSessionId,
} from "./engine-facade.js";
import type { ContextBuilder } from "./engine-facade.js";

/** resume 等 prototype 排除项的统一报错（机读码 `PROTOTYPE_UNSUPPORTED`）。 */
export class PrototypeUnsupportedError extends Error {
  readonly code = "PROTOTYPE_UNSUPPORTED";

  constructor(message: string) {
    super(message);
    this.name = "PrototypeUnsupportedError";
  }
}

/** 插件配置（cordis.patch.yml 的 row 字段）。 */
export interface Config {
  /** dsh llm provider 路由（须已注册 adapter）。 */
  provider: string;
  /** dsh model id。 */
  model: string;
  /** 声明给引擎的上下文窗口（透传 model-bridge）。 */
  contextWindow?: number;
  /** 声明给引擎的最大输出 token（透传 model-bridge）。 */
  maxOutputTokens?: number;
}

/**
 * 替换 stock agent-loop 的 zcode loop 工厂。
 * inject 与 stock AgentLoop 对齐（少 sessionProjections：inbox 最小重写不挂投影）。
 */
export class ZcodeLoop extends Service implements AgentFactory {
  static inject = ["agents", "sessions", "llm", "tools", "systemPrompt"];

  static Config: z<Config> = z.object({
    provider: z.string().required(),
    model: z.string().required(),
    contextWindow: z.natural(),
    maxOutputTokens: z.natural(),
  }) as unknown as z<Config>;

  /**
   * 本插件自己的 fiber ctx（构造参数，构造期捕获）。
   *
   * S04 现场实测：`createAgent` 被调用时 `this` 是 cordis traceable receiver
   * （dsh AgentRegistry.create 用 `getTraceable(ownerCtx, target)` 把调用方 ctx
   * 绑进 receiver，"ownership follows the caller"），因此 `this.ctx` 会**重绑成
   * 调用方入口插件**（如 headless-runner）的 ctx，其注入面没有 systemPrompt 等
   * 服务 —— 一切服务访问必须走本字段（stock 同款：`this.runtime.ctx`），`ownerCtx`
   * 只用于 ownership 断言。`this.ctx` 的 own-property 赋值被 proxy 拦截，故另取
   * 字段名保存。
   */
  private readonly loopCtx: Context;

  constructor(ctx: Context, public readonly config: Config) {
    super(ctx, "zcodeLoop");
    this.loopCtx = ctx;
    ctx.effect(() => ctx.agents.setFactory(this), "zcodeLoop.setFactory()");
    // 与 stock AgentLoop 相同的两个 prompt 变量（persona 段可能引用）。
    ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
    ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // ownership 断言对齐 stock（createAgent 的 this 被重绑为调用方 receiver，
    // 服务访问一律走 this.loopCtx —— 见 loopCtx 字段注释）。
    ownerCtx.fiber.assertActive();
    // ---- dsh session 装配（stock createAgent/createStoredSession 路径）----
    // prepare（未发布）→ persistence.create（session-persistence 在场即开写句柄，
    // jsonl 后端把已发布 session 的 live 事件按 id 路由进句柄）→ 装配 →
    // enter → agents.enter → announce → 补存 setup 窗口事件 → announce('startup')。
    // 原实现用 sessions.create（prepare+enter+announce 一步发布）：在真实 dsh
    // （dsh-base 挂了 session-persistence-jsonl）下没有任何写句柄，session log
    // 不会落盘 —— S04 修复（最小改动，报告声明），无 persistence 时行为与 S03 一致。
    const session = this.loopCtx.sessions.prepare(options.sessionId, {
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.inheritedEventCount === undefined
        ? {}
        : { inheritedEventCount: options.inheritedEventCount }),
    });
    const persistence = this.loopCtx.get("sessionPersistence");
    const stored =
      persistence === undefined
        ? undefined
        : {
            handle: await persistence.create(session.header, {
              ...(options.inheritedEventCount === undefined
                ? {}
                : { inheritedEventCount: options.inheritedEventCount }),
            }),
            storedCount: 0,
          };

    let created: ZcodeLoopAgent | undefined;
    try {
      // ---- 路由（agentOptions 覆盖插件默认）----
      const agentOptions = options.agentOptions ?? {};
      const provider = agentOptions.provider ?? this.config.provider;
      const model = agentOptions.model ?? this.config.model;

      // ---- dsh 路由真实元数据（引擎面 Model 声明的首选来源）----
      // 查询失败不阻塞装配：桥内回落 config → 硬编码默认（docs/GAPS.md 取值链）。
      let resolved: LlmResolvedModelInfo | undefined;
      try {
        resolved = await this.loopCtx.llm.resolveModelInfo(provider, model);
      } catch {
        resolved = undefined;
      }
      // agentOptions.reasoningEffort → 引擎 selection 档位（仅在 dsh 目录档位表内；
      // 引擎会按 optionSpecs.reasoningLevel.values 校验 selection，缺席目录时映射会失配）。
      const effortIds = resolved?.reasoning?.efforts?.map((effort) => effort.id) ?? [];
      const reasoningLevel =
        agentOptions.reasoningEffort !== undefined && effortIds.includes(agentOptions.reasoningEffort)
          ? agentOptions.reasoningEffort
          : undefined;

      // ---- 桥件 ----
      const sessionId = createSessionId(String(options.sessionId));
      const eventBridge = new DshSessionEventStoreBridge({ session, sessionId });
      const toolBridge = createDshToolBridge({
        ctx: this.loopCtx,
        // 工具执行期解析在册 agent（进入 dsh 执行输入的 agent 字段）。
        agent: () => this.loopCtx.agents.get(options.sessionId),
      });
      // 生效路由写回 agentOptions：agent.options 的 provider/model 是 persona 段
      // prompt 变量（{{provider}}/{{model}}，web 模板自带 personaPrefix 引用）与
      // UI 展示的事实来源；agentOptions 缺省时此前只落在局部变量上，装配上下文
      // 读 agent.options.model 拿到 undefined → {{model}} 插值直接抛错。
      const effectiveOptions: AgentOptions = { ...agentOptions, provider, model };
      // runtime 晚绑定：prompt 装配必须带 agent（变量/上下文 provider 读
      // context.agent，如 harness-dev-context 读 agent.session），而引擎
      // config.systemPrompt 又依赖装配结果 —— 先建 agent、装配，再挂 runtime。
      const agentDeps: ZcodeLoopAgentDeps = { toolBridge };
      const agent = (created = new ZcodeLoopAgent(
        this.loopCtx,
        options.sessionId,
        effectiveOptions,
        session,
        agentDeps,
      ));
      const promptAssembly = await assembleDshSystemPrompt(this.loopCtx, agent);

      // ---- ZCode 引擎（全经门面装配）----
      const runtime = createEmbeddedEngine({
        sessionId,
        eventStore: eventBridge,
        modelFactory: createDshModelBridge({
          ctx: this.loopCtx,
          provider,
          model,
          ...(resolved === undefined ? {} : { resolved }),
          ...(this.config.contextWindow === undefined
            ? {}
            : { contextWindow: this.config.contextWindow }),
          ...(this.config.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: this.config.maxOutputTokens }),
        }),
        workingDirectory: options.meta?.cwd ?? process.cwd(),
        config: {
          modelSelection: {
            providerId: provider,
            modelId: model,
            ...(reasoningLevel === undefined ? {} : { options: { reasoningLevel } }),
          },
          // 每轮存活的 system prompt 接缝（见 system-prompt-bridge 模块头）。
          systemPrompt: promptAssembly.prompt,
          // 禁全部内建工具：模型可见工具面 = dsh 工具（经桥），todo reminder 门随之关闭。
          toolAllowlist: [],
          dynamicWorkflowEnabled: false,
          dynamicWorkflowToolsOnDemand: false,
        },
        deps: {
          toolRegistry: toolBridge.registry,
          // 直通 allow：把关交给 dsh 管线（tools/pre-execute waterfall 等）。
          permissionBroker: createAllowThroughPermissionBroker(),
          // 构造期最小 contextBuilder（首轮起被引擎 rebuild 取代，见模块头注释）。
          contextBuilder: createDshContextBuilder(promptAssembly) as unknown as ContextBuilder,
        },
      });
      agentDeps.runtime = runtime;

      // ---- Agent + 发布（setup 在发布前跑，对齐 stock 的事务顺序）----
      const setupCommit = await options.setup?.(agent.ctx, agent);
      setupCommit?.commit();

      // ---- 发布事务（stock publish 顺序）：补存 setup 窗口事件（不经 live 路由）
      // → session enter → agent enter → announce → announce('startup') ----
      if (stored !== undefined) {
        // setup 窗口内追加的事件不经 session/event 重放，发布点补存（stock
        // appendUnstoredSuffix）；必须在 enter 之前——enter 起 live 路由会把写
        // 句柄光标按 event seq 推进，从 storedCount=0 补存会 seq 错位。
        const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
        if (suffix.length > 0) await stored.handle.append(suffix);
        stored.storedCount += suffix.length;
      }
      const detachSession = this.loopCtx.sessions.enter(session);
      const detachAgent = this.loopCtx.agents.enter(agent, options.parentAgent);
      this.loopCtx.sessions.announce(session);
      await this.loopCtx.agents.announce(agent, "startup");

      return {
        agent,
        dispose: async () => {
          agent.cancel({ kind: "disposed" }, { keepInbox: true });
          await agent.whenIdle();
          detachAgent();
          detachSession();
          await agent.dispose();
        },
      };
    } catch (error: unknown) {
      // 回滚：释放已铸造的 agent scope，关闭未物化的写句柄（stock create 的
      // stored?.handle.close()）。
      await created?.dispose().catch(() => {});
      await stored?.handle.close().catch(() => {});
      throw error;
    }
  }

  async resume(_ownerCtx: Context, _options: ResumeAgentOptions): Promise<AgentHandle> {
    throw new PrototypeUnsupportedError(
      "resume is not supported by the zcode-loop prototype (PROTOTYPE_UNSUPPORTED; fork/hydrator are out of scope)",
    );
  }
}

export default ZcodeLoop;
export { ZcodeLoopAgent } from "./agent.js";
export { ZcodeLoopInbox } from "./inbox.js";
export { createDshToolBridge } from "./bridges/tool-bridge.js";
export { assembleDshSystemPrompt } from "./bridges/system-prompt-bridge.js";
export { DshSessionEventStoreBridge } from "./bridges/event-store-bridge.js";
export { createDshModelBridge, DshModelError } from "./bridges/model-bridge.js";
