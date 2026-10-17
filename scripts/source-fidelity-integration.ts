/**
 * source 保真集成自证脚本（阶段 8a：user/message source 投影保真 + 压缩门回归护栏）：
 *
 * 装配与 pipeline 脚本同款（fake llm adapter + **不装** stock agent-loop；本脚本无工具
 * AC，不注册 dsh 工具，仅挂 ToolRuntime 服务）；慢速 adapter（25ms/字符）给
 * steering 留注入窗口（steer-probe 先例）。
 *
 * - AC1 正常路径 source 保真：followup 一条 source 为
 *   `{kind:"scheduler", name:"probe-scheduler"}` 的 createUserMessage → turn
 *   完成 → dsh log 里该 user/message 的 `data.source` 原样保留（不再被改写为
 *   `{kind:"user"}`）。kind 走 dsh `MessageSourceMap` 的 merge-extensible 机制
 *   在本文件声明 "scheduler"（与 dsh-goal 声明 "goal"、webhook 声明 "webhook"
 *   同一 producer 自declare 模式）。
 * - AC2 steering 路径 source 保真：turn 进行中（慢速 adapter）steer 一条非
 *   user source 消息 → log 中 steering 的 user/message 保留原 source，且不开
 *   新 turn（同轮 guide）；同 turn 的人类 followup 消息仍投影 `{kind:"user"}`。
 * - AC3 压缩门单元：直接构造 EventStoreBridge（fake session 记录器 + 记录型
 *   logger），喂 `turn_started` → `compact_started` → `model_request`（sidecar
 *   摘要请求）→ `model_complete` → `compact_completed` → `turn_complete`，断言
 *   sidecar 的 model 事件不产生任何 surface 节点（无 assistant/message）、
 *   logger.warn 记到 compact_started/completed、dropStats 计入丢弃。
 * - AC4 人类轮不回归：普通 followup（`{kind:"user"}` source）投影仍为
 *   `{kind:"user"}`、文本一致。
 */
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createUserMessage, LlmAdapter } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import type { Session as DshSession, SessionEvent as DshSessionEvent } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import { DshSessionEventStoreBridge } from "../src/bridges/event-store-bridge.js";
import type { Logger, SessionEvent } from "../src/engine-facade.js";
import ZcodeLoop from "../src/index.js";

// 本 probe 的非人类 producer source 声明（merge-extensible sum type，producer
// 在自己模块 declare 自己的 kind——reference dsh-goal/tool-goal 同款）。
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    scheduler: { kind: "scheduler"; name: string };
  }
}

// ------------------------------------------------------------------
// 慢速 fake llm adapter（照抄 steer-probe：每字符 chunk 间隔 25ms）
// ------------------------------------------------------------------

class SlowScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  /** 第 i 个请求的流开跑信号（等对应流真正启动后再 steer，避免竞态）。 */
  readonly streamStarted: PromiseWithResolvers<void>[] = [];

  constructor(private readonly script: StreamChunk[][]) {
    super();
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const chunks = this.script.shift();
    if (!chunks) throw new Error("SlowScriptedAdapter: script exhausted");
    const started = Promise.withResolvers<void>();
    this.streamStarted.push(started);
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error("aborted");
      started.resolve();
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield chunk;
    }
  }
}

function slowTextChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    ...Array.from(text, (char): StreamChunk => ({ type: "text-delta", index: 0, text: char })),
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

// ------------------------------------------------------------------
// 断言（pipeline 脚本同款）
// ------------------------------------------------------------------

function fail(message: string): never {
  console.error(`[source-fidelity] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

// ------------------------------------------------------------------
// log 读取助手（user/message 的 data 直接是消息体，见 steer-probe）
// ------------------------------------------------------------------

type UserMessageEvent = Extract<DshSessionEvent, { type: "user/message" }>;

function userMessagesOf(events: readonly DshSessionEvent[]): UserMessageEvent[] {
  return events.filter(
    (event): event is UserMessageEvent => event.type === "user/message",
  );
}

function messageText(content: readonly { type: string; text?: string }[]): string {
  return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

function findUserMessage(events: readonly DshSessionEvent[], text: string): UserMessageEvent {
  const found = userMessagesOf(events).find((event) => messageText(event.data.content) === text);
  if (found === undefined) {
    const texts = userMessagesOf(events).map((event) => messageText(event.data.content));
    fail(`user/message with text ${JSON.stringify(text)} not found, log has: ${JSON.stringify(texts)}`);
  }
  return found;
}

// ------------------------------------------------------------------
// AC3 用 fake 装配件：记录型 session + 记录型 logger
// ------------------------------------------------------------------

interface FakeAppendRecord {
  type: string;
  data: unknown;
}

function createFakeSession(): { appends: FakeAppendRecord[]; session: DshSession } {
  const appends: FakeAppendRecord[] = [];
  const fake = {
    append(type: string, data: unknown): { seq: number } {
      appends.push({ type, data });
      return { seq: appends.length };
    },
    snapshotEvents(): unknown[] {
      return [];
    },
  };
  return { appends, session: fake as unknown as DshSession };
}

class RecordingLogger {
  readonly warns: { message: string; context?: unknown }[] = [];
  debug(): void {}
  info(): void {}
  warn(message: string, context?: unknown): void {
    this.warns.push({ message, context });
  }
  error(): void {}
  child(): RecordingLogger {
    return this;
  }
}

let probeSeq = 0;

function engineEvent(type: string, payload: unknown): SessionEvent {
  probeSeq += 1;
  return {
    id: `source-fidelity-probe-${String(probeSeq)}` as SessionEvent["id"],
    sessionId: "compact-gate-probe" as SessionEvent["sessionId"],
    type: type as SessionEvent["type"],
    timestamp: new Date(),
    traceId: "source-fidelity-probe" as SessionEvent["traceId"],
    sequenceNumber: 0,
    payload,
  };
}

async function main(): Promise<void> {
  // ---- dsh 侧装配（pipeline 脚本同款）----
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ZcodeLoop, { provider: "mock", model: "mock" });

  // 4 个模型请求：turn1（AC1）+ turn2 首请求与转向后请求（AC2）+ turn3（AC4）。
  const adapter = new SlowScriptedAdapter([
    slowTextChunks("ack one"),
    slowTextChunks("ack two"),
    slowTextChunks("steered ack"),
    slowTextChunks("ack three"),
  ]);
  ctx.llm.registerAdapter(["mock"], adapter);

  const sessionId = DshSessionId("source-fidelity-zcode-loop");
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: "mock", model: "mock" },
  });
  const agent: Agent = handle.agent;
  const session = agent.session;

  // ---- AC1：正常路径 source 保真（claim 批逐条落原消息对象）----
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: "producer says hi" }],
      source: { kind: "scheduler", name: "probe-scheduler" },
    }),
  );
  await agent.whenIdle();
  const log1 = session.snapshotEvents();
  const ac1Event = findUserMessage(log1, "producer says hi");
  const ac1Source = ac1Event.data.source;
  if (ac1Source.kind !== "scheduler") {
    fail(`AC1: source.kind must stay "scheduler", got ${JSON.stringify(ac1Source)}`);
  }
  assert(
    ac1Source.name === "probe-scheduler",
    `AC1: source.name must survive projection, got ${JSON.stringify(ac1Source)}`,
  );
  console.log("[source-fidelity] AC1 producer source preserved: {kind:scheduler, name:probe-scheduler} ✓");

  // ---- AC2：steering 路径 source 保真（busy 时 steerActive 落原消息对象）----
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: "write slowly please" }],
      source: { kind: "user" },
    }),
  );
  while (adapter.streamStarted[1] === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await adapter.streamStarted[1]!.promise;
  assert(agent.status === "running", `agent must be running mid-turn, got ${agent.status}`);
  agent.steer(
    createUserMessage({
      content: [{ type: "text", text: "mid-turn steer from scheduler" }],
      source: { kind: "scheduler", name: "probe-scheduler" },
    }),
  );
  await agent.whenIdle();
  const log2 = session.snapshotEvents();
  // 转向在同轮内生效：第二个模型请求携带转向文本（guide 内联当前轮，不切轮）。
  assert(
    adapter.requests.length >= 3,
    `steer should trigger a second model request in-turn, got ${String(adapter.requests.length)}`,
  );
  const steeredRequest = adapter.requests[2]!;
  assert(
    JSON.stringify(steeredRequest.messages).includes("mid-turn steer from scheduler"),
    `post-steer request must carry the steering text, got: ${JSON.stringify(steeredRequest.messages).slice(0, 400)}`,
  );
  // steering 的 user/message 保留原 producer source（不再被改写为 {kind:"user"}）。
  const steerEvent = findUserMessage(log2, "mid-turn steer from scheduler");
  const steerSource = steerEvent.data.source;
  if (steerSource.kind !== "scheduler") {
    fail(`AC2: steering source.kind must stay "scheduler", got ${JSON.stringify(steerSource)}`);
  }
  assert(
    steerSource.name === "probe-scheduler",
    `AC2: steering source.name must survive, got ${JSON.stringify(steerSource)}`,
  );
  // steer 不开新 turn（同轮 guide）；同 turn 的人类 followup 投影不受影响。
  const turnStarts = log2.filter((event) => event.type === "turn/start");
  assert(turnStarts.length === 2, `steer must not open a new turn, got ${String(turnStarts.length)} turn/start`);
  const turn2Human = findUserMessage(log2, "write slowly please");
  assert(
    turn2Human.data.source.kind === "user",
    `human followup in the steered turn must still project {kind:"user"}, got ${JSON.stringify(turn2Human.data.source)}`,
  );
  console.log("[source-fidelity] AC2 steering source preserved + no new turn + human turn unaffected ✓");

  // ---- AC4：人类轮不回归（默认人类 source 投影逐字节同修复前）----
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: "plain human followup" }],
      source: { kind: "user" },
    }),
  );
  await agent.whenIdle();
  const ac4Event = findUserMessage(session.snapshotEvents(), "plain human followup");
  assert(
    ac4Event.data.source.kind === "user"
      && JSON.stringify(ac4Event.data.source) === JSON.stringify({ kind: "user" }),
    `AC4: human turn must project exactly {kind:"user"}, got ${JSON.stringify(ac4Event.data.source)}`,
  );
  assert(
    messageText(ac4Event.data.content) === "plain human followup",
    `AC4: human turn text must survive verbatim, got ${JSON.stringify(messageText(ac4Event.data.content))}`,
  );
  console.log("[source-fidelity] AC4 human turn regression: {kind:user} + verbatim text ✓");

  // ---- AC3：压缩门单元（直接构造 EventStoreBridge，不跑完整插件）----
  const { appends, session: fakeSession } = createFakeSession();
  const probeLogger = new RecordingLogger();
  const probeBridge = new DshSessionEventStoreBridge({
    session: fakeSession,
    logger: probeLogger as unknown as Logger,
  });
  // turn_started 开场（桥 requireTurn 需要已开的 turn），再进压缩 sidecar 序列。
  await probeBridge.append(engineEvent("turn_started", { turnNumber: 0, input: "human turn before compaction" }));
  await probeBridge.append(engineEvent("compact_started", { reason: "probe" }));
  await probeBridge.append(
    engineEvent("model_request", {
      messages: [
        { role: "system", content: "Summarize the conversation so far." },
        { role: "user", content: "Summarize this session." },
      ],
      providerId: "mock",
      modelId: "mock",
    }),
  );
  await probeBridge.append(
    engineEvent("model_complete", { content: "sidecar summary text", stopReason: "stop" }),
  );
  await probeBridge.append(engineEvent("compact_completed", { summarizedEvents: 10 }));
  await probeBridge.append(engineEvent("turn_complete", { response: "done" }));

  // (a) sidecar 摘要不污染 surface：无 assistant/message，turn 骨干仍正常落。
  const surfaceTypes = appends.map((record) => record.type);
  assert(
    !surfaceTypes.includes("assistant/message"),
    `AC3: sidecar summary must not create assistant/message, got ${JSON.stringify(surfaceTypes)}`,
  );
  assert(
    surfaceTypes.includes("turn/start") && surfaceTypes.includes("turn/end"),
    `AC3: turn skeleton must still be projected, got ${JSON.stringify(surfaceTypes)}`,
  );
  // (b) compact_started / compact_completed 都经 logger 镜像。
  assert(
    probeLogger.warns.some((entry) => entry.message.includes("compact_started")),
    `AC3: compact_started must be logger-mirrored, got ${JSON.stringify(probeLogger.warns)}`,
  );
  assert(
    probeLogger.warns.some((entry) => entry.message.includes("compact_completed")),
    `AC3: compact_completed must be logger-mirrored, got ${JSON.stringify(probeLogger.warns)}`,
  );
  // (c) dropStats：压缩门丢弃计数可见（compact_started/completed + 两类 model 事件）。
  const stats = probeBridge.dropStats();
  assert(
    stats.dropped >= 3,
    `AC3: compact-gated sequence must count >=3 drops, got ${JSON.stringify(stats)}`,
  );
  assert(
    (stats.droppedByType.model_request ?? 0) >= 1 && (stats.droppedByType.model_complete ?? 0) >= 1,
    `AC3: sidecar model events must be dropped-and-counted, got ${JSON.stringify(stats.droppedByType)}`,
  );
  console.log(
    `[source-fidelity] AC3 compact gate: surface=${JSON.stringify(surfaceTypes)}, warns=${String(probeLogger.warns.length)}, drops=${String(stats.dropped)} (${JSON.stringify(stats.droppedByType)}) ✓`,
  );

  await handle.dispose();
  console.log("[source-fidelity] PASS: AC1-AC4 all green (source fidelity + steering + compact gate + human regression)");
  process.exit(0);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
