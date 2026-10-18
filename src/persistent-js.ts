/**
 * 持久 JavaScript dsh 工具（把引擎公开的 NodeReplSession 经门面包进 dsh 管线）。
 *
 * 语义边界：
 * - 每个 live dsh agent/session 一个 NodeReplSession；工具注册在该 agent 的
 *   scoped ctx 上，状态（globalThis / 顶层声明）只在本会话内持久，跨会话不共享。
 * - 所有调用都由调用方经 `ctx.tools.execute` 进入 dsh 管线（pre-execute /
 *   timeout / post-execute 均不旁路），本插件只提供工具定义与执行体。
 * - `nodeRepl.emitImage` 的图片在 execute 阶段写入 dsh attachment 存储，render
 *   产出 image 内容块（T14 媒体通路）。attachment 服务缺席或写入失败时退化为
 *   显式文本占位并记录降级，不伪造图片数据。
 * - 取消：dsh 调用 signal 与插件生命周期 signal 合并后传给 NodeReplSession.run；
 *   abort 会走引擎的 kernel reset 语义。agent dispose / 插件卸载先中止在途
 *   run、等待其收口，再 dispose kernel（vm 内 timer/interval 一并清理）。
 */
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { AttachmentStore, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";

import { NodeReplSession } from "./engine-facade.js";
import type { NodeReplImage, NodeReplRunResult } from "./engine-facade.js";

/** dsh attachment 接受的图片 mediaType（与 attachment-local 准入词表一致）。 */
const IMAGE_MEDIA_TYPES = new Set<ImageAttachmentRef["mediaType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** NodeRepl 同步执行预算默认值；异步等待由 signal 中止。 */
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const MAX_SYNC_TIMEOUT_MS = 120_000;

export interface PersistentJsConfig {
  /** 工具名（缺省 `js`）。 */
  toolName?: string;
  /** 单次 run 的同步段预算（V8 interrupt）；缺省 30s，上限 120s。 */
  syncTimeoutMs?: number;
  /** 使用受限 process facade（禁止 cell 直接退出进程/写协议 stdout）。 */
  restrictProcess?: boolean;
}

interface JsInput {
  code: string;
  timeout_ms?: number;
}

interface ReplSessionRecord {
  readonly agentId: string;
  readonly session: NodeReplSession;
  readonly lifetime: AbortController;
  readonly pending: Set<Promise<unknown>>;
  unregister?: () => void;
  disposed: boolean;
}

interface ImagePersistResult {
  blocks: ContentBlock[];
  degradedImages: number;
}

/** 工具 canonical value：render 只消费 execute 阶段已写好的块。 */
interface JsCanonicalValue {
  content: ContentBlock[];
  logs: string;
  result?: string;
  error?: { name: string; message: string; stack?: string };
  degradedImages?: number;
  responseMeta?: Record<string, unknown>;
}

function clampTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return Math.min(fallback, MAX_SYNC_TIMEOUT_MS);
  }
  return Math.min(Math.trunc(value), MAX_SYNC_TIMEOUT_MS);
}

function normalizedImageType(value: string): ImageAttachmentRef["mediaType"] | undefined {
  const normalized = value.split(";")[0]?.trim().toLowerCase();
  return normalized !== undefined && IMAGE_MEDIA_TYPES.has(normalized as ImageAttachmentRef["mediaType"])
    ? (normalized as ImageAttachmentRef["mediaType"])
    : undefined;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "persistent JS execution cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * 输出文本与引擎 `formatJsModelContent` 同构：错误头/栈、logs、`=> result`；
 * 没有输出时给出 `(no output)`，不让模型把空结果当成工具失败。
 */
function formatOutputText(result: NodeReplRunResult): string {
  const parts: string[] = [];
  if (result.error !== undefined) {
    const header = `${result.error.name}: ${result.error.message}`;
    parts.push(header);
    if (result.error.stack !== undefined) {
      const frames = result.error.stack.startsWith(`${header}\n`)
        ? result.error.stack.slice(header.length + 1).trimEnd()
        : result.error.stack.split("\n").slice(1).join("\n").trimEnd();
      if (frames.length > 0) parts.push(frames);
    }
  }
  if (result.logs.length > 0) parts.push(result.logs);
  if (result.result !== undefined) parts.push(`=> ${result.result}`);
  return parts.length > 0 ? parts.join("\n") : "(no output)";
}

function textPlaceholder(image: NodeReplImage, reason: string): string {
  return `[image ${image.mimeType} omitted: ${reason}]`;
}

/**
 * 持久 JS 插件（独立 dsh 插件，可单独挂在任意 agent-loop 上）。
 */
export class PersistentJs extends Service {
  static inject = ["tools"];

  private readonly records = new Map<string, ReplSessionRecord>();
  private readonly pendingTeardowns = new Set<Promise<void>>();
  private readonly toolName: string;
  private readonly syncTimeoutMs: number;
  private readonly restrictProcess: boolean;

  constructor(ctx: Context, config: PersistentJsConfig = {}) {
    super(ctx, "persistentJs");
    this.toolName = config.toolName ?? "js";
    this.syncTimeoutMs = clampTimeout(config.syncTimeoutMs, DEFAULT_SYNC_TIMEOUT_MS);
    this.restrictProcess = config.restrictProcess ?? false;

    ctx.on("agent/created", ({ agent }) => {
      this.attach(agent);
    });
    ctx.on("agent/disposed", ({ agent }) => {
      // listener 是 emit 语义（同步返回）；失败必须自行收口，不能留下未处理拒绝。
      const teardown: Promise<void> = this.detach(String(agent.id))
        .catch((error: unknown) => {
          console.error("Persistent JS session teardown failed", error);
        })
        .finally(() => this.pendingTeardowns.delete(teardown));
      this.pendingTeardowns.add(teardown);
    });
    ctx.effect(() => async () => {
      // 先等在途 detach 完成，再统一收口仍存活的记录（插件卸载时 agent 可能还活着）。
      await Promise.allSettled([...this.pendingTeardowns]);
      const records = [...this.records.values()];
      this.records.clear();
      await Promise.allSettled(records.map((record) => this.closeRecord(record)));
    }, "persistentJs.lifecycle()");
  }

  /** 当前持有的 live kernel 数（诊断/探针）。 */
  activeSessionCount(): number {
    return this.records.size;
  }

  /** 等待所有 detach / 在途 run 收口（探针用；不在 agent 生命周期内调用）。 */
  async whenIdle(): Promise<void> {
    while (this.pendingTeardowns.size > 0) {
      await Promise.allSettled([...this.pendingTeardowns]);
    }
    while ([...this.records.values()].some((record) => record.pending.size > 0)) {
      const inFlight = [...this.records.values()].flatMap((record) => [...record.pending]);
      await Promise.allSettled(inFlight);
    }
  }

  private attach(agent: Agent): void {
    const agentId = String(agent.id);
    // resume/clear/compact 的 announce 可能仍触发 created；同一 live agent 只建一个 kernel。
    if (this.records.has(agentId)) return;
    const record: ReplSessionRecord = {
      agentId,
      session: new NodeReplSession({ restrictProcess: this.restrictProcess }),
      lifetime: new AbortController(),
      pending: new Set(),
      disposed: false,
    };
    try {
      record.unregister = agent.ctx.tools.register(this.definition(record));
    } catch (error) {
      record.session.dispose();
      throw error;
    }
    this.records.set(agentId, record);
  }

  private async detach(agentId: string): Promise<void> {
    const record = this.records.get(agentId);
    if (record === undefined) return;
    this.records.delete(agentId);
    await this.closeRecord(record);
  }

  private async closeRecord(record: ReplSessionRecord): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    // 中止在途 run：NodeReplSession 的 AbortSignal race 让 run 结算并 reset kernel。
    record.lifetime.abort(new Error("persistent JS session disposed"));
    await Promise.allSettled([...record.pending]);
    try {
      record.unregister?.();
    } catch {
      // agent scope 可能已先释放；重复注销不是错误。
    }
    record.unregister = undefined;
    record.session.dispose();
  }

  private definition(record: ReplSessionRecord): ToolDefinition {
    return defineTool({
      name: this.toolName,
      description:
        "Run JavaScript in a persistent Node REPL. State (globalThis and top-level declarations) " +
        "persists across calls in this session; different sessions are isolated. Top-level await is " +
        "supported and await importModule('...') loads modules. Return a value or use console.log / " +
        "nodeRepl.write to emit output. Use nodeRepl.emitImage({ base64 | bytes | dataUrl, mimeType }) " +
        "to return an image (for example a screenshot) to the model.",
      parameters: {
        code: {
          type: "string",
          required: true,
          description: "JavaScript code to execute in this session's persistent REPL.",
        },
        timeout_ms: {
          type: "integer",
          description:
            "Optional per-call synchronous execution budget in milliseconds (max 120000). " +
            "Asynchronous work is bounded by the tool cancellation signal.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            content: { type: "array", items: { type: "json" }, required: true },
            logs: { type: "string", required: true },
            result: { type: "string" },
            error: {
              type: "object",
              additionalProperties: true,
              properties: {
                name: { type: "string", required: true },
                message: { type: "string", required: true },
                stack: { type: "string" },
              },
            },
            degradedImages: { type: "integer" },
            responseMeta: { type: "json" },
          },
        },
        render: (_args, value) => value.content as unknown as ContentBlock[],
      },
      timeoutMs: this.syncTimeoutMs,
      // 会话内核有状态、不可并发执行；引擎/管线两侧都按独占调度。
      isConcurrencySafe: () => false,
      execute: async (args, exec) => (await this.run(record, args, exec)) as never,
    });
  }

  private async run(
    record: ReplSessionRecord,
    args: JsInput,
    exec: ToolRunContext,
  ): Promise<JsCanonicalValue> {
    if (record.disposed) throw new Error(`persistent JS session ${record.agentId} is disposed`);
    const signal = AbortSignal.any([exec.signal, record.lifetime.signal]);
    const job = this.runOnce(record, args, exec, signal);
    record.pending.add(job);
    try {
      return await job;
    } finally {
      record.pending.delete(job);
    }
  }

  private async runOnce(
    record: ReplSessionRecord,
    args: JsInput,
    exec: ToolRunContext,
    signal: AbortSignal,
  ): Promise<JsCanonicalValue> {
    const result = await record.session.run(args.code, {
      signal,
      syncTimeoutMs: clampTimeout(args.timeout_ms, this.syncTimeoutMs),
      requestMeta: {
        title: "persistent JavaScript",
        toolCallId: String(exec.callId),
        agentId: record.agentId,
      },
    });
    // run 把 abort 归一成结构化 error；取消必须继续沿 dsh 错误/取消语义上浮，
    // 不能伪装成普通成功输出。
    if (signal.aborted) throw abortReason(signal);

    const persisted = await this.persistImages(result.images ?? [], signal);
    const text = formatOutputText(result);
    const content: ContentBlock[] = [...persisted.blocks];
    if (text.length > 0 || content.length === 0) content.push({ type: "text", text });
    return {
      content,
      logs: result.logs,
      ...(result.result === undefined ? {} : { result: result.result }),
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(persisted.degradedImages === 0 ? {} : { degradedImages: persisted.degradedImages }),
      ...(result.responseMeta === undefined ? {} : { responseMeta: result.responseMeta }),
    };
  }

  private async persistImages(
    images: readonly NodeReplImage[],
    signal: AbortSignal,
  ): Promise<ImagePersistResult> {
    const blocks: ContentBlock[] = [];
    let degradedImages = 0;
    const store = this.ctx.get("attachments") as AttachmentStore | undefined;
    for (const image of images) {
      signal.throwIfAborted();
      const mediaType = normalizedImageType(image.mimeType);
      if (store === undefined) {
        degradedImages += 1;
        blocks.push({
          type: "text",
          text: textPlaceholder(image, "dsh attachment service is not mounted"),
        });
        continue;
      }
      if (mediaType === undefined) {
        degradedImages += 1;
        blocks.push({ type: "text", text: textPlaceholder(image, `unsupported media type ${image.mimeType}`) });
        continue;
      }
      try {
        const attachment = await store.saveImage({
          data: Buffer.from(image.base64, "base64"),
          mediaType,
        });
        blocks.push({ type: "image", attachment });
      } catch (error) {
        degradedImages += 1;
        blocks.push({
          type: "text",
          text: textPlaceholder(
            image,
            `attachment write failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        });
      }
    }
    return { blocks, degradedImages };
  }
}

export default PersistentJs;
