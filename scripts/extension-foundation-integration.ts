/**
 * dsh 扩展基础集成探针（T09）。
 *
 * 用真实钉版 dsh 扩展插件 + mock adapter 验证：AGENTS.md 上下文、skill
 * 发现/加载、MCP 工具与资源、文件引用、agent scope 隔离、插件卸载。
 *
 * 约束：
 * - 插件对 ZCode 无感知：全部贡献走 dsh 既有服务接缝（systemPrompt/
 *   pre-step/tools/contexts），本探针不注册任何 ZCode 专属适配。
 * - 每个场景独立 Context，避免跨场景的全局注册残留。
 * - MCP server 是 node 内置模块实现的最小 stdio fixture（scripts/fixtures）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import * as AgentInstructions from "@deepseek-ai/dsh-agent-instructions";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import LocalFileReference, { FILE_REFERENCE_PROMPT, formatFileMention } from "@deepseek-ai/dsh-file-reference-local";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, RequestMessage, StreamChunk } from "@deepseek-ai/dsh-llm";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import McpResources from "@deepseek-ai/dsh-mcp-resources";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import * as SkillFilesystem from "@deepseek-ai/dsh-skill-filesystem";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as ToolSkill from "@deepseek-ai/dsh-tool-skill";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";

import ZcodeLoop from "../src/index.js";

const MCP_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo-server.mjs");
const MCP_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "mcp__fixture__echo", "read_mcp_resource"];

interface Step {
  /** 本步模型可见工具名（顺序无关）。 */
  tools: readonly string[];
  /** 以该工具调用收步；缺席则输出文本。 */
  call?: { name: string; input?: Record<string, unknown> };
  /** 对本次模型请求的断言。 */
  check?: (request: GenerateOptions) => void;
}

/** 逐步脚本化 adapter：同时断言每步可见工具面并把请求留存给场景断言。 */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly failures: string[] = [];
  steps: Step[] = [];

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const step = this.steps.shift();
    assert(step, "unexpected model request");
    try {
      assert.deepEqual(
        (options.tools ?? []).map((tool) => tool.name).sort(),
        [...step.tools].sort(),
        "model must see exactly the current dsh tool surface",
      );
      step.check?.(options);
    } catch (error) {
      this.failures.push(String(error));
      throw error;
    }
    if (step.call !== undefined) {
      const id = ToolCallId(`extension-call-${this.requests.length}`);
      const args = JSON.stringify(step.call.input ?? {});
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id, name: step.call.name, argumentsDelta: args };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: step.call.name, arguments: args } };
    } else {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "extension step complete" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "extension step complete" } };
    }
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", reason: { kind: step.call === undefined ? "stop" : "tool-calls" } };
  }
}

interface Harness {
  ctx: Context;
  adapter: ScriptedAdapter;
}

/** 最小 dsh 服务栈：session/llm/tools/prompt/投影/fs/workingDirectory/agent + zcode loop。 */
async function createHarness(workspace: string): Promise<Harness> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(SessionProjection);
  await ctx.plugin(LocalFileSystem, { cwd: workspace });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace });
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ZcodeLoop, { provider: "mock", model: "mock" });
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter(["mock"], adapter);
  return { ctx, adapter };
}

function messageText(message: RequestMessage): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

function textOf(request: GenerateOptions, role?: RequestMessage["role"]): string {
  return request.messages
    .filter((message) => role === undefined || message.role === role)
    .map(messageText)
    .join("\n");
}

function sourceOf(message: RequestMessage): { kind?: string; baseline?: boolean; changes?: unknown[] } | undefined {
  return (message as { source?: { kind?: string; baseline?: boolean; changes?: unknown[] } }).source;
}

async function createAgent(ctx: Context, id: string, workspace: string) {
  return ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: workspace },
    agentOptions: { provider: "mock", model: "mock" },
  });
}

/** 跑一个 turn：脚本必须正好消费 steps，且 adapter 未记录断言失败。 */
async function runTurn(agent: Agent, adapter: ScriptedAdapter, steps: Step[], input: string): Promise<GenerateOptions[]> {
  adapter.steps = [...steps];
  const before = adapter.requests.length;
  agent.followup(createUserMessage({ content: [{ type: "text", text: input }], source: { kind: "user" } }));
  await agent.whenIdle();
  assert.equal(adapter.failures.length, 0, adapter.failures.join("\n"));
  assert.equal(adapter.steps.length, 0, `script must drain exactly; ${adapter.steps.length} step(s) left`);
  const requests = adapter.requests.slice(before);
  assert.equal(requests.length, steps.length, "each scripted step must produce exactly one model request");
  return requests;
}

function probeTool(name: string) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true },
      render: () => [{ type: "text", text: `${name} executed` }],
    },
    execute: async () => ({}),
  });
}

async function makeWorkspace(root: string, name: string): Promise<string> {
  const workspace = join(root, name);
  await mkdir(join(workspace, ".git"), { recursive: true });
  return workspace;
}

/** a. AGENTS.md：真实 dsh-agent-instructions 的 durable user-role 上下文。 */
async function agentsInstructionsProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "agents-workspace");
  const emptyWorkspace = await makeWorkspace(root, "empty-workspace");
  const marker = "AGENTS_MD_FOUNDATION_MARKER";
  await writeFile(join(workspace, "AGENTS.md"), `# Project rules\n\n${marker}\n`);
  const { ctx, adapter } = await createHarness(workspace);
  const instructions = await ctx.plugin(
    AgentInstructions as unknown as Plugin.Object<{ maxBytes: number }>,
    { maxBytes: 65_536 },
  );
  const handle = await createAgent(ctx, "extension-agents-instructions", workspace);
  const emptyHandle = await createAgent(ctx, "extension-agents-empty", emptyWorkspace);
  try {
    await runTurn(handle.agent, adapter, [{
      tools: [],
      check(request) {
        // 真实插件语义：AGENTS.md 是 durable user-role 基线消息，而不是
        // system 段落贡献；两者都必须经同一请求送达模型。
        assert(!textOf(request, "system").includes(marker), "AGENTS.md must not be faked into the system section");
        assert(textOf(request, "user").includes(marker), "first request must carry the AGENTS.md baseline");
        assert.match(textOf(request, "user"), /Instructions from: AGENTS\.md/);
      },
    }], "read the workspace instructions");

    const baseline = handle.agent.session.snapshotEvents().find((event) =>
      event.type === "user/message"
      && event.data.source.kind === "agent-instructions"
      && event.data.source.baseline === true,
    );
    assert(baseline?.type === "user/message", "baseline source must be durable on the session surface");
    // dsh-agent-instructions 的 source 词表通过其模块声明扩展；探针只读
    // 公开的 changes 列表，用窄视图避免依赖插件内部类型。
    const baselineSource = baseline.data.source as unknown as { changes?: Array<{ path?: unknown }> };
    assert(
      (baselineSource.changes ?? []).some((change) => String(change.path).endsWith("AGENTS.md")),
      "baseline source must retain the instruction file identity",
    );

    const beforeSwitch = handle.agent.session.snapshotEvents()
      .filter((event) => event.type === "user/message" && event.data.source.kind === "agent-instructions").length;
    await ctx.workingDirectory.set(handle.agent, emptyWorkspace, undefined);
    await runTurn(handle.agent, adapter, [{
      tools: [],
      check(request) {
        assert(!textOf(request, "system").includes(marker), "workspace switch must not add a system residue");
        const instructionMessages = request.messages.filter((message) => sourceOf(message)?.kind === "agent-instructions");
        assert(
          !instructionMessages.slice(beforeSwitch).some((message) => sourceOf(message)?.baseline === true),
          "switching to a workspace without AGENTS.md must not re-contribute the old baseline",
        );
      },
    }], "continue after the working-directory change");

    const switchedMessages = handle.agent.session.snapshotEvents()
      .filter((event) => event.type === "user/message" && event.data.source.kind === "agent-instructions")
      .slice(beforeSwitch);
    assert(
      switchedMessages.every((event) => event.type === "user/message"
        && (event.data.source as unknown as { baseline?: boolean }).baseline !== true),
      "an empty workspace must contribute a removal notice, never a stale baseline",
    );
    assert(switchedMessages.length <= 1, "empty workspace switch must not accumulate instruction context");
    if (switchedMessages.length === 1) {
      const notice = switchedMessages[0]!;
      assert(notice.type === "user/message");
      assert(
        messageText(notice.data as unknown as RequestMessage).includes("Instructions removed"),
        "the persisted switch notice must explicitly retire the previous instructions",
      );
    }

    await runTurn(emptyHandle.agent, adapter, [{
      tools: [],
      check(request) {
        assert(!textOf(request, "user").includes(marker), "a fresh empty-workspace agent must never see another workspace's instructions");
        assert(
          !request.messages.some((message) => sourceOf(message)?.kind === "agent-instructions"),
          "no instruction context may leak across sessions",
        );
      },
    }], "fresh empty workspace");
    console.log("[extension-foundation] a. AGENTS.md baseline, workspace switch and cross-session isolation passed");
  } finally {
    await emptyHandle.dispose();
    await handle.dispose();
    await instructions.dispose();
    await ctx.fiber.dispose();
  }
}

/** b. skill 发现、目录渲染、工具加载与正文热读。 */
async function skillProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "skill-workspace");
  const skillsRoot = join(root, "skill-root");
  const skillFile = join(skillsRoot, "demo", "SKILL.md");
  await mkdir(dirname(skillFile), { recursive: true });
  const frontmatter = "---\nname: demo\ndescription: Foundation probe skill\n---\n\n# Demo skill\n\n";
  await writeFile(skillFile, `${frontmatter}SKILL_BODY_V1\n`);
  const { ctx, adapter } = await createHarness(workspace);
  const registry = await ctx.plugin(SkillRegistry as unknown as Plugin);
  const provider = await ctx.plugin(
    SkillFilesystem as unknown as Plugin.Object<{
      includeDefaultRoots: boolean;
      customSkillDirs: string[];
      watch: boolean;
    }>,
    { includeDefaultRoots: false, customSkillDirs: [skillsRoot], watch: false },
  );
  const toolPlugin = await ctx.plugin(ToolSkill as unknown as Plugin.Object<{ catalogDescriptionMaxLength?: number }>, {});
  const handle = await createAgent(ctx, "extension-skill", workspace);
  try {
    await runTurn(handle.agent, adapter, [
      {
        tools: ["skill"],
        call: { name: "skill", input: { name: "demo" } },
        check(request) {
          const users = textOf(request, "user");
          assert(users.includes("<available_skills>"), "session catalog must be in the first request");
          assert(users.includes("- `demo`: Foundation probe skill"), "catalog must list the discovered skill");
        },
      },
      {
        tools: ["skill"],
        check(request) {
          const toolResults = textOf(request, "tool");
          assert(toolResults.includes('<skill_content name="demo">'), "loaded skill must use the canonical skill_content shape");
          assert(toolResults.includes("SKILL_BODY_V1"), "tool result must carry the current skill body");
        },
      },
    ], "load the demo skill");

    await writeFile(skillFile, `${frontmatter}SKILL_BODY_V2\n`);
    await runTurn(handle.agent, adapter, [
      { tools: ["skill"], call: { name: "skill", input: { name: "demo" } } },
      {
        tools: ["skill"],
        check(request) {
          assert(textOf(request, "tool").includes("SKILL_BODY_V2"), "a body edit must be visible to the next skill load request");
        },
      },
    ], "reload the edited demo skill");

    const results = handle.agent.session.snapshotEvents().filter((event) => event.type === "tool/result");
    assert(results.length >= 2, "both skill loads must be durable tool results");
    console.log("[extension-foundation] b. skill discovery, catalog, tool load and body refresh passed");
  } finally {
    await handle.dispose();
    await toolPlugin.dispose();
    await provider.dispose();
    await registry.dispose();
    await ctx.fiber.dispose();
  }
}

/** c. MCP stdio 工具/资源经 dsh 管线进入请求，并在插件卸载后消失。 */
async function mcpProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "mcp-workspace");
  const { ctx, adapter } = await createHarness(workspace);
  const resources = await ctx.plugin(McpResources as unknown as Plugin);
  const client = await ctx.plugin(
    McpClient as unknown as Plugin.Object<{
      transport: "stdio";
      serverName: string;
      command: string;
      args: string[];
      cwd: string;
      toolCallTimeoutMs: number;
      failOnStartupError: boolean;
      reconnect: { enabled: boolean };
    }>,
    {
      transport: "stdio",
      serverName: "fixture",
      command: process.execPath,
      args: [MCP_FIXTURE],
      cwd: workspace,
      toolCallTimeoutMs: 10_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    },
  );
  const handle = await createAgent(ctx, "extension-mcp", workspace);
  try {
    await runTurn(handle.agent, adapter, [
      {
        tools: MCP_TOOLS,
        call: { name: "mcp__fixture__echo", input: { text: "CALL_MARKER" } },
        check(request) {
          assert(
            textOf(request, "system").includes("MCP_FIXTURE_INSTRUCTIONS_MARKER"),
            "MCP server instructions must join the assembled system prompt",
          );
        },
      },
      {
        tools: MCP_TOOLS,
        call: { name: "list_mcp_resources", input: { server: "fixture" } },
        check(request) {
          assert(textOf(request, "tool").includes("echo:CALL_MARKER"), "MCP tool result must reach the next request");
        },
      },
      {
        tools: MCP_TOOLS,
        call: { name: "read_mcp_resource", input: { server: "fixture", uri: "fixture://greeting" } },
        check(request) {
          assert(textOf(request, "tool").includes("fixture://greeting"), "MCP resource listing must reach the next request");
        },
      },
      {
        tools: MCP_TOOLS,
        check(request) {
          assert(textOf(request, "tool").includes("hello from mcp resource"), "MCP resource content must remain usable by the model");
        },
      },
    ], "exercise the MCP fixture");

    await client.dispose();
    assert(!ctx.tools.schemas(handle.agent).some((schema) => schema.name.startsWith("mcp__")),
      "MCP tool registrations must disappear with the plugin");
    await runTurn(handle.agent, adapter, [{
      tools: [],
      check(request) {
        assert(!textOf(request, "system").includes("MCP_FIXTURE_INSTRUCTIONS_MARKER"),
          "MCP server instructions must disappear from the next request after unload");
        assert(!request.messages.some((message) => messageText(message).includes("MCP_FIXTURE_INSTRUCTIONS_MARKER")),
          "no prompt residue may remain after plugin unload");
      },
    }], "after MCP client unload");
    console.log("[extension-foundation] c. MCP tools/resources and unload refresh passed");
  } finally {
    await handle.dispose();
    await resources.dispose();
    await ctx.fiber.dispose();
  }
}

/** d. 文件引用：@mention 保真 + read 工具结果进入下一请求。 */
async function fileReferenceProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "file-reference-workspace");
  const contentMarker = "FILE_REFERENCE_CONTENT_MARKER";
  await writeFile(join(workspace, "notes.txt"), `${contentMarker}\n`);
  await writeFile(join(workspace, "notes with space.txt"), `${contentMarker} spaced\n`);
  const { ctx, adapter } = await createHarness(workspace);
  ctx.tools.register(defineTool({
    name: "read",
    description: "Read a workspace file as UTF-8 text.",
    parameters: { file_path: { type: "string", required: true } },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    execute: async (args) => readFile(resolve(workspace, String((args as { file_path: string }).file_path)), "utf8"),
  }));
  const references = await ctx.plugin(LocalFileReference, { maxResults: 20 });
  const handle = await createAgent(ctx, "extension-file-reference", workspace);
  try {
    const signal = new AbortController().signal;
    const plain = (await ctx.fileReferences.list(handle.agent, "notes", signal))
      .find((candidate) => candidate.path === "notes.txt");
    assert(plain, "local file-reference discovery must return notes.txt");
    const plainMention = formatFileMention(plain, false);
    assert.equal(plainMention, "@notes.txt");
    const spaced = (await ctx.fileReferences.list(handle.agent, "space", signal))
      .find((candidate) => candidate.path === "notes with space.txt");
    assert(spaced, "local file-reference discovery must return the spaced path");
    const spacedMention = formatFileMention(spaced, false);
    assert.equal(spacedMention, '@"notes with space.txt"');

    const input = `Please inspect ${plainMention} and ${spacedMention}.`;
    await runTurn(handle.agent, adapter, [
      {
        tools: ["read"],
        call: { name: "read", input: { file_path: "notes.txt" } },
        check(request) {
          const users = textOf(request, "user");
          assert(users.includes(plainMention), "plain @mention must enter the request verbatim");
          assert(users.includes(spacedMention), "quoted @mention must enter the request verbatim");
          assert(
            textOf(request, "system").includes(FILE_REFERENCE_PROMPT),
            "the provider's stabilized reference guidance must be present while read is visible",
          );
        },
      },
      {
        tools: ["read"],
        check(request) {
          assert(textOf(request, "tool").includes(contentMarker), "the referenced file content must remain usable in the next request");
        },
      },
    ], input);
    console.log("[extension-foundation] d. file reference grammar, request fidelity and read follow-up passed");
  } finally {
    await handle.dispose();
    await references.dispose();
    await ctx.fiber.dispose();
  }
}

/** e. agent scope（preset 同构）隔离：提示段、动态 context、工具都不跨 sibling。 */
async function scopeIsolationProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "scope-workspace");
  const { ctx, adapter } = await createHarness(workspace);
  ctx.tools.register(probeTool("global_probe"));
  const ownerHandle = await createAgent(ctx, "extension-scope-owner", workspace);
  const siblingHandle = await createAgent(ctx, "extension-scope-sibling", workspace);
  const scopedPlugin = await ownerHandle.agent.ctx.plugin({
    name: "extension-scope-probe",
    inject: ["systemPrompt", "tools"],
    apply(scopedCtx: Context) {
      scopedCtx.systemPrompt.section({
        name: "probe:scoped-prompt",
        order: 9_000,
        interpolate: false,
        text: "SCOPED_PROMPT_ONLY_FOR_OWNER",
      });
      scopedCtx.systemPrompt.context({
        name: "probe:scoped-context",
        order: 9_000,
        interpolate: false,
        text: "SCOPED_CONTEXT_ONLY_FOR_OWNER",
      });
      scopedCtx.tools.register(probeTool("scoped_probe"));
    },
  });
  try {
    await runTurn(ownerHandle.agent, adapter, [{
      tools: ["global_probe", "scoped_probe"],
      check(request) {
        assert(textOf(request, "system").includes("SCOPED_PROMPT_ONLY_FOR_OWNER"), "owner must see its scoped prompt section");
        assert(textOf(request, "user").includes("SCOPED_CONTEXT_ONLY_FOR_OWNER"), "owner must see its scoped runtime context");
      },
    }], "owner turn");
    await runTurn(siblingHandle.agent, adapter, [{
      tools: ["global_probe"],
      check(request) {
        assert(!textOf(request, "system").includes("SCOPED_PROMPT_ONLY_FOR_OWNER"), "sibling must not see the owner's prompt section");
        assert(!textOf(request, "user").includes("SCOPED_CONTEXT_ONLY_FOR_OWNER"), "sibling must not see the owner's context");
        assert(!textOf(request, "system").includes("SCOPED_CONTEXT_ONLY_FOR_OWNER"));
      },
    }], "sibling turn");
    console.log("[extension-foundation] e. scoped prompt/context/tool isolation passed");
  } finally {
    await scopedPlugin.dispose();
    await siblingHandle.dispose();
    await ownerHandle.dispose();
    await ctx.fiber.dispose();
  }
}

/** f. 全局插件卸载：提示段与工具从下一请求消失，无悬挂引用。 */
async function unloadProbe(root: string): Promise<void> {
  const workspace = await makeWorkspace(root, "unload-workspace");
  const { ctx, adapter } = await createHarness(workspace);
  const dynamicPlugin = await ctx.plugin({
    name: "extension-dynamic-probe",
    inject: ["systemPrompt", "tools"],
    apply(dynamicCtx: Context) {
      dynamicCtx.systemPrompt.section({
        name: "probe:dynamic-prompt",
        order: 9_100,
        interpolate: false,
        text: "DYNAMIC_PROMPT_MARKER",
      });
      dynamicCtx.tools.register(probeTool("dynamic_probe"));
    },
  });
  const handle = await createAgent(ctx, "extension-unload", workspace);
  try {
    await runTurn(handle.agent, adapter, [{
      tools: ["dynamic_probe"],
      check(request) {
        assert(textOf(request, "system").includes("DYNAMIC_PROMPT_MARKER"), "dynamic prompt section must be active before unload");
      },
    }], "before unload");

    await dynamicPlugin.dispose();
    assert(!ctx.tools.schemas(handle.agent).some((schema) => schema.name === "dynamic_probe"),
      "unloaded plugin must release its tool registration");
    await runTurn(handle.agent, adapter, [{
      tools: [],
      check(request) {
        assert(!textOf(request, "system").includes("DYNAMIC_PROMPT_MARKER"), "unloaded prompt section must leave the next request");
      },
    }], "after unload");
    const ends = handle.agent.session.snapshotEvents().filter((event) => event.type === "turn/end");
    assert(ends.at(-1)?.type === "turn/end" && ends.at(-1)!.data.reason.kind === "completed",
      "unload must not leave a hanging turn or dangling reference error");
    console.log("[extension-foundation] f. plugin unload removes prompt section and tool without dangling errors");
  } finally {
    await handle.dispose();
    await ctx.fiber.dispose();
  }
}

async function main(): Promise<void> {
  const watchdog = setTimeout(() => {
    console.error("[extension-foundation] FAIL: watchdog expired");
    process.exit(1);
  }, 90_000);
  watchdog.unref();
  const root = await mkdtemp(join(tmpdir(), "dsh-extension-foundation-"));
  try {
    await agentsInstructionsProbe(root);
    await skillProbe(root);
    await mcpProbe(root);
    await fileReferenceProbe(root);
    await scopeIsolationProbe(root);
    await unloadProbe(root);
  } finally {
    clearTimeout(watchdog);
    await rm(root, { recursive: true, force: true });
  }
  console.log("[extension-foundation] PASS: a-f extension foundation verified");
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error("[extension-foundation] FAIL:", error);
  process.exit(1);
});
