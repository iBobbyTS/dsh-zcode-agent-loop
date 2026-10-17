/** Exercise installed dsh consumers at every model-step boundary, not a mocked loop. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import ZcodeLoop from "../src/index.js";
import { installedRequire } from "./contract-verification/oracle.js";

export function stepReply(text: string, tool = false, limit = false): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
  ];
  if (tool) chunks.push(
    { type: "block-start", index: 1, blockType: "tool-call" },
    { type: "tool-call-delta", index: 1, id: ToolCallId("boundary-call"), name: "contract_ping", argumentsDelta: "{}" },
    { type: "block-end", index: 1, block: { type: "tool-call", id: ToolCallId("boundary-call"), name: "contract_ping", arguments: "{}" } },
  );
  chunks.push({ type: "finish", reason: tool ? { kind: "tool-calls" } : limit ? { kind: "max-tokens" } : { kind: "stop" } });
  return chunks;
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  onResolve?: () => void;
  afterChunk?: (chunk: StreamChunk) => void;
  reply: (request: GenerateOptions, n: number) => StreamChunk[] = (_r, n) => stepReply(`reply-${n}`, n === 1);
  override resolveModel(provider: string, model: string) {
    this.onResolve?.();
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 }, systemPromptUpdate: "in-history" as const });
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    for (const chunk of this.reply(request, this.requests.length)) { yield chunk; this.afterChunk?.(chunk); }
  }
}

async function fixture(label: string, test: (ctx: Context, agent: Agent, adapter: Adapter, effects: () => number) => Promise<void>, checkpoints = false) {
  const ctx = new Context(); let handle: AgentHandle | undefined; let effects = 0;
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {}); await ctx.plugin(AgentRegistry);
    mkdirSync(".agent-work/evidence/integration", { recursive: true });
    await ctx.plugin(Jsonl, { root: mkdtempSync(".agent-work/evidence/integration/step-jsonl-"), compression: "none" });
    if (checkpoints) {
      const policy = await import(pathToFileURL(installedRequire.resolve("@deepseek-ai/dsh-session-checkpoint-policy")).href);
      await ctx.plugin((policy.default ?? policy) as Plugin);
    }
    const adapter = new Adapter(); ctx.llm.registerAdapter(["boundary"], adapter);
    await ctx.plugin(ZcodeLoop, { provider: "boundary", model: "initial" });
    ctx.tools.register(defineTool({ name: "contract_ping", description: "boundary probe", parameters: {},
      output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "pong" }] },
      execute: async () => { effects++; return {}; },
    }));
    handle = await ctx.agents.create({ sessionId: SessionId(label) });
    await test(ctx, handle.agent, adapter, () => effects);
    const events = handle.agent.session.snapshotEvents();
    const replay = Session.create(SessionId(`${label}-replay`), events);
    assert.deepEqual(replay.deriveMessages(), handle.agent.session.deriveMessages());
    await ctx.sessions.flush(handle.agent.session);
    const reader = await ctx.sessionPersistence.open(handle.agent.id, "read");
    try { assert.deepEqual((await reader.read(0)).events, events, "actual v4 JSONL reader must accept the full log"); }
    finally { await reader.close(); }
    console.log(`[step-boundary] PASS ${label}`);
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
}
function send(agent: Agent, text = "boundary input") {
  agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
  return agent.whenIdle();
}

await fixture("second-step-rewrite", async (ctx, agent, adapter, effects) => {
  const steps: number[] = [];
  const injected = createUserMessage({ content: [{ type: "text", text: "SECOND_STEP_CONTEXT" }], source: { kind: "user" } });
  ctx.on("agent/pre-step", async ({ step }, next) => {
    steps.push(step); const result = await next();
    return step === 2 && result.kind === "enter" ? { ...result, messages: [...result.messages, injected] } : result;
  });
  ctx.on("agent/request", async ({ step }, next) => ({ ...await next(), ...(step === 2 ? { model: "rewritten" } : {}) }));
  await send(agent);
  assert.deepEqual(steps, [1, 2]); assert.equal(effects(), 1); assert.equal(adapter.requests.length, 2);
  assert.equal(adapter.requests[1]!.model, "rewritten");
  assert(adapter.requests[1]!.messages.some(m => m.id === injected.id));
  assert.equal(agent.session.requestHeader()?.config.model, "rewritten");
});

await fixture("second-step-rejection", async (ctx, agent, adapter, effects) => {
  ctx.on("agent/pre-step", ({ step }, next) => step === 2 ? Promise.resolve({ kind: "reject" }) : next());
  await send(agent);
  assert.equal(effects(), 1); assert.equal(adapter.requests.length, 1);
  const events = agent.session.snapshotEvents();
  assert.equal(events.filter(e => e.type === "step/start").length, 1);
  const end = events.findLast(e => e.type === "turn/end");
  assert(end?.type === "turn/end"); assert.equal(end.data.reason.kind, "blocked");
});

await fixture("cancel-during-request", async (ctx, agent, adapter) => {
  ctx.on("agent/request", (_payload, next) => { agent.cancel({ kind: "user" }); return next(); });
  await send(agent, "MUST_NOT_COMMIT");
  assert.equal(adapter.requests.length, 0);
  assert(!agent.session.snapshotEvents().some(e => e.type === "user/message" || e.type === "system/message"));
});

await fixture("cancel-during-preparation", async (ctx, agent, adapter) => {
  ctx.on("agent/request", (_payload, next) => {
    adapter.onResolve = () => agent.cancel({ kind: "user" }); return next();
  });
  await send(agent, "MUST_NOT_COMMIT");
  assert.equal(adapter.requests.length, 0);
  assert(!agent.session.snapshotEvents().some(e => e.type === "user/message" || e.type === "system/message"));
});

await fixture("request-error-retry", async (ctx, agent, adapter, effects) => {
  let preSteps = 0, failures = 0;
  ctx.on("agent/pre-step", (_payload, next) => { preSteps++; return next(); });
  ctx.on("agent/request-error", ({ failure }) => {
    assert.equal(failure.code, "CONTEXT_WINDOW_EXCEEDED"); failures++;
    return Promise.resolve({ kind: "retry" });
  });
  adapter.reply = (_request, n) => n === 1 ? [{ type: "finish", reason: { kind: "error", failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "controlled overflow" } } }] : stepReply("retry passed");
  await send(agent);
  assert.equal(adapter.requests.length, 2); assert.equal(preSteps, 1); assert.equal(failures, 1); assert.equal(effects(), 0);
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === "user/message").length, 1);
});

await fixture("engine-output-continuation", async (_ctx, agent, adapter) => {
  adapter.reply = (_request, n) => stepReply(`continuation-${n}`, false, n === 1);
  await send(agent);
  assert.equal(adapter.requests.length, 2);
  assert(JSON.stringify(adapter.requests[1]!.messages).includes("Output token limit hit"));
  assert(!JSON.stringify(agent.session.deriveMessages()).includes("Output token limit hit"));
});

await fixture("dynamic-prompt-and-facts", async (ctx, agent, adapter) => {
  let prompt = "PROMPT_BEFORE", fact = "FACT_BEFORE";
  ctx.systemPrompt.section({ name: "dynamic-boundary", order: 0, complete: true, text: () => prompt });
  ctx.systemPrompt.context({ name: "boundary-fact", order: 0, text: () => fact });
  ctx.on("agent/pre-step", ({ step }, next) => {
    if (step === 2) { prompt = "PROMPT_AFTER"; fact = "FACT_AFTER"; }
    return next();
  });
  // Sections are bound before pre-step, while runtime facts refresh at admission.
  await send(agent);
  assert(JSON.stringify(adapter.requests[0]!.messages).includes("PROMPT_BEFORE"));
  assert(JSON.stringify(adapter.requests[1]!.messages).includes("FACT_AFTER"));
  await send(agent, "next turn uses changed section");
  assert(JSON.stringify(adapter.requests.at(-1)!.messages).includes("PROMPT_AFTER"));
  prompt = ""; fact = "";
  await send(agent, "clear dynamic section");
  assert(!adapter.requests.at(-1)!.messages.some(m => m.role === "system"));
  assert(JSON.stringify(adapter.requests.at(-1)!.messages).includes("Earlier runtime-context snapshots no longer apply"));
});

await fixture("cancel-preserves-visible-prefix", async (_ctx, agent, adapter) => {
  adapter.reply = () => [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "VISIBLE_PREFIX" },
  ];
  adapter.afterChunk = chunk => { if (chunk.type === "text-delta") agent.cancel({ kind: "user" }); };
  await send(agent);
  const messages = agent.session.deriveMessages();
  assert(messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes("VISIBLE_PREFIX")));
  const end = agent.session.snapshotEvents().findLast(e => e.type === "turn/end");
  assert(end?.type === "turn/end"); assert.deepEqual(end.data.reason, { kind: "aborted", reason: { kind: "user" } });
  adapter.afterChunk = undefined; adapter.reply = () => stepReply("after cancellation");
  await send(agent, "continue after cancellation");
  assert(JSON.stringify(adapter.requests.at(-1)!.messages).includes("VISIBLE_PREFIX"));
});

await fixture("failed-tool-journal-is-readable", async (_ctx, agent, adapter, effects) => {
  const append = agent.session.append.bind(agent.session);
  let failed = false;
  agent.session.append = ((...args: Parameters<typeof append>) => {
    if (!failed && args[0] === "tool/call") { failed = true; throw new Error("controlled tool journal failure"); }
    return Reflect.apply(append, agent.session, args);
  }) as typeof append;
  await send(agent);
  assert(failed); assert.equal(effects(), 0, "tool body cannot run after its call journal failed");
  const results = agent.session.snapshotEvents().filter(e => e.type === "tool/result");
  assert(results.length > 0); assert(results.some(e => e.data.error?.code === "TOOL_NOT_STARTED"));
  assert.equal(adapter.requests.length, 1);
});

await fixture("partial-stream-plugin-retry", async (ctx, agent, adapter, effects) => {
  let preSteps = 0, failures = 0;
  ctx.on("agent/pre-step", (_payload, next) => { preSteps++; return next(); });
  ctx.on("agent/request-error", () => { failures++; return Promise.resolve({ kind: "retry" }); });
  adapter.reply = (_request, n) => n === 1 ? [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "DISCARDED_PARTIAL" },
    { type: "finish", reason: { kind: "error", failure: { code: "CONTROLLED_PARTIAL_RETRY", message: "controlled partial failure" } } },
  ] : stepReply("RECOVERED_WITHOUT_DUPLICATE");
  await send(agent);
  assert.equal(adapter.requests.length, 2); assert.equal(preSteps, 1); assert.equal(failures, 1); assert.equal(effects(), 0);
  assert(!JSON.stringify(agent.session.deriveMessages()).includes("DISCARDED_PARTIAL"));
  assert(JSON.stringify(agent.session.deriveMessages()).includes("RECOVERED_WITHOUT_DUPLICATE"));
  assert(agent.session.snapshotEvents().some(e => e.type === "assistant/attempt"));
});

await fixture("complete-tool-then-stream-failure", async (_ctx, agent, adapter, effects) => {
  adapter.reply = (_request, n) => n === 1 ? [
    ...stepReply("discard this partial text", true).slice(0, -1),
    { type: "finish", reason: { kind: "error", failure: { code: "MODEL_NETWORK_ERROR", message: "controlled stream failure after tool declaration" } } },
  ] : stepReply("TOOL_RECOVERY_FINISHED");
  await send(agent);
  assert.equal(adapter.requests.length, 2); assert.equal(effects(), 0, "non-stream-executed tool is settled as not executed, never guessed successful");
  const results = agent.session.snapshotEvents().filter(e => e.type === "tool/result");
  assert.equal(results.length, 1); assert.equal(results[0]!.data.message.isError, true);
  assert(JSON.stringify(agent.session.deriveMessages()).includes("TOOL_RECOVERY_FINISHED"));
});

for (const boundary of ["model", "tool"] as const) await fixture(`flush-before-${boundary}`, async (ctx, agent, adapter, effects) => {
  const flush = ctx.sessions.flush.bind(ctx.sessions);
  let failed = false;
  ctx.sessions.flush = async (...args: Parameters<typeof flush>) => {
    const events = agent.session.snapshotEvents();
    const target = boundary === "model" ? events.some(e => e.type === "request/header") : events.some(e => e.type === "tool/call");
    if (target && !failed) { failed = true; throw new Error(`controlled ${boundary} checkpoint failure`); }
    return flush(...args);
  };
  try {
    await send(agent);
    assert(failed, "installed checkpoint policy must reach the real flush barrier");
    assert.equal(effects(), 0, "no tool body runs past a failed durability barrier");
    if (boundary === "model") assert.equal(adapter.requests.length, 0, "provider dispatch waits for durable request");
  } finally { ctx.sessions.flush = flush; }
}, true);
