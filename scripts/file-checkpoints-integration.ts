/**
 * 文件检查点与回滚集成探针。
 *
 * 用钉版 dsh-tool-fs（write/edit）与探针内最小 delete 工具经真实 dsh 工具管线
 * 产生写前快照，验证 a–h：
 * - 写/删/新增捕获、list/preview、apply 恢复与 restore record；
 * - 冲突全量预检（零写入）、权限与部分应用故障、快照损坏、取消；
 * - 新宿主持久化、shell/external 变更不可恢复边界、与 /rerun 组合；
 * - commands 缺席时捕获照常、仅命令不可用。
 *
 * 边界：shell/外部程序（探针里直接用 node:fs）的变更不进入记录；本探针不经
 * 第二 OS 进程验证重启，而是用同一 DSH_HOME 下的新 Context/新宿主（TASK
 * 允许“新进程/新宿主”）。不宣称与 /rerun 跨进程原子。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import LlmRuntime, {
  LlmAdapter,
  ToolCallId as DshToolCallId,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId as DshSessionId } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import WorkingDirectory from "@deepseek-ai/dsh-working-directory";
// 钉版 dsh-tool-fs 是 dsh 的传递依赖，未提升到根 node_modules；按 pnpm 虚拟
// store 的稳定链接路径引入，避免为探针改动依赖解析或锁文件。
// @ts-expect-error 该相对路径没有 package.json exports 类型映射
import * as ToolFs from "../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js";
// @ts-expect-error 该相对路径没有 package.json exports 类型映射
import * as StrReplaceEditor from "../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-tool-str-replace-editor/lib/index.js";

import FileCheckpoints, {
  type CheckpointApplyOutcome,
  type CheckpointRecord,
} from "../src/file-checkpoints.js";
import ZcodeLoop from "../src/index.js";

const PROVIDER = "mock";
const EVIDENCE_ROOT = join(tmpdir(), "dsh-file-checkpoints");

function fail(message: string): never {
  console.error(`[file-checkpoints] FAIL: ${message}`);
  process.exit(1);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  fail(`timeout waiting for ${what}`);
}
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function readText(path: string): string {
  return readFileSync(path, "utf8");
}
function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}
function makeWorkspace(root: string, name: string): string {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  return realpathSync(workspace);
}

const tcid = (id: string) => DshToolCallId(id);

interface ScriptedCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

function response(text: string, calls: ScriptedCall[] = []): StreamChunk[] {
  const chunks: StreamChunk[] = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
  ];
  let index = 1;
  for (const call of calls) {
    const argumentsJson = JSON.stringify(call.args);
    chunks.push({ type: "block-start", index, blockType: "tool-call" });
    chunks.push({
      type: "tool-call-delta",
      index,
      id: tcid(call.callId),
      name: call.name,
      argumentsDelta: argumentsJson.slice(0, 7),
    });
    chunks.push({
      type: "tool-call-delta",
      index,
      id: tcid(call.callId),
      name: call.name,
      argumentsDelta: argumentsJson.slice(7),
    });
    chunks.push({
      type: "block-end",
      index,
      block: { type: "tool-call", id: tcid(call.callId), name: call.name, arguments: argumentsJson },
    });
    index += 1;
  }
  chunks.push({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
  chunks.push({ type: "finish", reason: calls.length > 0 ? { kind: "tool-calls" } : { kind: "stop" } });
  return chunks;
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  private readonly steps: StreamChunk[][] = [];

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  queue(steps: StreamChunk[][]): void {
    this.steps.push(...steps);
  }

  pending(): number {
    return this.steps.length;
  }

  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) throw new Error("unexpected model request");
    for (const chunk of step) {
      request.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

interface Host {
  ctx: Context;
  adapter: ScriptedAdapter;
  workspace: string;
  dispose(): Promise<void>;
}

/** 一个最小但真实的 dsh 栈：fs/工作目录/工具管线/commands/钉版 write/edit。 */
async function createHost(workspace: string, options: { commands?: boolean } = {}): Promise<Host> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(SessionProjection);
  await ctx.plugin(LocalFileSystem, { cwd: workspace });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace });
  await ctx.plugin(AgentRegistry);
  if (options.commands !== false) await ctx.plugin(CommandRuntime);
  await ctx.plugin(ToolFs as unknown as Plugin.Object<Record<string, unknown>>, {});
  await ctx.plugin(StrReplaceEditor as unknown as Plugin.Object<Record<string, unknown>>, {});
  await ctx.plugin(ZcodeLoop, { provider: PROVIDER, model: "mock" });
  await ctx.plugin(FileCheckpoints as unknown as Plugin.Object<Record<string, unknown>>, {
    dshHome: process.env.DSH_HOME,
  });
  // 钉版 dsh 包没有 delete 工具；探针注册一个同名/同参数形状的最小工具，
  // 仅用于验证删除路径的写前捕获与 recreate 语义。
  ctx.tools.register(defineTool({
    name: "delete",
    description: "Delete a text file (probe fixture for the pinned dsh surface)",
    parameters: {
      file_path: { type: "string", required: true, description: "Path to delete." },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const path = join(workspace, (args as { file_path: string }).file_path);
      exec.signal.throwIfAborted();
      const { unlink } = await import("node:fs/promises");
      await unlink(path);
      return path;
    },
  }));
  const adapter = new ScriptedAdapter();
  ctx.llm.registerAdapter([PROVIDER], adapter);
  return { ctx, adapter, workspace, dispose: () => ctx.fiber.dispose() };
}

function createAgent(host: Host, id: string): Promise<AgentHandle> {
  return host.ctx.agents.create({
    sessionId: DshSessionId(id),
    meta: { cwd: host.workspace },
    agentOptions: { provider: PROVIDER, model: "mock" },
  });
}

function userMessage(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

/** 一个 turn = 一次 tool-call 步 + 收口文本步；返回本 turn 的模型请求。 */
async function runToolTurn(
  host: Host,
  agent: Agent,
  input: string,
  calls: ScriptedCall[],
): Promise<GenerateOptions[]> {
  const before = host.adapter.requests.length;
  host.adapter.queue([response("working", calls), response("done")]);
  agent.followup(userMessage(input));
  await waitFor(() => agent.status === "idle", `turn idle for ${agent.id}`);
  await sleep(100);
  check(host.adapter.pending() === 0, "scripted steps must drain exactly");
  return host.adapter.requests.slice(before);
}

async function runTextTurn(
  host: Host,
  agent: Agent,
  input: string,
): Promise<GenerateOptions[]> {
  const before = host.adapter.requests.length;
  host.adapter.queue([response("text-only")]);
  agent.followup(userMessage(input));
  await waitFor(() => agent.status === "idle", `turn idle for ${agent.id}`);
  await sleep(100);
  check(host.adapter.pending() === 0, "scripted steps must drain exactly");
  return host.adapter.requests.slice(before);
}

async function executeCommand(
  ctx: Context,
  agent: Agent,
  line: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ kind: string; text?: string }> {
  const commands = ctx.get("commands") as unknown as {
    execute(
      agent: Agent,
      line: string,
      attachments: readonly unknown[],
      signal: AbortSignal,
    ): Promise<{ result: { kind: string; text?: string } } | undefined>;
  };
  const execution = await commands.execute(agent, line, [], signal);
  check(execution !== undefined, `command "${line}" was not resolved`);
  return execution.result;
}

function checkpointService(ctx: Context): FileCheckpoints {
  const service = ctx.get("fileCheckpoints") as FileCheckpoints | undefined;
  check(service !== undefined, "fileCheckpoints service must be registered");
  return service;
}

async function newestRecord(service: FileCheckpoints): Promise<CheckpointRecord> {
  const entries = await service.listCheckpoints();
  check(entries.length > 0, "at least one checkpoint record expected");
  const newest = [...entries].sort((left, right) => right.createdAt - left.createdAt)[0]!;
  const preview = await service.previewCheckpoint(newest.id);
  check(preview !== undefined, `checkpoint ${newest.id} must be readable`);
  return preview.record;
}

function targetByPath(record: CheckpointRecord, workspace: string, name: string) {
  const target = record.targets.find((candidate) => candidate.path === join(workspace, name));
  check(target !== undefined, `target ${name} must be captured`);
  return target;
}

function loadRestoreRecord(root: string, checkpoint: CheckpointRecord): {
  record: {
    restoreId: string;
    checkpointId: string;
    targets: Array<{
      path: string;
      beforeApply: { hash: string; size: number; snapshot: string } | null;
    }>;
  };
  dir: string;
} {
  const restores = join(root, checkpoint.id, "restores");
  check(existsSync(restores), "restore record directory must exist");
  const ids = readdirSync(restores).filter((name) => name.startsWith("restore-"));
  check(ids.length > 0, "at least one restore record expected");
  const dir = join(restores, ids[ids.length - 1]!);
  return {
    record: JSON.parse(readFileSync(join(dir, "record.json"), "utf8")),
    dir,
  };
}

function readSnapshot(root: string, checkpoint: CheckpointRecord, targetIndex: number): string {
  const target = checkpoint.targets[targetIndex]!;
  check(target.before !== null, "snapshot expected");
  return readFileSync(join(root, checkpoint.id, target.before.snapshot), "utf8");
}

/** a–c：真实 write/edit/delete 捕获、list/preview、apply 与 restore record。 */
async function captureListApplyScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "capture-workspace");
  writeText(join(workspace, "existing.txt"), "OLD-EXISTING");
  writeText(join(workspace, "removed.txt"), "OLD-REMOVED");
  writeText(join(workspace, "editable.txt"), "OLD-EDIT-PART");
  const host = await createHost(workspace);
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "checkpoint-capture");
    await runToolTurn(host, handle.agent, "change files", [
      { callId: "capture-write-existing", name: "write", args: { file_path: "existing.txt", content: "NEW-EXISTING" } },
      { callId: "capture-write-new", name: "write", args: { file_path: "new.txt", content: "NEW-CREATED" } },
      { callId: "capture-edit", name: "edit", args: { file_path: "editable.txt", old_string: "OLD-EDIT-PART", new_string: "NEW-EDIT-PART" } },
      { callId: "capture-editor-create", name: "str_replace_editor", args: { command: "create", path: join(workspace, "editor.txt"), file_text: "NEW-EDITOR" } },
      { callId: "capture-delete", name: "delete", args: { file_path: "removed.txt" } },
    ]);

    const service = checkpointService(host.ctx);
    const records = await service.listCheckpoints();
    check(records.length === 1, `expected exactly one checkpoint, got ${records.length}`);
    const summary = records[0]!;
    const checkpoint = await newestRecord(service);
    check(summary.status === "closed", "turn/end must close the checkpoint");
    check(summary.targetCount === 5, `expected 5 targets, got ${summary.targetCount}`);
    check(checkpoint.targets.length === 5, "record must persist all targets");

    const existing = targetByPath(checkpoint, workspace, "existing.txt");
    const created = targetByPath(checkpoint, workspace, "new.txt");
    const removed = targetByPath(checkpoint, workspace, "removed.txt");
    const edited = targetByPath(checkpoint, workspace, "editable.txt");
    const editorCreated = targetByPath(checkpoint, workspace, "editor.txt");
    check(existing.action === "restore", "existing write must be restore");
    check(existing.before?.hash === sha256("OLD-EXISTING"), "write before hash must be the pre-write bytes");
    check(existing.expectedHash === sha256("NEW-EXISTING"), "write expected hash must be post-write bytes");
    check(existing.expectedVerified, "post-execute must verify the write");
    check(existing.tools.includes("write"), "write tool must be recorded");
    check(created.action === "delete", "new file must be recorded as will-create delete");
    check(created.before === null, "will-create target must have no before snapshot");
    check(created.expectedHash === sha256("NEW-CREATED"), "created file expected hash");
    check(removed.action === "recreate", "deleted file must be recreate");
    check(removed.before?.hash === sha256("OLD-REMOVED"), "deleted file before hash");
    check(removed.expectedHash === null, "deleted file expected state must be absent");
    check(removed.tools.includes("delete"), "delete tool must be recorded");
    check(edited.action === "restore", "edit must be captured as restore");
    check(edited.before?.hash === sha256("OLD-EDIT-PART"), "edit before hash must be the pre-edit bytes");
    check(edited.expectedHash === sha256("NEW-EDIT-PART"), "edit expected hash must be post-edit bytes");
    check(edited.tools.includes("edit"), "edit tool must be recorded");
    check(editorCreated.action === "delete", "str_replace_editor create must be will-create delete");
    check(editorCreated.expectedHash === sha256("NEW-EDITOR"), "str_replace_editor expected hash");
    check(editorCreated.tools.includes("str_replace_editor"), "str_replace_editor tool must be recorded");
    check(service.rootPath.startsWith(process.env.DSH_HOME!), "storage must live under DSH_HOME");
    check(
      existsSync(join(service.rootPath, checkpoint.id, "snapshots")),
      "snapshot bytes must live in the plugin store, not the session log",
    );
    check(
      handle.agent.session.snapshotEvents().every((event) => !event.type.startsWith("plugin:zcode-loop/checkpoint")),
      "plugin must not append checkpoint records to the session log",
    );
    console.log("[file-checkpoints] a ✓ write 已存在/新增与 delete 的写前快照、action、hash 均正确");

    // b. list/preview 命令。
    const list = await executeCommand(host.ctx, handle.agent, "/checkpoint list");
    check(list.kind === "success", "list must succeed");
    check((list.text ?? "").includes(checkpoint.id), "list must include the checkpoint id");
    check((list.text ?? "").includes("5 target(s)"), "list must show target count");
    check((list.text ?? "").includes("existing.txt"), "list must show a path summary");
    check((list.text ?? "").includes("shell or external-program changes are not recoverable"), "list must state the recovery boundary");
    const preview = await executeCommand(host.ctx, handle.agent, `/checkpoint preview ${checkpoint.id}`);
    check(preview.kind === "success", "preview must succeed");
    const previewText = preview.text ?? "";
    check(previewText.includes("restore bytes"), "preview must name restore bytes");
    check(previewText.includes("delete"), "preview must name delete");
    check(previewText.includes("recreate"), "preview must name recreate");
    check(previewText.includes(existing.before!.hash), "preview must show the before hash");
    check(previewText.includes(existing.expectedHash!), "preview must show the expected hash");
    check(previewText.includes("canApply=true"), "preview must report apply readiness");
    console.log("[file-checkpoints] b ✓ /checkpoint list 与 preview 展示记录、动作与 hash");

    // c. apply 全部恢复，并留下 apply 前状态的 restore record。
    const apply = await executeCommand(host.ctx, handle.agent, `/checkpoint apply ${checkpoint.id}`);
    check(apply.kind === "success", `apply must succeed: ${apply.text}`);
    check(readText(join(workspace, "existing.txt")) === "OLD-EXISTING", "existing file must be restored");
    check(!existsSync(join(workspace, "new.txt")), "will-create file must be deleted");
    check(!existsSync(join(workspace, "editor.txt")), "str_replace_editor create must be deleted");
    check(readText(join(workspace, "editable.txt")) === "OLD-EDIT-PART", "edited file must be restored");
    check(readText(join(workspace, "removed.txt")) === "OLD-REMOVED", "deleted file must be recreated");

    const restore = loadRestoreRecord(service.rootPath, checkpoint);
    check(restore.record.checkpointId === checkpoint.id, "restore record must name the checkpoint");
    const restoreByPath = new Map(restore.record.targets.map((entry) => [entry.path, entry]));
    check(
      restoreByPath.get(join(workspace, "existing.txt"))?.beforeApply?.hash === sha256("NEW-EXISTING"),
      "restore record must save the pre-apply existing bytes",
    );
    check(
      restoreByPath.get(join(workspace, "new.txt"))?.beforeApply?.hash === sha256("NEW-CREATED"),
      "restore record must save the pre-apply created file",
    );
    check(
      restoreByPath.get(join(workspace, "editable.txt"))?.beforeApply?.hash === sha256("NEW-EDIT-PART"),
      "restore record must save the pre-apply edited file",
    );
    check(
      restoreByPath.get(join(workspace, "editor.txt"))?.beforeApply?.hash === sha256("NEW-EDITOR"),
      "restore record must save the pre-apply editor-created file",
    );
    check(
      restoreByPath.get(join(workspace, "removed.txt"))?.beforeApply === null,
      "restore record must save absence before recreation",
    );
    const persisted = JSON.parse(
      readFileSync(join(service.rootPath, checkpoint.id, "record.json"), "utf8"),
    ) as CheckpointRecord;
    check(persisted.lastApply?.complete === true, "checkpoint must record a complete apply");
    check(persisted.lastApply?.restoreId === restore.record.restoreId, "lastApply must reference the restore record");
    console.log("[file-checkpoints] c ✓ apply 恢复多文件/删除新增，restore record 内容为 apply 前状态");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** d：快照后外部修改一个目标，预检失败且零文件改动。 */
async function conflictScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "conflict-workspace");
  writeText(join(workspace, "a.txt"), "OLD-A");
  writeText(join(workspace, "b.txt"), "OLD-B");
  const host = await createHost(workspace);
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "checkpoint-conflict");
    await runToolTurn(host, handle.agent, "write both", [
      { callId: "conflict-a", name: "write", args: { file_path: "a.txt", content: "NEW-A" } },
      { callId: "conflict-b", name: "write", args: { file_path: "b.txt", content: "NEW-B" } },
    ]);
    const checkpoint = await newestRecord(checkpointService(host.ctx));
    // shell/external 变更：绕过 dsh 工具直接写文件。
    writeText(join(workspace, "b.txt"), "SHELL-B");
    const apply = await executeCommand(host.ctx, handle.agent, `/checkpoint apply ${checkpoint.id}`);
    check(apply.kind === "error", "conflicted apply must fail");
    check((apply.text ?? "").includes("file changed since checkpoint"), "error must say file changed since checkpoint");
    check((apply.text ?? "").includes("no file was changed"), "error must state zero files changed");
    check(readText(join(workspace, "a.txt")) === "NEW-A", "valid target must not be partially restored");
    check(readText(join(workspace, "b.txt")) === "SHELL-B", "external change must remain untouched");
    const preview = await checkpointService(host.ctx).previewCheckpoint(checkpoint.id);
    check(preview?.canApply === false, "preview must mark the checkpoint unappliable");
    check(preview!.targets.some((entry) => entry.changedSinceCheckpoint), "preview must identify the conflict");
    console.log("[file-checkpoints] d ✓ 冲突预检失败、零文件改动、错误明示 changed since checkpoint");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** e：权限、部分应用故障、快照损坏与取消。 */
async function failureScenario(root: string): Promise<void> {
  // e1. 只读目标在预检阶段被拦下，零写入。
  {
    const workspace = makeWorkspace(root, "permission-workspace");
    writeText(join(workspace, "locked.txt"), "OLD-LOCKED");
    const host = await createHost(workspace);
    let handle: AgentHandle | undefined;
    try {
      handle = await createAgent(host, "checkpoint-permission");
      await runToolTurn(host, handle.agent, "write locked", [
        { callId: "permission-write", name: "write", args: { file_path: "locked.txt", content: "NEW-LOCKED" } },
      ]);
      const checkpoint = await newestRecord(checkpointService(host.ctx));
      chmodSync(join(workspace, "locked.txt"), 0o444);
      const apply = await executeCommand(host.ctx, handle.agent, `/checkpoint apply ${checkpoint.id}`);
      check(apply.kind === "error", "read-only target must block apply");
      check((apply.text ?? "").includes("not writable"), "error must explain the permission failure");
      check(readText(join(workspace, "locked.txt")) === "NEW-LOCKED", "read-only target must remain unchanged");
      console.log("[file-checkpoints] e1 ✓ 权限预检拦下，目标未改动");
    } finally {
      chmodSync(join(workspace, "locked.txt"), 0o644);
      await handle?.dispose();
      await host.dispose();
    }
  }

  // e2. 应用阶段中途失败：先恢复正常目标，再在只读目录删除 will-create 目标失败。
  {
    const workspace = makeWorkspace(root, "partial-workspace");
    const lockedDir = join(workspace, "readonly-dir");
    mkdirSync(lockedDir, { recursive: true });
    writeText(join(workspace, "ok.txt"), "OLD-OK");
    const host = await createHost(workspace);
    let handle: AgentHandle | undefined;
    try {
      handle = await createAgent(host, "checkpoint-partial");
      await runToolTurn(host, handle.agent, "write ok then created", [
        { callId: "partial-ok", name: "write", args: { file_path: "ok.txt", content: "NEW-OK" } },
        { callId: "partial-created", name: "write", args: { file_path: "readonly-dir/created.txt", content: "CREATED" } },
      ]);
      const service = checkpointService(host.ctx);
      const checkpoint = await newestRecord(service);
      check(readText(join(lockedDir, "created.txt")) === "CREATED", "created file must exist before apply");
      chmodSync(lockedDir, 0o555);
      const outcome: CheckpointApplyOutcome = await service.applyCheckpoint(
        checkpoint.id,
        new AbortController().signal,
      );
      check(outcome.kind === "error", "partial apply must be reported as error");
      check(outcome.applied.includes(join(workspace, "ok.txt")), "first target must be reported applied");
      check(outcome.failures.some((failure) => failure.path === join(lockedDir, "created.txt")), "failed target must be reported");
      check(readText(join(workspace, "ok.txt")) === "OLD-OK", "applied part must stay applied");
      check(readText(join(lockedDir, "created.txt")) === "CREATED", "failed target must remain unchanged");
      check(outcome.restorePath !== undefined && existsSync(outcome.restorePath), "restore record must survive partial failure");
      const partialRestore = JSON.parse(readFileSync(outcome.restorePath!, "utf8")) as {
        targets: Array<{ path: string; beforeApply: { hash: string } | null }>;
      };
      const okBefore = partialRestore.targets.find((entry) => entry.path === join(workspace, "ok.txt"));
      check(okBefore?.beforeApply?.hash === sha256("NEW-OK"), "restore record must save pre-apply bytes for the applied target");
      console.log("[file-checkpoints] e2 ✓ 应用中途失败：已应用部分与 restore record 如实呈现，未报告成功");
    } finally {
      chmodSync(lockedDir, 0o755);
      await handle?.dispose();
      await host.dispose();
    }
  }

  // e3. 快照字节损坏在预检阶段被拦下。
  {
    const workspace = makeWorkspace(root, "corrupt-workspace");
    writeText(join(workspace, "corrupt.txt"), "OLD-CORRUPT");
    const host = await createHost(workspace);
    let handle: AgentHandle | undefined;
    try {
      handle = await createAgent(host, "checkpoint-corrupt");
      await runToolTurn(host, handle.agent, "write corrupt", [
        { callId: "corrupt-write", name: "write", args: { file_path: "corrupt.txt", content: "NEW-CORRUPT" } },
      ]);
      const service = checkpointService(host.ctx);
      const checkpoint = await newestRecord(service);
      const target = checkpoint.targets[0]!;
      check(target.before !== null, "corrupt target must have a snapshot");
      writeText(join(service.rootPath, checkpoint.id, target.before.snapshot), "corrupted-snapshot");
      const apply = await executeCommand(host.ctx, handle.agent, `/checkpoint apply ${checkpoint.id}`);
      check(apply.kind === "error", "corrupted snapshot must block apply");
      check((apply.text ?? "").includes("snapshot"), "error must name the snapshot problem");
      check(readText(join(workspace, "corrupt.txt")) === "NEW-CORRUPT", "corrupted snapshot must not write any target");
      console.log("[file-checkpoints] e3 ✓ 快照损坏预检失败，零写入");
    } finally {
      await handle?.dispose();
      await host.dispose();
    }
  }

  // e4. 取消：已 abort 的 signal 不写任何文件。
  {
    const workspace = makeWorkspace(root, "cancel-workspace");
    writeText(join(workspace, "cancel.txt"), "OLD-CANCEL");
    const host = await createHost(workspace);
    let handle: AgentHandle | undefined;
    try {
      handle = await createAgent(host, "checkpoint-cancel");
      await runToolTurn(host, handle.agent, "write cancel", [
        { callId: "cancel-write", name: "write", args: { file_path: "cancel.txt", content: "NEW-CANCEL" } },
      ]);
      const service = checkpointService(host.ctx);
      const checkpoint = await newestRecord(service);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(() => service.applyCheckpoint(checkpoint.id, controller.signal), "cancelled apply must reject");
      check(readText(join(workspace, "cancel.txt")) === "NEW-CANCEL", "cancelled apply must not write");
      console.log("[file-checkpoints] e4 ✓ 取消发生在写入前，目标未改动");
    } finally {
      await handle?.dispose();
      await host.dispose();
    }
  }
}

/** f：新宿主（同一 DSH_HOME）下 list/preview/apply 仍可用。 */
async function restartScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "restart-workspace");
  writeText(join(workspace, "restart.txt"), "OLD-RESTART");
  let checkpointId: string | undefined;
  {
    const host = await createHost(workspace);
    let handle: AgentHandle | undefined;
    try {
      handle = await createAgent(host, "checkpoint-restart-source");
      await runToolTurn(host, handle.agent, "write restart", [
        { callId: "restart-write", name: "write", args: { file_path: "restart.txt", content: "NEW-RESTART" } },
      ]);
      checkpointId = (await newestRecord(checkpointService(host.ctx))).id;
    } finally {
      await handle?.dispose();
      await host.dispose();
    }
  }
  check(checkpointId !== undefined, "source host must produce a checkpoint");
  check(readText(join(workspace, "restart.txt")) === "NEW-RESTART", "file must remain written before restart");

  const host = await createHost(workspace);
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "checkpoint-restart-reader");
    const list = await executeCommand(host.ctx, handle.agent, "/checkpoint list");
    check(list.kind === "success" && (list.text ?? "").includes(checkpointId!), "new host must list persisted checkpoints");
    const preview = await executeCommand(host.ctx, handle.agent, `/checkpoint preview ${checkpointId}`);
    check(preview.kind === "success", "new host must preview persisted checkpoints");
    const apply = await executeCommand(host.ctx, handle.agent, `/checkpoint apply ${checkpointId}`);
    check(apply.kind === "success", `new host must apply persisted checkpoints: ${apply.text}`);
    check(readText(join(workspace, "restart.txt")) === "OLD-RESTART", "new host apply must restore the snapshot");
    console.log("[file-checkpoints] f ✓ 新宿主下 list/preview/apply 仍可用（DSH_HOME 持久化）");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** g：shell 变更不可恢复 + 与 /rerun 组合互不干扰。 */
async function boundaryScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "boundary-workspace");
  writeText(join(workspace, "managed.txt"), "OLD-MANAGED");
  const host = await createHost(workspace);
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "checkpoint-boundary");
    await runTextTurn(host, handle.agent, "warm-up turn");
    await runToolTurn(host, handle.agent, "managed change", [
      { callId: "boundary-write", name: "write", args: { file_path: "managed.txt", content: "NEW-MANAGED" } },
    ]);
    const service = checkpointService(host.ctx);
    const checkpoint = await newestRecord(service);
    check(
      checkpoint.targets.every((target) => target.path === join(workspace, "managed.txt")),
      "only dsh-tool writes may be recorded",
    );

    // shell/external：直接 node:fs 写一个未受管理文件。
    writeText(join(workspace, "shell-only.txt"), "SHELL-ONLY");
    const rerun = await executeCommand(host.ctx, handle.agent, "/rerun 2 EDITED-RERUN");
    check(rerun.kind === "success", `rerun must coexist with checkpoints: ${rerun.text}`);
    check(readText(join(workspace, "managed.txt")) === "NEW-MANAGED", "rerun must not touch checked files");
    check(readText(join(workspace, "shell-only.txt")) === "SHELL-ONLY", "rerun must not touch shell files");

    const apply = await executeCommand(host.ctx, handle.agent, `/checkpoint apply ${checkpoint.id}`);
    check(apply.kind === "success", "apply after rerun must succeed");
    check((apply.text ?? "").includes("shell or external-program changes are not recoverable"), "apply must state the recovery boundary");
    check(readText(join(workspace, "managed.txt")) === "OLD-MANAGED", "managed file must be restored");
    check(readText(join(workspace, "shell-only.txt")) === "SHELL-ONLY", "shell change must remain and is not recoverable");
    check(
      !checkpoint.targets.some((target) => target.path === join(workspace, "shell-only.txt")),
      "shell-only file must never enter the checkpoint",
    );
    console.log("[file-checkpoints] g ✓ shell 变更不入记录且 apply 后仍在；/rerun 与 checkpoint 互不干扰");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

/** h：commands 缺席时捕获/服务仍工作，仅命令不可用。 */
async function degradationScenario(root: string): Promise<void> {
  const workspace = makeWorkspace(root, "degraded-workspace");
  writeText(join(workspace, "degraded.txt"), "OLD-DEGRADED");
  const host = await createHost(workspace, { commands: false });
  let handle: AgentHandle | undefined;
  try {
    handle = await createAgent(host, "checkpoint-degraded");
    await runToolTurn(host, handle.agent, "write degraded", [
      { callId: "degraded-write", name: "write", args: { file_path: "degraded.txt", content: "NEW-DEGRADED" } },
    ]);
    check(host.ctx.get("commands") === undefined, "commands service must be absent");
    const service = checkpointService(host.ctx);
    const checkpoint = await newestRecord(service);
    check(checkpoint.targets.length === 1, "capture must continue without commands");
    const outcome = await service.applyCheckpoint(checkpoint.id, new AbortController().signal);
    check(outcome.kind === "success", "programmatic apply must work without commands");
    check(readText(join(workspace, "degraded.txt")) === "OLD-DEGRADED", "apply without commands must restore");
    console.log("[file-checkpoints] h ✓ commands 缺席时 pre-execute 捕获与 apply 照常，仅斜杠命令不可用");
  } finally {
    await handle?.dispose();
    await host.dispose();
  }
}

mkdirSync(EVIDENCE_ROOT, { recursive: true });
process.env.DSH_HOME = mkdtempSync(join(EVIDENCE_ROOT, "home-"));
console.log(`[file-checkpoints] DSH_HOME=${process.env.DSH_HOME}`);
try {
  const root = mkdtempSync(join(tmpdir(), "dsh-file-checkpoints-work-"));
  await captureListApplyScenario(root);
  await conflictScenario(root);
  await failureScenario(root);
  await restartScenario(root);
  await boundaryScenario(root);
  await degradationScenario(root);
  rmSync(root, { recursive: true, force: true });
  console.log("[file-checkpoints] PASS: a–h 全部通过");
} catch (error) {
  console.error("[file-checkpoints] FAIL:", error);
  process.exit(1);
}
