/**
 * attachment-bridge — dsh attachment 存储与引擎媒体内容之间的唯一转换点。
 *
 * dsh 的 durable 事实只存 attachment 引用（ImageBlock/FileBlock）；引擎模型内容
 * 需要 `dataUrl` 或可读路径。本桥负责：
 *
 * - 读取：dsh 引用 → `readImage` 校验字节 → dataUrl（用户图片、工具结果图片、
 *   冷恢复水合共用）；file 引用 → 宿主只读路径（dsh `fileHostPath`），没有路径
 *   时保留引用文本。
 * - 写回：引擎图片块 → dsh 存储 `saveImage` → ImageBlock（引擎 standalone 路径
 *   或非 dsh 来源请求需要；主循环请求以 dsh session 派生消息为准）。
 * - 用户输入：`UserMessage` 的 image 块解析成引擎 `TurnAttachment`（executeTurn/
 *   steerTurn 的宿主图片通道），file 块降为引用文本；无 attachment 服务时对图片
 *   明确抛错，不静默丢弃。
 *
 * 不缓存字节、不改 durable 事件；attachment id 是唯一跨恢复稳定标识。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { ContentBlock, ImageBlock, UserMessage } from "@deepseek-ai/dsh-llm";

import type {
  ModelImageContentBlock,
  TurnAttachment,
} from "../engine-facade.js";

/** dsh 接受的图片 mediaType（attachment-local 的准入词表）。 */
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** 稳定 attachment digest（`sha256:<hex>` → `<hex>`；其它 id 原样）。 */
export function attachmentDigest(id: string): string {
  return id.startsWith("sha256:") ? id.slice("sha256:".length) : id;
}

/** data URL → 字节；非 canonical base64 直接报错（不猜测编码）。 */
export function decodeDataUrl(dataUrl: string): { mediaType: string; data: Uint8Array } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (match === null) throw new Error("image data URL is not canonical base64");
  return { mediaType: match[1]!.toLowerCase(), data: Buffer.from(match[2]!, "base64") };
}

export interface AttachmentMediaBridge {
  /** 是否挂载了 dsh attachment 服务；缺席时图片通路明确失败。 */
  readonly available: boolean;
  /** 校验并读取图片字节，返回 dataUrl。 */
  imageDataUrl(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<string>;
  /** dsh 图片块 → 引擎图片块（含原始引用身份）。 */
  toEngineImage(block: ImageBlock, signal?: AbortSignal): Promise<ModelImageContentBlock>;
  /** 已 offload 的图片引用 → 模型可见占位文本。 */
  offloadedImageText(ref: ImageAttachmentRef): string;
  /** dsh file 引用 → 引用文本（含可读路径，若可解析）。 */
  filePlaceholder(ref: FileAttachmentRef): string;
  /** dsh file 引用的当前只读路径（缺席时 undefined）。 */
  fileReadPath(ref: FileAttachmentRef): string | undefined;
  /** 引擎图片块 → dsh ImageBlock（字节写入 attachment 存储）。 */
  toDshImage(block: ModelImageContentBlock): Promise<ImageBlock>;
}

function imagePlaceholder(ref: ImageAttachmentRef): string {
  const name = ref.name === undefined ? "" : ` name=${ref.name}`;
  return `[image ${ref.mediaType} attachmentId=${ref.attachmentId} bytes=${ref.bytes} ${ref.width}x${ref.height}${name}]`;
}

export function createAttachmentMediaBridge(ctx: Context): AttachmentMediaBridge {
  // ctx.get 而不是 ctx.attachments：服务缺席时要能走明确降级/报错，不能抛属性错误。
  const store = ctx.get("attachments") as AttachmentStore | undefined;

  return {
    available: store !== undefined,

    async imageDataUrl(ref, signal) {
      if (store === undefined) {
        throw new Error(`image attachment ${ref.attachmentId} cannot be read: dsh attachment service is not mounted`);
      }
      const stored = await store.readImage(ref, signal);
      return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`;
    },

    async toEngineImage(block, signal) {
      const dataUrl = await this.imageDataUrl(block.attachment, signal);
      const ref = block.attachment;
      const digest = attachmentDigest(String(ref.attachmentId));
      return {
        type: "image",
        mediaType: ref.mediaType,
        dataUrl,
        source: {
          id: String(ref.attachmentId),
          kind: "inline",
          uri: `dsh-attachment:${ref.attachmentId}`,
          mimeType: ref.mediaType,
          sizeBytes: ref.bytes,
          sha256: digest,
        },
      };
    },

    offloadedImageText(ref) {
      return `[image offloaded ${ref.mediaType} attachmentId=${ref.attachmentId} bytes=${ref.bytes} ${ref.width}x${ref.height}]`;
    },

    filePlaceholder(ref) {
      let path: string | undefined;
      try {
        path = store?.fileHostPath(ref);
      } catch {
        path = undefined;
      }
      const location = path === undefined ? "" : ` path=${path}`;
      return `[file ${ref.name} attachmentId=${ref.attachmentId} bytes=${ref.bytes}${location}]`;
    },

    fileReadPath(ref) {
      try {
        return store?.fileHostPath(ref);
      } catch {
        return undefined;
      }
    },

    async toDshImage(block) {
      if (store === undefined) {
        throw new Error("engine image content cannot be routed: dsh attachment service is not mounted");
      }
      const { mediaType, data } = decodeDataUrl(block.dataUrl);
      if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
        throw new Error(`unsupported image media type "${mediaType}"`);
      }
      const ref = await store.saveImage({
        data,
        mediaType: mediaType as ImageAttachmentRef["mediaType"],
      });
      return { type: "image", attachment: ref };
    },
  };
}

/** 一批用户消息的引擎输入：文本 + 宿主图片通道附件。 */
export interface DshUserInput {
  text: string;
  attachments: TurnAttachment[];
}

/**
 * 把 dsh 用户消息转成引擎 `executeTurn`/`steerTurn` 输入。
 * 图片只走 attachments（durable 引用仍由 dsh 事件保留）；file/其它块保留文本占位。
 */
export async function buildDshUserInput(
  messages: readonly UserMessage[],
  media: AttachmentMediaBridge | undefined,
  signal?: AbortSignal,
): Promise<DshUserInput> {
  const parts: string[] = [];
  const attachments: TurnAttachment[] = [];
  for (const message of messages) {
    const texts: string[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          if (block.text.length > 0) texts.push(block.text);
          break;
        case "image": {
          // offloaded 是 dsh 的请求投影事实；消息本体仍可能被再次投递，按占位保留。
          if (block.offloaded === true) {
            texts.push(media?.offloadedImageText(block.attachment)
              ?? imagePlaceholder(block.attachment));
            break;
          }
          if (media === undefined || !media.available) {
            throw new Error(
              `user image attachment ${block.attachment.attachmentId} cannot be delivered: dsh attachment service is not mounted`,
            );
          }
          const content = await media.imageDataUrl(block.attachment, signal);
          attachments.push({
            type: "image",
            content,
            mimeType: block.attachment.mediaType,
            ...(block.attachment.name === undefined ? {} : { filename: block.attachment.name }),
            sizeBytes: block.attachment.bytes,
          });
          break;
        }
        case "file":
          texts.push(media?.filePlaceholder(block.attachment)
            ?? `[file ${block.attachment.name} attachmentId=${block.attachment.attachmentId} bytes=${block.attachment.bytes}]`);
          break;
        default:
          // reasoning 不属于用户可见文本；merge-extensible 块保留可读占位，不静默丢。
          if (block.type === "reasoning") texts.push(block.text);
          else texts.push(`[${String((block as ContentBlock).type)} content]`);
          break;
      }
    }
    if (texts.length > 0) parts.push(texts.join("\n"));
  }
  return { text: parts.join("\n\n"), attachments };
}
