/**
 * T14 附件与媒体集成自证。
 *
 * 复用真实 npm dsh 插件（attachment-local / compaction / token-meter）与生产
 * 嵌入 loop，逐项覆盖：
 * a. 用户图片：dsh image 引用 → 引擎 executeTurn 附件通道 → 下一请求 image 块；
 *    durable user/message 保留 ref，字节可严格读回。
 * b. 工具结果图片：工具返回 image 块 → 下一请求含图片；durable tool/result 保留 ref；
 *    引擎 formatModelContent 拿到 dataUrl 图片块。
 * c. 恢复/fork：含图 JSONL 冷恢复与 seeded fork 的请求仍含图，字节可重读。
 * d. offload：真实 compaction + image-offload，请求改发占位文本，durable ref 仍可读。
 * e. 不支持路由：adapter 显式 inputModalities=["text"] → dsh 文本占位，不静默。
 * f. 文件引用：durable file ref 保真，请求投影为 handle 文本，readFileStream 可读。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import LocalAttachmentStore from "@deepseek-ai/dsh-attachment-local";
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  offloadedImageText,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { ContentBlock, GenerateOptions, StreamChunk, UserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";

import ZcodeLoop from "../src/index.js";
import { createAttachmentMediaBridge } from "../src/bridges/attachment-bridge.js";
import { mapDshToolContent } from "../src/bridges/tool-bridge.js";
import { installedRequire } from "./contract-verification/oracle.js";

const loadPlugin = async (name: string): Promise<Plugin> =>
  (await import(pathToFileURL(installedRequire.resolve(name)).href)).default as Plugin;

const tokenMeter = await loadPlugin("@deepseek-ai/dsh-token-meter");
const compaction = await loadPlugin("@deepseek-ai/dsh-compaction-basic");
const imageOffloadModule = await import(
  pathToFileURL(installedRequire.resolve("@deepseek-ai/dsh-compaction-image-offload")).href
);
const imageOffload = imageOffloadModule as unknown as Plugin;

/** 1x1 RGBA PNG（attachment-local 会校验并归一化）。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type Step = StreamChunk[] | ((request: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>);

interface CapturedImage {
  ref: ImageAttachmentRef;
  role: string;
  offloaded: boolean;
  dataUrl?: string;
  bytes?: Uint8Array;
}

interface Capture {
  request: GenerateOptions;
  images: CapturedImage[];
}

class MediaAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly captures: Capture[] = [];
  readonly steps: Step[] = [];
  offloadFirstImage = false;

  constructor(private readonly attachments: AttachmentStore) {
    super();
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
      defaultMaxTokens: 256,
      // text-only 路由显式声明负能力；其余路由声明 image 输入。
      inputModalities: model === "text-only" ? ["text"] as const : ["text", "image"] as const,
    });
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const images: CapturedImage[] = [];
    for (const message of request.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type !== "image") continue;
        if (block.offloaded === true) {
          images.push({ ref: block.attachment, role: message.role, offloaded: true });
          continue;
        }
        // dsh image-capable adapter 的真实读取路径：验证并读回 durable 字节。
        const stored = await this.attachments.readImage(block.attachment);
        images.push({
          ref: block.attachment,
          role: message.role,
          offloaded: false,
          bytes: stored.data,
          dataUrl: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}`,
        });
      }
    }
    this.captures.push({ request, images });

    if (this.offloadFirstImage && images.some((image) => !image.offloaded)) {
      this.offloadFirstImage = false;
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: { code: "IMAGE_OFFLOAD_REQUIRED", message: "image request budget exceeded", offloadImages: 1 },
        },
      };
      return;
    }

    const step = this.steps.shift();
    assert(step, "MediaAdapter: script exhausted");
    const chunks = typeof step === "function" ? await step(request) : step;
    for (const chunk of chunks) {
      if (request.signal?.aborted) throw new Error("aborted");
      yield chunk;
    }
  }
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

function toolCallChunks(id: string, name: string): StreamChunk[] {
  const argumentsJson = "{}";
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    {
      type: "tool-call-delta",
      index: 0,
      id: ToolCallId(id),
      name,
      argumentsDelta: argumentsJson,
    },
    {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id: ToolCallId(id), name, arguments: argumentsJson },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

interface MountOptions {
  dshHome: string;
  persistenceRoot?: string;
  compaction?: boolean;
  imageOffload?: boolean;
}

async function mount(options: MountOptions) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjection);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(LocalAttachmentStore, { dshHome: options.dshHome });
  if (options.persistenceRoot !== undefined) {
    await ctx.plugin(Jsonl, { root: options.persistenceRoot, compression: "none" });
  }
  if (options.compaction === true) {
    await ctx.plugin(tokenMeter);
    await ctx.plugin(compaction, {
      auto: false,
      headroomTokens: 100,
      maxTokens: 256,
      thresholdRatio: 0.99,
      retainTokens: 0,
      summarizationProvider: "media",
      summarizationModel: "summary",
    });
  }
  if (options.imageOffload === true) await ctx.plugin(imageOffload);
  const adapter = new MediaAdapter(ctx.attachments);
  ctx.llm.registerAdapter(["media"], adapter);
  await ctx.plugin(ZcodeLoop, { provider: "media", model: "vision" });
  return { ctx, adapter };
}

function userImageMessage(ref: ImageAttachmentRef, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: "image", attachment: ref }, { type: "text", text }],
    source: { kind: "user" },
  });
}

function userFileMessage(ref: FileAttachmentRef, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: "file", attachment: ref }, { type: "text", text }],
    source: { kind: "user" },
  });
}

async function saveProbeImage(ctx: Context, name: string): Promise<ImageAttachmentRef> {
  return await ctx.attachments.saveImage({ data: PNG, mediaType: "image/png", name });
}

function durableUserMessages(handle: AgentHandle) {
  return handle.agent.session.snapshotEvents().filter((event) => event.type === "user/message");
}

function assertDataUrl(dataUrl: string | undefined, ref: ImageAttachmentRef): void {
  assert(dataUrl?.startsWith(`data:${ref.mediaType};base64,`), `adapter must receive ${ref.mediaType} dataUrl`);
}

async function runLiveMedia(dshHome: string): Promise<void> {
  const { ctx, adapter } = await mount({ dshHome });
  let handle: AgentHandle | undefined;
  try {
    const image = await saveProbeImage(ctx, "user.png");
    // 工具结果图片使用另一份同字节引用（content-addressed 去重由 store 负责）。
    const toolImage = await saveProbeImage(ctx, "tool.png");
    let toolOutput: unknown;
    ctx.tools.register(defineTool({
      name: "vision_probe",
      description: "return an image block",
      parameters: {},
      output: {
        schema: { type: "object", additionalProperties: true },
        render: () => [
          { type: "image", attachment: toolImage },
          { type: "text", text: "TOOL_IMAGE_DONE" },
        ] as ContentBlock[],
      },
      execute: async () => {
        toolOutput = {};
        return {};
      },
    }));
    handle = await ctx.agents.create({ sessionId: SessionId("media-live") });
    const agent = handle.agent;

    // a. 用户图片
    adapter.steps.push(textChunks("USER_IMAGE_SEEN"));
    agent.followup(userImageMessage(image, "describe this image"));
    await agent.whenIdle();

    const userMessages = durableUserMessages(handle);
    assert.equal(userMessages.length, 1);
    const durableUser = userMessages[0]!;
    assert(durableUser.type === "user/message");
    const durableImage = durableUser.data.content.find((block) => block.type === "image");
    assert(durableImage?.type === "image", "durable user/message must keep the image ref");
    assert.equal(durableImage.attachment.attachmentId, image.attachmentId);
    assert.equal(adapter.captures.length, 1);
    const firstCapture = adapter.captures[0]!;
    assert.equal(firstCapture.images.length, 1);
    assert.equal(firstCapture.images[0]!.role, "user");
    assert.equal(firstCapture.images[0]!.offloaded, false);
    assertDataUrl(firstCapture.images[0]!.dataUrl, image);
    const stored = await ctx.attachments.readImage(image);
    assert.deepEqual(Buffer.from(firstCapture.images[0]!.bytes!), Buffer.from(stored.data));

    // b. 工具结果图片：引擎的同步格式化接缝必须拿到 dataUrl 图片块。
    const mediaBridge = createAttachmentMediaBridge(ctx);
    const toolBlocks: ContentBlock[] = [
      { type: "image", attachment: toolImage },
      { type: "text", text: "TOOL_IMAGE_DONE" },
    ];
    const mapped = await mapDshToolContent(toolBlocks, mediaBridge);
    assert(Array.isArray(mapped), "tool result model content must be structured");
    assert.equal(mapped[0]?.type, "image");
    assertDataUrl(mapped[0]?.type === "image" ? mapped[0].dataUrl : undefined, toolImage);

    adapter.steps.push(toolCallChunks("tool-image-call", "vision_probe"), textChunks("TOOL_IMAGE_SEEN"));
    agent.followup(createUserMessage({ content: [{ type: "text", text: "run the vision tool" }], source: { kind: "user" } }));
    await agent.whenIdle();

    const toolResult = agent.session.snapshotEvents().find((event) => event.type === "tool/result");
    assert(toolResult?.type === "tool/result", "expected durable tool/result");
    const durableToolImage = toolResult.data.message.content.find((block) => block.type === "image");
    assert(durableToolImage?.type === "image", "durable tool/result must keep the image ref");
    assert.equal(durableToolImage.attachment.attachmentId, toolImage.attachmentId);
    const toolCapture = adapter.captures.at(-1)!;
    const toolImageCapture = toolCapture.images.find((candidate) => candidate.role === "tool");
    assert(toolImageCapture, "next model request must carry the tool image");
    assert.equal(toolImageCapture.offloaded, false);
    assertDataUrl(toolImageCapture.dataUrl, toolImage);
    assert(toolOutput !== undefined, "tool executed through the dsh pipeline");

    console.log("[attachments-media] PASS a/b: live user + tool-result images reach the adapter and durable refs");
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}

async function runResumeAndFork(dshHome: string, persistenceRoot: string): Promise<void> {
  const id = SessionId("media-resume");
  const first = await mount({ dshHome, persistenceRoot });
  let handle: AgentHandle | undefined;
  try {
    const image = await saveProbeImage(first.ctx, "resume.png");
    handle = await first.ctx.agents.create({ sessionId: id });
    first.adapter.steps.push(textChunks("RESUME_SEED_SEEN"));
    handle.agent.followup(userImageMessage(image, "remember this image"));
    await handle.agent.whenIdle();
    await first.ctx.sessions.flush(handle.agent.session);
    assert.equal(first.adapter.captures[0]!.images.length, 1);
    await handle.dispose();
    handle = undefined;
    await first.ctx.fiber.dispose();

    // c1. 冷恢复：同一 DSH_HOME 的 attachment 存储 + JSONL 会话。
    const resumed = await mount({ dshHome, persistenceRoot });
    let resumedHandle: AgentHandle | undefined;
    let forkedHandle: AgentHandle | undefined;
    try {
      resumedHandle = await resumed.ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: "media", model: "vision" },
      });
      resumed.adapter.steps.push(textChunks("RESUMED_IMAGE_SEEN"));
      resumedHandle.agent.followup(createUserMessage({
        content: [{ type: "text", text: "what did I show you?" }],
        source: { kind: "user" },
      }));
      await resumedHandle.agent.whenIdle();
      const resumedCapture = resumed.adapter.captures.at(-1)!;
      assert.equal(resumedCapture.images.length, 1, "resumed request must still carry the image");
      const resumedImage = resumedCapture.images[0]!;
      assert.equal(resumedImage.offloaded, false);
      assertDataUrl(resumedImage.dataUrl, image);
      assert.deepEqual(
        Buffer.from(resumedImage.bytes!),
        Buffer.from(await resumed.ctx.attachments.readImage(image).then((stored) => stored.data)),
        "cold resume must read the same durable bytes",
      );
      const resumedDurableImage = durableUserMessages(resumedHandle)[0];
      assert(resumedDurableImage?.type === "user/message");
      assert.equal(
        resumedDurableImage.data.content.find((block) => block.type === "image")?.type,
        "image",
      );

      // c2. fork 前缀：seeded create 与 resume 共用引擎水合。
      forkedHandle = await resumed.ctx.agents.create({
        sessionId: SessionId("media-fork"),
        seed: resumedHandle.agent.session.snapshotEvents(),
      });
      resumed.adapter.steps.push(textChunks("FORKED_IMAGE_SEEN"));
      forkedHandle.agent.followup(createUserMessage({
        content: [{ type: "text", text: "continue the fork" }],
        source: { kind: "user" },
      }));
      await forkedHandle.agent.whenIdle();
      const forkCapture = resumed.adapter.captures.at(-1)!;
      assert.equal(forkCapture.images.length, 1, "forked request must keep the inherited image");
      assertDataUrl(forkCapture.images[0]!.dataUrl, image);

      console.log("[attachments-media] PASS c: JSONL cold resume + seeded fork keep image bytes and refs");
    } finally {
      await forkedHandle?.dispose();
      await resumedHandle?.dispose();
      await resumed.ctx.fiber.dispose();
    }
  } finally {
    await handle?.dispose();
    await first.ctx.fiber.dispose();
  }
}

async function runOffload(dshHome: string, persistenceRoot: string): Promise<void> {
  const id = SessionId("media-offload");
  const { ctx, adapter } = await mount({
    dshHome,
    persistenceRoot,
    compaction: true,
    imageOffload: true,
  });
  let handle: AgentHandle | undefined;
  try {
    const image = await saveProbeImage(ctx, "offload.png");
    handle = await ctx.agents.create({ sessionId: id });
    const agent = handle.agent;
    // 先制造可压缩的旧历史，再发送图片；真实 compaction 会摘要旧文本。
    adapter.steps.push(textChunks("OLD_FILLER_REPLY"));
    agent.followup(createUserMessage({
      content: [{ type: "text", text: "OLD_FILLER ".repeat(1800) }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();

    adapter.offloadFirstImage = true;
    adapter.steps.push(textChunks("OFFLOADED_IMAGE_SEEN"));
    agent.followup(userImageMessage(image, "inspect the image"));
    await agent.whenIdle();

    // 第一次请求带图触发 IMAGE_OFFLOAD_REQUIRED；插件记录 durable image/offload
    // 后重试，第二次请求只发占位文本。
    assert(adapter.captures.length >= 3, "expected filler + retained image + offloaded retry");
    const retainedCapture = adapter.captures.find((capture) =>
      capture.images.some((candidate) => !candidate.offloaded));
    const offloadedCapture = adapter.captures.at(-1)!;
    assert(retainedCapture, "a request with a retained image must precede offload");
    assert.equal(offloadedCapture.images.length, 1);
    assert.equal(offloadedCapture.images[0]!.offloaded, true);
    assert.equal(offloadedCapture.images[0]!.dataUrl, undefined, "offloaded request must not inline image bytes");
    assert(
      JSON.stringify(offloadedCapture.request.messages).includes("offloaded") ||
        JSON.stringify(offloadedCapture.request.messages).includes("offload"),
      "adapter request must show the offload decision",
    );
    assert(
      agent.session.snapshotEvents().some((event) => (event.type as string) === "image/offload"),
      "durable image/offload decision missing",
    );
    const durableImage = durableUserMessages(handle)
      .flatMap((event) => event.type === "user/message" ? event.data.content : [])
      .find((block) => block.type === "image");
    assert(durableImage?.type === "image", "durable user image ref must survive offload");
    assert.equal(durableImage.attachment.attachmentId, image.attachmentId);
    assert.deepEqual(
      Buffer.from((await ctx.attachments.readImage(image)).data),
      Buffer.from((await ctx.attachments.readImage(durableImage.attachment)).data),
      "offloaded ref must remain readable",
    );

    // 真实 compaction：摘要旧历史，最新图片消息保留；随后请求仍按 offload 占位。
    const engine = ctx.get("compaction") as unknown as {
      compactNow(agent: Agent, signal: AbortSignal): Promise<unknown>;
    };
    adapter.steps.push(textChunks("SUMMARY_KEEP_FACT"));
    await engine.compactNow(agent, new AbortController().signal);
    assert(
      agent.session.snapshotEvents().some((event) => (event.type as string) === "compaction/end"),
      "real compaction transaction missing",
    );
    adapter.steps.push(textChunks("AFTER_COMPACT_SEEN"));
    agent.followup(createUserMessage({
      content: [{ type: "text", text: "after compaction" }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    const afterCompact = adapter.captures.at(-1)!;
    assert.equal(afterCompact.images.length, 0, "compacted request must not reintroduce the offloaded image");
    assert.deepEqual(
      Buffer.from(await ctx.attachments.readImage(image).then((stored) => stored.data)),
      Buffer.from(await ctx.attachments.readImage(durableImage.attachment).then((stored) => stored.data)),
    );

    console.log("[attachments-media] PASS d: durable image offload + real compaction preserve refs");
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}

async function runUnsupportedRoute(dshHome: string): Promise<void> {
  const { ctx, adapter } = await mount({ dshHome });
  let handle: AgentHandle | undefined;
  try {
    const image = await saveProbeImage(ctx, "text-only.png");
    handle = await ctx.agents.create({
      sessionId: SessionId("media-text-only"),
      agentOptions: { provider: "media", model: "text-only" },
    });
    adapter.steps.push(textChunks("TEXT_ONLY_REPLY"));
    handle.agent.followup(userImageMessage(image, "look at this"));
    await handle.agent.whenIdle();
    const capture = adapter.captures.at(-1)!;
    assert.equal(capture.images.length, 0, "text-only route must not receive image blocks");
    const serialized = JSON.stringify(capture.request.messages);
    assert(
      serialized.includes("accepts text only"),
      "text-only route must receive an explicit omission placeholder",
    );
    assert(serialized.includes(String(image.attachmentId).slice(7, 15)), "placeholder must identify the attachment");
    assert(
      durableUserMessages(handle)[0]?.type === "user/message" &&
        durableUserMessages(handle)[0]!.data.content.some((block) => block.type === "image"),
      "durable ref must remain even when the route is text-only",
    );
    console.log("[attachments-media] PASS e: text-only route gets explicit placeholder, never a silent drop");
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}

async function runFileReference(dshHome: string): Promise<void> {
  const { ctx, adapter } = await mount({ dshHome });
  let handle: AgentHandle | undefined;
  try {
    const bytes = Buffer.from("hello from a durable dsh file\n");
    const file = await ctx.attachments.saveFile({ data: bytes, name: "notes.txt" });
    handle = await ctx.agents.create({ sessionId: SessionId("media-file") });
    adapter.steps.push(textChunks("FILE_SEEN"));
    handle.agent.followup(userFileMessage(file, "read the attached file"));
    await handle.agent.whenIdle();

    const capture = adapter.captures.at(-1)!;
    const requestText = JSON.stringify(capture.request.messages);
    assert(requestText.includes("notes.txt"), "file request projection must name the stored file");
    assert(requestText.includes(String(file.bytes)), "file request projection must include byte size");

    const durable = durableUserMessages(handle)[0];
    assert(durable?.type === "user/message");
    const durableFile = durable.data.content.find((block) => block.type === "file");
    assert(durableFile?.type === "file", "durable user/message must keep the file ref");
    assert.equal(durableFile.attachment.attachmentId, file.attachmentId);
    assert.equal(durableFile.attachment.bytes, file.bytes);
    assert.equal(durableFile.attachment.name, "notes.txt");

    const chunks: Buffer[] = [];
    for await (const chunk of ctx.attachments.readFileStream(file)) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes, "file bytes must read back verbatim");
    console.log("[attachments-media] PASS f: durable file ref + handle text + verbatim read");
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}

const root = await mkdtemp(join(tmpdir(), "dsh-media-"));
const dshHome = join(root, "home");
const persistenceRoot = join(root, "sessions");
try {
  await runLiveMedia(dshHome);
  await runResumeAndFork(dshHome, persistenceRoot);
  await runOffload(dshHome, persistenceRoot);
  await runUnsupportedRoute(dshHome);
  await runFileReference(dshHome);
  console.log("[attachments-media] PASS: a-f");
} finally {
  await rm(root, { recursive: true, force: true });
}
