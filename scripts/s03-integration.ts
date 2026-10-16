/**
 * S03 集成自证脚本（AC 1–3 + 不变量 probe）：
 *
 * 装配：`new Context()`（npm cordis）+ 标准前置服务（LlmRuntime/SessionStore/
 * SystemPrompt/ToolRuntime/AgentRegistry，挂载序照抄 reference testkit 的
 * mountAgentLoopTestDependencies，去 SessionProjectionRegistry——inbox 最小
 * 重写不挂投影）+ fake llm adapter + **dsh 工具**（defineTool + ctx.tools.register，
 * dsh 工具插件的注册面）+ 本插件（**不装** stock agent-loop）。
 *
 * AC1 由 `pnpm typecheck` 单独覆盖；本脚本覆盖：
 * - AC2 `agent.followup(...)` → turn 完成且工具真执行；`tools/pre-execute`
 *   listener 计数 ≥1（边界样例 3 probe：证明走的是 dsh 管线而非旁路）。
 * - AC3 dsh session log 可 `deriveMessages()` 重建（system/user/assistant/tool
 *   骨干 + 终条 assistant 文本）。
 * - 附加 probe：system prompt 为 dsh `SystemPrompt.assemble()` 产物（含
 *   harness identity 段），且内建 ZCode reminder 段不在场（custom prompt 路径）；
 *   inbox splice 落盘；`agents.resume` 抛 `PROTOTYPE_UNSUPPORTED`。
 */
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import LlmRuntime, {
  createUserMessage,
  expandAssistantStream,
  LlmAdapter,
  ToolCallId as DshToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";

import ZcodeLoop, { PrototypeUnsupportedError } from "../src/index.js";

// ------------------------------------------------------------------
// fake llm adapter（照抄 S02 / reference mock-adapter 写法）
// ------------------------------------------------------------------

class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];

  constructor(private readonly script: StreamChunk[][]) {
    super();
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const chunks = this.script.shift();
    if (!chunks) throw new Error("ScriptedAdapter: script exhausted");
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error("aborted");
      yield chunk;
    }
  }
}

function textThenToolCallChunks(text: string, callId: string, name: string, args: object): StreamChunk[] {
  const argumentsJson = JSON.stringify(args);
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "tool-call-delta",
      index: 1,
      id: DshToolCallId(callId),
      name,
      argumentsDelta: argumentsJson.slice(0, 5),
    },
    { type: "tool-call-delta", index: 1, id: DshToolCallId(callId), argumentsDelta: argumentsJson.slice(5) },
    {
      type: "block-end",
      index: 1,
      block: { type: "tool-call", id: DshToolCallId(callId), name, arguments: argumentsJson },
    },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    ...Array.from(text, (char): StreamChunk => ({ type: "text-delta", index: 0, text: char })),
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

// ------------------------------------------------------------------
// 断言
// ------------------------------------------------------------------

function fail(message: string): never {
  console.error(`[s03] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) fail(message);
}

async function main(): Promise<void> {
  // ---- dsh 侧装配（npm 包，独立拉取）----
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);

  const adapter = new ScriptedAdapter([
    textThenToolCallChunks("Calling the echo tool.", "call-s03-1", "echo_dsh_tool", { text: "s03" }),
    textChunks("S03 tool says: s03"),
  ]);
  ctx.llm.registerAdapter(["mock"], adapter);

  // ---- dsh 工具（dsh 工具插件的注册面：defineTool + ctx.tools.register）----
  // npm 上全部 dsh-tool-* 插件钉死 0.0.1-rc.1 坏代际（peer 404，见 S02 §2），
  // 无法与 0.2.1-alpha.5 共装；以同一注册面落一个工具即"dsh 自带工具"的最小等价，
  // 管线证明由 pre-execute probe 承担（HANDOFF 声明该偏差）。
  const dshToolExecutions: unknown[] = [];
  const echoTool = defineTool({
    name: "echo_dsh_tool",
    description: "Echo the given text back (dsh-registered tool).",
    parameters: { text: { type: "string", required: true } },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (args, value) => [
        { type: "text", text: `Tool says: ${String((value as { text?: string } | undefined)?.text ?? "")}` },
      ],
    },
    execute: async (args) => {
      dshToolExecutions.push(args);
      return { text: args.text };
    },
  });
  ctx.tools.register(echoTool);

  // ---- 边界样例 3 判别 probe：tools/pre-execute 计数 ----
  let preExecuteCount = 0;
  ctx.on("tools/pre-execute", async (_exec, next) => {
    preExecuteCount += 1;
    return next();
  });

  // ---- 本插件（不装 stock agent-loop）----
  await ctx.plugin(ZcodeLoop, { provider: "mock", model: "mock" });

  const sessionId = DshSessionId("s03-zcode-loop");
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: "mock", model: "mock" },
  });
  const agent: Agent = handle.agent;
  assert(agent.id === sessionId, "agent id must equal session id");
  assert(agent.status === "idle", `fresh agent must be idle, got ${agent.status}`);

  // ---- AC2：followup → turn 完成且工具真执行 + pre-execute probe ----
  agent.followup(
    createUserMessage({
      content: [{ type: "text", text: "please call the echo tool" }],
      source: { kind: "user" },
    }),
  );
  await agent.whenIdle();
  assert(agent.status === "idle", `agent must return to idle, got ${agent.status}`);
  assert(dshToolExecutions.length === 1, `expected exactly one dsh tool execution, got ${dshToolExecutions.length}`);
  assert(
    (dshToolExecutions[0] as { text?: string })?.text === "s03",
    `unexpected tool arguments: ${JSON.stringify(dshToolExecutions[0])}`,
  );
  assert(preExecuteCount >= 1, `tools/pre-execute listener must fire (>=1), got ${preExecuteCount}`);
  assert(adapter.requests.length === 2, `expected 2 provider calls, got ${adapter.requests.length}`);
  console.log(
    `[s03] AC2 turn completed: dsh tool executions=${String(dshToolExecutions.length)}, pre-execute probe=${String(preExecuteCount)}, provider calls=${String(adapter.requests.length)}`,
  );

  // 模型请求确实带上了经桥同步的 dsh 工具 schema（工具面=dsh）。
  const requestTools = adapter.requests[0]?.tools ?? [];
  assert(
    requestTools.some((tool) => tool.name === "echo_dsh_tool"),
    `bridged dsh tool must appear in provider request tools, got ${JSON.stringify(requestTools.map((t) => t.name))}`,
  );
  const bridgedOnly = requestTools.every((tool) => tool.name === "echo_dsh_tool");
  assert(bridgedOnly, `no ZCode built-in tools may leak into the request, got ${JSON.stringify(requestTools.map((t) => t.name))}`);

  // ---- AC3：dsh session log 可 deriveMessages() 重建 ----
  const session = agent.session;
  const log = session.snapshotEvents();
  const logTypes = log.map((event) => event.type);
  console.log(`[s03] dsh log sequence: ${logTypes.join(" -> ")}`);
  // inbox splice（insert+claim）先于 turn 事件是 stock 同款时序：turn 骨架断言
  // 跳过 inbox 事件。
  const turnLogTypes = logTypes.filter((type) => type !== "agent/inbox/spliced");
  assert(turnLogTypes[0] === "turn/start", `turn log must open with turn/start, got ${turnLogTypes[0] ?? "<empty>"}`);
  assert(turnLogTypes.at(-1) === "turn/end", "turn log must close with turn/end");
  assert(turnLogTypes.includes("tool/call") && turnLogTypes.includes("tool/result"), "tool call/result must be logged");

  const derived = session.deriveMessages();
  const roles = derived.map((message) => message.role);
  console.log(`[s03] derived roles: ${roles.join(" -> ")}`);
  assert(roles[0] === "system", `derived must open with system, got ${roles[0] ?? "<empty>"}`);
  assert(roles.includes("user") && roles.includes("assistant") && roles.includes("tool"), "derived must rebuild the full backbone");

  // system prompt 是 dsh SystemPrompt.assemble() 的产物（harness identity 段在场）。
  // 引擎在 custom prompt 路径仍无条件保留自身 cli_prefix 身份行（"You are
  // ZCode..."，无配置门可关）；S02 桥已修复为把全部前导 system 拼成一条
  // dsh system/message（模型可见即落盘），因此 derived 的 system 文本应同时
  // 含引擎身份行与 dsh 装配文本。
  const systemMessages = derived.filter((message) => message.role === "system");
  assert(systemMessages.length === 1, `expected one merged system message, got ${String(systemMessages.length)}`);
  const systemText =
    systemMessages[0]?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
  assert(
    systemText.startsWith("You are ZCode"),
    `merged system message must open with the engine cli-prefix line, got: ${JSON.stringify(systemText.slice(0, 60))}`,
  );
  assert(
    systemText.includes("DeepSeek Harness"),
    `system prompt must contain the dsh assembly (harness identity), got: ${JSON.stringify(systemText.slice(0, 160))}...`,
  );
  // custom prompt 路径：ZCode 内建动态 reminder 段不应混入 system 消息。
  assert(
    !systemText.includes("context management") && !systemText.includes("long-term memory"),
    `ZCode built-in dynamic sections must not leak into the system prompt: ${JSON.stringify(systemText.slice(0, 240))}`,
  );

  // 工具结果配对（tool 消息的 toolCallId 与 assistant tool-call 块一致）。
  const toolMessages = derived.filter((message) => message.role === "tool");
  assert(toolMessages.length === 1, `expected 1 derived tool message, got ${String(toolMessages.length)}`);
  const assistantMessages = derived.filter((message) => message.role === "assistant");
  assert(assistantMessages.length === 2, `expected 2 assistant messages, got ${String(assistantMessages.length)}`);
  const firstAssistant = assistantMessages[0];
  assert(firstAssistant?.role === "assistant", "unreachable");
  const toolCallBlock = firstAssistant.content.find((block) => block.type === "tool-call");
  assert(toolCallBlock?.type === "tool-call" && toolCallBlock.name === "echo_dsh_tool", "assistant must carry the dsh tool-call block");
  const toolMessage = toolMessages[0];
  assert(
    toolMessage?.role === "tool" && "toolCallId" in toolMessage && toolMessage.toolCallId === toolCallBlock.id,
    "tool message toolCallId must pair with the assistant tool-call block",
  );

  // 终条 assistant 文本 = 脚本化终轮响应；紧凑流可展开。
  const lastDerived = derived.at(-1);
  assert(lastDerived?.role === "assistant", "last derived message must be the final assistant message");
  const finalText = lastDerived.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  assert(finalText === "S03 tool says: s03", `final assistant text mismatch: ${JSON.stringify(finalText)}`);
  const assistantEvents = log.filter((event) => event.type === "assistant/message");
  for (const event of assistantEvents) {
    if (event.type !== "assistant/message") continue;
    expandAssistantStream(event.data.stream);
  }
  console.log(`[s03] AC3 deriveMessages rebuilt: ${String(derived.length)} messages, final=${JSON.stringify(finalText)}`);

  // ---- 附加 probe：inbox splice 落盘（唯一真相）----
  const inboxSplices = log.filter((event) => event.type === "agent/inbox/spliced");
  assert(inboxSplices.length >= 2, `inbox splices must be durable (>=2: insert + claim), got ${String(inboxSplices.length)}`);
  console.log(`[s03] inbox splices durable: ${String(inboxSplices.length)}`);

  // ---- 附加 probe：resume 抛 PROTOTYPE_UNSUPPORTED ----
  let resumeError: unknown;
  try {
    await ctx.agents.resume({ resumeSessionId: sessionId });
  } catch (error: unknown) {
    resumeError = error;
  }
  assert(resumeError instanceof PrototypeUnsupportedError, `resume must throw PrototypeUnsupportedError, got ${String(resumeError)}`);
  assert(
    (resumeError as PrototypeUnsupportedError).code === "PROTOTYPE_UNSUPPORTED",
    "resume error must carry code PROTOTYPE_UNSUPPORTED",
  );
  console.log("[s03] resume probe: PROTOTYPE_UNSUPPORTED surfaced");

  await handle.dispose();
  console.log("[s03] PASS: AC2/AC3 + pipeline/system-prompt/inbox/resume probes all green");
  process.exit(0);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
