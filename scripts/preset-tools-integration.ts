/** Real agent-scope registration after enter, matching preset binding timing. */
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import ZcodeLoop, { createDshToolBridge } from "../src/index.js";

const GLOBAL = "preset_global_control";
const SCOPED = "preset_scoped_tool";
const LATE = "preset_late_tool";

interface RequestStep {
  visible: string[];
  call?: string;
}

class ScopedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly failures: string[] = [];
  steps: RequestStep[] = [];

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const step = this.steps.shift();
    assert(step, "unexpected model request");
    const visible = (options.tools ?? []).map((tool) => tool.name).sort();
    try {
      assert.deepEqual(visible, [...step.visible].sort(), "model must see exactly its agent's current tools");
    } catch (error) {
      this.failures.push(String(error));
      throw error;
    }
    if (step.call) {
      const id = ToolCallId(`preset-call-${this.requests.length}`);
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id, name: step.call, argumentsDelta: "{}" };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: step.call, arguments: "{}" } };
    } else {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "scope verified" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "scope verified" } };
    }
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", reason: { kind: step.call ? "tool-calls" : "stop" } };
  }
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("[preset-tools] FAIL: watchdog expired");
    process.exit(1);
  }, 30_000);
  watchdog.unref();
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ZcodeLoop, { provider: "mock", model: "mock" });
  const adapter = new ScopedAdapter();
  ctx.llm.registerAdapter(["mock"], adapter);

  const executions: Array<{ name: string; agent?: Agent; initiator?: Agent }> = [];
  const tool = (name: string, concurrentSafe: boolean) => ({ ...defineTool({
    name,
    description: name,
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: () => [{ type: "text", text: `${name} executed` }],
    },
    execute: async (_args, exec) => {
      executions.push({ name, agent: exec.agent, initiator: ctx.agents.currentInitiator() });
      return {};
    },
  }),
    // Constant registration metadata: defineTool's argument-validating wrapper
    // rejects the bridge's undefined registration-time probe before user code.
    isConcurrencySafe: () => concurrentSafe,
  });
  ctx.tools.register(tool(GLOBAL, false));
  const ownerHandle = await ctx.agents.create({ sessionId: SessionId("preset-owner") });
  const siblingHandle = await ctx.agents.create({ sessionId: SessionId("preset-sibling") });
  const owner = ownerHandle.agent;
  const sibling = siblingHandle.agent;

  // Registration uses the actual Cordis scoped context, after agent creation/enter.
  const unregisterScoped = owner.ctx.tools.register(tool(SCOPED, true));
  assert(ctx.agents.get(owner.id) === owner, "scope test must register after enter");
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), [GLOBAL]);
  assert.deepEqual(owner.ctx.tools.schemas().map((schema) => schema.name), [GLOBAL],
    "caller context alone does not select schemas' explicit scope argument");
  assert.deepEqual(ctx.tools.schemas(owner).map((schema) => schema.name).sort(), [GLOBAL, SCOPED].sort());
  assert.deepEqual(ctx.tools.schemas(sibling).map((schema) => schema.name), [GLOBAL]);
  console.log("[preset-tools] control: root/context-only/sibling see global; explicit owner scope also sees local");

  let preExecute = 0;
  owner.ctx.on("tools/pre-execute", async (exec, next) => {
    assert(exec.agent === owner, "owner pipeline listener must receive its agent");
    preExecute += 1;
    return next();
  });
  const run = async (agent: Agent, visible: string[], calls: string[]) => {
    adapter.steps = [...calls.map((call) => ({ visible, call })), { visible }];
    const before = adapter.requests.length;
    agent.followup(createUserMessage({ content: [{ type: "text", text: "verify scoped tools" }], source: { kind: "user" } }));
    await agent.whenIdle();
    assert.equal(adapter.failures.length, 0, adapter.failures.join("\n"));
    assert.equal(adapter.steps.length, 0, "script must drain");
    assert.equal(adapter.requests.length - before, calls.length + 1);
  };

  await run(owner, [GLOBAL, SCOPED], [SCOPED, GLOBAL]);
  assert.deepEqual(executions.map(({ name }) => name), [SCOPED, GLOBAL]);
  assert(executions.every((exec) => exec.agent === owner && exec.initiator === owner),
    "scoped and global handlers must receive the owner and its initiator");
  assert.equal(preExecute, 2, "both owner calls must pass through the scoped dsh pipeline");

  // Metadata must resolve through the same scope as schema/execution.
  const bridge = createDshToolBridge({ ctx, agent: () => owner });
  bridge.syncTools();
  assert.equal(bridge.registry.getMetadata(SCOPED)?.concurrentSafe, true);
  assert.equal(bridge.registry.getMetadata(GLOBAL)?.concurrentSafe, false);

  await run(sibling, [GLOBAL], [GLOBAL]);
  assert(executions.at(-1)?.agent === sibling && executions.at(-1)?.initiator === sibling);
  assert.equal(preExecute, 2, "sibling execution must not enter the owner's scoped listener");
  console.log("[preset-tools] first request + handler + metadata + initiator + sibling isolation passed");

  unregisterScoped();
  const unregisterLate = owner.ctx.tools.register(tool(LATE, false));
  const delta = bridge.syncTools();
  assert.deepEqual(delta.unregistered, [SCOPED]);
  assert.deepEqual(delta.registered, [LATE]);
  assert(!bridge.registry.has(SCOPED), "removed scoped entry must leave the registry");
  await run(owner, [GLOBAL, LATE], [LATE]);
  assert(executions.at(-1)?.name === LATE && executions.at(-1)?.agent === owner);
  unregisterLate();
  await run(owner, [GLOBAL], [GLOBAL]);
  await run(sibling, [GLOBAL], []);
  assert.equal(preExecute, 4);
  assert(executions.every((exec) => exec.agent === exec.initiator), "all executions must retain their initiator");
  console.log("[preset-tools] PASS: per-turn scoped add/remove refresh and global control preserved");
  await ownerHandle.dispose();
  await siblingHandle.dispose();
  clearTimeout(watchdog);
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error("[preset-tools] FAIL:", error);
  process.exit(1);
});
