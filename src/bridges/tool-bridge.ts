/**
 * tool-bridge — 工具执行桥（共享边界样例 3 的实现）。
 *
 * 方向与 model-bridge 相反：把 dsh `ctx.tools` 的**工具面**投影进 ZCode
 * `ToolRegistry`，让嵌入引擎"看见"并"调用" dsh 工具：
 *
 * - schema 同步（每 turn 前由外壳调用 {@link DshToolBridge.syncTools}）：
 *   `ctx.tools.schemas(agent)`（name/description/parameters 的 JSON Schema 投影）
 *   → ZCode `ToolEntry`（capability/inputSchema/metadata 等必填字段按引擎实测
 *   形状补齐；元数据映射 `isConcurrencySafe` → `concurrentSafe`）。
 * - 执行（不变量"工具执行必须过 dsh 管线"）：ToolEntry.handler **不实现工具**，
 *   只把调用翻译成 `ctx.tools.execute({callId, name, arguments, agent, signal})`，
 *   由 dsh ToolRuntime 走完整 pre-execute waterfall → guards → 执行 →
 *   post-execute 管线；dsh 工具插件对本桥无感。判别 probe：注册
 *   `tools/pre-execute` listener 计数（pipeline 集成脚本断言 ≥1）。
 * - 结果映射：dsh `ToolExecutionResult.content`（ContentBlock[]）逐块映射进
 *   引擎 `ModelMessageContent`。text/reasoning 保真；image 经 attachment 桥
 *   `readImage` 校验字节后生成带 `dataUrl` 的引擎图片块；file 没有 provider-
 *   native 通道，保留引用文本（含只读路径）；未知块 JSON 文本化，不静默丢弃。
 *   引擎的 `formatModelContent` 是同步接缝，handler 在执行期先异步解析并暂存
 *   （见 resolvedModelContent）。`isError` 时抛 `Error`（引擎记 tool 失败
 *   → event-store-bridge 落 `tool/result{isError}`）。
 *
 * 超时与结果预算的唯一权威是 dsh：引擎侧 deadline 按 dsh `ToolDefinition.timeoutMs`
 * 镜像（未声明 = 无 deadline），结果预算只保留一个宽容的 last-resort 上限，
 * 不覆盖 dsh spill/裁剪策略。
 *
 * 桥不做缓存策略/权限决策/并发编排（并发归 dsh 管线与引擎各自调度）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock, ToolSchema, UserMessage } from "@deepseek-ai/dsh-llm";
import { ToolCallId } from "@deepseek-ai/dsh-llm";

import { createToolRegistry } from "../engine-facade.js";
import type {
  JsonSchema,
  ModelMessageContent,
  ModelMessageContentBlock,
  ToolEntry,
  ToolExecutionContext,
  ToolRegistry,
} from "../engine-facade.js";
import type { AttachmentMediaBridge } from "./attachment-bridge.js";

export interface DshToolBridgeOptions {
  /** 挂载了 ToolRuntime（`ctx.tools`）的 Cordis context。 */
  ctx: Context;
  /** 延迟解析本桥所属代理，统一 schemas/get/execute 的显式 scope key。 */
  agent?: () => Agent | undefined;
  /** Stage contexts until the matching tool/result has reached the session. */
  acceptContexts?: (callId: string, messages: readonly UserMessage[]) => void;
  /**
   * 成功结果的原始 dsh ContentBlock[]：交给 event-store 桥落 `tool/result`，
   * 避免引擎事件载荷的文本投影把结构丢失（spill preview/多块文本/image 引用）。
   */
  onResultContent?: (callId: string, content: readonly ContentBlock[]) => void;
  /** 复用既有 registry（缺省新建；引擎侧 built-in 工具也会注册进来）。 */
  registry?: ToolRegistry;
  /**
   * dsh attachment 服务：工具结果 image 块读取校验字节 → 引擎图片块（dataUrl）。
   * 缺席时图片降级为引用文本（T08 边界），不伪造媒体数据。
   */
  media?: AttachmentMediaBridge;
}

/** 一次同步的差量结果（诊断/断言用）。 */
export interface ToolSyncResult {
  registered: string[];
  refreshed: string[];
  unregistered: string[];
}

/**
 * last-resort 结果预算，不是策略：dsh spill/裁剪插件已经在执行管线内把 content
 * 成形（spill 后模型看到 preview + locator）。这里取引擎可接受的最大安全整数，
 * 保证桥/引擎不会二次截断 dsh 已成形结果；任何真实预算都由 dsh 侧决定。
 */
const LAST_RESORT_RESULT_BUDGET_BYTES = Number.MAX_SAFE_INTEGER;

/**
 * 引擎 deadline 的收尾宽限：声明值本身由 dsh timeout policy 执行，引擎只做
 * 同值镜像。宽限让 dsh 在引擎计时器之前先中止合作式工具并结算结构化
 * TOOL_TIMEOUT，避免两个同值计时器竞速时引擎抢先报通用超时。
 */
const DSH_TIMEOUT_SETTLE_GRACE_MS = 250;

/** dsh `ToolDefinition` 的本地窄视图（只读注册元数据所需字段）。 */
interface DshToolDefinitionView {
  isConcurrencySafe?: (args: unknown) => boolean;
  /** 合作式超时预算；仅由 `@deepseek-ai/dsh-tool-call-timeout-policy` 执行。 */
  timeoutMs?: number;
}

function dshDefinitionView(ctx: Context, name: string, agent?: Agent): DshToolDefinitionView | undefined {
  const definition = ctx.tools.get(name, agent) as DshToolDefinitionView | undefined;
  return definition ?? undefined;
}

/** 注册期并发分类：`isConcurrencySafe` 探测（异常/缺席按独占处理，fail-closed）。 */
function classifyConcurrentSafe(ctx: Context, name: string, agent?: Agent): boolean {
  const definition = dshDefinitionView(ctx, name, agent);
  if (definition?.isConcurrencySafe === undefined) return false;
  try {
    return definition.isConcurrencySafe(undefined) === true;
  } catch {
    return false;
  }
}

/**
 * 引擎侧 deadline 只镜像 dsh 的声明：声明了 `timeoutMs` 就同值，未声明则
 * `{kind:"none"}` 完全交给 dsh 管线（未装 timeout policy 时就是无 deadline）。
 * 删除桥自带 120s 常量，避免覆盖宿主策略。
 */
function timeoutPolicyFor(declared: number | undefined): ToolEntry["timeout"] {
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
    return {
      kind: "timed",
      defaultMs: declared,
      allowCallOverride: false,
      cleanupGraceMs: DSH_TIMEOUT_SETTLE_GRACE_MS,
    };
  }
  return { kind: "none" };
}

/**
 * dsh 工具结果块 → 引擎模型内容块。
 *
 * image：经 attachment 桥 `readImage` 校验字节后生成 `dataUrl` 图片块（真通路）；
 * attachment 服务缺席时保留带元数据的文本占位（不伪造媒体）。
 * file：dsh 从不让 provider 原生接收文件，保留引用文本（含宿主只读路径）。
 * 未知块 JSON 文本化，不静默丢弃。
 */
export async function mapDshToolContent(
  content: readonly ContentBlock[],
  media?: AttachmentMediaBridge,
): Promise<ModelMessageContent> {
  const blocks: ModelMessageContentBlock[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text": {
        blocks.push({ type: "text", text: block.text });
        break;
      }
      case "reasoning": {
        // 工具结果不存在独立推理通道；按 text 保留，避免 durable 文本投影吞掉内容。
        blocks.push({ type: "text", text: block.text });
        break;
      }
      case "image": {
        if (media !== undefined && media.available) {
          blocks.push(await media.toEngineImage(block));
        } else {
          const { attachment } = block;
          const name = attachment.name === undefined ? "" : ` name=${attachment.name}`;
          blocks.push({
            type: "text",
            text: `[image ${attachment.mediaType} attachmentId=${attachment.attachmentId} bytes=${attachment.bytes} ${attachment.width}x${attachment.height}${name}]`,
          });
        }
        break;
      }
      case "file": {
        blocks.push({
          type: "text",
          text: media?.filePlaceholder(block.attachment)
            ?? `[file ${block.attachment.name} attachmentId=${block.attachment.attachmentId} bytes=${block.attachment.bytes}]`,
        });
        break;
      }
      default: {
        // merge-extensible 块（tool-call/tool-addition/...）不属于工具结果语义，
        // 但也不静默丢弃：完整 JSON 文本化。
        blocks.push({ type: "text", text: JSON.stringify(block) });
        break;
      }
    }
  }
  return blocks;
}

/** 同步文本投影（错误正文与 durable 文本；不做 attachment 读取）。 */
function dshContentText(content: readonly ContentBlock[]): string {
  return content.map((block): string => {
    switch (block.type) {
      case "text":
      case "reasoning":
        return block.text;
      case "image":
        return `[image ${block.attachment.mediaType} attachmentId=${block.attachment.attachmentId} bytes=${block.attachment.bytes}]`;
      case "file":
        return `[file ${block.attachment.name} attachmentId=${block.attachment.attachmentId} bytes=${block.attachment.bytes}]`;
      default:
        return JSON.stringify(block);
    }
  }).join("\n");
}

/** dsh parameters 投影归一为 ZCode `inputSchema`（缺 type 的兜成 object）。 */
function normalizeInputSchema(parameters: ToolSchema["parameters"]): JsonSchema {
  const schema = (parameters ?? {}) as Record<string, unknown>;
  if (schema.type === undefined) {
    return { type: "object", properties: {}, additionalProperties: true } as JsonSchema;
  }
  return schema as JsonSchema;
}

export interface DshToolBridge {
  /** ZCode 侧 registry（喂给 `AgentRuntimeDeps.toolRegistry`）。 */
  registry: ToolRegistry;
  /** 每 turn 前把所属 agent 可见工具同步进 registry（增量 upsert + 撤销消失项）。 */
  syncTools(): ToolSyncResult;
  /** 当前已同步的 dsh 工具名（诊断用）。 */
  syncedToolNames(): string[];
}

/**
 * 建 dsh→ZCode 工具桥。一个桥服务一个 agent（`agent()` 回调进入每次执行）。
 */
export function createDshToolBridge(options: DshToolBridgeOptions): DshToolBridge {
  const registry = options.registry ?? createToolRegistry();
  const synced = new Map<string, ToolEntry>();
  // handler 异步读图后，引擎的 formatModelContent 是同步接缝：按输出数组对象
  // 暂存已解析的模型内容（WeakMap 不延长输出生命周期，也不改 dsh 块结构）。
  const resolvedModelContent = new WeakMap<object, ModelMessageContent>();

  const entryFor = (schema: ToolSchema, agent: Agent | undefined): ToolEntry => {
    const name = schema.name;
    const definition = dshDefinitionView(options.ctx, name, agent);
    const declaredTimeout = definition?.timeoutMs;
    const entry: ToolEntry = {
      capability: `dsh.tool.${name}`,
      inputSchema: normalizeInputSchema(schema.parameters),
      outputSchema: {},
      permission: {
        permission: `dsh.tool.${name}`,
        reason: "gated by the dsh tool pipeline (tools/pre-execute and friends)",
        riskLevel: "low",
        sideEffectScope: "none",
        needsApproval: false,
        patternSources: ["none"],
        denyPriority: "afterStaticAllow",
      },
      resultBudget: {
        maxInlineBytes: LAST_RESORT_RESULT_BUDGET_BYTES,
        maxModelBytes: LAST_RESORT_RESULT_BUDGET_BYTES,
        strategy: "inline",
      },
      timeout: timeoutPolicyFor(declaredTimeout),
      cancellation: { supported: true, cleanup: "none", userVisibleMessage: "" },
      // required 是字面量 true（ToolTracePolicy 契约）；观测口径全 none。
      trace: {
        required: true,
        propagateToAdapters: false,
        recordInput: "none",
        recordOutput: "none",
      },
      metadata: {
        name,
        description: schema.description ?? name,
        readOnly: false,
        destructive: false,
        // 元数据映射（任务指定）：dsh isConcurrencySafe → ZCode concurrentSafe。
        // 注册期只能以 `undefined` 探测：声明式条件安全（按 args 判定）在这里
        // 一律 fail-closed 成独占，是已知精度边界（引擎调度器只读静态 metadata）。
        concurrentSafe: classifyConcurrentSafe(options.ctx, name, agent),
        ...(declaredTimeout === undefined ? {} : { timeoutMs: declaredTimeout }),
        needsApproval: false,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async (input: unknown, context: ToolExecutionContext) => {
        const output = await executeThroughDshPipeline(options, schema.name, input, context);
        // image 块需要校验读取后才可生成 dataUrl；在此一次性解析给同步格式化面。
        resolvedModelContent.set(output, await mapDshToolContent(output, options.media));
        return output;
      },
      // handler 返回 dsh ContentBlock[]；这里给出已解析的引擎模型内容，保真到请求。
      formatModelContent: (output: unknown) => {
        if (output !== null && typeof output === "object") {
          const resolved = resolvedModelContent.get(output);
          if (resolved !== undefined) return resolved;
        }
        return Array.isArray(output)
          ? Array.from(output as ContentBlock[]).map((block): ModelMessageContentBlock => {
            switch (block.type) {
              case "text":
              case "reasoning":
                return { type: "text", text: block.text };
              case "image":
                return {
                  type: "text",
                  text: `[image ${block.attachment.mediaType} attachmentId=${block.attachment.attachmentId} bytes=${block.attachment.bytes}]`,
                };
              case "file":
                return {
                  type: "text",
                  text: `[file ${block.attachment.name} attachmentId=${block.attachment.attachmentId} bytes=${block.attachment.bytes}]`,
                };
              default:
                return { type: "text", text: JSON.stringify(block) };
            }
          })
          : [];
      },
    };
    return entry;
  };

  return {
    registry,
    syncTools(): ToolSyncResult {
      const result: ToolSyncResult = { registered: [], refreshed: [], unregistered: [] };
      // ToolRuntime 注册时从 ctx 取 scope，但读取时要求显式传 agent；即使用
      // agent.ctx 调 schemas() 也只得到全局工具。每 turn 重新解析以容纳 preset
      // 在 agent 创建/enter 后绑定，以及后续 scope 工具增删。
      const agent = options.agent?.();
      const schemas = options.ctx.tools.schemas(agent);
      const liveNames = new Set(schemas.map((schema) => schema.name));
      for (const schema of schemas) {
        const previous = synced.get(schema.name);
        const entry = entryFor(schema, agent);
        registry.register(entry, { silentDuplicateWarning: true });
        synced.set(schema.name, entry);
        if (previous === undefined) result.registered.push(schema.name);
        else result.refreshed.push(schema.name);
      }
      for (const name of [...synced.keys()]) {
        if (!liveNames.has(name)) {
          registry.unregister(name);
          synced.delete(name);
          result.unregistered.push(name);
        }
      }
      return result;
    },
    syncedToolNames(): string[] {
      return [...synced.keys()];
    },
  };
}

/** handler 唯一职责：把引擎工具调用翻译进 dsh ToolRuntime 管线。 */
async function executeThroughDshPipeline(
  options: DshToolBridgeOptions,
  name: string,
  input: unknown,
  context: ToolExecutionContext,
): Promise<ContentBlock[]> {
  const agent = options.agent?.();
  const result = await options.ctx.tools.execute({
    callId: ToolCallId(context.toolCallId),
    name,
    arguments: input,
    ...(agent === undefined ? {} : { agent }),
    signal: context.abortSignal,
  });
  // contexts 必须在错误结果上也暂存（T05 语义），先于任何抛出。
  if (result.additionalContexts?.length) {
    options.acceptContexts?.(context.toolCallId, result.additionalContexts);
  }
  // 成功结果保留 dsh 块结构给 durable tool/result；失败走错误正文，不落块。
  if (!result.isError) options.onResultContent?.(context.toolCallId, result.content);
  if (result.isError) {
    const text = dshContentText(result.content);
    throw new Error(result.error?.message ?? (text.length > 0 ? text : `dsh tool "${name}" failed`));
  }
  return [...result.content];
}
