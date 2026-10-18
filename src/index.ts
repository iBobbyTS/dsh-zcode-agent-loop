/**
 * dsh-plugin-zcode-loop — Cordis 插件入口（阶段 3 resume 冷恢复 + 阶段 4
 * 会话内换模型/换档）。
 *
 * 把 vendored ZCode `AgentRuntime` 作为外部插件装进 dsh，替换 stock
 * `dsh-agent-loop`（profile patch：disable agent-loop row + insert 本插件 row，
 * 见 `dsh.bundle` 声明与 `profile/cordis.patch.yml` 样例）。
 *
 * `AgentFactory.createAgent` 装配（结构照抄 stock loop 的 createAgent/createStoredSession
 * 路径；persistence backend 在场时 prepare→persistence.create→…→enter→announce
 * 让 session 事件经 live 路由落进写句柄，无 backend 时退化为纯内存发布）：
 *
 *   dsh session 创建/挂载 → event-store 桥（唯一落盘真相）
 *   → 工具桥（dsh 工具面 → ZCode ToolRegistry；执行回 dsh 管线）
 *   → model-bridge（经 dsh llm 路由）→ permissionBroker 直通 allow
 *   → systemPrompt = dsh `SystemPrompt.assemble()` 渲染文本（每轮存活的
 *     `config.systemPrompt` 接缝 + 构造期最小 contextBuilder，见
 *     `bridges/system-prompt-bridge.ts` 模块头）
 *   → `toolAllowlist: []` 关闭全部 ZCode 内建工具（工具面=dsh 管线，且
 *     TodoWrite 在场性关闭 todo reminder）
 *   → `AgentRuntime` + `ZcodeLoopAgent` → 注册/公告 → AgentHandle。
 *
 * `AgentFactory.resume`（阶段 3 提前）照抄 stock `resumeWith` 形状：
 * persistence.open(write) → 冷读 → `interruptedTurnClosers` 合成中断收尾并补写 →
 * `sessions.prepare`（seed=全部持久事件 + closers）→ 与 createAgent 共用的
 * `assembleAndPublish`（source="resume" 时额外把 dsh log 逆向翻译成引擎历史并
 * `runtime.resumeFromStore({ persistedMessages })`，见 `bridges/resume-adapter.ts`）。
 * `PrototypeUnsupportedError` 保留给未来 prototype 排除项（机读码
 * `PROTOTYPE_UNSUPPORTED`）。
 *
 * 阶段 7（fork 的引擎侧历史水合）：controller `fork()` 走 seeded create（`agents.create`
 * 携带 `seed`，不 resume）。createAgent 把 seed 一并交给 `assembleAndPublish`：seed
 * 含对话历史（≥1 条 user/message，见 `hasSeedHistory`）时复用 resume 的逆向翻译 +
 * `resumeFromStore` 水合，fork 出的新 runtime messageHistory 才能承接前缀；announce
 * 仍是 "startup"（fork 是新建会话，非 resume 语义）。
 *
 * 阶段 4（会话内换模型/换档）：agent 的 scoped ctx 监听 dsh `model/selection`
 * 事件（DynamicContextProjection 先例：`(subject, event)` 签名 + subject 过滤，
 * 随 agent scope dispose 自动清理）。`applyModelSelection` 把事件 data
 * `{provider, model, reasoningEffort?}` 映射成引擎
 * `runtime.setSessionModelSelection`（下一 turn 的 createTurnModel 生效；
 * effort 经 resolveReasoningLevel 按 dsh 目录校验）+ model-bridge `refresh`
 * 热更新 resolved 元数据。resume 的初始 selection 从 seed 里最后的
 * `request/header`（foldRequestHeader 离线折叠）恢复——上次会话实际用的路由；
 * 档位不恢复（dsh 侧 loggedHeader 的 effort 消费属 controller，不归本插件）。
 */
import { Service } from "@deepseek-ai/cordis";
import type { Context, Volatile } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import z from "@deepseek-ai/schemastery";
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "@deepseek-ai/dsh-agent";
import type { SessionHandle } from "@deepseek-ai/dsh-session-persistence";
import type { LlmResolvedModelInfo } from "@deepseek-ai/dsh-llm";
import type {
  Session as DshSession,
  SessionEvent,
  SessionId as DshSessionId,
} from "@deepseek-ai/dsh-session";
import { foldRequestHeader, interruptedTurnClosers, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session";
import { z as zod } from "zod";

import {
  BRANCH_RERUN_USAGE,
  createBranchRerun,
  parseBranchRerunInput,
} from "./branch-rerun.js";
import { inboxProjectionDefinition } from "./inbox.js";
import { registerOffPeakCommands } from "./off-peak.js";
import { createSelectionSideChat } from "./side-chat.js";
import { ZcodeLoopAgent } from "./agent.js";
import type { ZcodeLoopAgentDeps } from "./agent.js";
import { ZcodeLoopRuntimes } from "./runtime-seam.js";
import { DshSessionEventStoreBridge } from "./bridges/event-store-bridge.js";
import { createAttachmentMediaBridge } from "./bridges/attachment-bridge.js";
import type { AttachmentMediaBridge } from "./bridges/attachment-bridge.js";
import { createDshLoggerAdapter } from "./bridges/logger-adapter.js";
import { createDshModelBridge } from "./bridges/model-bridge.js";
import type { RefreshableModelFactory } from "./bridges/model-bridge.js";
import {
  createResumeSessionInfo,
  createResumeSessionStore,
  translateDshEventsToEngineMessages,
} from "./bridges/resume-adapter.js";
import {
  assembleDshSystemPrompt,
  createDshContextBuilder,
} from "./bridges/system-prompt-bridge.js";
import { createDshToolBridge } from "./bridges/tool-bridge.js";
import {
  createAllowThroughPermissionBroker,
  createEmbeddedEngine,
  createInMemoryToolArtifactStore,
  createSessionId,
} from "./engine-facade.js";
import type {
  AgentRuntime,
  ContextBuilder,
  MessageWithParts,
  SessionId as EngineSessionId,
  SessionStorePort,
} from "./engine-facade.js";

/** prototype 排除项的统一报错（机读码 `PROTOTYPE_UNSUPPORTED`；resume 已改走冷恢复）。 */
export class PrototypeUnsupportedError extends Error {
  readonly code = "PROTOTYPE_UNSUPPORTED";

  constructor(message: string) {
    super(message);
    this.name = "PrototypeUnsupportedError";
  }
}

/**
 * 插件配置输入（cordis.patch.yml 的 row 字段）。
 *
 * 输出面见 {@link Config}：provider/model 是 volatile 引用（dsh settings 可热改），
 * 其余字段是启动期旋钮（新建 agent 时读取，已创建 agent 不回溯）。
 */
export interface ConfigInput {
  /** dsh llm provider 路由（须已注册 adapter）。 */
  provider: string;
  /** dsh model id。 */
  model: string;
  /** 声明给引擎的上下文窗口（透传 model-bridge）。 */
  contextWindow?: number;
  /**
   * 声明给引擎的最大输出 token 上限（Model.optionSpecs.maxOutputTokens.max）。
   * 三层语义：本字段覆盖引擎 Model 声明（优先于 adapter defaultMaxTokens）；
   * adapter defaultMaxTokens 仅在无本字段时充作声明上限；dsh
   * `AgentOptions.maxTokens` 是逐请求上限，不混入声明。
   */
  maxOutputTokens?: number;
  /** 逐字流式开关（默认开；false → 引擎走整段 generateText，无 live frame）。 */
  streaming?: boolean;
  /**
   * 引擎执行限制：单次 turn 内的模型步数上限。dsh AgentOptions 无对应物；
   * vendored 引擎主循环不消费其原生字段（仅 subagent/memory 路径读取），由本
   * 插件在准入层实施——超限的后续步按 pre-step 拒绝收口（turn blocked）。
   */
  maxTurns?: number;
  /**
   * 引擎工具调度并发上限（映射 AgentRuntimeConfig.toolConcurrency.maxConcurrency）。
   * dsh 无对应物；只暴露引擎级旋钮，不参与工具独占/并行语义判断。
   */
  toolConcurrency?: number;
  /**
   * 旧 stock `agent-loop` 字段别名（映射到 {@link toolConcurrency}；两者同时给出时
   * `toolConcurrency` 优先）。保留别名是为了让沿用 stock row 设置的部署在替换为本
   * 插件后仍能生效，而不是静默无效。
   */
  maxParallelToolCalls?: number;
}

/**
 * 运行期解析后的插件配置。provider/model 为 dsh settings 可实时编辑的 volatile
 * 引用（`loader/volatile-update` 提交后下一请求生效）；其余字段在 agent 装配时读取。
 */
export interface Config {
  /** dsh llm provider 路由（volatile：settings 写入后下一请求生效）。 */
  provider: Volatile<string>;
  /** dsh model id（volatile：settings 写入后下一请求生效）。 */
  model: Volatile<string>;
  /** 声明给引擎的上下文窗口（透传 model-bridge）。 */
  contextWindow?: number;
  /**
   * 声明给引擎的最大输出 token 上限（Model.optionSpecs.maxOutputTokens.max）。
   * 三层语义：本字段覆盖引擎 Model 声明（优先于 adapter defaultMaxTokens）；
   * adapter defaultMaxTokens 仅在无本字段时充作声明上限；dsh
   * `AgentOptions.maxTokens` 是逐请求上限，不混入声明。
   */
  maxOutputTokens?: number;
  /** 逐字流式开关（默认开；false → 引擎走整段 generateText，无 live frame）。 */
  streaming?: boolean;
  /**
   * 引擎执行限制：单次 turn 内的模型步数上限。dsh AgentOptions 无对应物；
   * vendored 引擎主循环不消费其原生字段（仅 subagent/memory 路径读取），由本
   * 插件在准入层实施——超限的后续步按 pre-step 拒绝收口（turn blocked）。
   */
  maxTurns?: number;
  /**
   * 引擎工具调度并发上限（映射 AgentRuntimeConfig.toolConcurrency.maxConcurrency）。
   * dsh 无对应物；只暴露引擎级旋钮，不参与工具独占/并行语义判断。
   */
  toolConcurrency?: number;
  /** 旧 stock 字段别名（见 {@link ConfigInput.maxParallelToolCalls}）。 */
  maxParallelToolCalls?: number;
}

/** 写句柄 + 已落盘事件数（create/resume 共用的 stored 形状，stock 同名字段）。 */
interface StoredSession {
  handle: SessionHandle;
  storedCount: number;
}

/**
 * `assembleAndPublish` 的归一化装配输入：create/resume 两条字面路径在此汇合。
 * create 直接透传 `CreateAgentOptions` 的同名字段；resume 以 persisted id 与
 * `handle.header` 快照充位（stock resumeWith 同构）。
 */
interface AssembleAgentInput {
  signal?: AbortSignal;
  /** dsh 侧 agent/session 身份（create=新建 id；resume=persisted id）。 */
  sessionId: DshSessionId;
  /** 会话元数据（workingDirectory 消费 `meta.cwd`；resume 时来自存储 header）。 */
  meta?: CreateAgentOptions["meta"];
  parentAgent?: Agent;
  agentOptions?: AgentOptions;
  setup?: AgentSetup;
  /**
   * fork 的前缀事件——controller `fork()` 经 `agents.create` 传入（普通 create 缺席）。
   * 插件用它复用 resume 的引擎水合（`hasSeedHistory` 命中即走 prepareResumeContext），
   * dsh 层 `sessions.prepare` 的 seed 重放不变。
   */
  seed?: CreateAgentOptions["seed"];
}

/** Cancel creation waits; a write handle arriving after cancellation is still released. */
async function awaitCreation<T>(signal: AbortSignal, operation: () => Promise<T>, releaseLate?: (value: T) => Promise<void>): Promise<T> {
  const abortError = () => signal.reason instanceof Error ? signal.reason : new Error("Agent creation cancelled", { cause: signal.reason });
  if (signal.aborted) throw abortError();
  const aborted = Promise.withResolvers<never>();
  const listener = () => aborted.reject(abortError());
  signal.addEventListener("abort", listener, { once: true });
  const pending = Promise.resolve().then(() => { if (signal.aborted) throw abortError(); return operation(); });
  try { return await Promise.race([pending, aborted.promise]); }
  catch (error) {
    if (signal.aborted && releaseLate) void pending.then(releaseLate, () => {}).catch(failure => console.error("Late session handle cleanup failed", failure));
    throw error;
  } finally { signal.removeEventListener("abort", listener); }
}

/**
 * dsh 档位 → 引擎 selection 档位（阶段 4 抽公用）：仅在 dsh 目录
 * （`resolved.reasoning.efforts`）内的 effort 放行，缺席/越档一律 undefined——
 * 引擎会按 optionSpecs.reasoningLevel.values 校验 selection，缺席目录时映射会失配。
 * 两处共用：装配期（agentOptions.reasoningEffort）与 model/selection 监听器
 * （事件 data 里的 reasoningEffort）。
 */
function resolveReasoningLevel(
  resolved: LlmResolvedModelInfo | undefined,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined || effort.length === 0) return undefined;
  // 档位 id 是 dsh ReasoningEffortId 品牌串；按 string 收纳便于与任意来路的 effort 比对。
  const effortIds: string[] = resolved?.reasoning?.efforts?.map((candidate) => candidate.id) ?? [];
  return effortIds.includes(effort) ? effort : undefined;
}

/**
 * 装配期 dsh 路由元数据解析失败 → 延迟到首个模型请求抛出的明确错误。
 *
 * 与 stock loop 对齐：provider 无 adapter 时装配不阻塞，错误在首个请求的
 * prepare/dispatch 处 surfaced。差异是 stock 不预先解析元数据；本插件需要它
 * 生成引擎 Model 声明，因此不能像旧实现那样吞掉失败回落硬编码默认预算——
 * 否则引擎会带着错误 contextWindow 深处失败。原始 code（如 NO_ADAPTER）保留
 * 在 message 与 `code` 字段上，便于宿主与探针识别。
 */
function createModelResolutionError(provider: string, model: string, cause: unknown): Error {
  const source = cause as { code?: unknown; failure?: { code?: unknown } } | null;
  const code =
    typeof source?.code === "string" && source.code.length > 0
      ? source.code
      : typeof source?.failure?.code === "string" && source.failure.code.length > 0
        ? source.failure.code
        : undefined;
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `cannot resolve model "${provider}/${model}" for a request: ${detail}${
      code === undefined || detail.includes(code) ? "" : ` (${code})`
    }`,
    { cause: cause instanceof Error ? cause : undefined },
  );
  error.name = "ModelResolutionError";
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

/**
 * fork seed 是否携带对话历史（≥1 条 surface user/message）——决定 seeded create 是否
 * 走引擎水合。无历史的 seed 不必走（省一条 session_resumed drop + 一次空水合）。
 * 只判 `user/message` 不验 source：runtime-context 注入也落 user/message，但对 fork
 * seed（buildForkSeed 只取已完成 turn 前缀）无害。
 */
function hasSeedHistory(seed: readonly SessionEvent[] | undefined): boolean {
  return seed?.some((event) => event.type === "user/message") ?? false;
}

/**
 * stock agent-loop 的 turnBoundary 投影（阶段 8b 重挂，语义逐字对齐 stock
 * `turnBoundaryProjectionDefinition`）：goal 工具族的开轮边界 authority 读
 * `stateOf(session, "turnBoundary")`，key 缺席即拒绝 "goal tools require an
 * open model turn"。桥已忠实落 turn/start|end 与 step/start|end，纯事件
 * 解释在此重挂即可（host 回归面没有 sessionProjections 服务时不注册）。
 */
const turnBoundaryProjectionDefinition = {
  key: "turnBoundary",
  stateVersion: 2,
  stateSchema: zod.object({
    openTurnStartSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
    lastStepStartSeq: zod.number().int().nonnegative().transform(SessionSeq).nullable(),
    lastStepBoundary: zod
      .object({
        kind: zod.union([zod.literal("start"), zod.literal("end")]),
        seq: zod.number().int().nonnegative().transform(SessionSeq),
      })
      .nullable(),
    lastTurn: zod.number().int().nonnegative(),
  }),
  init: () => ({
    openTurnStartSeq: null,
    lastStepStartSeq: null,
    lastStepBoundary: null,
    lastTurn: 0,
  }),
  apply: (
    state: {
      openTurnStartSeq: number | null;
      lastStepStartSeq: number | null;
      lastStepBoundary: { kind: "start" | "end"; seq: number } | null;
      lastTurn: number;
    },
    event: { type: string; seq: number; data: { turn?: number } },
  ) => {
    switch (event.type) {
      case "turn/start":
        return {
          ...state,
          openTurnStartSeq: event.seq,
          lastTurn: event.data.turn ?? state.lastTurn,
        };
      case "turn/end":
        return { ...state, openTurnStartSeq: null };
      case "step/start":
        return {
          ...state,
          lastStepStartSeq: event.seq,
          lastStepBoundary: { kind: "start", seq: event.seq },
        };
      case "step/end":
        return { ...state, lastStepBoundary: { kind: "end", seq: event.seq } };
      default:
        return state;
    }
  },
};

/** 一个 live agent 的路由热更新面（settings volatile 提交后推进下一 turn）。 */
interface LiveRoute {
  runtime: AgentRuntime;
  modelFactory: RefreshableModelFactory;
}

/** 本插件支持的配置键（未列出的 stock agent-loop 字段必须显式拒绝）。 */
const SUPPORTED_CONFIG_KEYS = new Set([
  "provider",
  "model",
  "contextWindow",
  "maxOutputTokens",
  "streaming",
  "maxTurns",
  "toolConcurrency",
  "maxParallelToolCalls",
]);

/** 窄化后的 Loader 读面（只用于提示被禁用的 stock row 设置）。 */
interface LoaderEntryView {
  options: { id?: string; config?: unknown };
  disabled: boolean;
}

interface LoaderView {
  entries(): Iterable<LoaderEntryView>;
  await(): Promise<void>;
}

/**
 * 替换 stock agent-loop 的 zcode loop 工厂。
 * sessionProjections 保持可选；在场时注册标准 inbox 与 turnBoundary。
 */
export class ZcodeLoop extends Service implements AgentFactory {
  static inject = ["agents", "sessions", "llm", "tools", "systemPrompt"];

  static Config: z<ConfigInput, Config> = z.object({
    // dsh settings 只暴露 volatile 字段：路由是唯一可热改的子集（下一请求生效）。
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    contextWindow: z.natural(),
    maxOutputTokens: z.natural(),
    streaming: z.boolean().default(true),
    maxTurns: z.natural(),
    toolConcurrency: z.natural(),
    // stock agent-loop 兼容别名（非 volatile：启动期装配旋钮）。
    maxParallelToolCalls: z.natural(),
  }) as unknown as z<ConfigInput, Config>;

  /**
   * 本插件自己的 fiber ctx（构造参数，构造期捕获）。
   *
   * 现场实测：`createAgent` 被调用时 `this` 是 cordis traceable receiver
   * （dsh AgentRegistry.create 用 `getTraceable(ownerCtx, target)` 把调用方 ctx
   * 绑进 receiver，"ownership follows the caller"），因此 `this.ctx` 会**重绑成
   * 调用方入口插件**（如 headless-runner）的 ctx，其注入面没有 systemPrompt 等
   * 服务 —— 一切服务访问必须走本字段（stock 同款：`this.runtime.ctx`），`ownerCtx`
   * 只用于 ownership 断言。`this.ctx` 的 own-property 赋值被 proxy 拦截，故另取
   * 字段名保存。
   */
  private readonly loopCtx: Context;
  private readonly runtimes: ZcodeLoopRuntimes;
  private readonly liveTeardowns = new Set<() => Promise<void>>();
  private readonly factoryAbort = new AbortController();
  private readonly pendingCreations = new Set<Promise<void>>();
  /** 每个 live agent 的路由刷新面（volatile provider/model 更新时推进下一 turn）。 */
  private readonly liveRoutes = new Set<LiveRoute>();
  /** 生效的引擎工具并发（`toolConcurrency` 优先，回退 stock 别名）。 */
  private effectiveToolConcurrency: number | undefined;

  constructor(ctx: Context, public readonly config: Config) {
    super(ctx, "zcodeLoop");
    this.loopCtx = ctx;
    this.effectiveToolConcurrency = config.toolConcurrency ?? config.maxParallelToolCalls;
    this.assertSupportedConfig(config, ctx);
    // 窄接缝先于下面的 teardown effect 注册：fiber 卸载时 effect 逆序执行，
    // 工厂 teardown（释放每个 agent 的 runtime 视图）先于服务注销。
    this.runtimes = new ZcodeLoopRuntimes(ctx);
    const live = this.liveTeardowns;
    const factoryAbort = this.factoryAbort, pending = this.pendingCreations;
    ctx.effect(() => async () => {
      factoryAbort.abort(new Error("ZCode loop is not active"));
      const settled = await Promise.allSettled([...pending, ...[...live].map(dispose => dispose())]);
      const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Agent factory teardown failed");
    }, "zcodeLoop.liveAgents()");
    ctx.effect(() => ctx.agents.setFactory(this), "zcodeLoop.setFactory()");
    // dsh settings 的 volatile 提交由 Loader 通知本 fiber。provider/model 是唯一
    // 可热改的子集：推进所有 live agent 的下一 turn 路由（T07 语义），resolved
    // 元数据同步刷新；无效路由照发请求，由 dsh llm 层报错。
    ctx.on("loader/volatile-update" as never, ((paths: readonly (readonly string[])[]) => {
      if (!paths.some(path => path.length === 0 || path[0] === "provider" || path[0] === "model")) return;
      void this.applyConfiguredRoute().catch(error => ctx.logger.warn(error));
    }) as never);
    // stock `agent-loop` row 被禁用后，其 row 设置不会进入本插件。装载完成后检查
    // 该 row：可映射的 `maxParallelToolCalls` 映射到引擎并发，其余字段显式提示，
    // 不让旧 stock 专属设置静默无效。
    ctx.inject(["loader"], loaderCtx => {
      const loader = loaderCtx.get("loader") as unknown as LoaderView | undefined;
      if (loader === undefined) return;
      void loader.await()
        .then(() => this.adoptStockAgentLoopSettings(loader, loaderCtx))
        .catch(error => loaderCtx.logger.warn(error));
    });
    // 与 stock AgentLoop 相同的两个 prompt 变量（persona 段可能引用）。
    ctx.systemPrompt.variable("provider", (context) => context.agent?.options.provider);
    ctx.systemPrompt.variable("model", (context) => context.agent?.options.model);
    // inbox 与 turnBoundary 投影可选注册（pending 队列与 goal 开轮边界读面；
    // stock 由 agent-loop 注册，本插件顶替其位）。运行时 inject 而非 static
    // inject——host 回归面没装 dsh-session-projection，声明成硬依赖会把插件
    // 挂起；服务缺席时回调不跑，goal 工具在那儿本就缺席，行为不变。
    ctx.inject(["sessionProjections"], (projectionCtx) => {
      const projections = projectionCtx.get("sessionProjections") as unknown as {
        register(definition: unknown): () => void;
      } | undefined;
      projections?.register(turnBoundaryProjectionDefinition);
      projections?.register(inboxProjectionDefinition);
    });
    ctx.inject(["commands"], commandCtx => {
      commandCtx.commands.register({
        name: "queue",
        description: "Pause or resume queued turns; the current turn keeps running",
        input: { hint: "pause | resume | status" },
        handler: async ({ agent, rawInput, signal }) => {
          signal.throwIfAborted();
          if (!(agent instanceof ZcodeLoopAgent)) return { kind: "error", text: "Queue control requires a ZCode loop agent." };
          const action = rawInput.trim() || "status";
          if (!["pause", "resume", "status"].includes(action)) return { kind: "error", text: "Usage: /queue pause | resume | status" };
          if (action !== "status") agent.setQueuePaused(action === "pause");
          return { kind: "success", text: `Queue ${agent.queuePaused ? "paused" : "running"}: ${agent.inbox.nextTurn.length} turn input(s), ${agent.inbox.nextStep.length} step input(s).` };
        },
      });
      commandCtx.commands.register({
        name: "sidechat",
        description: "Start an independent side-chat session from the completed turn prefix plus the selected text",
        input: { hint: "selected text" },
        handler: async ({ agent, rawInput, signal }) => {
          signal.throwIfAborted();
          const selection = rawInput.trim();
          if (selection.length === 0) return { kind: "error", text: "Usage: /sidechat <selected text>" };
          try {
            const branch = await createSelectionSideChat(commandCtx, agent, selection, signal);
            return {
              kind: "success",
              text: `Side chat ${branch.sessionId} created from parent ${agent.id} through event ${branch.boundary}.`,
            };
          } catch (error) {
            return { kind: "error", text: error instanceof Error ? error.message : String(error) };
          }
        },
      });
      commandCtx.commands.register({
        name: "rerun",
        description: "Branch from the completed turn before a user message and seed the edited input (new session; parent log unchanged)",
        input: { hint: "<message-number>|last <edited text>" },
        handler: async ({ agent, rawInput, signal }) => {
          signal.throwIfAborted();
          const request = parseBranchRerunInput(rawInput);
          if (request === undefined) return { kind: "error", text: BRANCH_RERUN_USAGE };
          try {
            const branch = await createBranchRerun(commandCtx, agent, request, signal);
            return {
              kind: "success",
              text:
                `Rerun branch ${branch.sessionId} created: parentSession=${agent.id}, ` +
                `rerunFrom=message:${branch.targetSeq},boundary:${branch.boundary}, ` +
                `userMessage:${branch.messageNumber}, inherited:${branch.inheritedEventCount}. ` +
                "This creates a new session and leaves the parent log unchanged (not a same-session rewind).",
            };
          } catch (error) {
            return { kind: "error", text: error instanceof Error ? error.message : String(error) };
          }
        },
      });
    });
    // 低峰命令可选注册：schedule 或 commands 缺席时回调不跑（命令不注册），
    // AgentFactory 本身不声明成硬依赖；条目的持久化/恢复仍归 dsh schedule。
    ctx.inject(["commands", "schedule"], offPeakCtx => {
      registerOffPeakCommands(offPeakCtx);
    });
  }

  /**
   * 拒绝在本 row 上出现的其他 stock agent-loop 字段（schemastery 非 strict 会把
   * 未声明键并入输出，不能靠 schema 静默吞掉）。`agents: []` 是 stock 默认值，
   * 视为显式 no-op 并提示；非空 declarative agents 无法映射，明确报错。
   */
  private assertSupportedConfig(config: Config, ctx: Context): void {
    const unknown = Object.keys(config).filter(key => !SUPPORTED_CONFIG_KEYS.has(key));
    if (unknown.length > 0) {
      const stockOnly = unknown.filter(key => key !== "agents");
      if (stockOnly.length > 0) {
        throw new TypeError(
          `zcode-loop does not support stock agent-loop config field(s): ${stockOnly.join(", ")}` +
            " (supported legacy mapping: maxParallelToolCalls -> toolConcurrency)",
        );
      }
    }
    const agents = (config as Config & { agents?: unknown }).agents;
    if (agents === undefined) return;
    if (Array.isArray(agents) && agents.length === 0) {
      ctx.logger.info("zcode-loop: stock agent-loop \"agents: []\" is a no-op; declarative agents are not supported");
      return;
    }
    throw new TypeError(
      "zcode-loop does not support stock agent-loop declarative agents; create or resume agents through the dsh launcher/Agent API",
    );
  }

  /**
   * 检查被禁用的 stock `agent-loop` row：`maxParallelToolCalls` 在本插件未显式
   * 配置并发时映射到 `toolConcurrency`；其他字段无法映射，逐项 warning。因此
   * “旧 stock 专属设置”要么生效、要么在启动日志里出现明确提示。
   */
  private adoptStockAgentLoopSettings(loader: LoaderView, ctx: Context): void {
    const stock = [...loader.entries()].find(entry => entry.options.id === "agent-loop");
    if (stock === undefined || stock.disabled !== true) return;
    const raw = stock.options.config;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
    const config = raw as Record<string, unknown>;
    const unsupported = Object.keys(config).filter(key => key !== "maxParallelToolCalls" && key !== "agents");
    if (unsupported.length > 0) {
      ctx.logger.warn(
        `zcode-loop: disabled stock agent-loop row carries unsupported setting(s) ${unsupported.join(", ")}; they have no effect under this plugin`,
      );
    }
    const agents = config.agents;
    if (agents !== undefined && (!Array.isArray(agents) || agents.length > 0)) {
      ctx.logger.warn(
        "zcode-loop: disabled stock agent-loop row declares agents; declarative agents cannot be mapped and are not started",
      );
    }
    const legacy = config.maxParallelToolCalls;
    if (legacy === undefined) return;
    if (typeof legacy !== "number" || !Number.isSafeInteger(legacy) || legacy < 1) {
      ctx.logger.warn(`zcode-loop: disabled stock agent-loop maxParallelToolCalls=${String(legacy)} is invalid; ignored`);
      return;
    }
    if (this.config.toolConcurrency !== undefined || this.config.maxParallelToolCalls !== undefined) {
      ctx.logger.info(
        `zcode-loop: disabled stock agent-loop maxParallelToolCalls=${legacy} is overridden by the zcode-loop row`,
      );
      return;
    }
    this.effectiveToolConcurrency = legacy;
    ctx.logger.info(`zcode-loop: mapped disabled stock agent-loop maxParallelToolCalls=${legacy} to toolConcurrency`);
  }

  /**
   * dsh settings 提交 provider/model 后推进所有 live agent 的下一 turn 路由。
   * 与 `applyModelSelection` 同语义：resolved 查询失败不阻塞，selection 照发，
   * 无效路由由 dsh llm 层报错。
   */
  private async applyConfiguredRoute(): Promise<void> {
    const provider = this.config.provider.get();
    const model = this.config.model.get();
    await Promise.all([...this.liveRoutes].map(async ({ runtime, modelFactory }) => {
      let resolved: LlmResolvedModelInfo | undefined;
      try {
        resolved = await this.loopCtx.llm.resolveModelInfo(provider, model);
      } catch {
        resolved = undefined;
      }
      modelFactory.refresh(resolved === undefined ? {} : { resolved });
      runtime.setSessionModelSelection({ providerId: provider, modelId: model });
    }));
  }

  private async duringCreation(ownerCtx: Context, callerSignal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<AgentHandle>): Promise<AgentHandle> {
    ownerCtx.fiber.assertActive();
    const ownerAbort = new AbortController();
    const signal = AbortSignal.any([ownerAbort.signal, this.factoryAbort.signal, ...(callerSignal ? [callerSignal] : [])]);
    signal.throwIfAborted();
    let job: Promise<AgentHandle> | undefined, completed = false;
    const untrackOwner = ownerCtx.effect(() => async () => {
      if (!completed) { ownerAbort.abort(new Error("Agent creation owner disposed")); await job?.then(() => {}, () => {}); }
    }, "zcodeLoop.creation()");
    let tracked: Promise<void> | undefined;
    try {
      job = operation(signal); tracked = job.then(() => {}, () => {}); this.pendingCreations.add(tracked);
      return await job;
    } finally {
      completed = true;
      if (tracked) this.pendingCreations.delete(tracked);
      await untrackOwner();
    }
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    return this.duringCreation(ownerCtx, options.signal, signal => this.createAgentNow(ownerCtx, { ...options, signal }));
  }

  private async createAgentNow(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    // ownership 断言对齐 stock（createAgent 的 this 被重绑为调用方 receiver，
    // 服务访问一律走 this.loopCtx —— 见 loopCtx 字段注释）。
    ownerCtx.fiber.assertActive();
    // ---- dsh session 装配（stock createAgent/createStoredSession 路径）----
    // prepare（未发布）→ persistence.create（session-persistence 在场即开写句柄，
    // jsonl 后端把已发布 session 的 live 事件按 id 路由进句柄）→ 装配 →
    // enter → agents.enter → announce → 补存 setup 窗口事件 → announce('startup')。
    // 原实现用 sessions.create（prepare+enter+announce 一步发布）：在真实 dsh
    // （dsh-base 挂了 session-persistence-jsonl）下没有任何写句柄，session log
    // 不会落盘 —— 修复（最小改动，报告声明），无 persistence 时行为与纯内存装配一致。
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
            handle: await awaitCreation(options.signal!, () => persistence.create(session.header, {
              ...(options.inheritedEventCount === undefined
                ? {}
                : { inheritedEventCount: options.inheritedEventCount }),
              signal: options.signal,
            }), handle => handle.close()),
            storedCount: 0,
          };
    return await this.assembleAndPublish(
      ownerCtx,
      session,
      stored,
      {
        sessionId: options.sessionId,
        meta: options.meta,
        parentAgent: options.parentAgent,
        agentOptions: options.agentOptions,
        setup: options.setup,
        seed: options.seed,
        signal: options.signal,
      },
      "startup",
    );
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    return this.duringCreation(ownerCtx, options.signal, signal => this.resumeNow(ownerCtx, { ...options, signal }));
  }

  private async resumeNow(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    // ownership 断言对齐 createAgent；服务访问一律走 this.loopCtx（见 loopCtx 注释）。
    ownerCtx.fiber.assertActive();
    // stock resume 同款文案：无 persistence 后端时 resume 无法进行。
    const persistence = this.loopCtx.get("sessionPersistence");
    if (persistence === undefined) {
      throw new Error(
        "cannot resume: session persistence is not configured (load a dsh-session-persistence backend)",
      );
    }
    const id = options.resumeSessionId;
    // handle 在被 stored 收养前打开/失败时由 finally 兜底关闭（stock resumeWith
    // 的 handle/owned 所有权交接语义）；成功路径 handle 归 agent 生命周期所有。
    let handle: SessionHandle | undefined;
    try {
      handle = await awaitCreation(options.signal!, () => persistence.open(id, "write", {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }), late => late.close());
      // 冷读：valid contiguous 前缀（torn tail 由后端截掉），含 fork 继承前缀。
      const ownedHandle = handle;
      const coldRead = await awaitCreation(options.signal!, () => ownedHandle.read(0, undefined, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }));
      const persisted = coldRead.events;
      // 中断收尾（@deepseek-ai/dsh-session 导出）：为未决 tool/call 合成 error
      // result、补 step/end 与 turn/end{interrupted}，先补写进存储再 seed。
      const closers = interruptedTurnClosers(persisted);
      if (closers.length > 0) {
        await handle.append(closers, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }
      // meta 用存储 header 快照（cwd 携带会话工作目录，装配段消费 meta.cwd）。
      const meta = structuredClone(handle.header);
      const session = this.loopCtx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta,
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      });
      const stored: StoredSession = {
        handle,
        storedCount: persisted.length + closers.length,
      };
      handle = undefined;
      return await this.assembleAndPublish(
        ownerCtx,
        session,
        stored,
        {
          sessionId: id,
          meta,
          parentAgent: options.parentAgent,
          agentOptions: options.agentOptions,
          setup: options.setup,
          signal: options.signal,
        },
        "resume",
      );
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /**
   * resume/fork-seed 冷路径附件（stage 7 起 seeded create 也走；source==="startup"
   * 且 seed 无对话历史时不构建）：把已 seed 进 session 的 dsh 事件逆向翻译成引擎
   * `MessageWithParts[]`，并铸只覆盖 resumeFromStore 冷路径的哑 SessionStorePort。
   * 契约字段装配集中在 resume-adapter。
   */
  private async prepareResumeContext(
    session: DshSession,
    engineSessionId: EngineSessionId,
    directory: string,
    media: AttachmentMediaBridge,
  ): Promise<{
    messages: MessageWithParts[];
    sessionStore: SessionStorePort;
    turnBase: number;
    /** 阶段 4：会话上次实际路由（seed 最后 request/header 的 config）；无 header 时缺席。 */
    initialSelection?: { providerId: string; modelId: string };
  }> {
    const events = session.snapshotEvents(SessionLogOffset(0));
    const messages = await translateDshEventsToEngineMessages(
      events,
      engineSessionId,
      new Set(session.surface.nodes),
      media,
    );
    // 引擎恢复后 turnNumber 从历史用户消息数起；dsh seed 的已有 turn 数可能更多
    // （失败 turn 未必落过 user/message）。偏移 = 最大已有 turn − 引擎历史基线，
    // 保证新 turn 号接在 seed 之后不重复（event-store-bridge setTurnBase）。
    let maxTurn = 0;
    for (const event of events) {
      if (event.type === "turn/start") {
        const turn = Number((event.data as { turn?: unknown } | undefined)?.turn ?? 0);
        if (Number.isFinite(turn) && turn > maxTurn) maxTurn = turn;
      }
    }
    const engineBaseTurns = messages.filter((message) => message.info.role === "user").length;
    // 阶段 4：resume 初始 selection = 会话上次实际用的模型。权威来源是 seed 里最后
    // 的 request/header——用 dsh 官方离线折叠 foldRequestHeader 取最新快照（等价于
    // 倒序找第一条 header，且走 stock 同一条重建路径）。config 由 dsh LlmCallConfig
    // 保证 provider/model 在场，长度检查只兜外部写入的残缺 header。档位不恢复：
    // dsh 侧 loggedHeader 的 effort 消费属 controller，不归本插件。
    const headerConfig = foldRequestHeader(events)?.config;
    const initialSelection =
      headerConfig !== undefined &&
      headerConfig.provider.length > 0 &&
      headerConfig.model.length > 0
        ? { providerId: headerConfig.provider, modelId: headerConfig.model }
        : undefined;
    return {
      messages,
      turnBase: maxTurn - engineBaseTurns,
      sessionStore: createResumeSessionStore(
        engineSessionId,
        createResumeSessionInfo(engineSessionId, directory, session.header.createdAt),
      ),
      ...(initialSelection === undefined ? {} : { initialSelection }),
    };
  }

  /**
   * createAgent 后半段的共用装配（语句序列原样抽取；resume 复用同一序列）：
   * 路由解析 → 桥件 → agent 构造 → prompt 装配 → engine 创建 → setup →
   * 补存 suffix → enter/announce → 返回 handle。`source` 只是 announce 字面量与
   * resume 冷路径开关（create 传 "startup"，语句行为与抽取前完全一致）。
   */
  private async assembleAndPublish(
    _ownerCtx: Context,
    session: DshSession,
    stored: StoredSession | undefined,
    input: AssembleAgentInput,
    source: "startup" | "resume",
  ): Promise<AgentHandle> {
    let created: ZcodeLoopAgent | undefined;
    let offModelSelection: (() => void) | undefined;
    let detachSession: (() => void) | undefined;
    let detachAgent: (() => void) | undefined;
    let teardownPromise: Promise<void> | undefined;
    let unfollowOwner: (() => void | Promise<void>) | undefined;
    let unfollowScope: (() => void | Promise<void>) | undefined;
    let liveRoute: LiveRoute | undefined;
    const creationAbort = new AbortController();
    const creationSignal = AbortSignal.any([creationAbort.signal, ...(input.signal ? [input.signal] : [])]);
    let publication: Promise<void> | undefined;
    const teardown = (): Promise<void> => teardownPromise ??= (async () => {
      creationAbort.abort(new Error("Agent lifecycle disposed"));
      if (publication) await publication.catch(() => {});
      const failures: unknown[] = [];
      for (const dispose of [() => created?.dispose(), () => this.runtimes.release(created),
        () => offModelSelection?.(), () => { if (liveRoute !== undefined) this.liveRoutes.delete(liveRoute); },
        () => detachAgent?.(), () => detachSession?.(), () => stored?.handle.close()]) {
        try { await dispose(); } catch (failure) { failures.push(failure); }
      }
      this.liveTeardowns.delete(dispose);
      if (failures.length) throw new AggregateError(failures, "ZCode agent teardown failed");
    })();
    const dispose = async (): Promise<void> => {
      try { await teardown(); }
      finally { await Promise.all([unfollowOwner?.(), unfollowScope?.()]); }
    };
    this.liveTeardowns.add(dispose);
    try {
      creationSignal.throwIfAborted();
      // ---- 路由（agentOptions 覆盖插件默认）----
      const agentOptions = input.agentOptions ?? {};
      // dsh 公开契约：请求级上限必须是可精确落到 wire 的正整数（stock assertAgentOptions 同款）。
      if (
        agentOptions.maxTokens !== undefined &&
        (!Number.isSafeInteger(agentOptions.maxTokens) || agentOptions.maxTokens <= 0)
      ) {
        throw new TypeError("agent maxTokens must be a positive safe integer");
      }
      const provider = agentOptions.provider ?? this.config.provider.get();
      const model = agentOptions.model ?? this.config.model.get();

      // ---- dsh 路由真实元数据（引擎面 Model 声明的首选来源）----
      // 查询失败不阻塞装配（stock 同样在装配期不解析元数据），但也不回落硬编码
      // 默认预算：把失败延迟到首个模型请求抛出，保证错误来自真实 adapter 路由。
      let resolved: LlmResolvedModelInfo | undefined;
      let modelResolutionFailure: Error | undefined;
      try {
        resolved = await awaitCreation(creationSignal, () => this.loopCtx.llm.resolveModelInfo(provider, model, creationSignal));
      } catch (error) {
        modelResolutionFailure = createModelResolutionError(provider, model, error);
      }
      creationSignal.throwIfAborted();
      // agentOptions.reasoningEffort → 引擎 selection 档位（仅在 dsh 目录档位表内，
      // 见 resolveReasoningLevel；阶段 4 起与 model/selection 监听器共用）。
      const reasoningLevel = resolveReasoningLevel(resolved, agentOptions.reasoningEffort);

      // ---- 桥件 ----
      const sessionId = createSessionId(String(input.sessionId));
      // 阶段 2：引擎 Logger port → dsh 日志面（容器 stdout / docker logs 可见）。
      // name 短而可 grep：插件前缀 + sessionId 前 8 字符；引擎与事件桥共用同一实例
      // （同一 agent 的日志同名聚簇）。loopCtx 而非 this.ctx：见 loopCtx 字段注释。
      const dshLogger = createDshLoggerAdapter(
        this.loopCtx,
        `zcode-loop:${String(input.sessionId).slice(0, 8)}`,
      );
      const eventBridge = new DshSessionEventStoreBridge({ session, sessionId, logger: dshLogger });
      // dsh durable attachment 引用 ↔ 引擎媒体内容的唯一转换点（用户图片、
      // 工具结果图片、冷恢复水合共用；服务缺席时图片通路明确失败）。
      const mediaBridge = createAttachmentMediaBridge(this.loopCtx);
      const toolBridge = createDshToolBridge({
        ctx: this.loopCtx,
        // 桥先于 agent 构造；延迟解析本实例，供 schema/metadata/执行共享 scope。
        agent: () => agent,
        acceptContexts: (callId, messages) => agent.acceptToolContexts(callId, messages),
        // dsh 结果块结构直通 durable tool/result（引擎事件只带文本投影）。
        onResultContent: (callId, content) => eventBridge.setToolResultContent(callId, content),
        media: mediaBridge,
      });
      // 生效路由写回 agentOptions：agent.options 的 provider/model 是 persona 段
      // prompt 变量（{{provider}}/{{model}}，web 模板自带 personaPrefix 引用）与
      // UI 展示的事实来源；agentOptions 缺省时此前只落在局部变量上，装配上下文
      // 读 agent.options.model 拿到 undefined → {{model}} 插值直接抛错。
      const effectiveOptions: AgentOptions = { ...agentOptions, provider, model };
      // runtime 晚绑定：prompt 装配必须带 agent（变量/上下文 provider 读
      // context.agent，如 harness-dev-context 读 agent.session），而引擎
      // config.systemPrompt 又依赖装配结果 —— 先建 agent、装配，再挂 runtime。
      const agentDeps: ZcodeLoopAgentDeps = {
        toolBridge,
        media: mediaBridge,
        // 阶段 2：桥句柄给 agent（drain 收口取 dropStats 打点）+ agent 的 debug
        // 打点出口（agent 自身无 logger，经同一 dshLogger 进 dsh 日志面）。
        eventBridge,
        logDebug: (message, context) => dshLogger.debug(message, context),
        // 阶段 8b：drain 的 initiator 边界（goal 工具 authority 的
        // currentInitiator 校验；stock loop 的 withInitiator(kick) 同款）。
        runWithInitiator: (operation) => this.loopCtx.agents.withInitiator(agent, operation),
        // 装配期元数据解析失败延迟到首个模型请求抛出（见 createModelResolutionError）。
        ...(modelResolutionFailure === undefined ? {} : { modelResolutionFailure }),
        // maxTurns 由桥准入层实施（vendored 引擎主循环不消费其原生字段，
        // 仅 subagent/memory 路径读取）；语义=单 turn 内模型步数上限。
        ...(this.config.maxTurns === undefined ? {} : { maxTurns: this.config.maxTurns }),
      };
      const agent = (created = new ZcodeLoopAgent(
        this.loopCtx,
        input.sessionId,
        effectiveOptions,
        session,
        agentDeps,
      ));
      // Exact disposers are yielded so Cordis does not release the agent scope
      // concurrently with its still-running model/tool driver.
      unfollowScope = this.loopCtx.effect(function* () {
        yield agent.scopeDisposer();
        yield () => teardown();
      }, `zcodeLoop.scope(${agent.id})`);
      unfollowOwner = _ownerCtx.effect(function* () {
        yield () => teardown();
      }, `zcodeLoop.owner(${agent.id})`);
      const promptAssembly = await awaitCreation(creationSignal, () => assembleDshSystemPrompt(this.loopCtx, agent, creationSignal));

      // ---- resume/fork-seed 冷路径附件（纯新建且无 seed 历史时本段整体缺席）----
      // 逆向翻译只读 session log（此刻 seed 已被 prepare 重放进 session），哑
      // sessionStore 只服务 resumeFromStore 冷路径；两者都要求在引擎构造期注入。
      // stage 7：seeded create（fork）带 ≥1 条 user/message 时与 resume 同路。
      const resumeContext =
        source === "resume" || hasSeedHistory(input.seed)
          ? await this.prepareResumeContext(
              session,
              sessionId,
              input.meta?.cwd ?? process.cwd(),
              mediaBridge,
            )
          : undefined;
      if (resumeContext !== undefined) eventBridge.setTurnBase(resumeContext.turnBase);

      // ---- ZCode 引擎（全经门面装配）----
      // 桥先铸（阶段 4）：factory 句柄要同时喂给引擎与 model/selection 监听器
      // （refresh 热更新 resolved 元数据），不能只作内联实参。
      const modelFactory = createDshModelBridge({
        ctx: this.loopCtx,
        streamRequest: (request, engineRequest) => agent.streamModelRequest(request, engineRequest),
        provider,
        model,
        media: mediaBridge,
        ...(resolved === undefined ? {} : { resolved }),
        ...(this.config.contextWindow === undefined
          ? {}
          : { contextWindow: this.config.contextWindow }),
        ...(this.config.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: this.config.maxOutputTokens }),
      });
      const runtime = createEmbeddedEngine({
        sessionId,
        eventStore: eventBridge,
        modelFactory,
        workingDirectory: input.meta?.cwd ?? process.cwd(),
        config: {
          // 初始 selection（构造期定格为 sessionModelSelection，之后由
          // model/selection 监听器推进）：无历史的 create 用外壳路由 + 目录校验后
          // 的档位；resume/fork seed 用会话上次实际路由（seed 最后 request/header），
          // 缺 header 回落外壳路由，档位一律不恢复（dsh 侧 loggedHeader 的 effort
          // 消费属 controller）。
          modelSelection:
            resumeContext?.initialSelection ??
            {
              providerId: provider,
              modelId: model,
              ...(source === "resume" || reasoningLevel === undefined
                ? {}
                : { options: { reasoningLevel } }),
            },
          // 每轮存活的 system prompt 接缝（见 system-prompt-bridge 模块头）。
          systemPrompt: promptAssembly.prompt,
          // 禁全部内建工具：模型可见工具面 = dsh 工具（经桥），todo reminder 门随之关闭。
          toolAllowlist: [],
          dynamicWorkflowEnabled: false,
          dynamicWorkflowToolsOnDemand: false,
          // dsh owns the effective surface and all compaction transactions.
          // Running a second in-memory compactor would diverge again on resume.
          compact: { enabled: false },
          titleGeneration: { enabled: false },
          // 逐字流式（streaming=false → 引擎整段 generateText，无 model_streaming/live frame）。
          modelStreaming: this.config.streaming === false ? "off" : "on",
          // 引擎执行限制（dsh 无对应物）：直接透传引擎原生 config 字段。
          ...(this.config.maxTurns === undefined ? {} : { maxTurns: this.config.maxTurns }),
          ...(this.effectiveToolConcurrency === undefined
            ? {}
            : { toolConcurrency: { maxConcurrency: this.effectiveToolConcurrency } }),
        },
        deps: {
          toolRegistry: toolBridge.registry,
          // 直通 allow：把关交给 dsh 管线（tools/pre-execute waterfall 等）。
          permissionBroker: createAllowThroughPermissionBroker(),
          // 引擎内部媒体收尾需要 artifact store；dsh session log 才是 durable 真相，
          // 这里只需进程内承载（见 createInMemoryToolArtifactStore 注释）。
          artifactStore: createInMemoryToolArtifactStore(),
          // 构造期最小 contextBuilder（首轮起被引擎 rebuild 取代，见模块头注释）。
          contextBuilder: createDshContextBuilder(promptAssembly) as unknown as ContextBuilder,
          // 阶段 2：引擎内部日志（token 预算、压缩决策、resume 水合、流式 flush 等）
          // 经 adapter 进 dsh 日志面；端口缺席时引擎日志走黑洞。
          logger: dshLogger,
          // resume 冷路径：引擎 resumeFromStore 强制要求 sessionStore（哑适配器）。
          sessionStore: resumeContext?.sessionStore ?? createResumeSessionStore(sessionId,
            createResumeSessionInfo(sessionId, input.meta?.cwd ?? process.cwd(), session.header.createdAt)),
        },
      });
      agentDeps.runtime = runtime;
      // 记录路由热更新面：settings 改 provider/model 时推进本 agent 的下一 turn。
      liveRoute = { runtime, modelFactory };
      this.liveRoutes.add(liveRoute);
      agentDeps.refreshHistory = async () => {
        const messages = await translateDshEventsToEngineMessages(
          session.snapshotEvents(),
          sessionId,
          new Set(session.surface.nodes),
          mediaBridge,
        );
        await runtime.resumeFromStore({ persistedMessages: messages });
      };
      eventBridge.setRequestBoundary((position) => agent.prepareModelStep(position));
      eventBridge.setPromptCommitter((prepared) => agent.commitPrompt(prepared));
      // 阶段 4：会话内换模型/换档。dsh UI 换选 → api-session-controller
      // selectForNextRequest 落盘 `model/selection`（data {provider, model,
      // reasoningEffort?}）→ 这里映射成引擎 session selection（下一 turn 的
      // createTurnModel 以新 selection 调 factory 即生效）+ 桥 refresh。
      // 监听必须挂宿主 ctx：`session/event` 只派发到 session attach 的 emit 链
      // （实测 probe：agent 的 scoped ctx 收不到，root ctx 收得到）——subject
      // 过滤承担 scope 收窄，disposer 在 handle.dispose 收尾。监听器同步返回，
      // 应用异步跑且错误吞掉打日志（applyModelSelection）。event.type 的
      // `model/selection` 词表项由 api-session-controller 声明（不在本插件依赖
      // 集），按 string 比对。
      offModelSelection = this.loopCtx.on("session/event" as never, ((subject: unknown, event: { type: string; data: unknown }) => {
        if (subject !== session || event.type !== "model/selection") return;
        void this.applyModelSelection(
          runtime,
          modelFactory,
          (message, context) => dshLogger.debug(message, context),
          event.data,
        );
      }) as never);
      // live 通路：桥的流式 frame 经 agent 的 dsh AgentEventDispatch 发
      // agent/assistant-stream（stock 同款面，web UI 据此逐字渲染）。
      eventBridge.setStreamPublisher((frame) => agent.emitAssistantStream(frame));
      eventBridge.setToolResultListener((callId) => agent.deliverToolContexts(callId));
      // resume/fork-seed 冷恢复（resumeContext 在场即走，见上文构建条件）：
      // persistedMessages 直传（绕开 sessionStore.messages()），
      // 引擎内部完成 ensureContextInitialized → 历史 hydration → session_resumed
      // 事件（桥按 drop 计数）。之后首个 executeTurn 才把新 turn 落在历史之后。
      if (resumeContext !== undefined) {
        await awaitCreation(creationSignal, () => runtime.resumeFromStore({ persistedMessages: resumeContext.messages, abortSignal: creationSignal }));
      }

      // ---- Agent + 发布（setup 在发布前跑，对齐 stock 的事务顺序）----
      const setupCommit = await awaitCreation(creationSignal, async () => input.setup?.(agent.ctx, agent));
      creationSignal.throwIfAborted();
      setupCommit?.commit();
      creationSignal.throwIfAborted();

      // ---- 发布事务（stock publish 顺序）：补存 setup 窗口事件（不经 live 路由）
      // → session enter → agent enter → announce → announce('startup'|'resume') ----
      if (stored !== undefined) {
        // setup 窗口内追加的事件不经 session/event 重放，发布点补存（stock
        // appendUnstoredSuffix）；必须在 enter 之前——enter 起 live 路由会把写
        // 句柄光标按 event seq 推进，从 storedCount=0 补存会 seq 错位。
        const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
        if (suffix.length > 0) await stored.handle.append(suffix);
        stored.storedCount += suffix.length;
      }
      creationSignal.throwIfAborted();
      detachSession = this.loopCtx.sessions.enter(session);
      detachAgent = this.loopCtx.agents.enter(agent, input.parentAgent);
      this.loopCtx.sessions.announce(session);
      publication = this.loopCtx.agents.announce(agent, source, creationSignal);
      await publication;
      creationSignal.throwIfAborted();
      // 发布完成后才允许扩展经窄服务解析；创建通知内 resolve 已可用。
      this.runtimes.publish(agent, runtime);
      agent.start();
      creationSignal.throwIfAborted();

      return {
        agent,
        dispose,
      };
    } catch (error: unknown) {
      // 回滚：释放已铸造的 agent scope，关闭未物化的写句柄（stock create 的
      // stored?.handle.close()）。
      try { await dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Agent creation failed and rollback reported cleanup failures", { cause: error }); }
      throw error;
    }
  }

  /**
   * 应用一次 dsh 模型选择（阶段 4，model/selection 监听器的异步后半段）：
   * resolved 元数据查询失败不阻塞（refresh 不带 resolved → 桥回落既有 config/
   * 硬编码默认声明）；selection 不做校验失败回退——无效路由照发请求，dsh llm 层
   * 自会报错（PLAN 排除项）。reasoningEffort 仅在 dsh 目录档位表内映射为引擎
   * selection.options.reasoningLevel。错误整体吞掉打日志：监听器必须同步返回，
   * 本方法经 `void` 调用，rejection 绝不能冒进 session/event 派发。
   */
  private async applyModelSelection(
    runtime: AgentRuntime,
    modelFactory: RefreshableModelFactory,
    log: (message: string, context?: Record<string, unknown>) => void,
    data: unknown,
  ): Promise<void> {
    // 事件 data 形状防御（{provider, model, reasoningEffort?}；字段缺失直接忽略）。
    const view = data as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
    const provider = view.provider;
    const model = view.model;
    const reasoningEffort =
      typeof view.reasoningEffort === "string" && view.reasoningEffort.length > 0
        ? view.reasoningEffort
        : undefined;
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      typeof model !== "string" ||
      model.length === 0
    ) {
      return;
    }
    try {
      // resolved 查询失败 → undefined：桥 refresh 后按 config/默认声明新路由，
      // selection 本身不受阻（照发请求，dsh llm 层自会报错）。
      let nextResolved: LlmResolvedModelInfo | undefined;
      try {
        nextResolved = await this.loopCtx.llm.resolveModelInfo(provider, model);
      } catch {
        nextResolved = undefined;
      }
      modelFactory.refresh(nextResolved === undefined ? {} : { resolved: nextResolved });
      const reasoningLevel = resolveReasoningLevel(nextResolved, reasoningEffort);
      runtime.setSessionModelSelection({
        providerId: provider,
        modelId: model,
        ...(reasoningLevel === undefined ? {} : { options: { reasoningLevel } }),
      });
      log("model selection applied", { provider, model, reasoningEffort });
    } catch (error) {
      log("model selection apply failed", { provider, model, error: String(error) });
    }
  }
}

export default ZcodeLoop;
export { ZcodeLoopRuntimes } from "./runtime-seam.js";
export type { ZcodeLoopRuntimeRelease, ZcodeLoopRuntimeView } from "./runtime-seam.js";
export { PersistentJs } from "./persistent-js.js";
export type { PersistentJsConfig } from "./persistent-js.js";
export { ZcodeLoopAgent } from "./agent.js";
export { ZcodeLoopInbox } from "./inbox.js";
export { createDshToolBridge } from "./bridges/tool-bridge.js";
export { assembleDshSystemPrompt } from "./bridges/system-prompt-bridge.js";
export { DshSessionEventStoreBridge } from "./bridges/event-store-bridge.js";
export { createDshModelBridge, DshModelError } from "./bridges/model-bridge.js";
export {
  createResumeSessionStore,
  translateDshEventsToEngineMessages,
} from "./bridges/resume-adapter.js";
