/**
 * dsh-plugin-zcode-loop — Cordis 插件入口（S03）。
 *
 * 把 vendored ZCode `AgentRuntime` 作为外部插件装进 dsh，替换 stock
 * `dsh-agent-loop`（profile patch：disable agent-loop row + insert 本插件 row，
 * 见 `dsh.bundle` 声明与 `profile/cordis.patch.yml` 样例）。
 *
 * `AgentFactory.createAgent` 装配（结构照抄 stock loop 的 createStoredSession
 * 路径；原型无 persistence backend，`createStoredSession` 退化为
 * sessions.create 即 prepare→enter→announce）：
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
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";

import { ZcodeLoopAgent } from "./agent.js";
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

  constructor(ctx: Context, public readonly config: Config) {
    super(ctx, "zcodeLoop");
    ctx.effect(() => ctx.agents.setFactory(this), "zcodeLoop.setFactory()");
    // 与 stock AgentLoop 相同的两个 prompt 变量（persona 段可能引用）。
    ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
    ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // ---- dsh session 创建/挂载（stock createStoredSession 路径；无 persistence）----
    const session = this.ctx.sessions.create(options.sessionId, {
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.inheritedEventCount === undefined
        ? {}
        : { inheritedEventCount: options.inheritedEventCount }),
    });

    // ---- 路由（agentOptions 覆盖插件默认）----
    const agentOptions = options.agentOptions ?? {};
    const provider = agentOptions.provider ?? this.config.provider;
    const model = agentOptions.model ?? this.config.model;

    // ---- 桥件 ----
    const sessionId = createSessionId(String(options.sessionId));
    const eventBridge = new DshSessionEventStoreBridge({ session, sessionId });
    const toolBridge = createDshToolBridge({
      ctx: this.ctx,
      // 工具执行期解析在册 agent（进入 dsh 执行输入的 agent 字段）。
      agent: () => this.ctx.agents.get(options.sessionId),
    });
    const promptAssembly = await assembleDshSystemPrompt(this.ctx);

    // ---- ZCode 引擎（全经门面装配）----
    const runtime = createEmbeddedEngine({
      sessionId,
      eventStore: eventBridge,
      modelFactory: createDshModelBridge({
        ctx: this.ctx,
        provider,
        model,
        ...(this.config.contextWindow === undefined
          ? {}
          : { contextWindow: this.config.contextWindow }),
        ...(this.config.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: this.config.maxOutputTokens }),
      }),
      workingDirectory: options.meta?.cwd ?? process.cwd(),
      config: {
        modelSelection: { providerId: provider, modelId: model },
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

    // ---- Agent + 发布（setup 在发布前跑，对齐 stock 的事务顺序）----
    const agent = new ZcodeLoopAgent(this.ctx, options.sessionId, agentOptions, session, {
      runtime,
      toolBridge,
    });
    const setupCommit = await options.setup?.(agent.ctx, agent);
    setupCommit?.commit();
    const detachAgent = this.ctx.agents.enter(agent, options.parentAgent);
    await this.ctx.agents.announce(agent, "startup");

    return {
      agent,
      dispose: async () => {
        agent.cancel({ kind: "disposed" }, { keepInbox: true });
        await agent.whenIdle();
        detachAgent();
      },
    };
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
