/**
 * tool-bridge — 工具执行桥（共享边界样例 3 的实现）。
 *
 * 方向与 model-bridge 相反：把 dsh `ctx.tools` 的**工具面**投影进 ZCode
 * `ToolRegistry`，让嵌入引擎"看见"并"调用" dsh 工具：
 *
 * - schema 同步（每 turn 前由外壳调用 {@link DshToolBridge.syncTools}）：
 *   `ctx.tools.schemas()`（name/description/parameters 的 JSON Schema 投影）
 *   → ZCode `ToolEntry`（capability/inputSchema/metadata 等必填字段按引擎实测
 *   形状补齐；元数据映射 `isConcurrencySafe` → `concurrentSafe`）。
 * - 执行（不变量"工具执行必须过 dsh 管线"）：ToolEntry.handler **不实现工具**，
 *   只把调用翻译成 `ctx.tools.execute({callId, name, arguments, agent, signal})`，
 *   由 dsh ToolRuntime 走完整 pre-execute waterfall → guards → 执行 →
 *   post-execute 管线；dsh 工具插件对本桥无感。判别 probe：注册
 *   `tools/pre-execute` listener 计数（pipeline 集成脚本断言 ≥1）。
 * - 结果映射：dsh `ToolExecutionResult.content`（ContentBlock[]）折叠为文本；
 *   `isError` 时抛 `Error`（引擎记 tool 失败 → event-store-bridge 落
 *   `tool/result{isError}`）。
 *
 * 桥不做缓存策略/权限决策/并发编排（并发归 dsh 管线与引擎各自调度）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import { ToolCallId } from "@deepseek-ai/dsh-llm";

import { createToolRegistry } from "../engine-facade.js";
import type { JsonSchema, ToolEntry, ToolExecutionContext, ToolRegistry } from "../engine-facade.js";

export interface DshToolBridgeOptions {
  /** 挂载了 ToolRuntime（`ctx.tools`）的 Cordis context。 */
  ctx: Context;
  /** 解析当前代理（进入 dsh 执行输入的 `agent`，供 scope 过滤/审计）。 */
  agent?: () => Agent | undefined;
  /** 复用既有 registry（缺省新建；引擎侧 built-in 工具也会注册进来）。 */
  registry?: ToolRegistry;
}

/** 一次同步的差量结果（诊断/断言用）。 */
export interface ToolSyncResult {
  registered: string[];
  refreshed: string[];
  unregistered: string[];
}

const DSH_TOOL_TIMEOUT_MS = 120_000;
const DSH_TOOL_BUDGET_BYTES = 262_144;

/** dsh `ToolDefinition` 的本地窄视图（只读注册元数据所需字段）。 */
interface DshToolDefinitionView {
  isConcurrencySafe?: (args: unknown) => boolean;
}

function dshDefinitionView(ctx: Context, name: string): DshToolDefinitionView | undefined {
  const definition = ctx.tools.get(name) as DshToolDefinitionView | undefined;
  return definition ?? undefined;
}

/** 注册期并发分类：`isConcurrencySafe` 探测（异常/缺席按独占处理，fail-closed）。 */
function classifyConcurrentSafe(ctx: Context, name: string): boolean {
  const definition = dshDefinitionView(ctx, name);
  if (definition?.isConcurrencySafe === undefined) return false;
  try {
    return definition.isConcurrencySafe(undefined) === true;
  } catch {
    return false;
  }
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
  /** 每 turn 前把 `ctx.tools.schemas()` 同步进 registry（增量 upsert + 撤销消失项）。 */
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

  const entryFor = (schema: ToolSchema): ToolEntry => {
    const name = schema.name;
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
        maxInlineBytes: DSH_TOOL_BUDGET_BYTES,
        maxModelBytes: DSH_TOOL_BUDGET_BYTES,
        strategy: "inline",
      },
      timeout: { kind: "timed", defaultMs: DSH_TOOL_TIMEOUT_MS, allowCallOverride: true },
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
        concurrentSafe: classifyConcurrentSafe(options.ctx, name),
        needsApproval: false,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async (input: unknown, context: ToolExecutionContext) =>
        executeThroughDshPipeline(options, schema.name, input, context),
    };
    return entry;
  };

  return {
    registry,
    syncTools(): ToolSyncResult {
      const result: ToolSyncResult = { registered: [], refreshed: [], unregistered: [] };
      const schemas = options.ctx.tools.schemas();
      const liveNames = new Set(schemas.map((schema) => schema.name));
      for (const schema of schemas) {
        const previous = synced.get(schema.name);
        const entry = entryFor(schema);
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
): Promise<string> {
  const agent = options.agent?.();
  const result = await options.ctx.tools.execute({
    callId: ToolCallId(context.toolCallId),
    name,
    arguments: input,
    ...(agent === undefined ? {} : { agent }),
    signal: context.abortSignal,
  });
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : `[${block.type} content]`))
    .join("\n");
  if (result.isError) {
    throw new Error(result.error?.message ?? (text.length > 0 ? text : `dsh tool "${name}" failed`));
  }
  return text;
}
