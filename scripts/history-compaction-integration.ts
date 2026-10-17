/** Real npm compaction/surface readers against the production embedded loop. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry, { type AgentHandle } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import ZcodeLoop from "../src/index.js";
import { installedRequire } from "./contract-verification/oracle.js";

const load = async (name: string) => (await import(pathToFileURL(installedRequire.resolve(name)).href)).default as Plugin;
const tokenMeter = await load("@deepseek-ai/dsh-token-meter");
const compaction = await load("@deepseek-ai/dsh-compaction-basic");
function* text(text: string): Generator<StreamChunk> {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}
class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly summaries: GenerateOptions[] = [];
  tool = false; overflow = false;
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 }, defaultMaxTokens: 256 });
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    if (request.model === "summary") { this.summaries.push(request); yield* text("SUMMARY_KEEP_FACT"); return; }
    this.requests.push(request);
    if (this.overflow) {
      this.overflow = false;
      yield { type: "finish", reason: { kind: "error", failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "controlled context overflow" } } };
      return;
    }
    if (this.tool) {
      this.tool = false;
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: ToolCallId("large-result"), name: "history_payload", argumentsDelta: "{}" };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId("large-result"), name: "history_payload", arguments: "{}" } };
      yield { type: "finish", reason: { kind: "tool-calls" } }; return;
    }
    yield* text(`MAIN_REPLY_${this.requests.length}`);
  }
}
async function run(mode: "manual" | "pressure" | "overflow" | "between-turns") {
  const ctx = new Context(); const handles: AgentHandle[] = [];
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjection);
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, {}); await ctx.plugin(AgentRegistry); await ctx.plugin(tokenMeter);
    const adapter = new Adapter(); ctx.llm.registerAdapter(["history"], adapter);
    await ctx.plugin(compaction, { auto: mode !== "manual", headroomTokens: 100, maxTokens: 256,
      thresholdRatio: mode === "pressure" ? 0.3 : mode === "between-turns" ? 0.05 : 0.99, retainTokens: 0,
      summarizationProvider: "history", summarizationModel: "summary",
    });
    await ctx.plugin(ZcodeLoop, { provider: "history", model: "main" });
    ctx.tools.register(defineTool({ name: "history_payload", description: "large payload", parameters: {},
      output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "TOOL_OLD_PAYLOAD ".repeat(6000) }] }, execute: async () => ({}),
    }));
    const handle = await ctx.agents.create({ sessionId: SessionId(`history-${mode}`) }); handles.push(handle);
    const agent = handle.agent;
    const send = async (input: string) => {
      agent.followup(createUserMessage({ content: [{ type: "text", text: input }], source: { kind: "user" } }));
      await agent.whenIdle();
    };
    const preSteps: number[] = [];
    ctx.on("agent/pre-step", ({ step }, next) => { preSteps.push(step); return next(); });
    if (mode === "pressure") {
      await send("USER_OLD_PAYLOAD ".repeat(2500));
      adapter.tool = true; await send("produce a large result");
      assert(adapter.summaries.length > 0, "installed pressure listener must run between tool steps");
      assert.equal(adapter.requests.length, 3);
      assert.deepEqual(preSteps, [1, 1, 2]);
    } else {
      await send("USER_OLD_PAYLOAD ".repeat(1800));
      if (mode === "between-turns") {
        await send("pressure at the first step of the next turn");
        assert(adapter.summaries.length > 0, "first-step compaction must have an open host turn");
      } else if (mode === "manual") {
        const engine = ctx.get("compaction") as unknown as { compactNow(agent: typeof handle.agent, signal: AbortSignal): Promise<unknown> };
        assert(await engine.compactNow(agent, new AbortController().signal));
        await send("continue after manual compaction");
      } else {
        adapter.overflow = true; await send("trigger controlled overflow");
        assert.equal(adapter.requests.length, 3, "overflow recovery retries the model, not the whole user turn");
        assert.deepEqual(preSteps, [1, 1], "retry does not repeat pre-step");
      }
    }
    const last = adapter.requests.at(-1)!;
    assert(JSON.stringify(last.messages).includes("SUMMARY_KEEP_FACT"), JSON.stringify({ mode,
      requests: adapter.requests.map(r => ({ model: r.model, messages: r.messages.map(m => ({ role: m.role, text: JSON.stringify(m.content).slice(0, 180) })) })),
      surface: agent.session.deriveMessages().map(m => ({ role: m.role, text: JSON.stringify(m.content).slice(0, 180) })),
    }));
    assert(!JSON.stringify(last.messages).includes("USER_OLD_PAYLOAD"));
    // The installed compactor deliberately retains the newest balanced tool
    // pair even at retainTokens=0; only older compacted history must disappear.
    assert.equal(JSON.stringify(last.messages).includes("TOOL_OLD_PAYLOAD"), mode === "pressure");
    assert(!agent.session.deriveMessages().some(message => message.role === "assistant" && JSON.stringify(message.content).includes("SUMMARY_KEEP_FACT")), "summary is a checkpoint, not an assistant answer");
    assert(agent.session.snapshotEvents().some(event => (event.type as string) === "compaction/end"));
    const replay = Session.create(SessionId(`history-${mode}-replay`), agent.session.snapshotEvents());
    assert.deepEqual(replay.deriveMessages(), agent.session.deriveMessages());
    const child = await ctx.agents.create({ sessionId: SessionId(`history-${mode}-fork`), seed: agent.session.snapshotEvents() }); handles.push(child);
    child.agent.followup(createUserMessage({ content: [{ type: "text", text: "fork continuation" }], source: { kind: "user" } }));
    await child.agent.whenIdle();
    assert(JSON.stringify(adapter.requests.at(-1)!.messages).includes("SUMMARY_KEEP_FACT"));
    assert(!JSON.stringify(adapter.requests.at(-1)!.messages).includes("USER_OLD_PAYLOAD"));
    console.log(`[history-compaction] PASS ${mode}: installed summarizer + active surface + fork`);
  } finally { for (const handle of handles.reverse()) await handle.dispose(); await ctx.fiber.dispose(); }
}
for (const mode of ["manual", "pressure", "overflow", "between-turns"] as const) await run(mode);
