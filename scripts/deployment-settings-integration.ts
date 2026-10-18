/**
 * 部署与设置集成探针（T22）。
 *
 * 覆盖：
 * a. headless 形态装配：真实 Loader 树（同 headless 核心服务集 + zcode-loop 唯一
 *    工厂）跑 create → turn → resume，durable JSONL 完整。
 * b. SDK-minimal 形态装配：SDK-minimal 不含 settings/config-editor，其余程序化面
 *    与 headless 高度重合；共用装配并注明，同样跑 create/turn/resume。
 * c. 单工厂一致性：两种装配的 `ctx.agents` 工厂唯一且为 ZcodeLoop；stock
 *    `agent-loop` row 禁用。另用真实 bundle patch 组合（dsh-base + headless、
 *    sdk-minimal）验证 repo patch 的 disable+insert 语义（web 形态同 base 组合，
 *    由主 agent Browser 验收覆盖，不在本探针重复）。
 * d. 可选插件卸载/重载：PersistentJs 加载→用→卸载→重载→再可用；zcode-loop 本体
 *    经 Loader 禁用（fiber 卸载）后工厂注销，同 id 重新启用后 create/turn 可用。
 * e. 设置接线：真实 dsh-settings + config-editor + Loader，`settings.describe/update`
 *    只暴露 volatile 的 provider/model；写入后下一请求生效且持久化到 profile patch。
 *    stock 专属字段：`maxParallelToolCalls` 映射到 toolConcurrency，其他字段显式
 *    拒绝/告警，非 volatile 字段经 settings 写入被显式拒绝。
 * f. 凭证保留：装配/任务/设置/卸载/重载前后 $DSH_HOME 凭证与旁路配置字节不变。
 *
 * 边界：shipped settings 页（dsh-client-ui-settings-agent-loop）绑定 `agent-loop`
 * namespace 与 `maxParallelToolCalls` 字段；本插件 row 语义要求 stock row 禁用 +
 * `zcode-loop` 注册（repo cordis.patch.yml），因此该页面不会挂到本插件。探针驱动
 * 的是页面背后的真实 settings/config-editor/Loader 通路，不伪造 UI。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { boot, composeEntries, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import SessionStore from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import ZcodeLoop, { PersistentJs } from "../src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_PATCH = join(REPO_ROOT, "cordis.patch.yml");
const PLUGIN_NAME = "dsh-plugin-zcode-loop";

type Label = "headless" | "sdk-minimal";

/** 每个形态使用的受控路由（同一 adapter 同时注册两组 provider/model）。 */
interface Route {
  provider: string;
  model: string;
}

const ROUTE_A: Route = { provider: "probe-a", model: "model-a" };
const ROUTE_B: Route = { provider: "probe-b", model: "model-b" };

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model });
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const text = `reply-${this.requests.length}`;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

interface SettingsDescriptor {
  autoGenerate: boolean;
  ns: string;
  revision: number;
  value: Record<string, unknown>;
  base: Record<string, unknown>;
  user: Record<string, unknown>;
}

interface SettingsLike {
  describe(): SettingsDescriptor[];
  update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void>;
}

interface LogRecord {
  type: string;
  args: unknown[];
}

interface Assembly {
  ctx: Context;
  adapter: ScriptedAdapter;
  settings?: SettingsLike;
  profilePatch: string;
  home: string;
  root: string;
  logs: LogRecord[];
  /** 装配前写入的 $DSH_HOME 凭证/旁路配置字节快照。 */
  credentials: Map<string, Buffer>;
  dispose(): Promise<void>;
}

interface AssemblyOptions {
  label: Label;
  settings: boolean;
  /** stock agent-loop row 上遗留的旧设置（用于映射/告警断言）。 */
  stockConfig: Record<string, unknown>;
}

function message(text: string) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(message(text));
  await agent.whenIdle();
}

function runtimeOf(agent: Agent): {
  config?: { toolConcurrency?: { maxConcurrency?: number } };
  getSessionModelSelection?: () => { providerId: string; modelId: string } | undefined;
} {
  return (agent as unknown as {
    deps?: {
      runtime?: {
        config?: { toolConcurrency?: { maxConcurrency?: number } };
        getSessionModelSelection?: () => { providerId: string; modelId: string } | undefined;
      };
    };
  }).deps?.runtime ?? {};
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** 让临时 profile 解析 `@deepseek-ai/*` 与本插件包名（Loader 从 profile 向上查找）。 */
function prepareProfileRoot(root: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules", "@deepseek-ai"), join(root, "node_modules", "@deepseek-ai"), "dir");
  const proxy = join(root, "node_modules", PLUGIN_NAME);
  mkdirSync(proxy, { recursive: true });
  writeFileSync(join(proxy, "package.json"), `${JSON.stringify({
    name: PLUGIN_NAME,
    version: "0.0.0",
    private: true,
    type: "module",
    exports: { ".": "./index.js" },
  }, null, 2)}\n`);
  // tsx 负责 .ts 解析；Loader 只看到普通包名（与 repo patch 的 name 一致）。
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  writeFileSync(
    join(proxy, "index.js"),
    `export { default } from ${JSON.stringify(pathToFileURL(entry).href)};\nexport * from ${JSON.stringify(pathToFileURL(entry).href)};\n`,
  );
}

function profilePatchFor(options: AssemblyOptions): string {
  return [
    "# generated by scripts/deployment-settings-integration.ts — repo patch semantics, probe route",
    "- id: agent-loop",
    "  disabled: true",
    "- insert:",
    "    - id: zcode-loop",
    `      name: ${JSON.stringify(PLUGIN_NAME)}`,
    "      config:",
    `        provider: ${ROUTE_A.provider}`,
    `        model: ${ROUTE_A.model}`,
    "",
  ].join("\n");
}

function coreRootConfig(options: AssemblyOptions, sessionsRoot: string): string {
  const rows = [
    "- id: agent-loop",
    "  name: '@deepseek-ai/dsh-agent-loop'",
    "  disabled: true",
    "  config:",
    ...Object.entries(options.stockConfig).flatMap(([key, value]) => {
      const rendered = JSON.stringify(value);
      return [`    ${key}: ${rendered}`];
    }),
    "- id: llm",
    "  name: '@deepseek-ai/dsh-llm'",
    "- id: session",
    "  name: '@deepseek-ai/dsh-session'",
    "- id: system-prompt",
    "  name: '@deepseek-ai/dsh-system-prompt'",
    "  config: {}",
    "- id: tools",
    "  name: '@deepseek-ai/dsh-tools'",
    "- id: agents",
    "  name: '@deepseek-ai/dsh-agent'",
    "- id: sessions",
    "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    "  config:",
    `    root: ${JSON.stringify(sessionsRoot)}`,
    "    compression: none",
  ];
  if (options.settings) {
    rows.push(
      "- id: config-editor",
      "  name: '@deepseek-ai/dsh-config-editor'",
      "- id: settings",
      "  name: '@deepseek-ai/dsh-settings'",
    );
  }
  rows.push("");
  return rows.join("\n");
}

async function mountAssembly(options: AssemblyOptions): Promise<Assembly> {
  const root = mkdtempSync(join(tmpdir(), `t22-${options.label}-`));
  prepareProfileRoot(root);
  const home = join(root, "home");
  const profileDir = join(root, "profiles", options.label);
  const sessionsRoot = join(home, "sessions");
  mkdirSync(home, { recursive: true });
  // 凭证/旁路配置必须在装配前落盘，才能证明整个生命周期不触碰它们。
  const credentials = seedCredentialFixtures(home);
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });
  writeFileSync(join(profileDir, "package.json"), `${JSON.stringify({
    name: `dsh-profile-${options.label}`,
    private: true,
    dsh: { profile: { bundles: [] } },
  }, null, 2)}\n`);
  const profilePatch = join(profileDir, "cordis.patch.yml");
  writeFileSync(profilePatch, profilePatchFor(options));
  const rootConfig = join(profileDir, "cordis.yml");
  writeFileSync(rootConfig, coreRootConfig(options, sessionsRoot));

  const profileContext = {
    name: options.label,
    dir: profileDir,
    patchPath: profilePatch,
    installAnchor: join(REPO_ROOT, "package.json"),
    home,
    cwd: REPO_ROOT,
    startedBundles: [],
    overlays: [],
  };

  const logs: LogRecord[] = [];
  const patches = loadOverlayPatches(options.label, profilePatch);
  const ctx = await boot(options.label, rootConfig, patches, async (hostCtx) => {
    hostCtx.provide("profileContext", profileContext);
    hostCtx.logger.exporter({
      levels: { default: 3 },
      export: (record: LogRecord) => logs.push(record),
    });
  });

  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter([ROUTE_A.provider, ROUTE_B.provider], adapter);
  const settings = options.settings
    ? (ctx.get("settings") as unknown as SettingsLike | undefined)
    : undefined;
  if (options.settings) assert(settings !== undefined, "headless assembly must expose ctx.settings");

  return {
    ctx,
    adapter,
    ...(settings === undefined ? {} : { settings }),
    profilePatch,
    home,
    root,
    logs,
    credentials,
    async dispose() {
      await ctx.fiber.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function bundlePatch(packageName: string): string {
  return join(REPO_ROOT, "node_modules", packageName, "cordis.patch.yml");
}

/** 真实 bundle 层 + repo patch 的组合（web 同 base 组合；web 本身由 Browser 验收）。 */
function composedRows(label: Label): Array<{ id?: string; name?: string; disabled?: boolean; config?: unknown }> {
  const bundles = label === "headless"
    ? ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
    : ["@deepseek-ai/dsh-sdk-minimal"];
  const layers = [
    ...bundles.map(name => loadOverlayPatches(label, bundlePatch(name))),
    loadOverlayPatches("dsh", REPO_PATCH),
  ];
  return composeEntries(layers) as Array<{ id?: string; name?: string; disabled?: boolean; config?: unknown }>;
}

function assertLoaderComposition(label: Label): void {
  const rows = composedRows(label);
  const stockRows = rows.filter(row => row.id === "agent-loop" && row.name === "@deepseek-ai/dsh-agent-loop");
  assert.equal(stockRows.length, 1, `${label}: composition must carry exactly one stock agent-loop row`);
  assert.equal(stockRows[0].disabled, true, `${label}: repo patch must disable the stock agent-loop row`);
  const loops = rows.filter(row => row.id === "zcode-loop");
  assert.equal(loops.length, 1, `${label}: composition must insert exactly one zcode-loop row`);
  assert.equal(loops[0].name, PLUGIN_NAME, `${label}: inserted row must point at this plugin`);
  assert.notEqual(loops[0].disabled, true, `${label}: inserted zcode-loop row must be enabled`);
  const enabledStockLoops = rows.filter(
    row => row.name === "@deepseek-ai/dsh-agent-loop" && row.disabled !== true,
  );
  assert.equal(enabledStockLoops.length, 0, `${label}: no enabled stock loop factory row may survive`);
  console.log(`[deployment-settings] PASS composition/${label}: stock agent-loop disabled, zcode-loop inserted`);
}

function assertSingleFactory(assembly: Assembly, label: Label): void {
  const { ctx } = assembly;
  assert.equal(ctx.get("agentLoop"), undefined, `${label}: stock agentLoop service must be absent`);
  const loop = ctx.get("zcodeLoop");
  assert(loop instanceof ZcodeLoop, `${label}: zcodeLoop service must be the replacement factory`);
  // `ctx.get` returns a traceable wrapper; `factory.target` is the original instance.
  const factory = (ctx.agents as unknown as { factory?: { target?: unknown } }).factory;
  assert(factory !== undefined, `${label}: agents factory slot must be registered`);
  assert(factory.target instanceof ZcodeLoop, `${label}: the only factory must be ZcodeLoop`);
  assert.throws(
    () => ctx.agents.setFactory({} as never),
    /already registered/,
    `${label}: a second factory must be rejected`,
  );
  const entries = [...ctx.loader.entries()];
  const stock = entries.find(entry => entry.options.id === "agent-loop");
  assert(stock !== undefined, `${label}: loader must retain the disabled stock row`);
  assert.equal(stock.disabled, true, `${label}: stock loop row must stay disabled at runtime`);
  const loops = entries.filter(entry => entry.options.id === "zcode-loop");
  assert.equal(loops.length, 1, `${label}: exactly one zcode-loop loader entry`);
  assert.equal(loops[0].disabled, false, `${label}: zcode-loop loader entry must be enabled`);
  assert.equal(loops[0].options.name, PLUGIN_NAME, `${label}: loader row name must match the repo patch`);
  console.log(`[deployment-settings] PASS single-factory/${label}: ZcodeLoop is the unique ctx.agents factory`);
}

async function assertDurable(label: Label, ctx: Context, id: string): Promise<void> {
  const persistence = ctx.get("sessionPersistence") as unknown as {
    open(id: ReturnType<typeof SessionId>, mode: "read"): Promise<{
      read(): Promise<{ events: Array<{ type: string }> }>;
      close(): Promise<void>;
    }>;
  } | undefined;
  assert(persistence !== undefined, `${label}: durable session backend must be mounted`);
  const handle = await persistence.open(SessionId(id), "read");
  try {
    const { events } = await handle.read();
    const types = events.map(event => event.type);
    assert(types.filter(type => type === "turn/start").length >= 2, `${label}: durable log must hold both turns`);
    assert(types.filter(type => type === "turn/end").length >= 2, `${label}: both turns must close`);
    assert(types.filter(type => type === "user/message").length >= 2, `${label}: both user messages must persist`);
    assert(types.filter(type => type === "assistant/message").length >= 2, `${label}: both assistant messages must persist`);
    console.log(`[deployment-settings] PASS durable/${label}: ${types.length} events, two complete turns`);
  } finally {
    await handle.close();
  }
}

async function representativeTask(assembly: Assembly, label: Label): Promise<void> {
  const { ctx, adapter } = assembly;
  const id = `${label}-representative-session`;
  const created = await ctx.agents.create({ sessionId: SessionId(id) });
  try {
    await send(created.agent, "first representative turn");
    assert.equal(adapter.requests.at(-1)?.provider, ROUTE_A.provider, `${label}: first request route`);
    assert.equal(adapter.requests.at(-1)?.model, ROUTE_A.model, `${label}: first request model`);
  } finally {
    await created.dispose();
  }

  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId(id) });
  try {
    assert(resumed.agent.session.snapshotEvents().some(event => event.type === "turn/start"),
      `${label}: resume must seed the prior durable history`);
    await send(resumed.agent, "second representative turn");
    assert(adapter.requests.length >= 2, `${label}: resumed agent must issue a request`);
  } finally {
    // 写句柄关闭后 JSONL 才完成 flush；durable 断言必须读关闭后的日志。
    await resumed.dispose();
  }
  await assertDurable(label, ctx, id);
  console.log(`[deployment-settings] PASS representative/${label}: create+turn+resume with durable history`);
}

async function settingsProbe(assembly: Assembly): Promise<void> {
  const settings = assembly.settings;
  assert(settings !== undefined, "headless assembly must expose the settings service");

  const descriptors = settings.describe();
  const descriptor = descriptors.find(row => row.ns === "zcode-loop");
  assert(descriptor !== undefined, "settings must expose the zcode-loop entry");
  assert.equal(descriptor.autoGenerate, true, "form auto-generation flag must be available");
  assert.deepEqual(
    Object.keys(descriptor.value).sort(),
    ["model", "provider"],
    "only volatile provider/model may be exposed as live settings",
  );
  assert(
    !descriptors.some(row => row.ns === "agent-loop"),
    "the disabled stock agent-loop namespace must not be exposed as a settings form",
  );
  await assert.rejects(
    () => settings.update("agent-loop", { maxParallelToolCalls: 4 }),
    /No configurable plugin entry/,
    "writes to the disabled stock namespace must fail explicitly, not no-op silently",
  );
  console.log("[deployment-settings] PASS settings-describe: zcode-loop exposes live provider/model; stock namespace closed");

  // stock 专属/启动期字段不是 volatile：经 settings 写入必须显式拒绝，不能静默吞掉。
  await assert.rejects(
    () => settings.update("zcode-loop", { maxParallelToolCalls: 4 }),
    /not volatile/,
    "settings must refuse non-volatile stock fields instead of silently ignoring them",
  );
  console.log("[deployment-settings] PASS settings-reject: non-volatile stock field refused");

  const live = await assembly.ctx.agents.create({ sessionId: SessionId("settings-live-route") });
  try {
    await send(live.agent, "route A");
    assert.equal(assembly.adapter.requests.at(-1)?.provider, ROUTE_A.provider);
    assert.equal(assembly.adapter.requests.at(-1)?.model, ROUTE_A.model);

    await settings.update("zcode-loop", { provider: ROUTE_B.provider, model: ROUTE_B.model });
    const loop = assembly.ctx.get("zcodeLoop") as unknown as { config: { provider: { get(): string }; model: { get(): string } } };
    assert.equal(loop.config.provider.get(), ROUTE_B.provider, "settings write must commit the volatile provider");
    assert.equal(loop.config.model.get(), ROUTE_B.model, "settings write must commit the volatile model");
    await until(
      () => runtimeOf(live.agent).getSessionModelSelection?.()?.modelId === ROUTE_B.model,
      "live agent route selection",
    );
    await send(live.agent, "route B");
    assert.equal(assembly.adapter.requests.at(-1)?.provider, ROUTE_B.provider, "next request must use the settings route");
    assert.equal(assembly.adapter.requests.at(-1)?.model, ROUTE_B.model, "next request must use the settings model");
    assert.match(readFileSync(assembly.profilePatch, "utf8"), /provider: probe-b/, "settings must persist into the profile patch");
    console.log("[deployment-settings] PASS settings-live: updated provider/model applies to the next request and persists");
  } finally {
    await live.dispose();
  }
}

async function stockSettingsProbe(assembly: Assembly): Promise<void> {
  const stockWarnings = assembly.logs
    .filter(record => record.type === "warn")
    .map(record => String(record.args[0] ?? ""));
  assert(
    stockWarnings.some(line => /unsupported setting\(s\) streamingToolExecution/.test(line)),
    "unsupported stock field must produce an explicit warning",
  );
  assert(
    stockWarnings.some(line => /declares agents/.test(line)),
    "non-empty stock agents must produce an explicit warning",
  );
  const mapped = assembly.logs
    .filter(record => record.type === "info")
    .map(record => String(record.args[0] ?? ""));
  assert(
    mapped.some(line => /mapped disabled stock agent-loop maxParallelToolCalls=3 to toolConcurrency/.test(line)),
    "stock maxParallelToolCalls must be mapped explicitly",
  );

  const handle = await assembly.ctx.agents.create({ sessionId: SessionId("stock-mapped-concurrency") });
  try {
    assert.equal(
      runtimeOf(handle.agent).config?.toolConcurrency?.maxConcurrency,
      3,
      "stock maxParallelToolCalls must reach the engine as toolConcurrency",
    );
    console.log("[deployment-settings] PASS stock-settings: mapped maxParallelToolCalls; other stock fields warned");
  } finally {
    await handle.dispose();
  }
}

/** 本 row 上的 stock 专属字段必须显式报错/提示（不能靠 schema 静默合并）。 */
async function configCompatibilityProbe(): Promise<void> {
  const ctx = await mountCore();
  try {
    await pluginRejects(ctx, { provider: "mock", model: "m", agents: [{ id: "legacy" }] }, /declarative agents/);
    await pluginRejects(ctx, { provider: "mock", model: "m", streamingToolExecution: true }, /does not support stock agent-loop config field/);
    await pluginRejects(ctx, { provider: "mock", model: "m", agents: "invalid" }, /declarative agents/);

    const fiber = await ctx.plugin(ZcodeLoop, {
      provider: "mock",
      model: "m",
      agents: [],
      maxParallelToolCalls: 4,
    } as never);
    try {
      const adapter = new ScriptedAdapter();
      ctx.llm.registerAdapter(["mock"], adapter);
      const handle = await ctx.agents.create({ sessionId: SessionId("config-alias") });
      try {
        assert.equal(
          runtimeOf(handle.agent).config?.toolConcurrency?.maxConcurrency,
          4,
          "maxParallelToolCalls alias must map to toolConcurrency",
        );
        await send(handle.agent, "alias");
      } finally {
        await handle.dispose();
      }
    } finally {
      await fiber.dispose();
    }
    console.log("[deployment-settings] PASS stock-config-shape: unsupported fields throw; maxParallelToolCalls maps");
  } finally {
    await ctx.fiber.dispose();
  }
}

/** 只装构造期依赖的裸 Context（用于配置形状负向断言）。 */
async function mountCore(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  return ctx;
}

async function pluginRejects(ctx: Context, config: unknown, expected: RegExp): Promise<void> {
  await assert.rejects(async () => { await ctx.plugin(ZcodeLoop, config as never); }, expected);
}

async function optionalPluginProbe(assembly: Assembly): Promise<void> {
  const { ctx } = assembly;
  const jsPlugin = await ctx.plugin(PersistentJs);
  let first: AgentHandle | undefined;
  let second: AgentHandle | undefined;
  try {
    first = await ctx.agents.create({ sessionId: SessionId("optional-js-before") });
    const before = ctx.tools.schemas(first.agent).map(schema => schema.name);
    assert(before.includes("js"), "persistent-js must register its tool while loaded");
    const result = await ctx.tools.execute({
      callId: ToolCallId("optional-js-before-call"),
      name: "js",
      arguments: { code: "1 + 1" },
      agent: first.agent,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false, "persistent-js tool must execute while loaded");
    assert(result.content.some(block => block.type === "text" && block.text.includes("2")),
      "persistent-js result must carry the evaluated value");

    await jsPlugin.dispose();
    assert(!ctx.tools.schemas(first.agent).map(schema => schema.name).includes("js"),
      "plugin unload must remove its tool from the live agent");

    const reloaded = await ctx.plugin(PersistentJs);
    try {
      second = await ctx.agents.create({ sessionId: SessionId("optional-js-after") });
      assert(ctx.tools.schemas(second.agent).map(schema => schema.name).includes("js"),
        "plugin reload must make the tool usable again");
      const again = await ctx.tools.execute({
        callId: ToolCallId("optional-js-after-call"),
        name: "js",
        arguments: { code: "2 + 2" },
        agent: second.agent,
        signal: new AbortController().signal,
      });
      assert.equal(again.isError, false, "reloaded persistent-js tool must execute");
    } finally {
      await reloaded.dispose();
    }
    console.log("[deployment-settings] PASS optional-plugin: load/use/unload/reload/use");
  } finally {
    await second?.dispose().catch(() => {});
    await first?.dispose().catch(() => {});
    try { await jsPlugin.dispose(); } catch { /* already disposed */ }
  }
}

async function loopUnloadReloadProbe(assembly: Assembly): Promise<void> {
  const { ctx } = assembly;
  const entry = [...ctx.loader.entries()].find(row => row.options.id === "zcode-loop");
  assert(entry !== undefined, "zcode-loop loader entry must exist");
  const updateEntry = (entry as unknown as { update(options: Record<string, unknown>): Promise<void> }).update.bind(entry);
  const before = ctx.get("zcodeLoop");

  await updateEntry({ disabled: true });
  assert.equal(ctx.get("zcodeLoop"), undefined, "disabling the row must unregister the factory service");
  await assert.rejects(
    () => ctx.agents.create({ sessionId: SessionId("after-loop-unload") }),
    /no agent factory registered/,
    "create must fail explicitly while the factory is unloaded",
  );

  await updateEntry({ disabled: false });
  await ctx.loader.await();
  const after = ctx.get("zcodeLoop");
  assert(after instanceof ZcodeLoop, "re-enabling the same row must restore the factory");
  assert.notStrictEqual(after, before, "reload must build a fresh factory instance");
  const handle = await ctx.agents.create({ sessionId: SessionId("after-loop-reload") });
  try {
    await send(handle.agent, "after reload");
    // 设置探针已把 profile patch 的 provider/model 改为 route B；重载后沿用。
    assert.equal(assembly.adapter.requests.at(-1)?.provider, ROUTE_B.provider,
      "reloaded factory must read the persisted settings route");
    assert.equal(assembly.adapter.requests.at(-1)?.model, ROUTE_B.model);
  } finally {
    await handle.dispose();
  }
  console.log("[deployment-settings] PASS loop-reload: unload unregisters the factory; same-id reload creates and drives");
}

function credentialFiles(home: string): string[] {
  return [
    join(home, ".credentials.yaml"),
    join(home, ".env"),
    // 不用 settings.yaml：dsh-settings 会在 boot 后有意导入并改名 legacy document，
    // 那是宿主迁移行为，不属于本插件启停/重载的凭证保留断言。
    join(home, "config-sentinel.yaml"),
  ];
}

function seedCredentialFixtures(home: string): Map<string, Buffer> {
  const contents = new Map<string, Buffer>([
    [join(home, ".credentials.yaml"), Buffer.from("deepseek:\n  apiKey: probe-secret\n")],
    [join(home, ".env"), Buffer.from("PROBE_ENV=1\n")],
    [join(home, "config-sentinel.yaml"), Buffer.from("- id: sentinel\n  config:\n    untouched: true\n")],
  ]);
  for (const [path, bytes] of contents) writeFileSync(path, bytes);
  return contents;
}

function assertCredentialsUnchanged(home: string, before: Map<string, Buffer>): void {
  for (const path of credentialFiles(home)) {
    const expected = before.get(path);
    assert(expected !== undefined, `missing credential fixture ${path}`);
    assert(readFileSync(path).equals(expected), `${path} must stay byte-identical across the lifecycle`);
  }
}

async function runAssembly(label: Label, options: { settings: boolean; runSettings: boolean }): Promise<void> {
  const assembly = await mountAssembly({
    label,
    settings: options.settings,
    stockConfig: {
      maxParallelToolCalls: 3,
      streamingToolExecution: true,
      agents: [{ id: "legacy" }],
    },
  });
  try {
    assertSingleFactory(assembly, label);
    await representativeTask(assembly, label);
    if (options.runSettings) {
      await stockSettingsProbe(assembly);
      await settingsProbe(assembly);
      await loopUnloadReloadProbe(assembly);
    }
    await optionalPluginProbe(assembly);
  } finally {
    assertCredentialsUnchanged(assembly.home, assembly.credentials);
    await assembly.dispose();
  }
  console.log(`[deployment-settings] PASS credentials: fixtures byte-identical after ${label} lifecycle`);
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("[deployment-settings] FAIL: watchdog expired");
    process.exit(1);
  }, 180_000);
  watchdog.unref();

  assertLoaderComposition("headless");
  assertLoaderComposition("sdk-minimal");

  // a/c/d/e/f：headless 形态（含 settings/config-editor）。
  await runAssembly("headless", { settings: true, runSettings: true });

  // b：SDK-minimal 形态（不含 settings；程序化 agent 面与 headless 共用装配）。
  await runAssembly("sdk-minimal", { settings: false, runSettings: false });

  // e 的裸配置形状负向断言（stock 专属字段显式报错/映射）。
  await configCompatibilityProbe();

  clearTimeout(watchdog);
  console.log("[deployment-settings] PASS: a-f deployment and settings probes green");
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error("[deployment-settings] FAIL:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
