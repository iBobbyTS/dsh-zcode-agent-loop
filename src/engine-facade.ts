/**
 * engine-facade.ts — 全仓唯一允许 import `@zcode/*` 的文件（门面隔离不变量）。
 *
 * 桥与 dsh 外壳只经这里消费 vendored ZCode 引擎，不得直接 import
 * `@zcode/core` / `@zcode/contracts`。`scripts/assert-facade-isolation.mjs` 用 grep
 * 断言这一约束。
 *
 * 本文件刻意保持"最小门面"：
 * - 重新导出桥与外壳需要的引擎值与类型；
 * - 提供脱离 ZCode bootstrap 的最小构造件：内存事件 store、脚本化假模型工厂、
 *   最小 config/deps 装配（对照上游 `apps/zcode-cli/packages/core/tests` 的
 *   test-agent-runtime / test-runtime-model 写法，照结构不照语义）。
 */
import { AgentRuntime, SessionEventType, createExternalTurnFaultError } from "@zcode/core";
import { createToolRegistry } from "@zcode/core";
import type { ResumeSessionOptions } from "@zcode/core";
import type {
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ContextBuilder,
  ContextBuildResult,
  ExecuteTurnOptions,
  ToolEntry,
  ToolExecutionContext,
  ToolRegistry,
  TurnAttachment,
  TurnResult,
} from "@zcode/core";
import {
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createProjectId,
  createRootTraceContext,
  createSessionId,
  InMemorySessionEventStore,
} from "@zcode/contracts";
import type {
  AssistantMessageInfo,
  FilePart,
  JsonSchema,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  Model,
  ModelEvent,
  ModelImageContentBlock,
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelOptions,
  ModelProperties,
  ModelRequest,
  ModelResult,
  ModelSelection,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  PermissionBrokerPort,
  PermissionBrokerResult,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionEventStoreStats,
  SessionId,
  SessionInfo,
  SessionProjection,
  SessionStorePort,
  TextPart,
  ToolArtifactReadRequest,
  ToolArtifactReadResult,
  ToolArtifactStatRequest,
  ToolArtifactStatResult,
  ToolArtifactStorePort,
  ToolArtifactWriteRequest,
  ToolArtifactWriteResult,
  ToolPart,
  TraceContext,
  TurnId,
  Logger,
  LogContext,
  UserMessageInfo,
} from "@zcode/contracts";

// ------------------------------------------------------------------
// 引擎值与类型的再导出（门面消费面）
// ------------------------------------------------------------------

export { AgentRuntime, InMemorySessionEventStore, SessionEventType, createExternalTurnFaultError };
export { createToolRegistry };
export {
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createProjectId,
  createRootTraceContext,
  createSessionId,
};
export type {
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  AssistantMessageInfo,
  ContextBuilder,
  ContextBuildResult,
  ExecuteTurnOptions,
  FilePart,
  JsonSchema,
  Logger,
  LogContext,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  Model,
  ModelEvent,
  ModelImageContentBlock,
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelOptions,
  ModelProperties,
  ModelRequest,
  ModelResult,
  ModelSelection,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  PermissionBrokerPort,
  PermissionBrokerResult,
  ResumeSessionOptions,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionEventStoreStats,
  SessionId,
  SessionInfo,
  SessionProjection,
  SessionStorePort,
  TextPart,
  ToolArtifactStorePort,
  ToolEntry,
  ToolExecutionContext,
  ToolPart,
  ToolRegistry,
  TraceContext,
  TurnAttachment,
  TurnId,
  TurnResult,
  UserMessageInfo,
};

/** 引擎期望的模型工厂；model-bridge 以它为接缝。 */
export type RuntimeModelFactory = AgentRuntimeDeps["modelFactory"];

// ------------------------------------------------------------------
// 脚本化假模型（纯文本、无工具）
// ------------------------------------------------------------------

export interface ScriptedModelOptions {
  /** 假模型每次请求返回的固定文本。 */
  text?: string;
  providerId?: string;
  modelId?: string;
  contextWindow?: number;
  supportsToolCall?: boolean;
}

const SCRIPTED_USAGE = { inputTokens: 3, outputTokens: 5, totalTokens: 8 } as const;

function createScriptedModelProperties(input: ScriptedModelOptions): ModelProperties {
  const supportsToolCall = input.supportsToolCall ?? false;
  return {
    requiresMfjsToolSchema: false,
    contextWindow: input.contextWindow ?? 200_000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  };
}

/**
 * 脚本化假 `modelFactory`：固定返回一段纯文本，声明不支持工具调用。
 * 对照上游 tests/test-runtime-model.ts 的最小 Model 形状补齐了
 * `ModelProperties`/`ModelOptionSpecs` 的必填字段（含 option map 表达式）。
 */
export function createScriptedModelFactory(
  options: ScriptedModelOptions = {},
): RuntimeModelFactory {
  return (input) => {
    const providerId = createModelProviderId(options.providerId ?? input.selection.providerId);
    const modelId = createModelId(options.modelId ?? input.selection.modelId);
    const properties = createScriptedModelProperties(options);
    const baseOptions: ModelOptions = { ...input.selection.options };

  const respond = async (_request: ModelRequest): Promise<ModelResult> => ({
    text: options.text ?? "ok",
    finishReason: "stop",
    usage: { ...SCRIPTED_USAGE },
  });

    const createModel = (currentOptions: ModelOptions): Model => ({
      providerId,
      modelId,
      properties,
      optionSpecs: {
        reasoningLevel: {
          values: ["disabled"],
          map: "{'reasoning_effort': reasoningLevel}",
        },
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_output_tokens': maxOutputTokens}",
        },
      },
      options: currentOptions,
      bind(nextOptions) {
        return createModel({ ...currentOptions, ...nextOptions });
      },
      generateText: respond,
      async *streamText(request): AsyncIterable<ModelEvent> {
        const result = await respond(request);
        if (result.text) {
          yield { type: "text_start", id: "scripted-text" };
          yield { type: "text_delta", id: "scripted-text", text: result.text };
          yield { type: "text_end", id: "scripted-text" };
        }
        yield {
          type: "finish",
          finishReason: result.finishReason,
          usage: result.usage,
        };
      },
    });

    return createModel(baseOptions);
  };
}

// ------------------------------------------------------------------
// 最小引擎装配（脱离 ZCode bootstrap 的冷启动路径）
// ------------------------------------------------------------------

export interface CreateEmbeddedEngineInput {
  sessionId: SessionId;
  eventStore: SessionEventStorePort;
  /** 缺省用脚本化纯文本假模型；运行时替换为经 dsh llm 路由的真模型工厂。 */
  modelFactory?: RuntimeModelFactory;
  workingDirectory?: string;
  config?: AgentRuntimeConfig;
  deps?: Partial<AgentRuntimeDeps>;
}

/**
 * 用最小 config/deps 构造 `AgentRuntime`：内存事件 store + 显式 modelSelection +
 * 关闭 dynamic workflow。`AgentRuntimeConfig` 其余字段全部可选（类型现场核对），
 * contextBuilder 不喂（构造器接受 null，executeTurn 走默认装配）。
 */
export function createEmbeddedEngine(input: CreateEmbeddedEngineInput): AgentRuntime {
  const modelSelection: ModelSelection =
    input.config?.modelSelection ?? {
      providerId: "zcode-loop-prototype",
      modelId: "scripted-text",
    };
  const config: AgentRuntimeConfig = {
    workingDirectory: input.workingDirectory ?? ".",
    dynamicWorkflowEnabled: false,
    dynamicWorkflowToolsOnDemand: false,
    ...input.config,
    modelSelection,
  };
  const deps: AgentRuntimeDeps = {
    eventStore: input.eventStore,
    modelFactory: input.modelFactory ?? createScriptedModelFactory(),
    ...input.deps,
  };
  return new AgentRuntime(input.sessionId, config, deps);
}

/**
 * 引擎内部 artifact store 的最小实现（仅承载引擎自己的 tool result media 收尾）。
 *
 * dsh session log（event-store 桥）才是 durable 真相；引擎 resume 走
 * `persistedMessages` 直传，不读这些 artifact。它们只用于满足引擎在同一进程内
 * `persistToolResultMediaAttachments` 的收尾要求（缺 store 时引擎会拒绝含图工具
 * 结果）。因此这里用进程内 Map，不复制字节到第二份持久化存储。
 */
export function createInMemoryToolArtifactStore(): ToolArtifactStorePort {
  let nextId = 0;
  const records = new Map<string, { content: string; contentType: string; createdAt: Date }>();
  return {
    async writeToolResultArtifact(request: ToolArtifactWriteRequest): Promise<ToolArtifactWriteResult> {
      const id = `zcode-loop-artifact-${++nextId}`;
      const uri = `zcode-artifact://zcode-loop/${id}`;
      const createdAt = new Date();
      const contentType = request.contentType ?? "text/plain";
      records.set(uri, { content: request.content, contentType, createdAt });
      return {
        id,
        uri,
        bytes: Buffer.byteLength(request.content, "utf8"),
        contentType,
        createdAt,
      };
    },
    async readToolResultArtifact(request: ToolArtifactReadRequest): Promise<ToolArtifactReadResult> {
      const record = records.get(request.uri);
      if (record === undefined) throw new Error(`tool artifact "${request.uri}" is not available`);
      return {
        uri: request.uri,
        content: record.content,
        contentType: record.contentType,
        bytes: Buffer.byteLength(record.content, "utf8"),
      };
    },
    async statToolResultArtifact(request: ToolArtifactStatRequest): Promise<ToolArtifactStatResult> {
      const record = records.get(request.uri);
      if (record === undefined) throw new Error(`tool artifact "${request.uri}" is not available`);
      return {
        uri: request.uri,
        bytes: Buffer.byteLength(record.content, "utf8"),
        contentType: record.contentType,
        mtimeMs: record.createdAt.getTime(),
      };
    },
    // 不把 artifact 映射成执行世界路径：模型请求只需要 dataUrl/引用文本，
    // 路径物化是可选增强（引擎对此有 unsupported 分支）。
    async ensureMediaAttachmentPath() {
      return { status: "unsupported" as const };
    },
  };
}

/**
 * 直通 permission broker：一切请求放行（decision "allow"）。
 * 把关责任交给 dsh 工具管线（tools/pre-execute waterfall 等）——桥接工具的
 * `needsApproval:false` 元数据使引擎不发起权限交互，本 broker 只是引擎面的
 * 显式 allow 直通，不做任何决策。
 */
export function createAllowThroughPermissionBroker(): PermissionBrokerPort {
  return {
    requestPermission: (_request) => {
      const result: PermissionBrokerResult = { decision: "allow", reason: "dsh pipeline owns gating" };
      return Object.assign(Promise.resolve(result), { registered: Promise.resolve() });
    },
  };
}
