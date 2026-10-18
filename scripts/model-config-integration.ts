/**
 * 模型与必要配置集成探针（T07）：
 *
 * - 缺 adapter：装配不阻塞，首个模型请求显式失败（NO_ADAPTER surfaced，
 *   无静默默认预算请求）。
 * - maxTokens 三层：config.maxOutputTokens（引擎声明上限）> adapter
 *   defaultMaxTokens（无 config 时的声明上限）；dsh AgentOptions.maxTokens
 *   是逐请求上限，在 agent/request waterfall 之后仍生效。
 * - maxTurns/toolConcurrency：Config 透传到 AgentRuntimeConfig（引擎当前
 *   版本不消费 main-loop maxTurns）；maxTurns 由桥准入层实施——超限步按
 *   pre-step 拒绝收口（blocked，零 agent/error），见 3b。
 * - 小窗口：真实 adapter contextWindow → 引擎 preflight 收缩请求预算；
 *   dsh request/context 携带同一窗口值。
 * - 会话换档/恢复：model/selection 改 reasoning effort 影响后续请求；
 *   resume 恢复上次路由（effort 不恢复，dsh adapter default 生效）。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import LlmRuntime, {
  createUserMessage,
  errorChain,
  LlmAdapter,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import ZcodeLoop from "../src/index.js";
import type { ConfigInput } from "../src/index.js";

const EFFORTS = [
  { id: ReasoningEffortId("low"), name: "Low" },
  { id: ReasoningEffortId("high"), name: "High" },
];

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

class ConfigAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly metadata: Partial<LlmResolvedModelInfo> = {}) {
    super();
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, ...this.metadata });
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    yield* textChunks(`reply-${this.requests.length}`);
  }
}

function message(text: string) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(message(text));
  await agent.whenIdle();
}

/** `model/selection` 词表项由 api-session-controller 声明，不在本仓类型面。 */
function appendSelection(
  session: Agent["session"],
  selection: { provider: string; model: string; reasoningEffort?: string },
): void {
  (session.append as unknown as (type: string, data: unknown) => unknown)("model/selection", selection);
}

interface RuntimeView {
  config?: {
    maxTurns?: number;
    toolConcurrency?: { maxConcurrency?: number };
  };
  getSessionModelSelection?: () => {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  } | undefined;
}

/** 探针只读引擎装配结果；运行面没有公开 config getter。 */
function runtimeOf(agent: Agent): RuntimeView {
  return (agent as unknown as { deps?: { runtime?: RuntimeView } }).deps?.runtime ?? {};
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function mount(options: {
  plugin: ConfigInput;
  adapter?: LlmAdapter;
  jsonl?: boolean;
  beforePlugin?: (ctx: Context) => void;
}): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  if (options.jsonl === true) {
    await ctx.plugin(Jsonl, { root: mkdtempSync(join(tmpdir(), "model-config-jsonl-")), compression: "none" });
  }
  if (options.adapter !== undefined) ctx.llm.registerAdapter([options.plugin.provider], options.adapter);
  options.beforePlugin?.(ctx);
  await ctx.plugin(ZcodeLoop, options.plugin);
  return ctx;
}

// ------------------------------------------------------------------
// 1. 缺 adapter：装配不阻塞，首个模型请求显式失败
// ------------------------------------------------------------------
async function missingAdapter(): Promise<void> {
  const ctx = await mount({ plugin: { provider: "missing", model: "m" } });
  let handle: AgentHandle | undefined;
  try {
    // 与 stock 对齐：装配期不因路由不可用而失败。
    handle = await ctx.agents.create({ sessionId: SessionId("model-config-missing-adapter") });
    const errors: unknown[] = [];
    ctx.on("agent/error", ({ error }) => { errors.push(error); });
    await send(handle.agent, "must not reach a silently defaulted request");
    assert.equal(errors.length, 1, "missing adapter must surface exactly one agent/error");
    const failureText = errorChain(errors[0]);
    assert.match(failureText, /NO_ADAPTER/, `agent/error cause chain must carry NO_ADAPTER, got: ${failureText}`);
    assert.match(failureText, /no adapter registered for provider "missing"/, "original adapter failure must surface");
    const end = handle.agent.session.snapshotEvents().findLast((event) => event.type === "turn/end");
    assert(end?.type === "turn/end");
    assert.equal(end.data.reason.kind, "error", "turn must close with an error reason");
    assert.match(JSON.stringify(end.data.reason), /NO_ADAPTER/, "durable turn/end must carry the adapter failure");
    console.log("[model-config] PASS missing-adapter: deferred explicit NO_ADAPTER, no default request");
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------
// 2. maxTokens 三层语义
// ------------------------------------------------------------------
async function maxTokensLayers(): Promise<void> {
  // 2a. 无 config 覆盖 → 引擎声明取 adapter defaultMaxTokens；请求预算同值。
  const defaulted = new ConfigAdapter({ defaultMaxTokens: 512 });
  const ctxDefault = await mount({ plugin: { provider: "mock", model: "m" }, adapter: defaulted });
  let defaultHandle: AgentHandle | undefined;
  try {
    defaultHandle = await ctxDefault.agents.create({ sessionId: SessionId("model-config-max-default") });
    await send(defaultHandle.agent, "default max tokens");
    assert.equal(defaulted.requests.at(-1)?.maxTokens, 512, "adapter defaultMaxTokens must become the engine request budget");
  } finally {
    await defaultHandle?.dispose();
    await ctxDefault.fiber.dispose();
  }

  // 2b. dsh AgentOptions.maxTokens 是逐请求上限；agent/request 改写之后仍生效。
  const capped = new ConfigAdapter({ defaultMaxTokens: 512 });
  const ctxCapped = await mount({ plugin: { provider: "mock", model: "m" }, adapter: capped });
  let cappedHandle: AgentHandle | undefined;
  try {
    ctxCapped.on("agent/request", async (_payload, next) => ({ ...await next(), maxTokens: 999 }));
    cappedHandle = await ctxCapped.agents.create({
      sessionId: SessionId("model-config-max-capped"),
      agentOptions: { provider: "mock", model: "m", maxTokens: 100 },
    });
    await send(cappedHandle.agent, "request cap");
    assert.equal(capped.requests.at(-1)?.maxTokens, 100, "AgentOptions.maxTokens must cap the request after agent/request rewrites");
  } finally {
    await cappedHandle?.dispose();
    await ctxCapped.fiber.dispose();
  }

  // 2c. config.maxOutputTokens 覆盖 adapter defaultMaxTokens（声明层优先）。
  const overridden = new ConfigAdapter({ defaultMaxTokens: 512 });
  const ctxOverride = await mount({
    plugin: { provider: "mock", model: "m", maxOutputTokens: 700 },
    adapter: overridden,
  });
  let overrideHandle: AgentHandle | undefined;
  try {
    overrideHandle = await ctxOverride.agents.create({ sessionId: SessionId("model-config-max-override") });
    await send(overrideHandle.agent, "config override");
    assert.equal(overridden.requests.at(-1)?.maxTokens, 700, "config.maxOutputTokens must override adapter defaultMaxTokens on the declaration layer");
    const header = overrideHandle.agent.session.requestHeader();
    assert.equal(header?.config.maxTokens, 700, "logged request header must record the declaration-derived budget");
  } finally {
    await overrideHandle?.dispose();
    await ctxOverride.fiber.dispose();
  }

  console.log("[model-config] PASS max-tokens: default=512, AgentOptions cap=100 after waterfall, config override=700");
}

// ------------------------------------------------------------------
// 3. maxTurns / toolConcurrency 透传
// ------------------------------------------------------------------
async function runtimePolicyKnobs(): Promise<void> {
  const adapter = new ConfigAdapter({ defaultMaxTokens: 512 });
  const ctx = await mount({
    plugin: { provider: "mock", model: "m", maxTurns: 1, toolConcurrency: 2 },
    adapter,
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await ctx.agents.create({ sessionId: SessionId("model-config-runtime-knobs") });
    const runtime = runtimeOf(handle.agent);
    assert.equal(runtime.config?.maxTurns, 1, "Config.maxTurns must reach AgentRuntimeConfig");
    assert.equal(runtime.config?.toolConcurrency?.maxConcurrency, 2, "Config.toolConcurrency must map to toolConcurrency.maxConcurrency");
    await send(handle.agent, "policy knobs");
    assert(
      handle.agent.session.snapshotEvents().some((event) => event.type === "turn/end" && event.data.reason.kind === "completed"),
      "a configured runtime policy must not prevent a normal turn close",
    );
    // 已知引擎缺口：vendored revision 的 main turn loop 不读取 config.maxTurns
    // （只有 subagent 路径使用 subagents.maxTurns）。透传保留供引擎后续消费；
    // 桥准入层实施见下方 3b。
    console.log("[model-config] PASS runtime-knobs: maxTurns=1/toolConcurrency=2 reach engine config (engine revision does not enforce main-loop maxTurns)");
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------
// 3b. maxTurns 桥层实施：工具循环被步数上限截断为 blocked 收口
// ------------------------------------------------------------------
async function maxTurnsEnforcement(): Promise<void> {
  // 每步都请求工具调用的 adapter：没有上限时会一直步进，永不自然收尾。
  class ToolLoopAdapter extends ConfigAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options);
      const index = 0;
      yield { type: "block-start", index, blockType: "tool-call" };
      yield { type: "tool-call-delta", index, id: ToolCallId("model-config-loop-call"), name: "config_probe", argumentsDelta: "{}" };
      yield { type: "block-end", index, block: { type: "tool-call", id: ToolCallId("model-config-loop-call"), name: "config_probe", arguments: "{}" } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
    }
  }
  const adapter = new ToolLoopAdapter({ defaultMaxTokens: 512 });
  const ctx = await mount({
    plugin: { provider: "mock", model: "m", maxTurns: 2 },
    adapter,
    beforePlugin: (ctx) => {
      ctx.tools.register(defineTool({
        name: "config_probe",
        description: "Controlled probe tool for the maxTurns enforcement case",
        parameters: {},
        output: { schema: { type: "object", additionalProperties: true }, render: () => [] },
        execute: async () => ({}),
      }));
    },
  });
  let handle: AgentHandle | undefined;
  try {
    handle = await ctx.agents.create({ sessionId: SessionId("model-config-max-turns") });
    const errors: unknown[] = [];
    ctx.on("agent/error", ({ error }) => { errors.push(error); });
    await send(handle.agent, "keep calling the tool");
    // 步 1（准入于 drain）与步 2 放行；步 3 超限 → blocked 收口，不发 agent/error。
    assert.equal(adapter.requests.length, 2, `maxTurns=2 must admit exactly two model steps, got ${adapter.requests.length}`);
    assert.equal(errors.length, 0, "a step-limit close must not emit agent/error");
    const end = handle.agent.session.snapshotEvents().findLast((event) => event.type === "turn/end");
    assert(end?.type === "turn/end");
    assert.equal(end.data.reason.kind, "blocked", "the limited turn must close as blocked at the admission boundary");
    console.log("[model-config] PASS max-turns-enforcement: tool loop capped at 2 steps, turn closed blocked, zero agent/error");
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}

// ------------------------------------------------------------------
// 4. 小窗口：真实 adapter contextWindow → 引擎预算收缩
// ------------------------------------------------------------------
async function smallContextWindow(): Promise<void> {
  const longInput = "x".repeat(2_100);
  const small = new ConfigAdapter({ context: { contextWindow: 2_000 }, defaultMaxTokens: 512 });
  const ctxSmall = await mount({ plugin: { provider: "mock", model: "m" }, adapter: small });
  let smallHandle: AgentHandle | undefined;
  try {
    smallHandle = await ctxSmall.agents.create({ sessionId: SessionId("model-config-small-window") });
    await send(smallHandle.agent, longInput);
    const maxTokens = small.requests.at(-1)?.maxTokens;
    assert(typeof maxTokens === "number", "the engine must send a request token budget");
    assert(maxTokens > 0 && maxTokens < 512, `small real contextWindow must shrink the request budget, got ${String(maxTokens)}`);
    assert.equal(smallHandle.agent.session.requestContext()?.contextWindow, 2_000, "dsh request/context must carry the adapter contextWindow");
  } finally {
    await smallHandle?.dispose();
    await ctxSmall.fiber.dispose();
  }

  const large = new ConfigAdapter({ context: { contextWindow: 100_000 }, defaultMaxTokens: 512 });
  const ctxLarge = await mount({ plugin: { provider: "mock", model: "m" }, adapter: large });
  let largeHandle: AgentHandle | undefined;
  try {
    largeHandle = await ctxLarge.agents.create({ sessionId: SessionId("model-config-large-window") });
    await send(largeHandle.agent, longInput);
    assert.equal(large.requests.at(-1)?.maxTokens, 512, "a roomy window keeps the declaration budget");
  } finally {
    await largeHandle?.dispose();
    await ctxLarge.fiber.dispose();
  }

  console.log("[model-config] PASS small-window: contextWindow=2000 shrinks budget below 512; request/context follows adapter");
}

// ------------------------------------------------------------------
// 5. 会话换档 + resume 路由恢复
// ------------------------------------------------------------------
async function selectionAndResume(): Promise<void> {
  const adapter = new ConfigAdapter({
    context: { contextWindow: 100_000 },
    defaultMaxTokens: 512,
    reasoning: { efforts: EFFORTS, defaultEffort: ReasoningEffortId("low") },
  });
  const ctx = await mount({
    plugin: { provider: "mock", model: "alpha" },
    adapter,
    jsonl: true,
  });
  const id = SessionId("model-config-selection-resume");
  let handle: AgentHandle | undefined;
  try {
    const created = await ctx.agents.create({
      sessionId: id,
      agentOptions: { provider: "mock", model: "alpha" },
    });
    handle = created;
    await send(created.agent, "first turn");
    assert.equal(adapter.requests.at(-1)?.model, "alpha");
    assert.equal(String(adapter.requests.at(-1)?.reasoningEffort), "low", "dsh defaultEffort applies when no selection effort is set");

    // live model/selection：下一 turn 生效。
    appendSelection(created.agent.session, {
      provider: "mock",
      model: "beta",
      reasoningEffort: ReasoningEffortId("high"),
    });
    await until(() => runtimeOf(created.agent).getSessionModelSelection?.()?.modelId === "beta", "beta selection");
    await send(created.agent, "second turn");
    assert.equal(adapter.requests.at(-1)?.model, "beta", "model/selection must route the next request");
    assert.equal(String(adapter.requests.at(-1)?.reasoningEffort), "high", "model/selection effort must reach the request");

    await created.dispose();
    handle = undefined;

    // resume：路由从最后一次 request/header 恢复；effort 不恢复（dsh 契约）。
    const resumed = await ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: "mock", model: "alpha" },
    });
    handle = resumed;
    await send(resumed.agent, "third turn after resume");
    assert.equal(adapter.requests.at(-1)?.model, "beta", "resume must restore the last persisted route, not the shell default");
    assert.equal(String(adapter.requests.at(-1)?.reasoningEffort), "low", "resume does not restore effort; dsh defaultEffort applies");

    // resume 后的 model/selection 仍走同一监听路径。
    appendSelection(resumed.agent.session, {
      provider: "mock",
      model: "gamma",
      reasoningEffort: ReasoningEffortId("high"),
    });
    await until(() => runtimeOf(resumed.agent).getSessionModelSelection?.()?.modelId === "gamma", "gamma selection");
    await send(resumed.agent, "fourth turn after resumed selection");
    assert.equal(adapter.requests.at(-1)?.model, "gamma");
    assert.equal(String(adapter.requests.at(-1)?.reasoningEffort), "high");

    console.log("[model-config] PASS selection-resume: live beta/high; resume beta/low; post-resume gamma/high");
  } finally {
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}

await missingAdapter();
await maxTokensLayers();
await runtimePolicyKnobs();
await maxTurnsEnforcement();
await smallContextWindow();
await selectionAndResume();
console.log("[model-config] PASS: all model/config probes green");
