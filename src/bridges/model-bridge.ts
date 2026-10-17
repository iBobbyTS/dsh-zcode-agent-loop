/**
 * model-bridge — 模型流桥（共享边界样例 1 的实现）。
 *
 * ZCode `RuntimeModelFactory` 的 dsh 实现：`Model.streamText(request)` 内部走
 * dsh `ctx.llm.prepareCall(...) + prepared.stream(request)`，把 dsh
 * `StreamChunk{block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish}`
 * 翻译回 ZCode 流事件（text_start/text_delta/tool_input_delta/tool_call/finish 等）
 * 供引擎消费。
 *
 * 错误归一化（失败样例）：dsh 终态 `finish{kind:'error'|'aborted'}` → 抛
 * `DshModelError`（保留 dsh `LlmFailure.code` 为 `providerCode`）→ 引擎走自身
 * fallback / 取消判定，桥不重试、不吞错。
 *
 * 换模型/换档（阶段 4）：selection 由引擎按 turn 供给——每 turn `createTurnModel`
 * 以当前 session selection 调 factory，factory 取值 **selection 优先**
 * （`options.provider/model` 只是缺省回落，不再覆盖 selection）；`resolved` 元数据
 * （contextWindow/maxOutputTokens/reasoning 档位/midSystem 声明）经
 * `refresh({ resolved })` 热更新（外壳监听 dsh `model/selection` 时调用），对下一次
 * factory 调用生效，已创建的 Model 不回溯。
 *
 * 不变量：桥翻译流并在 prepared-call 接缝通知宿主；不缓存、不自行落盘、
 * 不做路由决策（provider/model 路由属于 dsh llm）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmFailure,
  LlmResolvedModelInfo,
  PreparedLlmCall,
  RequestMessage,
  StreamChunk,
  TokenUsage,
  TextBlock,
  ToolSchema,
} from "@deepseek-ai/dsh-llm";
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";

import {
  createModelId,
  createModelProviderId,
} from "../engine-facade.js";
import type {
  Model,
  ModelEvent,
  ModelInputMessage,
  ModelOptions,
  ModelProperties,
  ModelRequest,
  ModelResult,
  ModelToolCall,
  ModelUsage,
  RuntimeModelFactory,
} from "../engine-facade.js";

/** dsh 失败归一化错误：`code`/`providerCode` 都是 dsh `LlmFailure.code`（provider 中立机读码）。 */
export class DshModelError extends Error {
  readonly code: string;
  readonly providerCode: string;
  readonly status?: number;
  readonly kind: "error" | "aborted";
  readonly retryable?: true;

  constructor(kind: "error" | "aborted", failure: LlmFailure, retryable = false) {
    super(`dsh model ${kind}: ${failure.message}`);
    this.name = "DshModelError";
    this.kind = kind;
    this.code = failure.code;
    this.providerCode = failure.code;
    if (retryable) this.retryable = true;
    if (typeof failure.status === "number") this.status = failure.status;
  }
}

/** {@link createDshModelBridge} 的输入。 */
export interface DshModelBridgeOptions {
  /** 已挂载 LlmRuntime（`ctx.plugin(LlmRuntime)` + `registerAdapter`）的 Cordis context。 */
  ctx: Context;
  /** dsh provider 路由（必须已注册 adapter）；阶段 4 起 selection 优先，本字段只是 selection 缺项时的回落。 */
  provider?: string;
  /** dsh model id；阶段 4 起 selection 优先，本字段只是 selection 缺项时的回落。 */
  model?: string;
  /**
   * 装配期 `ctx.llm.resolveModelInfo(provider, model)` 的结果（dsh 路由真实元数据）。
   * 显式 config 字段优先于它，它优先于硬编码默认；查询失败传 undefined 即回落。
   */
  resolved?: LlmResolvedModelInfo;
  /** Standalone transport hook; production conversation admission is owned by streamRequest. */
  onPreparedRequest?: (prepared: PreparedLlmCall, request: GenerateOptions) => void;
  /** Host conversation transport; auxiliary/standalone models use the default path. */
  streamRequest?: (request: GenerateOptions, engineRequest: ModelRequest) => AsyncIterable<StreamChunk>;
  /** 声明给引擎的上下文窗口（进入 `Model.properties.contextWindow`）。 */
  contextWindow?: number;
  /** 声明给引擎的最大输出 token（进入 `Model.optionSpecs.maxOutputTokens.max`）。 */
  maxOutputTokens?: number;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * {@link createDshModelBridge} 返回的 factory 面：热刷新 resolved 元数据（阶段 4）。
 * `refresh` 用新的 dsh 路由元数据整体重算 Model 声明（properties/optionSpecs），
 * 对下一次 factory 调用生效；已创建的 Model 不回溯（引擎每 turn 重建 Model）。
 */
export type RefreshableModelFactory = RuntimeModelFactory & {
  refresh(next: { resolved?: LlmResolvedModelInfo }): void;
};

/**
 * 图片数据通路尚未落地：消息翻译只投影文本（`blockToText` 丢弃 image 块），
 * inbox/session 的 attachments 也未桥接（docs/GAPS.md）。通路补齐前即便
 * dsh 路由声明了 image 输入，也不向引擎放行，避免引擎保留图片块后被桥静默丢弃。
 */
const IMAGE_DATA_PATH_ENABLED = false;

function bridgeModelProperties(contextWindow: number, resolved?: LlmResolvedModelInfo): ModelProperties {
  const modalities = resolved?.inputModalities;
  return {
    requiresMfjsToolSchema: false,
    contextWindow,
    inputFormat: {
      supportsText: true,
      supportsImage: IMAGE_DATA_PATH_ENABLED && (modalities?.includes("image") ?? false),
      // dsh 模态词表只有 text/image；video/audio/pdf 无来源，恒 false（docs/GAPS.md）。
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: resolved?.systemPromptUpdate === "in-history",
  };
}

/** factory 闭包持有的 Model 声明快照；`refresh()` 整体重算替换（阶段 4 热更新）。 */
interface BridgeModelDeclaration {
  maxOutputTokensCap: number;
  properties: ModelProperties;
  effectiveReasoningValues: string[];
}

/**
 * 由 dsh 路由元数据计算 Model 声明：显式 config 字段（装配期固定）优先于 resolved，
 * resolved 缺席回落硬编码默认；reasoning 档位目录来自 resolved.reasoning.efforts。
 */
function bridgeModelDeclaration(
  resolved: LlmResolvedModelInfo | undefined,
  overrides: { contextWindow?: number; maxOutputTokens?: number },
): BridgeModelDeclaration {
  const contextWindow =
    overrides.contextWindow ?? resolved?.context?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokensCap =
    overrides.maxOutputTokens ?? resolved?.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const reasoningValues = resolved?.reasoning?.efforts
    ?.map((effort) => effort.id)
    .filter((id) => id.length > 0);
  // schema 要求档位非空且不重复；dsh 目录缺席时回落单档 "disabled"（不选即不发 effort）。
  const effectiveReasoningValues =
    reasoningValues !== undefined && reasoningValues.length > 0 ? [...new Set(reasoningValues)] : ["disabled"];
  return {
    maxOutputTokensCap,
    properties: bridgeModelProperties(contextWindow, resolved),
    effectiveReasoningValues,
  };
}

// ------------------------------------------------------------------
// ZCode ModelRequest → dsh GenerateOptions
// ------------------------------------------------------------------

/** 内容块的原型文本投影（引擎在请求装配侧已完成媒体投影，到达桥的正常只余 text）。 */
function blockToText(block: { type: string } & Record<string, unknown>): string {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  // reasoning 不进用户可见文本；其余块（image/file/video/resource_link）占位投影。
  return "";
}

function translateContent(
  content: ModelInputMessage["content"],
): TextBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const texts: TextBlock[] = [];
  for (const block of content) {
    const text = blockToText(block as unknown as { type: string } & Record<string, unknown>);
    if (text.length > 0) texts.push({ type: "text", text });
  }
  return texts;
}

function translateToolCallsToBlocks(
  toolCalls: ModelToolCall[] | undefined,
): ContentBlock[] {
  if (toolCalls === undefined) return [];
  return toolCalls.map((toolCall) => ({
    type: "tool-call" as const,
    id: ToolCallId(toolCall.id),
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.input ?? {}),
  }));
}

function contentToText(content: ModelInputMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => blockToText(block as unknown as { type: string } & Record<string, unknown>))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * ZCode `ModelInputMessage[]` → dsh `RequestMessage[]`。
 * 角色 1:1（system/user/assistant/tool）；assistant 的 `toolCalls` 内联为
 * `tool-call` 内容块；tool 消息按 `toolCallId` 配对（dsh 一条 tool 消息一个 result）。
 */
export function translateMessagesToDsh(
  messages: ModelInputMessage[],
  fallbackSource: { provider: string; model: string },
): RequestMessage[] {
  return messages.map((message): RequestMessage => {
    switch (message.role) {
      case "system":
        return createSystemMessage(contentToText(message.content));
      case "user":
        return createUserMessage({
          content: translateContent(message.content),
          source: { kind: "user" },
        });
      case "assistant":
        return createAssistantMessage({
          content: [
            ...translateContent(message.content),
            ...translateToolCallsToBlocks(message.toolCalls),
          ],
          source: {
            provider: message.providerId ?? fallbackSource.provider,
            model: message.modelId ?? fallbackSource.model,
          },
        });
      case "tool":
        return createToolResultMessage({
          callId: ToolCallId(message.toolCallId ?? ""),
          content: translateContent(message.content),
          isError: message.isError ?? false,
        });
    }
  });
}

function translateToolsToDsh(tools: ModelRequest["tools"]): ToolSchema[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    parameters: (tool.inputSchema as Record<string, unknown>) ?? {},
  }));
}

// ------------------------------------------------------------------
// dsh StreamChunk → ZCode ModelEvent
// ------------------------------------------------------------------

interface StreamTranslateState {
  /** tool-call 块 index → 已开始的 (id, name)。 */
  toolBlocks: Map<number, { id: string; name: string; started: boolean }>;
  /** 已完成的 tool-call（generateText 折叠用）。 */
  toolCalls: ModelToolCall[];
  usage: ModelUsage | undefined;
}

function emptyStreamState(): StreamTranslateState {
  return { toolBlocks: new Map(), toolCalls: [], usage: undefined };
}

function tokenUsageToModelUsage(usage: TokenUsage): ModelUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}

function finishReasonFromDsh(reason: FinishReason): string {
  switch (reason.kind) {
    case "stop":
      return "stop";
    case "tool-calls":
      return "tool-calls";
    case "max-tokens":
      return "length";
    case "aborted":
    case "error":
      // 失败样例：终态错误 finish → 桥抛错（保 providerCode），不产生 finish 事件。
      throw new DshModelError(reason.kind, reason.failure);
  }
}

function safeParseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return { _raw: argumentsJson };
  }
}

/** 翻译一个 dsh StreamChunk 为 0..n 个 ZCode ModelEvent，追加进 `out`。 */
function translateChunk(chunk: StreamChunk, state: StreamTranslateState, out: ModelEvent[]): void {
  switch (chunk.type) {
    case "block-start": {
      if (chunk.blockType === "text") {
        out.push({ type: "text_start", id: `text-${chunk.index}` });
      } else if (chunk.blockType === "reasoning") {
        out.push({ type: "reasoning_start", id: `reasoning-${chunk.index}` });
      } else if (chunk.blockType === "tool-call") {
        state.toolBlocks.set(chunk.index, { id: "", name: "", started: false });
      }
      // 其余 blockType（merge-extensible 词表）原型不翻译。
      return;
    }
    case "text-delta": {
      out.push({ type: "text_delta", id: `text-${chunk.index}`, text: chunk.text });
      return;
    }
    case "reasoning-delta": {
      out.push({ type: "reasoning_delta", id: `reasoning-${chunk.index}`, text: chunk.text });
      return;
    }
    case "tool-call-delta": {
      const block = state.toolBlocks.get(chunk.index);
      if (block === undefined) return;
      if (!block.started) {
        block.id = chunk.id;
        block.name = chunk.name ?? "";
        block.started = true;
        out.push({ type: "tool_input_start", id: chunk.id, toolName: block.name });
      }
      out.push({ type: "tool_input_delta", id: chunk.id, delta: chunk.argumentsDelta });
      return;
    }
    case "block-end": {
      const block = chunk.block;
      if (block.type === "text") {
        out.push({ type: "text_end", id: `text-${chunk.index}` });
      } else if (block.type === "reasoning") {
        out.push({ type: "reasoning_end", id: `reasoning-${chunk.index}` });
      } else if (block.type === "tool-call") {
        const input = safeParseArguments(block.arguments);
        state.toolCalls.push({ id: block.id, name: block.name, input });
        out.push({ type: "tool_input_end", id: block.id });
        out.push({ type: "tool_call", toolCall: { id: block.id, name: block.name, input } });
      }
      return;
    }
    case "usage": {
      state.usage = tokenUsageToModelUsage(chunk.usage);
      return;
    }
    case "finish": {
      const finishReason = finishReasonFromDsh(chunk.reason);
      out.push({ type: "finish", finishReason, usage: state.usage ?? {} });
      return;
    }
  }
}

// ------------------------------------------------------------------
// 桥工厂
// ------------------------------------------------------------------

/**
 * 构造经 dsh llm 路由的 `RuntimeModelFactory`（带 `refresh` 热刷新面，阶段 4）。
 * 每次 `streamText` 都现场 `prepareCall`（adapter 注册捕获在 prepared call 内），
 * `prepared.stream` 恰好分发一次；桥不做任何缓存或路由决策。
 */
export function createDshModelBridge(options: DshModelBridgeOptions): RefreshableModelFactory {
  // resolved 元数据快照：refresh() 时整体重算替换，factory 每次调用读 current。
  let current = bridgeModelDeclaration(options.resolved, options);

  const factory: RuntimeModelFactory = (input): Model => {
    // selection 优先（阶段 4）：引擎每 turn 以当前 session selection 调 factory，
    // 换模型/换档随新 selection 生效；options.provider/model 只在 selection 缺项时
    // 回落（引擎 schema 保证 selection 两字段 trim().min(1)，末位回落只是类型闭环
    // + 对异常输入的防御）。
    const provider = input.selection.providerId || options.provider || input.selection.providerId;
    const modelId = input.selection.modelId || options.model || input.selection.modelId;
    const baseOptions: ModelOptions = { ...input.selection.options };

    const createModel = (currentOptions: ModelOptions): Model => {
      /**
       * ZCode 请求 → dsh 请求；call-config 字段（provider/model/maxTokens/reasoningEffort）
       * 两侧严格一致（否则 dsh 抛 INVALID_PREPARED_CALL）。档位优先级：请求级
       * `request.options.reasoningLevel`（引擎 agent-step 目前不用）> Model 绑定档位
       * （引擎经 `modelSelection.options.reasoningLevel` + `bind()` 注入）。
       */
      const buildDshCall = (request: ModelRequest): {
        config: {
          provider: string;
          model: string;
          maxTokens?: number;
          reasoningEffort?: NonNullable<GenerateOptions["reasoningEffort"]>;
        };
        generateOptions: GenerateOptions;
      } => {
        const maxTokens = request.options?.maxOutputTokens;
        const reasoningLevel = request.options?.reasoningLevel ?? currentOptions.reasoningLevel;
        const reasoningEffort =
          reasoningLevel === undefined || reasoningLevel.length === 0
            ? undefined
            : ReasoningEffortId(reasoningLevel);
        const tools = translateToolsToDsh(request.tools);
        return {
          config: {
            provider,
            model: modelId,
            ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          },
          generateOptions: {
            provider,
            model: modelId,
            messages: translateMessagesToDsh(request.messages, { provider, model: modelId }),
            ...(tools === undefined ? {} : { tools }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
          },
        };
      };

      const streamDsh = async function* (request: ModelRequest): AsyncGenerator<ModelEvent> {
        const { config, generateOptions } = buildDshCall(request);
        if (options.streamRequest) {
          const state = emptyStreamState();
          try {
            for await (const chunk of options.streamRequest(generateOptions, request)) {
              const events: ModelEvent[] = [];
              translateChunk(chunk, state, events);
              for (const event of events) yield event;
            }
          } catch (error) { throw normalizeBridgeError(error); }
          return;
        }
        let prepared: PreparedLlmCall;
        try {
          prepared = await options.ctx.llm.prepareCall(config, request.abortSignal);
        } catch (error) {
          throw normalizeBridgeError(error);
        }
        const state = emptyStreamState();
        const dispatch = withPreparedDefaults(generateOptions, prepared);
        options.onPreparedRequest?.(prepared, dispatch);
        const chunks = prepared.stream(dispatch);
        for await (const chunk of chunks) {
          const events: ModelEvent[] = [];
          translateChunk(chunk, state, events);
          for (const event of events) yield event;
        }
      };

      return {
        providerId: createModelProviderId(provider),
        modelId: createModelId(modelId),
        displayName: `dsh:${provider}/${modelId}`,
        properties: current.properties,
        optionSpecs: {
          reasoningLevel: {
            values: current.effectiveReasoningValues,
            map: "{'reasoning_effort': reasoningLevel}",
          },
          maxOutputTokens: {
            max: current.maxOutputTokensCap,
            map: "{'max_output_tokens': maxOutputTokens}",
          },
        },
        options: currentOptions,
        bind(nextOptions) {
          return createModel({ ...currentOptions, ...nextOptions });
        },
        async generateText(request): Promise<ModelResult> {
          const { config, generateOptions } = buildDshCall(request);
          const state = emptyStreamState();
          let text = "";
          const reasoning: Array<{ type: "reasoning"; text: string }> = [];
          let finishReason = "stop";
          let usage: ModelUsage = {};
          let chunks: AsyncIterable<StreamChunk>;
          if (options.streamRequest) chunks = options.streamRequest(generateOptions, request);
          else {
            const prepared = await options.ctx.llm.prepareCall(config, request.abortSignal).catch(error => { throw normalizeBridgeError(error); });
            const dispatch = withPreparedDefaults(generateOptions, prepared);
            options.onPreparedRequest?.(prepared, dispatch);
            chunks = prepared.stream(dispatch);
          }
          for await (const chunk of chunks) {
            const events: ModelEvent[] = [];
            translateChunk(chunk, state, events);
            for (const event of events) {
              switch (event.type) {
                case "text_delta":
                  text += event.text;
                  break;
                case "reasoning_delta": {
                  const last = reasoning.at(-1);
                  if (last) last.text += event.text;
                  else reasoning.push({ type: "reasoning", text: event.text });
                  break;
                }
                case "finish":
                  finishReason = event.finishReason;
                  usage = event.usage;
                  break;
                default:
                  break;
              }
            }
          }
          return {
            text,
            finishReason,
            usage,
            ...(reasoning.length > 0 ? { reasoning } : {}),
            ...(state.toolCalls.length > 0 ? { toolCalls: state.toolCalls } : {}),
          };
        },
        streamText(request) {
          return streamDsh(request);
        },
      };
    };

    return createModel(baseOptions);
  };

  // 热刷新面（阶段 4）：外壳监听 dsh model/selection 时以新 resolved 重算声明。
  return Object.assign(factory, {
    refresh(next: { resolved?: LlmResolvedModelInfo }): void {
      current = bridgeModelDeclaration(next.resolved, options);
    },
  });
}

/**
 * `prepareCall` 会把 adapter 缺省（`defaultMaxTokens`、reasoning `defaultEffort`）
 * 物化进 `prepared.config`，而 dispatch 的 options 必须与物化后的 config 逐字段
 * 相等（`callConfigEquals`，否则 INVALID_PREPARED_CALL）。把物化值回填进派发
 * options —— dsh 的缺省语义原样保留，桥不自行填缺省。
 */
function withPreparedDefaults(generateOptions: GenerateOptions, prepared: PreparedLlmCall): GenerateOptions {
  return { ...generateOptions, ...prepared.config };
}

/** 流外的 dsh `LlmError`（含 `failure` 事实）归一化为 `DshModelError`（保 code）。 */
function normalizeBridgeError(error: unknown): Error {  if (error instanceof DshModelError) return error;
  const candidate = error as { failure?: unknown; retryable?: unknown } | null;
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.failure === "object" &&
    candidate.failure !== null
  ) {
    const failure = candidate.failure as LlmFailure;
    if (typeof failure.code === "string" && typeof failure.message === "string") {
      return new DshModelError("error", failure, candidate.retryable === true);
    }
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}
