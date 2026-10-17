/** Public registry + real loop consumers, including cold seeded/resumed pending inputs. */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent, type InboxState, type InboxTarget } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk, type UserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import ZcodeLoop from "../src/index.js";
import { ZcodeLoopInbox, inboxProjectionDefinition } from "../src/inbox.js";

const installedRequire = createRequire(realpathSync("node_modules/@deepseek-ai/dsh/package.json"));
const stockLoop = (await import(pathToFileURL(installedRequire.resolve("@deepseek-ai/dsh-agent-loop")).href)).default as Plugin;
const message = (text: string) => createUserMessage({
  content: [{ type: "text", text }], source: { kind: "scheduler", name: `producer-${text}` },
});
const fixtures = Array.from({ length: 14 }, (_, index) => message(`pending-${index}`));
type ClaimableInbox = Agent["inbox"] & { claim(target: InboxTarget, turn: number): UserMessage[] };

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "ack" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "ack" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

async function host(engine: "stock" | "zcode", options: { projections?: boolean; persistence?: string } = {}) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools, {});
  await ctx.plugin(AgentRegistry);
  if (options.projections !== false) await ctx.plugin(SessionProjections);
  if (options.persistence) await ctx.plugin(Jsonl, { root: options.persistence, compression: "none" });
  const loop = await ctx.plugin(engine === "stock" ? stockLoop : ZcodeLoop as Plugin, { provider: "mock", model: "mock" });
  const adapter = new Adapter();
  ctx.llm.registerAdapter(["mock"], adapter);
  return { ctx, loop, adapter };
}

async function commands(engine: "stock" | "zcode") {
  const { ctx, loop } = await host(engine);
  const snapshots: InboxState[] = [];
  const handle = await ctx.agents.create({ sessionId: SessionId(`commands-${engine}`), agentOptions: { provider: "mock", model: "mock" } });
  try {
    const { session } = handle.agent;
    const inbox = handle.agent.inbox as ClaimableInbox;
    const check = (turn: readonly UserMessage[], step: readonly UserMessage[]) => {
      const expected = { "next-turn": turn, "next-step": step };
      assert.deepEqual(ctx.sessionProjections.stateOf(session, "inbox"), expected);
      const snapshot = ctx.sessionProjections.snapshot(session, ["inbox"]);
      assert.deepEqual(snapshot.values.inbox, expected);
      assert.equal(snapshot.asOfSeq, session.snapshotEvents().length - 1);
      assert.deepEqual(inbox.nextTurn, turn);
      assert.deepEqual(inbox.nextStep, step);
      assert.equal(ctx.sessionProjections.checkpoint(session).inbox?.ver, 1);
      snapshots.push(structuredClone(expected));
    };
    check([], []);
    inbox.append("next-turn", fixtures[0]!); check([fixtures[0]!], []);
    inbox.prepend("next-turn", fixtures[1]!); check([fixtures[1]!, fixtures[0]!], []);
    inbox.append("next-step", fixtures[2]!); check([fixtures[1]!, fixtures[0]!], [fixtures[2]!]);
    inbox.prepend("next-step", fixtures[3]!); check([fixtures[1]!, fixtures[0]!], [fixtures[3]!, fixtures[2]!]);
    assert(inbox.replace(fixtures[0]!.id, fixtures[4]!)); check([fixtures[1]!, fixtures[4]!], [fixtures[3]!, fixtures[2]!]);
    assert(inbox.replace(fixtures[2]!.id, fixtures[5]!)); check([fixtures[1]!, fixtures[4]!], [fixtures[3]!, fixtures[5]!]);
    assert(inbox.remove(fixtures[1]!.id)); check([fixtures[4]!], [fixtures[3]!, fixtures[5]!]);
    assert(inbox.remove(fixtures[3]!.id)); check([fixtures[4]!], [fixtures[5]!]);
    const count = session.snapshotEvents().length;
    assert.throws(() => inbox.append("next-turn", fixtures[5]!), /already pending/);
    assert.equal(session.snapshotEvents().length, count);
    assert.deepEqual(inbox.claim("next-step", 1), [fixtures[5]!]); check([fixtures[4]!], []);
    inbox.append("next-step", fixtures[6]!);
    assert.deepEqual(inbox.claim("next-turn", 2), [fixtures[6]!, fixtures[4]!]); check([], []);
    inbox.splice("next-turn", -99, 99, [fixtures[7]!, fixtures[8]!]); check([fixtures[7]!, fixtures[8]!], []);
    inbox.splice("next-turn", -1, 9, [fixtures[9]!]); check([fixtures[7]!, fixtures[9]!], []);
    inbox.splice("next-step", Number.NaN, Number.NaN, [fixtures[10]!]); check([fixtures[7]!, fixtures[9]!], [fixtures[10]!]);
    inbox.clear(); check([], []);
    assert.equal(inbox.remove(fixtures[0]!.id), false);
    assert.equal(inbox.replace(fixtures[0]!.id, fixtures[1]!), false);
    await handle.dispose();
    await loop.dispose();
    assert.equal(ctx.sessionProjections.stateOf(session, "inbox"), undefined);
    assert.equal(ctx.sessionProjections.stateOf(session, "turnBoundary"), undefined);
    assert.deepEqual(ctx.sessionProjections.snapshot(session).values, {});
    return snapshots;
  } finally { await ctx.fiber.dispose(); }
}

async function malformedHistory() {
  for (const failure of ["range", "duplicate"] as const) {
    const session = Session.create(SessionId(`invalid-${failure}`));
    if (failure === "range") session.append("agent/inbox/spliced", { target: "next-turn", start: 0, removedCount: 1, inserted: [] });
    else {
      session.append("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [fixtures[0]!] });
      session.append("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [fixtures[0]!] });
    }
    const ctx = new Context();
    try {
      await ctx.plugin(SessionProjections);
      ctx.sessionProjections.register(inboxProjectionDefinition);
      const error = (e: unknown) => e instanceof Error && /invalid persisted inbox splice at session seq/.test(e.message)
        && e.cause instanceof Error && (failure === "range" ? e.cause.message === "invalid inbox splice" : /already pending/.test(e.cause.message));
      assert.throws(() => ctx.sessionProjections.stateOf(session, "inbox"), error);
      assert.throws(() => ctx.sessionProjections.snapshot(session), error);
      assert.throws(() => new ZcodeLoopInbox(session), error);
    } finally { await ctx.fiber.dispose(); }
  }
}

async function reconstruction() {
  const root = mkdtempSync(join(tmpdir(), "zcode-inbox-projection-"));
  const seed = Session.create(SessionId("inbox-seed"));
  const seedInbox = new ZcodeLoopInbox(seed);
  seedInbox.append("next-turn", fixtures[11]!);
  seedInbox.append("next-step", fixtures[12]!);
  const id = SessionId("inbox-cold-resume");
  let runtime = await host("zcode", { persistence: root });
  try {
    const created = await runtime.ctx.agents.create({ sessionId: id, seed: seed.snapshotEvents(), agentOptions: { provider: "mock", model: "mock" } });
    assert.deepEqual(created.agent.inbox.nextTurn, [fixtures[11]!]);
    assert.deepEqual(created.agent.inbox.nextStep, [fixtures[12]!]);
    assert.deepEqual(runtime.ctx.sessionProjections.snapshot(created.agent.session).values.inbox,
      { "next-turn": [fixtures[11]!], "next-step": [fixtures[12]!] });
    await created.dispose();
    await runtime.ctx.fiber.dispose();
    runtime = await host("zcode", { persistence: root });
    const resumed = await runtime.ctx.agents.resume({ resumeSessionId: id });
    try {
      const inbox = resumed.agent.inbox;
      assert.deepEqual(inbox.nextTurn, [fixtures[11]!]);
      assert.deepEqual(inbox.nextStep, [fixtures[12]!]);
      resumed.agent.followup(fixtures[13]!);
      await resumed.agent.whenIdle();
      assert.equal(runtime.adapter.requests.length, 2, "one turn per queued next-turn prompt");
      const consumed = resumed.agent.session.snapshotEvents().filter(e => e.type === "user/message").map(e => e.data);
      assert.deepEqual(consumed, [fixtures[12]!, fixtures[11]!, fixtures[13]!], "original messages and producer sources, exactly once");
      assert.deepEqual(runtime.ctx.sessionProjections.stateOf(resumed.agent.session, "inbox"), { "next-turn": [], "next-step": [] });
      const reconstructed = new ZcodeLoopInbox(resumed.agent.session);
      assert.equal(reconstructed.hasPending, false, "consumed seed must not reappear");
    } finally { await resumed.dispose(); }
  } finally { await runtime.ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }); }
}

async function optionalService() {
  const { ctx, adapter } = await host("zcode", { projections: false });
  try {
    const handle = await ctx.agents.create({ sessionId: SessionId("inbox-no-projections"), agentOptions: { provider: "mock", model: "mock" } });
    try {
      handle.agent.inject(fixtures[0]!);
      handle.agent.followup(fixtures[1]!);
      await handle.agent.whenIdle();
      assert.equal(adapter.requests.length, 1);
      assert.deepEqual(handle.agent.inbox.nextTurn, []);
      assert.deepEqual(handle.agent.inbox.nextStep, []);
      const second = new ZcodeLoopInbox(handle.agent.session);
      handle.agent.inbox.append("next-step", fixtures[2]!);
      assert.deepEqual(second.nextStep, [fixtures[2]!], "independent facade sees committed splices");
      second.clear();
      assert.deepEqual(handle.agent.inbox.nextStep, []);
    } finally { await handle.dispose(); }
  } finally { await ctx.fiber.dispose(); }
}

assert.deepEqual(await commands("zcode"), await commands("stock"), "actual registry consumers match installed stock loop");
await malformedHistory();
await reconstruction();
await optionalService();
console.log("[inbox-projection] PASS: stock state/wire parity, commands, invalid history, seed/resume consumption, teardown, optional service");
