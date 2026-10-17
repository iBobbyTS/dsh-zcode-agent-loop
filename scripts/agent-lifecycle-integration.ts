/** Stock-oracle interleaves at Agent/Inbox/maintenance ownership boundaries. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync } from "node:fs";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId, pluginRecordOf } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import ZcodeLoop, { ZcodeLoopAgent } from "../src/index.js";
import { installedRequire } from "./contract-verification/oracle.js";

const stock = (await import(pathToFileURL(installedRequire.resolve("@deepseek-ai/dsh-agent-loop")).href)).default as Plugin;
const releases: (() => void)[] = [];
function gate() { const result = Promise.withResolvers<void>(); releases.push(() => result.resolve()); return result; }
function message(text: string) { return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }); }
/** 公开 Agent 契约不声明 claim/hasPending；宿主实现（stock 与 zcode）都提供。 */
type ClaimableInbox = Agent["inbox"] & { claim(target: "next-turn" | "next-step", turn: number): ReturnType<typeof message>[] };
function hasPending(agent: Agent): boolean {
  return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0;
}
function textReply(text = "lifecycle reply"): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}
function toolCallReply(callId = "containment-call"): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: ToolCallId(callId), name: "containment_ping", argumentsDelta: "{}" },
    { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId(callId), name: "containment_ping", arguments: "{}" } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}
function containmentProbe() {
  return defineTool({
    name: "containment_ping",
    description: "containment probe",
    parameters: {},
    output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "pong" }] },
    execute: async () => ({}),
  });
}
class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  beforeReply?: (request: GenerateOptions, number: number) => Promise<void>;
  beforeResolve?: () => Promise<void>;
  reply?: (request: GenerateOptions, number: number) => StreamChunk[];
  override async resolveModel(provider: string, model: string) { await this.beforeResolve?.(); return { provider, id: model, name: model }; }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    await this.beforeReply?.(request, this.requests.length);
    request.signal?.throwIfAborted();
    const scripted = this.reply?.(request, this.requests.length);
    if (scripted !== undefined) { for (const chunk of scripted) yield chunk; return; }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "lifecycle reply" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "lifecycle reply" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("lifecycle fixture timed out")), 10000); })]); }
  finally { clearTimeout(timer); }
}
/** 严格重读口径：每个 turn/start 必须由同 turn 号、随后出现的 turn/end 收口。 */
function assertTurnPairing(events: readonly { type: string; data: unknown }[]): void {
  let open: number | undefined;
  for (const event of events) {
    const data = event.data as { turn?: number };
    if (event.type === "turn/start") {
      assert.equal(open, undefined, "durable log nests or unbalances turn/start");
      open = data.turn;
    } else if (event.type === "turn/end") {
      assert.equal(open, data.turn, "turn/end does not match the open turn");
      open = undefined;
    }
  }
  assert.equal(open, undefined, "durable log has an unclosed turn");
}
type Test = (ctx: Context, agent: Agent, adapter: Adapter, handle: AgentHandle) => Promise<void>;
async function host(engine: "stock" | "zcode", persistenceRoot?: string) {
    const ctx = new Context();
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjection);
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, {}); await ctx.plugin(AgentRegistry);
    if (persistenceRoot !== undefined) await ctx.plugin(Jsonl, { root: persistenceRoot, compression: "none" });
    const adapter = new Adapter(); ctx.llm.registerAdapter(["lifecycle"], adapter);
    const loop = await ctx.plugin(engine === "stock" ? stock : ZcodeLoop as Plugin, { provider: "lifecycle", model: "mock" });
    return { ctx, adapter, loop };
}
async function fixture(engine: "stock" | "zcode", label: string, test: Test) {
  const { ctx, adapter } = await host(engine); let handle: AgentHandle | undefined;
  try {
    handle = await ctx.agents.create({ sessionId: SessionId(`lifecycle-${engine}-${label}`), agentOptions: { provider: "lifecycle", model: "mock" } });
    await deadline(test(ctx, handle.agent, adapter, handle));
    console.log(`[agent-lifecycle] PASS ${engine}/${label}`);
  } finally {
    for (const release of releases.splice(0)) release();
    await handle?.dispose(); await ctx.fiber.dispose();
  }
}
const cases: [string, Test][] = [
  ["maintenance-injection-does-not-wake", async (_ctx, agent, adapter) => {
    const maintenance = gate();
    const task = agent.runMaintenance(() => maintenance.promise);
    assert.equal(agent.status, "idle", "maintenance owns work while public status remains idle");
    agent.inject(message("parked context"));
    maintenance.resolve(); await task; await agent.whenIdle();
    assert.equal(adapter.requests.length, 0); assert.equal(agent.inbox.nextStep.length, 1);
    agent.followup(message("wake with followup")); await agent.whenIdle();
    assert.equal(adapter.requests.length, 1); assert(JSON.stringify(adapter.requests[0]!.messages).includes("parked context"));
  }],
  ["maintenance-failure-releases-owner", async (_ctx, agent, adapter) => {
    await assert.rejects(agent.runMaintenance(async () => { throw new Error("controlled maintenance failure"); }), /controlled maintenance failure/);
    await agent.whenIdle(); assert.equal(agent.status, "idle");
    agent.followup(message("after failed maintenance")); await agent.whenIdle(); assert.equal(adapter.requests.length, 1);
  }],
  ["when-idle-follows-maintenance-wakeup", async (_ctx, agent, adapter) => {
    const maintenance = gate(), started = gate(), provider = gate();
    adapter.beforeReply = async () => { started.resolve(); await provider.promise; };
    const task = agent.runMaintenance(() => maintenance.promise);
    agent.followup(message("waking input during maintenance"));
    let idle = false; const completion = agent.whenIdle().then(() => { idle = true; });
    maintenance.resolve(); await task; await started.promise; await Promise.resolve();
    assert.equal(idle, false, "maintenance settlement is not whole-agent quiescence");
    provider.resolve(); await completion; assert.equal(adapter.requests.length, 1);
  }],
  ["cancel-parks-existing-input", async (_ctx, agent, adapter) => {
    const started = gate(), provider = gate();
    adapter.beforeReply = async (_request, n) => { if (n === 1) { started.resolve(); await provider.promise; } };
    agent.followup(message("active A")); await started.promise;
    const parked = message("parked B"); agent.followup(parked);
    agent.cancel({ kind: "user" }, { keepInbox: true }); provider.resolve(); await agent.whenIdle();
    assert.equal(adapter.requests.length, 1); assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), [parked.id]);
    agent.followup(message("wake C")); await agent.whenIdle(); assert.equal(adapter.requests.length, 3);
  }],
  ["wakeup-after-abort-is-not-lost", async (_ctx, agent, adapter) => {
    const started = gate(), provider = gate();
    adapter.beforeReply = async (_request, n) => { if (n === 1) { started.resolve(); await provider.promise; } };
    agent.followup(message("active A")); await started.promise;
    agent.followup(message("queued B")); agent.cancel({ kind: "user" }, { keepInbox: true });
    agent.followup(message("new wake C")); provider.resolve(); await agent.whenIdle();
    assert.equal(adapter.requests.length, 3); assert.equal(agent.status, "idle");
  }],
  ["send-target-is-preserved", async (_ctx, agent, adapter) => {
    const context = message("step A"), ordinary = message("turn B"), steer = message("step C");
    agent.send(context, "next-step", false); agent.send(ordinary, "next-turn", false); agent.send(steer, "next-step", true);
    await agent.whenIdle();
    assert.equal(adapter.requests.length, 1);
    assert.deepEqual(adapter.requests[0]!.messages.filter(m => m.role === "user").map(m => m.id), [context.id, steer.id, ordinary.id]);
  }],
  ["reentrant-status-cancel", async (ctx, agent, adapter) => {
    let cancelled = false;
    ctx.on("agent/status", ({ status }) => { if (status === "running" && !cancelled) { cancelled = true; agent.cancel({ kind: "user" }); } });
    agent.followup(message("cancel synchronously at running")); await agent.whenIdle();
    assert(cancelled); assert.equal(adapter.requests.length, 0); assert.equal(agent.status, "idle");
  }],
  ["idle-steering-precedes-ordinary-input", async (_ctx, agent, adapter) => {
    const ordinary = message("ordinary queued without wake"), steering = message("idle steering");
    agent.send(ordinary, "next-turn", false); agent.steer(steering); await agent.whenIdle();
    assert.equal(adapter.requests.length, 1);
    assert.deepEqual(adapter.requests[0]!.messages.filter(m => m.role === "user").map(m => m.id), [steering.id, ordinary.id]);
  }],
  ["cleared-wake-still-opens-turn", async (ctx, agent, adapter) => {
    ctx.on("agent/status", ({ status }) => { if (status === "running") agent.inbox.clear(); });
    agent.followup(message("cleared on synchronous wake")); await agent.whenIdle();
    assert.equal(adapter.requests.length, 0);
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === "turn/start").length, 1);
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === "step/start").length, 0);
  }],
  ["idempotent-dispose-active-driver", async (_ctx, agent, adapter, handle) => {
    const started = gate(), provider = gate();
    adapter.beforeReply = async request => {
      started.resolve();
      request.signal?.addEventListener("abort", () => provider.resolve(), { once: true });
      await provider.promise;
    };
    agent.followup(message("dispose active request")); await started.promise;
    await Promise.all([handle.dispose(), handle.dispose()]);
    assert.equal(agent.status, "idle");
  }],
  ["blocked-first-step-stops-driver", async (ctx, agent, adapter) => {
    const rejections: string[] = [], errors: unknown[] = [];
    ctx.on("agent/error", ({ error }) => { errors.push(error); });
    ctx.on("agent/pre-step", ({ step }, next) => {
      if (step === 1 && rejections.length === 0) {
        rejections.push("first proposal");
        return Promise.resolve({ kind: "reject" as const });
      }
      return next();
    });
    const rejected = message("rejected active A"), parked = message("parked B"), wake = message("wake C");
    agent.followup(rejected); agent.followup(parked);
    await agent.whenIdle();
    assert.deepEqual(rejections, ["first proposal"]);
    assert.equal(adapter.requests.length, 0, "a rejected first step spends no model request");
    assert.equal(errors.length, 0, "a pre-step rejection is not an agent error");
    assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), [parked.id]);
    assert.equal(agent.status, "idle");
    agent.followup(wake); await agent.whenIdle();
    assert.equal(adapter.requests.length, 2);
    assert(adapter.requests[0]!.messages.some(m => m.id === parked.id));
    assert(adapter.requests[1]!.messages.some(m => m.id === wake.id));
    assert.equal(hasPending(agent), false);
  }],
  ["turn-failure-stops-driver", async (ctx, agent, adapter) => {
    const errors: unknown[] = [];
    ctx.on("agent/error", ({ error }) => { errors.push(error); });
    adapter.beforeReply = async (_request, number) => {
      if (number === 1) throw new Error("controlled model failure");
    };
    const failed = message("fatal A"), parked = message("parked B"), wake = message("recovery C");
    agent.followup(failed); agent.followup(parked);
    await agent.whenIdle();
    assert.equal(errors.length, 1, "a fatal turn reports exactly one agent/error");
    assert.equal(adapter.requests.length, 1);
    const end = agent.session.snapshotEvents().findLast(e => e.type === "turn/end");
    assert(end?.type === "turn/end"); assert.equal(end.data.reason.kind, "error");
    assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), [parked.id]);
    assert.equal(agent.status, "idle");
    agent.followup(wake); await agent.whenIdle();
    assert.equal(adapter.requests.length, 3);
    assert(adapter.requests[1]!.messages.some(m => m.id === parked.id));
    assert(adapter.requests[2]!.messages.some(m => m.id === wake.id));
  }],
  ["blocked-later-step-stops-driver-without-error", async (ctx, agent, adapter) => {
    const errors: unknown[] = [];
    ctx.on("agent/error", ({ error }) => { errors.push(error); });
    ctx.on("agent/pre-step", ({ step }, next) => step >= 2 ? Promise.resolve({ kind: "reject" as const }) : next());
    ctx.tools.register(containmentProbe());
    adapter.reply = () => toolCallReply();
    const active = message("tool turn A"), parked = message("parked B"), wake = message("recovery C");
    agent.followup(active); agent.followup(parked);
    await agent.whenIdle();
    assert.equal(adapter.requests.length, 1);
    assert.equal(errors.length, 0, "a blocked later step is not an agent error");
    const end = agent.session.snapshotEvents().findLast(e => e.type === "turn/end");
    assert(end?.type === "turn/end"); assert.equal(end.data.reason.kind, "blocked");
    assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), [parked.id]);
    assert.equal(agent.status, "idle");
    adapter.reply = () => textReply();
    agent.followup(wake); await agent.whenIdle();
    assert.equal(adapter.requests.length, 3);
    assert(adapter.requests[1]!.messages.some(m => m.id === parked.id));
    assert(adapter.requests[2]!.messages.some(m => m.id === wake.id));
  }],
  ["turn-open-failure-is-contained", async (ctx, agent, adapter) => {
    const errors: unknown[] = [];
    ctx.on("agent/error", ({ error }) => { errors.push(error); });
    const inbox = agent.inbox as ClaimableInbox;
    const claim = inbox.claim.bind(inbox);
    let failed = false;
    inbox.claim = (target, turn) => {
      if (!failed) { failed = true; throw new Error("controlled claim failure"); }
      return claim(target, turn);
    };
    const blocked = message("open failure A"), wake = message("recovery B");
    agent.followup(blocked); await agent.whenIdle();
    assert(failed);
    assert.equal(adapter.requests.length, 0);
    assert.equal(errors.length, 1, "an opening failure reports exactly one agent/error");
    assert.equal(agent.status, "idle");
    assertTurnPairing(agent.session.snapshotEvents());
    agent.followup(wake); await agent.whenIdle();
    assert.equal(adapter.requests.length, 2);
    assert(adapter.requests[0]!.messages.some(m => m.id === blocked.id));
    assert(adapter.requests[1]!.messages.some(m => m.id === wake.id));
    assert.equal(hasPending(agent), false);
  }],
];
for (const engine of ["stock", "zcode"] as const) for (const [name, test] of cases) await fixture(engine, name, test);

for (const engine of ["stock", "zcode"] as const) {
  mkdirSync(".agent-work/evidence/integration", { recursive: true });
  const root = mkdtempSync(".agent-work/evidence/integration/containment-jsonl-");
  const { ctx, adapter } = await host(engine, root);
  let handle: AgentHandle | undefined;
  try {
    const errors: unknown[] = [];
    let rejectFirstStep = true, rejectLaterStep = false;
    ctx.on("agent/error", ({ error }) => { errors.push(error); });
    ctx.on("agent/pre-step", ({ step }, next) => {
      if (rejectFirstStep && step === 1) { rejectFirstStep = false; return Promise.resolve({ kind: "reject" as const }); }
      if (rejectLaterStep && step >= 2) return Promise.resolve({ kind: "reject" as const });
      return next();
    });
    ctx.tools.register(containmentProbe());
    adapter.beforeReply = async (_request, number) => {
      if (number === 1) throw new Error("controlled durable model failure");
    };
    let toolNext = false;
    adapter.reply = () => {
      const chunks = toolNext ? toolCallReply("durable-containment-call") : textReply();
      toolNext = false;
      return chunks;
    };
    handle = await ctx.agents.create({ sessionId: SessionId(`containment-durable-${engine}`), agentOptions: { provider: "lifecycle", model: "mock" } });
    const agent = handle.agent;
    const rejected = message("durable rejected A"), parked = message("durable parked B");
    agent.followup(rejected); agent.followup(parked); await agent.whenIdle();
    assert.equal(adapter.requests.length, 0);
    assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), [parked.id]);
    const failureWake = message("durable fatal wake C");
    agent.followup(failureWake); await agent.whenIdle();
    assert.equal(adapter.requests.length, 1);
    assert.equal(errors.length, 1);
    assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), [failureWake.id]);
    adapter.beforeReply = undefined;
    const recovery = message("durable recovery D");
    agent.followup(recovery); await agent.whenIdle();
    assert.equal(adapter.requests.length, 3);
    assert.equal(hasPending(agent), false);
    rejectLaterStep = true; toolNext = true;
    const laterRejected = message("durable later-step reject E");
    agent.followup(laterRejected); await agent.whenIdle();
    assert.equal(adapter.requests.length, 4);
    assert.equal(errors.length, 1, "later-step rejection stays out of agent/error");
    rejectLaterStep = false;
    const afterBlocked = message("durable recovery F");
    agent.followup(afterBlocked); await agent.whenIdle();
    assert.equal(adapter.requests.length, 5);
    assert.equal(hasPending(agent), false);
    await ctx.sessions.flush(agent.session);
    const events = agent.session.snapshotEvents();
    const reader = await ctx.sessionPersistence.open(agent.id, "read");
    try {
      const durable = (await reader.read(0)).events;
      assert.deepEqual(durable, events, "actual v4 JSONL reader must accept the containment log");
      assertTurnPairing(durable);
      const reasons = durable.flatMap(e => e.type === "turn/end" ? [e.data.reason.kind] : []);
      assert(reasons.includes("blocked"), "durable log keeps the blocked turn ending");
      assert.equal(reasons.filter(kind => kind === "error").length, 1, "durable log keeps exactly one fatal turn ending");
    } finally { await reader.close(); }
    console.log(`[agent-lifecycle] PASS ${engine}/containment-durable-cold-read`);
  } finally {
    for (const release of releases.splice(0)) release();
    await handle?.dispose(); await ctx.fiber.dispose();
  }
}

for (const engine of ["stock", "zcode"] as const) {
  const { ctx, adapter } = await host(engine); let handle: AgentHandle | undefined;
  try {
    let entered = false;
    const stop = ctx.on("agent/created", async ({ agent }) => {
      entered = true; agent.followup(message("queued by created listener"));
      await Promise.resolve(); assert.equal(adapter.requests.length, 0, "publication awaits serial created listeners before running input");
    });
    handle = await ctx.agents.create({ sessionId: SessionId(`publication-${engine}`), agentOptions: { provider: "lifecycle", model: "mock" } });
    assert(entered); await handle.agent.whenIdle(); assert.equal(adapter.requests.length, 1); stop();
    const failedId = SessionId(`failed-publication-${engine}`);
    const off = ctx.on("agent/created", ({ agent }) => {
      if (agent.id !== failedId) return;
      agent.followup(message("must never dispatch before rollback")); throw new Error("controlled publication listener failure");
    });
    await assert.rejects(ctx.agents.create({ sessionId: failedId, agentOptions: { provider: "lifecycle", model: "mock" } }), /controlled publication listener failure/);
    assert.equal(ctx.agents.get(failedId), undefined); assert.equal(ctx.sessions.get(failedId), undefined);
    assert.equal(adapter.requests.length, 1); off();
    const retry = await ctx.agents.create({ sessionId: failedId, agentOptions: { provider: "lifecycle", model: "mock" } });
    await retry.dispose();
    console.log(`[agent-lifecycle] PASS ${engine}/publication-and-rollback`);
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
}

for (const engine of ["stock", "zcode"] as const) {
  const { ctx, adapter } = await host(engine); let handle: AgentHandle | undefined;
  try {
    const owner = ctx.plugin({ name: `caller-owner-${engine}`, inject: ["agents"], apply() {} });
    const id = SessionId(`caller-lifetime-${engine}`);
    handle = await owner.ctx.agents.create({ sessionId: id, agentOptions: { provider: "lifecycle", model: "mock" } });
    handle.agent.followup(message("caller only injects agents")); await handle.agent.whenIdle();
    assert.equal(adapter.requests.length, 1);
    await owner.dispose();
    assert(ctx.agents.get(id) === undefined, "caller unload must detach its agent");
    assert(ctx.sessions.get(id) === undefined, "caller unload must detach its session");
    console.log(`[agent-lifecycle] PASS ${engine}/caller-owner-and-dependency-context`);
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
}

for (const engine of ["stock", "zcode"] as const) for (const boundary of (engine === "stock" ? ["setup"] : ["metadata", "setup"]) as ("metadata" | "setup")[]) {
  const { ctx, adapter } = await host(engine); const entered = gate(), held = gate();
  try {
    const abort = new AbortController(), id = SessionId(`cancel-creation-${engine}-${boundary}`);
    let committed = false;
    if (boundary === "metadata") adapter.beforeResolve = async () => { entered.resolve(); await held.promise; };
    const created = ctx.agents.create({ sessionId: id, agentOptions: { provider: "lifecycle", model: "mock" }, signal: abort.signal,
      setup: boundary === "setup" ? async () => { entered.resolve(); await held.promise; return { commit() { committed = true; } }; } : undefined,
    });
    await deadline(entered.promise); abort.abort(new Error("controlled creation cancellation"));
    await deadline(assert.rejects(created, /controlled creation cancellation/));
    assert(ctx.agents.get(id) === undefined); assert(ctx.sessions.get(id) === undefined);
    held.resolve(); adapter.beforeResolve = undefined; await Promise.resolve();
    assert.equal(committed, false); assert.equal(adapter.requests.length, 0);
    console.log(`[agent-lifecycle] PASS ${engine}/caller-cancel-during-${boundary}`);
  } finally { for (const release of releases.splice(0)) release(); await ctx.fiber.dispose(); }
}

for (const engine of ["stock", "zcode"] as const) for (const boundary of ["setup", "publication"] as const) {
  const { ctx, adapter, loop } = await host(engine); const entered = gate(), held = gate();
  try {
    const id = SessionId(`unload-creation-${engine}-${boundary}`);
    let committed = false;
    if (boundary === "publication") ctx.on("agent/created", async ({ agent, signal }) => {
      if (agent.id !== id) return;
      entered.resolve(); await new Promise<void>(resolve => { signal!.addEventListener("abort", () => resolve(), { once: true }); });
      assert(ctx.agents.get(id) === agent, "publication retains its exact live entry while listeners settle");
      agent.ctx.fiber.assertActive();
    });
    const created = ctx.agents.create({ sessionId: id, agentOptions: { provider: "lifecycle", model: "mock" },
      setup: boundary === "setup" ? async () => { entered.resolve(); await held.promise; return { commit() { committed = true; } }; } : undefined,
    });
    // Attach failure observation before unload rejects the still-pending creation.
    const cancelled = assert.rejects(created, /not active|disposed|aborted/);
    await deadline(entered.promise); await deadline(loop.dispose()); await cancelled;
    assert(ctx.agents.get(id) === undefined); assert(ctx.sessions.get(id) === undefined);
    held.resolve(); await Promise.resolve(); assert.equal(committed, false); assert.equal(adapter.requests.length, 0);
    console.log(`[agent-lifecycle] PASS ${engine}/factory-unload-during-${boundary}`);
  } finally { for (const release of releases.splice(0)) release(); await ctx.fiber.dispose(); }
}

for (const engine of ["stock", "zcode"] as const) {
  const { ctx, adapter, loop } = await host(engine);
  let first: AgentHandle | undefined, replacement: AgentHandle | undefined;
  try {
    const entered = gate(), stopped = gate();
    let projectionAtAbort = false;
    let projectionFailure: unknown;
    adapter.beforeReply = async request => {
      entered.resolve(); request.signal?.addEventListener("abort", () => {
        try { ctx.sessionProjections.stateOf(first!.agent.session, "inbox"); projectionAtAbort = true; }
        catch (failure) { projectionFailure = failure; }
        finally { stopped.resolve(); }
      }, { once: true }); await stopped.promise;
    };
    const id = SessionId(`factory-reload-${engine}`);
    const options = { sessionId: id, agentOptions: { provider: "lifecycle", model: "mock" } };
    first = await ctx.agents.create(options);
    first.agent.followup(message("active during factory unload")); await entered.promise;
    await deadline(loop.dispose());
    assert(projectionAtAbort, `inbox projection must remain registered through driver cancellation: ${String(projectionFailure)}`);
    assert(ctx.agents.get(id) === undefined, "factory unload left its agent registered");
    assert(ctx.sessions.get(id) === undefined, "factory unload left its session registered");
    adapter.beforeReply = undefined;
    await ctx.plugin(engine === "stock" ? stock : ZcodeLoop as Plugin, { provider: "lifecycle", model: "mock" });
    replacement = await ctx.agents.create(options);
    await first.dispose();
    assert.equal(ctx.agents.get(id), replacement.agent, "old teardown cannot detach a replacement of the same identity");
    replacement.agent.followup(message("after factory reload")); await replacement.agent.whenIdle();
    assert.equal(adapter.requests.length, 2);
    console.log(`[agent-lifecycle] PASS ${engine}/factory-unload-reload-same-id`);
  } finally {
    for (const release of releases.splice(0)) release();
    await first?.dispose(); await replacement?.dispose(); await ctx.fiber.dispose();
  }
}

mkdirSync(".agent-work/evidence/integration", { recursive: true });
const root = mkdtempSync(".agent-work/evidence/integration/queue-mode-");
let runtime = await host("zcode"); let queueHandle: AgentHandle | undefined;
const queueId = SessionId("durable-paused-queue");
try {
  await runtime.ctx.plugin(Jsonl, { root, compression: "none" }); await runtime.ctx.plugin(CommandRuntime);
  queueHandle = await runtime.ctx.agents.create({ sessionId: queueId });
  const agent = queueHandle.agent;
  const execute = (line: string) => runtime.ctx.commands.execute(agent, line, [], new AbortController().signal);
  assert.equal((await execute("/queue pause"))?.result.kind, "success");
  const first = message("first queued"), second = message("remove queued"), priority = message("priority queued"), edited = message("edited first");
  agent.followup(first); agent.followup(second); agent.inbox.prepend("next-turn", priority);
  assert(agent.inbox.replace(first.id, edited)); assert(agent.inbox.remove(second.id));
  await agent.whenIdle(); assert.equal(runtime.adapter.requests.length, 0);
  await queueHandle.dispose(); queueHandle = undefined; await runtime.ctx.fiber.dispose();
  runtime = await host("zcode");
  await runtime.ctx.plugin(Jsonl, { root, compression: "none" }); await runtime.ctx.plugin(CommandRuntime);
  queueHandle = await runtime.ctx.agents.resume({ resumeSessionId: queueId, agentOptions: { provider: "lifecycle", model: "mock" } });
  const resumed = queueHandle.agent;
  assert(resumed instanceof ZcodeLoopAgent || "queuePaused" in resumed);
  const command = (line: string) => runtime.ctx.commands.execute(resumed, line, [], new AbortController().signal);
  assert((await command("/queue status"))?.result.text?.includes("paused"));
  assert.deepEqual(resumed.inbox.nextTurn.map(m => m.id), [priority.id, edited.id]);
  assert.equal(runtime.adapter.requests.length, 0);
  assert.equal((await command("/queue invalid"))?.result.kind, "error");
  assert.equal((await command("/queue resume"))?.result.kind, "success");
  await resumed.whenIdle(); assert.equal(runtime.adapter.requests.length, 2);
  assert.deepEqual(runtime.adapter.requests.map(r => r.messages.filter(m => m.role === "user").at(-1)?.id), [priority.id, edited.id]);
  await runtime.ctx.sessions.flush(resumed.session);
  const reader = await runtime.ctx.sessionPersistence.open(queueId, "read");
  try { assert((await reader.read(0)).events.some(e => pluginRecordOf(e)?.type === "plugin:zcode-loop/queue-mode")); } finally { await reader.close(); }
  console.log("[agent-lifecycle] PASS zcode/durable-queue-command: pause, edit/reorder/remove, real JSONL cold resume, status and resume");
} finally { await queueHandle?.dispose(); await runtime.ctx.fiber.dispose(); }
