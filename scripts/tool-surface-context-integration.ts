import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type AssistantStreamFrame } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { BlockAssembler, createUserMessage, expandAssistantStream, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { Session, SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import ZcodeLoop from "../src/index.js";
import { DshSessionEventStoreBridge } from "../src/bridges/event-store-bridge.js";
import type { SessionEvent } from "../src/engine-facade.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap { toolSurfaceProbe: { kind: "toolSurfaceProbe"; owner: string } }
}

const calls = [
  { callId: "pair-a", name: "first", input: { nested: { value: "a" } } },
  { callId: "pair-b", name: "second", input: { values: [1, 2] } },
];
const expectedCalls = calls.map((call) => ({ type: "tool-call", id: ToolCallId(call.callId), name: call.name, arguments: JSON.stringify(call.input) }));

async function bridgeProbe(streaming: boolean, reason: string, callCount: number): Promise<void> {
  const session = Session.create(SessionId(`surface-${streaming}-${reason}-${callCount}`));
  const bridge = new DshSessionEventStoreBridge({ session });
  const frames: AssistantStreamFrame[] = [];
  bridge.setStreamPublisher((frame) => frames.push(frame));
  let sequence = 0;
  const emit = async (type: string, payload: unknown) => bridge.append({
    id: `probe-${++sequence}`, type, payload, sessionId: "probe", sequenceNumber: sequence, timestamp: new Date(), traceId: "probe",
  } as SessionEvent);
  await emit("turn_started", { turnNumber: 0, input: "probe" });
  await emit("model_request", { messages: [{ role: "system", content: "system" }], providerId: "mock", modelId: "mock" });
  const scheduled = async (i: number) => {
    const call = calls[i]!;
    await emit("tool_call_scheduled", { toolCallId: call.callId, toolName: call.name, input: call.input });
    await emit("tool_call_result", { toolCallId: call.callId, result: { success: true, content: `result-${i}` } });
  };
  if (streaming) {
    for (const [kind, delta] of [["text_start", ""], ["text_delta", "hello"], ["text_end", ""]]) await emit("model_streaming", { kind, delta });
    for (let i = 0; i < callCount; i++) {
      const call = calls[i]!;
      await emit("model_streaming", { kind: "tool_input_start", toolCallId: call.callId, toolName: call.name, delta: "" });
      await emit("model_streaming", { kind: "tool_input_delta", delta: JSON.stringify(call.input) });
      await emit("model_streaming", { kind: "tool_call", toolCallId: call.callId, toolName: call.name, input: call.input, delta: "" });
      // Exercise during-stream tools, before the complete call set is known.
      await scheduled(i);
      assert.equal(session.snapshotEvents().filter((event) => event.type === "tool/call").length, 0);
    }
    await emit("model_streaming", { kind: "finish", done: true, delta: "" });
  }
  await emit("model_complete", { content: "hello", stopReason: reason, toolCallCount: callCount, usage: { inputTokens: 7, outputTokens: 9 } });
  if (!streaming) for (let i = 0; i < callCount; i++) await scheduled(i);
  await emit("turn_complete", { response: "hello" });
  const events = session.snapshotEvents();
  const assistant = events.find((event) => event.type === "assistant/message");
  assert(assistant?.type === "assistant/message");
  assert.deepEqual(assistant.data.message.content, [{ type: "text", text: "hello" }, ...expectedCalls.slice(0, callCount)]);
  const expanded = expandAssistantStream(assistant.data.stream);
  const terminal = expanded.filter((entry) => entry.chunk.type === "finish");
  assert.equal(terminal.length, 1);
  const assembler = new BlockAssembler();
  for (const entry of expanded) assembler.push(entry.chunk);
  assert.equal(assembler.finish.kind, reason === "length" ? "max-tokens" : reason);
  assert.deepEqual(assembler.blocks(), assistant.data.message.content);
  assert.deepEqual(assembler.usage, { inputTokens: 7, outputTokens: 9 });
  const liveChunks = frames.filter((frame) => frame.type === "chunk").map((frame) => frame.chunk);
  const liveAssembler = new BlockAssembler();
  for (const chunk of liveChunks) liveAssembler.push(chunk);
  assert.equal(liveChunks.filter((chunk) => chunk.type === "finish").length, 1);
  assert.deepEqual(liveAssembler.finish, assembler.finish);
  assert.deepEqual(liveAssembler.usage, assembler.usage);
  assert.deepEqual(liveAssembler.blocks(), assembler.blocks());
  const end = frames.at(-1);
  assert(end?.type === "end" && end.outcome.kind === "committed" && end.outcome.seq === assistant.seq);
  for (const event of events.filter((event) => event.type === "tool/call")) assert(assistant.seq < event.seq);
  const replayed = Session.create(SessionId(`replay-${session.id}`), events);
  assert.deepEqual(replayed.deriveMessages(), session.deriveMessages());
  const results = replayed.deriveMessages().filter((message) => message.role === "tool");
  assert.deepEqual(results.map((message) => message.toolCallId), calls.slice(0, callCount).map((call) => ToolCallId(call.callId)));
}

function reply(text: string, tool = false): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
  ];
  if (tool) chunks.push(
    { type: "block-start", index: 1, blockType: "tool-call" },
    { type: "tool-call-delta", index: 1, id: ToolCallId("same-call"), name: "deferred_probe", argumentsDelta: "{}" },
    { type: "block-end", index: 1, block: { type: "tool-call", id: ToolCallId("same-call"), name: "deferred_probe", arguments: "{}" } },
  );
  chunks.push({ type: "finish", reason: { kind: tool ? "tool-calls" : "stop" } });
  return chunks;
}
class ContextAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  constructor(readonly owner: string, readonly instruction: string) { super(); }
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    if (this.requests.length === 1) yield* reply("calling", true);
    else {
      assert.equal(this.requests.length, 2, "context must stay in the active turn");
      const userText = request.messages.filter((message) => message.role === "user").flatMap((message) => message.content).filter((block) => block.type === "text").map((block) => block.text).join("\n");
      assert.equal(userText.split(this.instruction).length - 1, 1, "actual next request must contain the instruction exactly once");
      assert(!userText.includes(`deferred-for-${this.owner === "owner" ? "sibling" : "owner"}`), "contexts must not cross agents");
      yield* reply(`obeyed ${this.instruction}`);
    }
  }
}
async function contextProbe(): Promise<void> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ZcodeLoop, { provider: "mock", model: "owner" });
  const adapters = new Map(["owner", "sibling"].map((owner) => [owner, new ContextAdapter(owner, `deferred-for-${owner}`)]));
  class Router extends LlmAdapter {
    override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }); }
    async *stream(request: GenerateOptions) { yield* adapters.get(request.model)!.stream(request); }
  }
  ctx.llm.registerAdapter(["mock"], new Router());
  const contexts = new Map<string, ReturnType<typeof createUserMessage>>();
  ctx.tools.register(defineTool({
    name: "deferred_probe", description: "Defer a scoped instruction, also on error", parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    execute: async (_args, execution) => {
      const owner = execution.agent!.options.model!;
      const message = createUserMessage({ content: [{ type: "text", text: `deferred-for-${owner}` }], source: { kind: "toolSurfaceProbe", owner } });
      contexts.set(owner, message);
      execution.deferContext(message);
      if (owner === "sibling") throw new Error("expected probe error");
      return "ok";
    },
  }));
  const handles = await Promise.all(["owner", "sibling"].map((owner) => ctx.agents.create({ sessionId: SessionId(owner), agentOptions: { provider: "mock", model: owner } })));
  for (const handle of handles) handle.agent.followup(createUserMessage({ content: [{ type: "text", text: "run the tool" }], source: { kind: "user" } }));
  await Promise.all(handles.map((handle) => handle.agent.whenIdle()));
  for (const [i, owner] of ["owner", "sibling"].entries()) {
    const agent = handles[i]!.agent;
    assert.equal(adapters.get(owner)!.requests.length, 2);
    const events = agent.session.snapshotEvents();
    const result = events.find((event) => event.type === "tool/result");
    assert(result?.type === "tool/result");
    assert.equal(result.data.message.isError, owner === "sibling");
    const notices = events.filter((event) => event.type === "user/message" && event.data.source.kind === "toolSurfaceProbe");
    assert.equal(notices.length, 1);
    const notice = notices[0]!;
    assert.deepEqual(notice.data, contexts.get(owner));
    assert(result.seq < notice.seq);
    const splices = events.filter((event) => event.type === "agent/inbox/spliced" && event.data.target === "next-step");
    assert.equal(splices.length, 2, "one insertion and one claim");
    assert.equal(agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0);
    assert.equal(events.filter((event) => event.type === "turn/start").length, 1);
    await handles[i]!.dispose();
  }
}

for (const streaming of [true, false]) {
  for (const reason of ["stop", "length"]) await bridgeProbe(streaming, reason, 0);
  for (const count of [1, 2]) await bridgeProbe(streaming, "tool-calls", count);
}
await contextProbe();
console.log("[tool-surface-context] PASS: complete multi-tool surface/replay, terminal assembly/live, success/error contexts and sibling isolation");
process.exit(0);
