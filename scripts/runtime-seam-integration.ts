/**
 * dsh 运行时窄接缝集成探针（T15）。
 *
 * 覆盖：
 * a. 独立扩展插件经 `zcodeLoopRuntimes.resolve(agent)` 取得本工厂 runtime，
 *    读取最小公共面并跑一个 turn。
 * b. 非本工厂 Agent 明确报错（含 "not a zcode-loop agent" 语义）。
 * c. agent dispose 后 resolve 拒绝；工厂卸载后服务不可达、视图已释放、
 *    监听方不再收到泄漏通知。
 * d. 扩展插件卸载释放其监听与命令；只访问 dsh 的扩展不依赖本服务。
 *
 * 场景各自独立 Context，避免跨场景服务残留。
 */
import assert from "node:assert/strict";

import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import LlmRuntime, { createUserMessage, LlmAdapter } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import ZcodeLoop from "../src/index.js";
import type { ZcodeLoopRuntimeView } from "../src/index.js";

const PROVIDER = "seam";

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "seam reply" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "seam reply" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

interface Harness {
  ctx: Context;
  adapter: ScriptedAdapter;
  loop: Awaited<ReturnType<typeof mountLoop>>;
}

async function mountLoop(ctx: Context) {
  return ctx.plugin(ZcodeLoop, { provider: PROVIDER, model: "mock" });
}

async function createHarness(): Promise<Harness> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(AgentRegistry);
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter([PROVIDER], adapter);
  const loop = await mountLoop(ctx);
  return { ctx, adapter, loop };
}

function createAgent(ctx: Context, id: string): Promise<AgentHandle> {
  return ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: PROVIDER, model: "mock" },
  });
}

function message(text: string) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

interface ExtensionRecord {
  resolve(agent: Agent): ZcodeLoopRuntimeView;
  commandRegistered(agent: Agent): boolean;
  created: number;
  released: string[];
  lastCreated?: ZcodeLoopRuntimeView;
}

/**
 * 模拟独立扩展插件：只依赖公共 cordis 服务面（窄服务 + commands），
 * 监听/命令都注册在自己的 fiber 上，随插件 dispose 自动释放。
 */
function extensionPlugin(record: ExtensionRecord): Plugin {
  return Object.assign((ctx: Context) => {
    const runtimes = ctx.zcodeLoopRuntimes;
    record.resolve = (agent) => runtimes.resolve(agent);
    record.commandRegistered = (agent) => ctx.commands.find(agent, "seam-probe") !== undefined;
    ctx.on("zcode-loop/runtime-created", (view) => {
      record.created += 1;
      record.lastCreated = view;
    });
    ctx.on("zcode-loop/runtime-released", ({ agentId }) => {
      record.released.push(agentId);
    });
    ctx.commands.register({
      name: "seam-probe",
      description: "runtime seam probe command",
      handler: async () => ({ kind: "success", text: "seam ok" }),
    });
  }, { inject: ["zcodeLoopRuntimes", "commands"] });
}

/** 只访问 dsh 的扩展：注入列表刻意不含窄服务。 */
function dshOnlyPlugin(record: { loaded: boolean }): Plugin {
  return Object.assign((ctx: Context) => {
    record.loaded = true;
    ctx.commands.register({
      name: "dsh-only-probe",
      description: "plain dsh extension probe",
      handler: async () => ({ kind: "success", text: "dsh ok" }),
    });
  }, { inject: ["commands"] });
}

async function probeResolveAndDrive(): Promise<void> {
  const { ctx, adapter } = await createHarness();
  const record: ExtensionRecord = { created: 0, released: [], resolve: () => { throw new Error("unmounted"); }, commandRegistered: () => false };
  const extension = await ctx.plugin(extensionPlugin(record));
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(ctx, "seam-resolve");
    assert.equal(record.created, 1, "extension must observe exactly one creation");

    const view = record.resolve(handle.agent);
    assert.equal(view.agentId, String(handle.agent.id), "view must expose the dsh agent identity");
    assert.equal(String(view.runtime.getSessionId()).endsWith(String(handle.agent.id)), true,
      "runtime must belong to the resolved agent");
    assert.deepEqual(view.runtime.getSessionModelSelection(), { providerId: PROVIDER, modelId: "mock" });
    assert.equal(record.lastCreated?.runtime, view.runtime, "creation notification must carry the same runtime handle");

    handle.agent.followup(message("drive through the resolved runtime"));
    await handle.agent.whenIdle();
    assert.equal(adapter.requests.length, 1, "resolved handle must correspond to a live, drivable agent");
    assert.equal(view.runtime.hasActiveOrQueuedTurnWork(), false);
    console.log("[runtime-seam] a. extension resolves the factory runtime and drives a turn");
  } finally {
    await handle?.dispose();
    await extension.dispose();
    await ctx.fiber.dispose();
  }
}

async function probeForeignAgent(): Promise<void> {
  const { ctx } = await createHarness();
  const record: ExtensionRecord = { created: 0, released: [], resolve: () => { throw new Error("unmounted"); }, commandRegistered: () => false };
  const extension = await ctx.plugin(extensionPlugin(record));
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(ctx, "seam-foreign");
    const foreign = { id: SessionId("stock-agent") } as Agent;
    assert.throws(
      () => record.resolve(foreign),
      /not a zcode-loop agent/,
      "foreign agents must be rejected explicitly",
    );
    assert.throws(
      () => ctx.zcodeLoopRuntimes.resolve(foreign),
      /not a zcode-loop agent/,
      "the service itself must reject foreign agents",
    );
    assert.equal(record.created, 1, "foreign resolve must not publish anything");
    console.log("[runtime-seam] b. foreign agents are rejected explicitly");
  } finally {
    await handle?.dispose();
    await extension.dispose();
    await ctx.fiber.dispose();
  }
}

async function probeRelease(): Promise<void> {
  const { ctx, loop } = await createHarness();
  const record: ExtensionRecord = { created: 0, released: [], resolve: () => { throw new Error("unmounted"); }, commandRegistered: () => false };
  const extension = await ctx.plugin(extensionPlugin(record));
  let handle: AgentHandle | undefined;
  let second: AgentHandle | undefined;
  try {
    handle = await createAgent(ctx, "seam-dispose");
    assert.equal(record.resolve(handle.agent).agentId, String(handle.agent.id));
    await handle.dispose();
    assert.throws(
      () => record.resolve(handle!.agent),
      /not published or has been released/,
      "agent dispose must remove the resolvable view",
    );
    assert.deepEqual(record.released, [String(handle.agent.id)], "release notification must name the disposed agent");

    second = await createAgent(ctx, "seam-factory-unload");
    assert.equal(record.created, 2);
    const service = ctx.zcodeLoopRuntimes;
    assert.equal(service.resolve(second.agent).agentId, String(second.agent.id));

    // 不 inject 服务的观察者仍能看到释放通知；注入服务的扩展会在服务注销时
    // 被 cordis 自动卸载（依赖消失），其监听随 fiber 释放，不再收到后续事件。
    const observed: string[] = [];
    ctx.on("zcode-loop/runtime-released", ({ agentId }) => observed.push(agentId));
    const createdBeforeUnload = record.created;
    const releasedBeforeUnload = record.released.length;
    await loop.dispose();
    assert.equal(ctx.get("zcodeLoopRuntimes"), undefined, "factory unload must unregister the service");
    assert.throws(
      () => service.resolve(second!.agent),
      /not published or has been released/,
      "factory unload must release live views",
    );
    assert.deepEqual(observed, [String(second.agent.id)], "factory unload must notify the live release");
    assert.equal(record.released.length, releasedBeforeUnload,
      "a service-dependent listener must be released before the unload notification");
    assert.equal(ctx.commands.find(second.agent, "seam-probe"), undefined,
      "dependency unload must release the extension command");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(record.created, createdBeforeUnload, "no creation notifications may leak after unload");
    assert.equal(record.released.length, releasedBeforeUnload, "no release notifications may leak after unload");
    assert.deepEqual(observed, [String(second.agent.id)], "observer must see exactly one release notification");
    console.log("[runtime-seam] c. dispose/unload leaves no resolvable runtime reference");
  } finally {
    await second?.dispose().catch(() => {});
    await handle?.dispose().catch(() => {});
    await extension.dispose().catch(() => {});
    await ctx.fiber.dispose();
  }
}

async function probeExtensionUnload(): Promise<void> {
  const { ctx } = await createHarness();
  const record: ExtensionRecord = { created: 0, released: [], resolve: () => { throw new Error("unmounted"); }, commandRegistered: () => false };
  const extension = await ctx.plugin(extensionPlugin(record));
  let first: AgentHandle | undefined;
  let second: AgentHandle | undefined;
  try {
    first = await createAgent(ctx, "seam-extension-unload");
    assert.equal(record.created, 1);
    assert.equal(record.commandRegistered(first.agent), true, "extension command must be visible while mounted");

    await extension.dispose();
    assert.equal(ctx.commands.find(first.agent, "seam-probe"), undefined, "extension dispose must release its command");

    second = await createAgent(ctx, "seam-after-extension-unload");
    assert.equal(record.created, 1, "extension dispose must release its creation listener");
    await second.dispose();
    assert.deepEqual(record.released, [], "extension dispose must release its release listener");
    assert.equal(ctx.zcodeLoopRuntimes.resolve(first.agent).agentId, String(first.agent.id),
      "the narrow service must remain usable by other consumers");

    const pure: { loaded: boolean } = { loaded: false };
    const pureExtension = await ctx.plugin(dshOnlyPlugin(pure));
    try {
      assert.equal(pure.loaded, true, "a dsh-only extension must not depend on the runtime seam");
      assert.notEqual(ctx.commands.find(second.agent, "dsh-only-probe"), undefined,
        "dsh-only extension contributions must keep working");
    } finally {
      await pureExtension.dispose();
    }
    console.log("[runtime-seam] d. extension unload releases listeners/commands; dsh-only extensions stay independent");
  } finally {
    await second?.dispose().catch(() => {});
    await first?.dispose().catch(() => {});
    await ctx.fiber.dispose();
  }
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("[runtime-seam] FAIL: watchdog expired");
    process.exit(1);
  }, 60_000);
  watchdog.unref();
  await probeResolveAndDrive();
  await probeForeignAgent();
  await probeRelease();
  await probeExtensionUnload();
  clearTimeout(watchdog);
  console.log("[runtime-seam] PASS: a-d runtime seam verified");
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error("[runtime-seam] FAIL:", error);
  process.exit(1);
});
