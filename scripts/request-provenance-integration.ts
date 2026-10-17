/** Prepared-call provenance checked at the installed adapter and Session consumers. */
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createSystemMessage, createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { canonicalHeader, Session, SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import ZcodeLoop, { createDshModelBridge, DshSessionEventStoreBridge } from "../src/index.js";
import { createModelId, createModelProviderId, type ModelRequest, type SessionEvent } from "../src/engine-facade.js";
import { capture } from "./contract-verification/runner.js";

function reply(call?: string): StreamChunk[] {
  return call ? [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: ToolCallId("provenance-call"), name: call, argumentsDelta: "{}" },
    { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId("provenance-call"), name: call, arguments: "{}" } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ] : [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "provenance checked" },
    { type: "block-end", index: 0, block: { type: "text", text: "provenance checked" } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}
class ProvenanceAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  failures: unknown[] = [];
  session?: Session;
  call?: string;
  maxTokensDefaulted = true;
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, ...(model === "bare" ? {} : {
      defaultMaxTokens: 333,
      context: { contextWindow: 45678 },
      systemPromptUpdate: "in-history" as const,
      reasoning: { efforts: [{ id: ReasoningEffortId("low"), name: "Low" }], defaultEffort: ReasoningEffortId("low") },
    }) });
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    try {
      if (this.session) {
        // This executes before any provider response: snapshots must already exist.
        const header = this.session.requestHeader();
        assert(header, "prepared main call must persist a full header before dispatch");
        const { provider, model, maxTokens, reasoningEffort, temperature, stop } = request;
        const config = { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(temperature === undefined ? {} : { temperature }), ...(stop === undefined ? {} : { stop }) };
        assert.deepEqual(header, canonicalHeader({ config, tools: request.tools,
          adapterDefaults: model === "bare" ? {} : { ...(this.maxTokensDefaulted ? { maxTokens: true as const } : {}), reasoningEffort: true } }));
        assert.deepEqual(this.session.requestContext(), { provider, model, ...(model === "bare" ? {} : {
          contextWindow: 45678, systemPromptUpdate: "in-history",
        }) });
        assert(!("messages" in header.config) && !("signal" in header.config));
      }
    } catch (error) { this.failures.push(error); throw error; }
    const call = this.call; this.call = undefined;
    yield* reply(call);
  }
}
const tool = (name: string) => defineTool({ name, description: `schema for ${name}`, parameters: {},
  output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "done" }] },
  execute: async () => ({}),
});
const headerEvents = (session: Session) => session.snapshotEvents().filter((event) => event.type === "request/header");
async function pluginProbe(streaming: boolean): Promise<void> {
  const ctx = new Context();
  let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined;
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {}); await ctx.plugin(AgentRegistry);
    await ctx.plugin(ZcodeLoop, { provider: "mock", model: "rich", streaming });
    const adapter = new ProvenanceAdapter(); adapter.maxTokensDefaulted = false; ctx.llm.registerAdapter(["mock"], adapter);
    ctx.tools.register(tool("global_probe"));
    handle = await ctx.agents.create({ sessionId: SessionId(`provenance-${streaming}`) });
    const agent = handle.agent; adapter.session = agent.session;
    let preStep = 0;
    const admittedTurns: number[] = [];
    const transformed = createUserMessage({ content: [{ type: "text", text: "transformed pre-step input" }], source: { kind: "user" } });
    const offPreStep = agent.ctx.on("agent/pre-step", async ({ turn }, next) => {
      preStep += 1;
      if (preStep === 1) return { kind: "reject" as const };
      admittedTurns.push(turn);
      const decision = await next();
      return decision.kind === "reject" ? decision : { ...decision, messages: [transformed], startsRequestSeries: true as const };
    });
    agent.followup(createUserMessage({ content: [{ type: "text", text: "reject this turn" }], source: { kind: "user" } }));
    await agent.whenIdle();
    assert.equal(adapter.requests.length, 0, "pre-step rejection must not reach the provider");
    let remove = agent.ctx.tools.register(tool("scoped_probe"));
    const run = async (call?: string) => {
      adapter.call = call;
      const before = adapter.requests.length;
      agent.followup(createUserMessage({ content: [{ type: "text", text: "check provenance" }], source: { kind: "user" } }));
      await agent.whenIdle();
      assert.deepEqual(adapter.failures, []);
      assert.equal(adapter.requests.length - before, call ? 2 : 1);
    };
    await run("scoped_probe");
    offPreStep();
    assert.deepEqual(admittedTurns, [1], "rejected admission must not shift the next engine turn");
    assert.deepEqual(agent.session.snapshotEvents().filter((event) => event.type === "turn/start").map((event) => event.data.turn), [1]);
    assert(adapter.requests[0]!.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("transformed pre-step input")));
    assert(agent.session.snapshotEvents().some((event) => event.type === "user/message" && event.data.id === transformed.id));
    assert.equal(headerEvents(agent.session)[0]?.data.startsSeries, true, "pre-step series flag must reach the header");
    assert.deepEqual(agent.session.requestHeader()?.tools?.map((entry) => entry.name).sort(), ["global_probe", "scoped_probe"]);
    assert.equal(headerEvents(agent.session).length, 1, "same-series tool step must inherit header");
    await run();
    assert.equal(headerEvents(agent.session).length, 1, "ordinary later turn must inherit header");
    remove(); remove = agent.ctx.tools.register(tool("late_probe"));
    await run();
    assert.equal(headerEvents(agent.session).at(-1)?.data.reason, "change");
    const update = agent.session.snapshotEvents().find((event) => event.type === "developer/message");
    assert(update?.type === "developer/message");
    assert.deepEqual(update.data.message.content, [
      { type: "tool-addition", toolName: "late_probe" }, { type: "tool-removal", toolName: "scoped_probe" },
    ]);
    assert.equal(update.data.headerSeq, headerEvents(agent.session).at(-1)?.seq);
    assert(agent.session.toolHistory().updates.some((entry) => entry.additions.some((entry) => entry.name === "late_probe")));
    remove(); await run();
    assert.deepEqual(agent.session.requestHeader()?.tools?.map((entry) => entry.name), ["global_probe"]);
    // Replay is the browser/trajectory's persisted consumer, independent of the hook.
    const replay = Session.create(SessionId(`replay-${streaming}`), agent.session.snapshotEvents());
    assert.deepEqual(replay.requestHeader(), agent.session.requestHeader());
    assert.deepEqual(replay.requestContext(), agent.session.requestContext());
    console.log(`[request-provenance] real plugin streaming=${streaming}: defaults, scoped schemas, dedup, changes and replay passed`);
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
}

async function bridgeProbe(): Promise<void> {
  const ctx = new Context(); await ctx.plugin(LlmRuntime);
  try {
    const adapter = new ProvenanceAdapter(); ctx.llm.registerAdapter(["mock"], adapter);
    const seed = Session.create(SessionId("provenance-seed"));
    const bridge = new DshSessionEventStoreBridge({ session: seed });
    let seq = 0;
    const emit = (target: DshSessionEventStoreBridge, type: string, payload: unknown) => target.append({
      id: `event-${++seq}`, type, payload, sessionId: "probe", sequenceNumber: seq, timestamp: new Date(), traceId: "probe",
    } as SessionEvent);
    const factory = (target: DshSessionEventStoreBridge, model = "rich") => createDshModelBridge({ ctx,
      onPreparedRequest: (prepared, request) => target.recordPreparedRequest(prepared, request),
    })({ selection: { providerId: createModelProviderId("mock"), modelId: createModelId(model) } });
    const request: ModelRequest = { messages: [{ role: "system", content: "system" }, { role: "user", content: "input" }] };
    const modelPayload = { messages: request.messages, providerId: "mock", modelId: "rich" };
    await emit(bridge, "turn_started", { turnNumber: 0, input: "input" });
    await emit(bridge, "model_request", modelPayload);
    adapter.session = seed;
    await factory(bridge).generateText(request);
    assert.equal(headerEvents(seed).length, 1);
    // A surface replacement, unlike ordinary appends, starts a new message series.
    const head = seed.surface.nodes[0]!;
    seed.append("system/message", { turn: 1, step: 1, message: createSystemMessage("replacement") },
      { surfaceOp: { op: "replace", startSeq: head, endSeq: head }, sourceEventSeqs: [head] });
    await emit(bridge, "model_request", modelPayload);
    await factory(bridge).generateText(request);
    assert.equal(headerEvents(seed).at(-1)?.data.reason, "series");
    // Compaction can run while the main turn is still open and awaiting preparation.
    await emit(bridge, "model_request", modelPayload);
    const before = seed.snapshotEvents().length;
    await emit(bridge, "compact_started", {});
    adapter.session = undefined;
    await factory(bridge, "bare").generateText(request);
    assert.equal(seed.snapshotEvents().length, before, "sidecar must not consume main admission or emit envelopes");
    await emit(bridge, "compact_completed", {});
    adapter.session = seed;
    await factory(bridge).generateText(request);
    assert.equal(headerEvents(seed).length, 2);
    await emit(bridge, "turn_complete", { response: "done" });
    const resumed = Session.create(SessionId("provenance-resumed"), seed.snapshotEvents());
    const resumedBridge = new DshSessionEventStoreBridge({ session: resumed }); resumedBridge.setTurnBase(1);
    adapter.session = resumed;
    await emit(resumedBridge, "turn_started", { turnNumber: 0, input: "resumed" });
    await emit(resumedBridge, "model_request", modelPayload);
    for await (const _event of factory(resumedBridge).streamText(request)) { /* stream path */ }
    assert.equal(headerEvents(resumed).at(-1)?.data.reason, "resume");
    assert.equal(resumed.snapshotEvents().filter((event) => event.type === "request/context").length, 1, "unchanged resumed context must inherit baseline");
    resumedBridge.setStartsRequestSeries(true);
    await emit(resumedBridge, "model_request", { ...modelPayload, modelId: "bare" });
    await factory(resumedBridge, "bare").generateText(request);
    assert.equal(headerEvents(resumed).at(-1)?.data.reason, "change");
    assert.equal(headerEvents(resumed).at(-1)?.data.startsSeries, true, "changed envelope must retain explicit series boundary");
    assert.deepEqual(resumed.requestContext(), { provider: "mock", model: "bare" }, "optional metadata absence must survive folding");
    assert.deepEqual(resumed.requestHeader()?.config, { provider: "mock", model: "bare" });
    assert.equal(resumed.requestHeader()?.adapterDefaults, undefined);
    assert.deepEqual(adapter.failures, []);
    console.log("[request-provenance] actual model bridge: series, resume baseline, metadata removal and compact sidecar gate passed");
  } finally { await ctx.fiber.dispose(); }
}

async function stockDifferential(): Promise<void> {
  for (const scenario of ["basic-text", "todo-tool", "goal-round"] as const) {
    const stock = await capture("stock", scenario) as { events: Parameters<typeof Session.create>[1] };
    const zcode = await capture("zcode", scenario) as typeof stock;
    const a = Session.create(SessionId(`stock-${scenario}`), stock.events);
    const b = Session.create(SessionId(`zcode-${scenario}`), zcode.events);
    // Preserve the existing engine budget and admission order. These were hidden
    // by the old route-only log; compare the same schemas as a named set here.
    const comparable = (session: Session) => {
      const header = session.requestHeader()!;
      const { maxTokens, ...config } = header.config;
      assert.equal(maxTokens, session === a ? undefined : 32000);
      return { ...header, config, tools: [...(header.tools ?? [])].sort((x, y) => x.name.localeCompare(y.name)) };
    };
    assert.deepEqual(comparable(b), comparable(a), `${scenario}: installed folded schema set and route`);
    assert.deepEqual(b.requestContext(), a.requestContext(), `${scenario}: actual installed folded context`);
    const envelopes = (s: Session) => headerEvents(s).map((event) => ({ reason: event.data.reason, startsSeries: event.data.startsSeries }));
    assert.deepEqual(envelopes(b), envelopes(a), `${scenario}: stock snapshot admission and series reasons`);
    console.log(`[request-provenance] installed stock differential ${scenario}: folded schema set/context + snapshot policy passed (explicit engine maxTokens retained)`);
  }
}
const watchdog = setTimeout(() => { console.error("request provenance watchdog expired"); process.exit(1); }, 60000); watchdog.unref();
try { await pluginProbe(true); await pluginProbe(false); await bridgeProbe(); await stockDifferential(); }
finally { clearTimeout(watchdog); }
