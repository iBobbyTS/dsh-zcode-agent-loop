/** Kill a test child after a durable call and a real file side effect, then cold-resume. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import * as Jsonl from "@deepseek-ai/dsh-session-persistence-jsonl";
import ZcodeLoop from "../src/index.js";
import { installedRequire } from "./contract-verification/oracle.js";

const id = SessionId("crash-after-side-effect");
class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(private readonly child: boolean) { super(); }
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    if (this.child) {
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id: ToolCallId("crash-call"), name: "crash_effect", argumentsDelta: "{}" };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id: ToolCallId("crash-call"), name: "crash_effect", arguments: "{}" } };
      yield { type: "finish", reason: { kind: "tool-calls" } }; return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "resumed without replaying the side effect" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "resumed without replaying the side effect" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
async function host(root: string, child: boolean) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {}); await ctx.plugin(AgentRegistry);
  await ctx.plugin(Jsonl, { root: join(root, "sessions"), compression: "none" });
  const module = await import(pathToFileURL(installedRequire.resolve("@deepseek-ai/dsh-session-checkpoint-policy")).href);
  await ctx.plugin((module.default ?? module) as Plugin);
  const adapter = new Adapter(child); ctx.llm.registerAdapter(["crash"], adapter);
  await ctx.plugin(ZcodeLoop, { provider: "crash", model: "mock" });
  ctx.tools.register(defineTool({ name: "crash_effect", description: "test-owned file effect", parameters: {},
    output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "effect" }] },
    execute: async () => {
      const file = join(root, "effect-count.txt");
      if (!child) { writeFileSync(file, String(Number(readFileSync(file, "utf8")) + 1)); throw new Error("Unknown side effect was replayed"); }
      writeFileSync(file, "1");
      process.kill(process.pid, "SIGKILL");
      return {};
    },
  }));
  return { ctx, adapter };
}
if (process.argv[2] === "--crash-child") {
  const { ctx } = await host(process.argv[3]!, true);
  const handle = await ctx.agents.create({ sessionId: id });
  handle.agent.followup(createUserMessage({ content: [{ type: "text", text: "perform the controlled effect" }], source: { kind: "user" } }));
  await handle.agent.whenIdle();
  throw new Error("Child must be killed inside the test tool body");
} else {
  mkdirSync(".agent-work/evidence/integration", { recursive: true });
  const root = resolve(mkdtempSync(".agent-work/evidence/integration/crash-run-"));
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--crash-child", root], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-2000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("crash fixture did not reach the tool body within 20s")); }, 20000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => { clearTimeout(timer); signal === "SIGKILL" ? accept() : reject(new Error(`unexpected child exit ${code}/${signal}: ${stderr}`)); });
  });
  assert.equal(readFileSync(join(root, "effect-count.txt"), "utf8"), "1");
  const { ctx, adapter } = await host(root, false);
  let handle: Awaited<ReturnType<typeof ctx.agents.resume>> | undefined;
  try {
    handle = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: "crash", model: "mock" } });
    await handle.agent.whenIdle();
    assert.equal(adapter.requests.length, 0, "cold resume cannot automatically replay unknown work");
    const result = handle.agent.session.snapshotEvents().find(event => event.type === "tool/result");
    assert(result?.type === "tool/result"); assert.equal(result.data.error?.code, "TOOL_OUTCOME_UNKNOWN");
    handle.agent.followup(createUserMessage({ content: [{ type: "text", text: "continue without retrying the unknown side effect" }], source: { kind: "user" } }));
    await handle.agent.whenIdle();
    assert.equal(adapter.requests.length, 1);
    assert(JSON.stringify(adapter.requests[0]!.messages).includes("outcome is unknown"));
    assert.equal(readFileSync(join(root, "effect-count.txt"), "utf8"), "1");
    await ctx.sessions.flush(handle.agent.session);
    const reader = await ctx.sessionPersistence.open(id, "read");
    try { assert((await reader.read(0)).events.some(event => event.type === "turn/end")); } finally { await reader.close(); }
    console.log("[crash-recovery] PASS: actual SIGKILL after effect; durable call; unknown result; cold continuation; effect count stays 1");
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
}
