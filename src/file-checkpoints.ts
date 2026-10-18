/**
 * 文件检查点与回滚插件（与会话 flush checkpoint 无关）。
 *
 * 语义边界：
 * - 只捕获经 dsh 文件写工具发生的写路径（`write`/`edit`/`str_replace_editor`
 *   以及探针可注册的 `delete`/`remove` 形状）。必须在 `tools/pre-execute`
 *   的 `next()` 之前读取目标写前字节，写后由 `tools/post-execute` 记录
 *   期望 hash；因此任意 shell/外部程序的变更不在记录内，且明确不可恢复。
 * - 检查点以「agent turn」分组（session/event 的 turn/start → turn/end）；
 *   无 turn 信息的直接工具调用按 rootCallId 单独成组。同组同一文件保留
 *   首次写前状态，随后每次成功写入只推进 expectedHash。
 * - 存储是插件自有数据：`$DSH_HOME/file-checkpoints/<checkpoint>/`，快照
 *   字节不写进 dsh session log。不做去重/压缩；大文件按字节全量保存。
 * - apply 先全量预检（快照可读/hash 一致、目标当前 hash 与 expected 一致、
 *   已存在目标可写），任一失败则一个文件都不写；通过后先落 restore
 *   record（应用前当前状态）再逐个恢复。应用阶段中途失败如实报告已应用
 *   部分与恢复记录，绝不报告成功。
 * - 与 /rerun 等分支入口互不调用；二者没有跨进程原子性承诺。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-commands";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type {} from "@deepseek-ai/dsh-session";
import type { ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

/** 检查点命令的统一 usage。 */
export const FILE_CHECKPOINTS_USAGE = "Usage: /checkpoint list | preview <id> | apply <id>";

/** apply 前不可恢复语义的固定提示（命令输出必须显式携带）。 */
const RECOVERY_BOUNDARY =
  "Only files written through dsh write/edit tools are captured; shell or external-program changes are not recoverable.";

const RECORD_VERSION = 1;
const CHECKPOINT_ID_PATTERN = /^cp-[A-Za-z0-9.-]+$/;
const RESTORE_ID_PATTERN = /^restore-[A-Za-z0-9.-]+$/;

export interface FileCheckpointsConfig {
  /** 显式存储根（探针/测试用）；缺省 `$DSH_HOME/file-checkpoints`。 */
  storageRoot?: string;
  /** 显式 DSH home；缺省按 DSH_HOME 环境变量解析。 */
  dshHome?: string;
}

export const Config = z.object({
  storageRoot: z.string(),
  dshHome: z.string(),
}) as unknown as z<FileCheckpointsConfig>;

export type CheckpointAction = "restore" | "delete" | "recreate";

/** 一个受管理目标的写前快照与写后期望状态。 */
export interface CheckpointTarget {
  /** 绝对主机路径（实际恢复位置）。 */
  path: string;
  /** dsh 文件工具的展示路径。 */
  displayPath: string;
  /** restore=写回字节；delete=删除本检查点创建的文件；recreate=重建被删文件。 */
  action: CheckpointAction;
  /** 写前状态；null 表示写前不存在（will-create）。 */
  before: {
    hash: string;
    size: number;
    /** 相对检查点目录的快照文件路径。 */
    snapshot: string;
  } | null;
  /** 检查点最后一次成功写后的 hash；null 表示期望不存在。 */
  expectedHash: string | null;
  /** expectedHash 是否已由 post-execute 观测；false 时 apply 拒绝。 */
  expectedVerified: boolean;
  /** 本组内触及该目标的工具名（审计用）。 */
  tools: string[];
}

export interface CheckpointRecord {
  version: typeof RECORD_VERSION;
  id: string;
  createdAt: number;
  closedAt?: number;
  status: "open" | "closed";
  sessionId?: string;
  turn?: number;
  targets: CheckpointTarget[];
  lastApply?: {
    restoreId: string;
    appliedAt: number;
    applied: string[];
    failed: string[];
    complete: boolean;
  };
}

export interface CheckpointListEntry {
  id: string;
  createdAt: number;
  status: "open" | "closed";
  sessionId?: string;
  targetCount: number;
  paths: string[];
}

export interface CheckpointPreviewTarget {
  target: CheckpointTarget;
  snapshotReadable: boolean;
  currentHash: string | null;
  changedSinceCheckpoint: boolean;
  error?: string;
}

export interface CheckpointPreview {
  record: CheckpointRecord;
  targets: CheckpointPreviewTarget[];
  canApply: boolean;
}

export interface CheckpointApplyFailure {
  path: string;
  reason: string;
}

export interface CheckpointApplySuccess {
  kind: "success";
  applied: string[];
  restoreId: string;
  restorePath: string;
}

export interface CheckpointApplyError {
  kind: "error";
  text: string;
  applied: string[];
  failures: CheckpointApplyFailure[];
  restoreId?: string;
  restorePath?: string;
}

export type CheckpointApplyOutcome = CheckpointApplySuccess | CheckpointApplyError;

interface FileState {
  hash: string;
  size: number;
  bytes: Uint8Array;
}

interface ManagedWrite {
  path: string;
  kind: "write" | "delete";
  tool: string;
}

interface ActiveCall {
  groupKey: string;
  path: string;
  /** 该调用是否首次把此目标加入检查点（失败且无状态变化时用于撤销空记录）。 */
  createdTarget: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function pathArgument(args: Record<string, unknown>): string | undefined {
  return stringField(args.file_path) ?? stringField(args.path) ?? stringField(args.filePath);
}

/**
 * 识别钉版 dsh 文件工具的参数形状：
 * - `write`/`edit`/`replace`: `file_path`
 * - `str_replace_editor`: `command` in create/str_replace/insert + `path`（view 不写）
 * - `delete`/`remove`/`delete_file`/`rm`: 路径参数（删除类工具无钉版包，探针可注册）
 */
export function describeManagedWrite(toolName: string, args: unknown): ManagedWrite | undefined {
  if (!isRecord(args)) return undefined;
  if (toolName === "write" || toolName === "edit" || toolName === "replace") {
    const path = pathArgument(args);
    return path === undefined ? undefined : { path, kind: "write", tool: toolName };
  }
  if (toolName === "str_replace_editor") {
    const command = stringField(args.command);
    if (command !== "create" && command !== "str_replace" && command !== "insert") return undefined;
    const path = pathArgument(args);
    return path === undefined ? undefined : { path, kind: "write", tool: toolName };
  }
  if (toolName === "delete" || toolName === "remove" || toolName === "delete_file" || toolName === "rm") {
    const path = pathArgument(args);
    return path === undefined ? undefined : { path, kind: "delete", tool: toolName };
  }
  return undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function displayAction(action: CheckpointAction): string {
  switch (action) {
    case "restore":
      return "restore bytes";
    case "delete":
      return "delete";
    case "recreate":
      return "recreate";
  }
}

function formatHash(hash: string | null): string {
  return hash === null ? "absent" : hash;
}

function checkpointId(): string {
  return `cp-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function restoreId(): string {
  return `restore-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

async function readFileState(path: string): Promise<FileState | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`target is not a regular file: ${path}`);
    const bytes = new Uint8Array(await readFile(path));
    return { hash: sha256(bytes), size: bytes.byteLength, bytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 原子写：先写同目录临时文件再 rename，避免崩溃留下半个 JSON。 */
async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, data);
  await rename(temp, path);
}

function parseCheckpointRecord(raw: unknown): CheckpointRecord | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.version !== RECORD_VERSION) return undefined;
  const id = stringField(raw.id);
  if (id === undefined || !CHECKPOINT_ID_PATTERN.test(id)) return undefined;
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return undefined;
  if (raw.status !== "open" && raw.status !== "closed") return undefined;
  if (!Array.isArray(raw.targets)) return undefined;
  const targets: CheckpointTarget[] = [];
  for (const value of raw.targets) {
    if (!isRecord(value)) return undefined;
    const path = stringField(value.path);
    const displayPath = stringField(value.displayPath);
    if (path === undefined || displayPath === undefined) return undefined;
    if (value.action !== "restore" && value.action !== "delete" && value.action !== "recreate") return undefined;
    if (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string")) return undefined;
    let before: CheckpointTarget["before"] = null;
    if (value.before !== null) {
      if (!isRecord(value.before)) return undefined;
      const hash = stringField(value.before.hash);
      const snapshot = stringField(value.before.snapshot);
      if (hash === undefined || snapshot === undefined || typeof value.before.size !== "number") return undefined;
      before = { hash, snapshot, size: value.before.size };
    }
    const expectedHash = value.expectedHash;
    if (expectedHash !== null && typeof expectedHash !== "string") return undefined;
    if (typeof value.expectedVerified !== "boolean") return undefined;
    targets.push({
      path,
      displayPath,
      action: value.action,
      before,
      expectedHash,
      expectedVerified: value.expectedVerified,
      tools: value.tools,
    });
  }
  return {
    version: RECORD_VERSION,
    id,
    createdAt: raw.createdAt,
    ...(typeof raw.closedAt === "number" ? { closedAt: raw.closedAt } : {}),
    status: raw.status,
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.turn === "number" ? { turn: raw.turn } : {}),
    targets,
    ...(isRecord(raw.lastApply) ? { lastApply: raw.lastApply as unknown as CheckpointRecord["lastApply"] } : {}),
  };
}

function serializeRecord(record: CheckpointRecord): string {
  return JSON.stringify(record, null, 2);
}

/** 写前快照 + 写后期望状态的持久化与命令服务。 */
export class FileCheckpoints extends Service {
  static inject = ["tools"];

  static Config = Config;

  private readonly storageRoot: string;
  private readonly groups = new Map<string, CheckpointRecord>();
  private readonly currentTurns = new Map<string, number>();
  private readonly activeCalls = new Map<string, ActiveCall>();
  private saveTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(ctx: Context, config: FileCheckpointsConfig = {}) {
    super(ctx, "fileCheckpoints");
    this.storageRoot = resolve(
      config.storageRoot ?? join(resolveDshHome(config.dshHome), "file-checkpoints"),
    );
    ctx.on("tools/pre-execute", async (exec, next) => {
      await this.capture(exec);
      return next();
    });
    ctx.on("tools/post-execute", async (exec, result, next) => {
      const settled = await next();
      await this.observeResult(exec, result);
      return settled;
    });
    // final-result 路径（pre-execute 之后的取消/策略失败）可能绕过 post-execute；
    // tools/result 兜底把真实磁盘状态写回 expected，避免留下永远 unverified 的目标。
    ctx.on("tools/result", (exec, result) => {
      if (this.activeCalls.has(String(exec.callId))) void this.observeResult(exec, result);
    });
    // session/event 是 root ctx 上的 emit 链：只用来划分 turn 分组，不写 session log。
    ctx.on("session/event", (session, event) => {
      if (event.type === "turn/start") {
        this.currentTurns.set(String(session.id), event.data.turn);
      } else if (event.type === "turn/end") {
        this.currentTurns.delete(String(session.id));
        void this.closeGroup(`${String(session.id)}:turn:${String(event.data.turn)}`);
      }
    });
    ctx.inject(["commands"], (commandCtx) => {
      commandCtx.commands.register({
        name: "checkpoint",
        description: "List, preview, or apply pre-write file checkpoints captured from dsh write tools",
        input: { hint: "list | preview <id> | apply <id>" },
        handler: async ({ rawInput, signal }) => {
          const input = rawInput.trim();
          const [action, ...rest] = input.length === 0 ? [] : input.split(/\s+/u);
          if (action === "list" && rest.length === 0) {
            return { kind: "success", text: await this.listText() };
          }
          if (action === "preview" && rest.length === 1) {
            try {
              const preview = await this.previewCheckpoint(rest[0]!);
              if (preview === undefined) return { kind: "error", text: `No checkpoint "${rest[0]}".` };
              return { kind: "success", text: this.previewText(preview) };
            } catch (error) {
              return { kind: "error", text: error instanceof Error ? error.message : String(error) };
            }
          }
          if (action === "apply" && rest.length === 1) {
            try {
              const outcome = await this.applyCheckpoint(rest[0]!, signal);
              return outcome.kind === "success"
                ? { kind: "success", text: this.applySuccessText(outcome) }
                : { kind: "error", text: outcome.text };
            } catch (error) {
              return { kind: "error", text: error instanceof Error ? error.message : String(error) };
            }
          }
          return { kind: "error", text: FILE_CHECKPOINTS_USAGE };
        },
      });
    });
    ctx.effect(() => async () => {
      this.disposed = true;
      await Promise.allSettled([...this.groups.keys()].map((key) => this.closeGroup(key)));
      await this.saveTail;
    });
  }

  /** 插件实际使用的存储根（诊断/探针断言）。 */
  get rootPath(): string {
    return this.storageRoot;
  }

  async listCheckpoints(): Promise<CheckpointListEntry[]> {
    await this.saveTail;
    const records = await this.readAllRecords();
    return records
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => ({
        id: record.id,
        createdAt: record.createdAt,
        status: record.status,
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        targetCount: record.targets.length,
        paths: record.targets.map((target) => target.displayPath),
      }));
  }

  async previewCheckpoint(id: string): Promise<CheckpointPreview | undefined> {
    await this.saveTail;
    const record = await this.readRecord(id);
    if (record === undefined) return undefined;
    const targets: CheckpointPreviewTarget[] = [];
    let canApply = record.targets.length > 0;
    for (const target of record.targets) {
      let snapshotReadable = true;
      let error: string | undefined;
      if (target.before !== null) {
        try {
          const snapshot = await this.readSnapshot(record.id, target.before.snapshot);
          if (sha256(snapshot) !== target.before.hash) {
            snapshotReadable = false;
            error = "snapshot bytes do not match the recorded hash";
          }
        } catch (readError) {
          snapshotReadable = false;
          error = readError instanceof Error ? readError.message : String(readError);
        }
      }
      let currentHash: string | null = null;
      try {
        currentHash = (await readFileState(target.path))?.hash ?? null;
      } catch (statError) {
        error = statError instanceof Error ? statError.message : String(statError);
        canApply = false;
      }
      const changedSinceCheckpoint =
        target.expectedVerified && currentHash !== target.expectedHash;
      if (!snapshotReadable || !target.expectedVerified || changedSinceCheckpoint) canApply = false;
      targets.push({
        target,
        snapshotReadable,
        currentHash,
        changedSinceCheckpoint,
        ...(error === undefined ? {} : { error }),
      });
    }
    return { record, targets, canApply };
  }

  /**
   * 全量预检后应用。预检只读；通过后先落 restore record 再写文件。
   * 应用阶段失败/取消返回 kind:"error" 并如实带上已应用路径。
   */
  async applyCheckpoint(id: string, signal: AbortSignal): Promise<CheckpointApplyOutcome> {
    signal.throwIfAborted();
    await this.saveTail;
    const record = await this.readRecord(id);
    if (record === undefined) {
      return { kind: "error", text: `No checkpoint "${id}".`, applied: [], failures: [] };
    }
    if (record.targets.length === 0) {
      return { kind: "error", text: `Checkpoint ${id} has no managed targets.`, applied: [], failures: [] };
    }
    const failures = await this.precheck(record);
    if (failures.length > 0) {
      return {
        kind: "error",
        text:
          `Checkpoint ${id} was not applied; no file was changed. ` +
          `Precheck failed for ${failures.length} target(s): ` +
          failures.map((failure) => `${failure.path}: ${failure.reason}`).join("; ") +
          `. ${RECOVERY_BOUNDARY}`,
        applied: [],
        failures,
      };
    }
    signal.throwIfAborted();

    // 预检通过后、应用任何目标前，把“apply 前当前状态”另存为 restoration record。
    const restore = await this.writeRestoreRecord(record);
    signal.throwIfAborted();

    const applied: string[] = [];
    for (const target of record.targets) {
      if (signal.aborted) {
        return this.applyError(record, restore, applied, target.path, "cancelled before this target was applied");
      }
      try {
        await this.applyTarget(record, target);
        applied.push(target.path);
      } catch (error) {
        return this.applyError(
          record,
          restore,
          applied,
          target.path,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    record.lastApply = {
      restoreId: restore.restoreId,
      appliedAt: Date.now(),
      applied,
      failed: [],
      complete: true,
    };
    await this.persistRecord(record);
    return { kind: "success", applied, restoreId: restore.restoreId, restorePath: restore.path };
  }

  private async applyError(
    record: CheckpointRecord,
    restore: { restoreId: string; path: string },
    applied: string[],
    failedPath: string,
    reason: string,
  ): Promise<CheckpointApplyError> {
    record.lastApply = {
      restoreId: restore.restoreId,
      appliedAt: Date.now(),
      applied,
      failed: [failedPath],
      complete: false,
    };
    await this.persistRecord(record);
    return {
      kind: "error",
      text:
        `Checkpoint ${record.id} FAILED during apply: ${failedPath}: ${reason}. ` +
        `Applied ${applied.length} of ${record.targets.length} target(s)` +
        `${applied.length === 0 ? "" : ` (${applied.join(", ")})`}. ` +
        `Restore record: ${restore.restoreId} at ${restore.path}. ` +
        `This is not a successful apply. ${RECOVERY_BOUNDARY}`,
      applied,
      failures: [{ path: failedPath, reason }],
      restoreId: restore.restoreId,
      restorePath: restore.path,
    };
  }

  private async precheck(record: CheckpointRecord): Promise<CheckpointApplyFailure[]> {
    const failures: CheckpointApplyFailure[] = [];
    for (const target of record.targets) {
      if (target.before !== null) {
        try {
          const snapshot = await this.readSnapshot(record.id, target.before.snapshot);
          if (sha256(snapshot) !== target.before.hash) {
            failures.push({ path: target.path, reason: "snapshot bytes corrupted (hash mismatch)" });
            continue;
          }
        } catch (error) {
          failures.push({
            path: target.path,
            reason: `snapshot unreadable: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
      }
      if (!target.expectedVerified) {
        failures.push({ path: target.path, reason: "post-write state was not observed; target is not verifiable" });
        continue;
      }
      let currentHash: string | null;
      try {
        currentHash = (await readFileState(target.path))?.hash ?? null;
      } catch (error) {
        failures.push({
          path: target.path,
          reason: `current state unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (currentHash !== target.expectedHash) {
        failures.push({
          path: target.path,
          reason:
            `file changed since checkpoint (current ${formatHash(currentHash)}, ` +
            `expected ${formatHash(target.expectedHash)})`,
        });
        continue;
      }
      // 已存在目标的可写性在预检拦下；不存在目标（recreate / will-create 删除）
      // 的目录权限留给应用阶段报告（这样部分应用故障也能被如实观测）。
      if (currentHash !== null) {
        try {
          await access(target.path, fsConstants.W_OK);
        } catch {
          failures.push({ path: target.path, reason: "target is not writable" });
        }
      }
    }
    return failures;
  }

  private async applyTarget(record: CheckpointRecord, target: CheckpointTarget): Promise<void> {
    if (target.action === "delete") {
      await unlink(target.path);
      return;
    }
    if (target.before === null) throw new Error("missing pre-write snapshot for restore/recreate");
    const bytes = await this.readSnapshot(record.id, target.before.snapshot);
    if (sha256(bytes) !== target.before.hash) throw new Error("snapshot bytes corrupted during apply");
    await writeFileAtomic(target.path, bytes);
  }

  private async writeRestoreRecord(
    record: CheckpointRecord,
  ): Promise<{ restoreId: string; path: string }> {
    const id = restoreId();
    if (!RESTORE_ID_PATTERN.test(id)) throw new Error("failed to mint a valid restore id");
    const dir = join(this.storageRoot, record.id, "restores", id);
    const targets: Array<{
      path: string;
      displayPath: string;
      beforeApply: { hash: string; size: number; snapshot: string } | null;
    }> = [];
    for (const [index, target] of record.targets.entries()) {
      const current = await readFileState(target.path);
      if ((current?.hash ?? null) !== target.expectedHash) {
        throw new Error(
          `target changed while preparing the restore record: ${target.path} ` +
            `(current ${formatHash(current?.hash ?? null)}, expected ${formatHash(target.expectedHash)})`,
        );
      }
      if (current === undefined) {
        targets.push({ path: target.path, displayPath: target.displayPath, beforeApply: null });
      } else {
        const snapshot = `snapshots/${index}.bin`;
        await writeFileAtomic(join(dir, snapshot), current.bytes);
        targets.push({
          path: target.path,
          displayPath: target.displayPath,
          beforeApply: { hash: current.hash, size: current.size, snapshot },
        });
      }
    }
    const path = join(dir, "record.json");
    await writeFileAtomic(
      path,
      JSON.stringify(
        {
          version: RECORD_VERSION,
          restoreId: id,
          checkpointId: record.id,
          createdAt: Date.now(),
          targets,
        },
        null,
        2,
      ),
    );
    return { restoreId: id, path };
  }

  private async capture(exec: ToolExecution): Promise<void> {
    if (this.disposed) return;
    const managed = describeManagedWrite(exec.name, exec.arguments);
    if (managed === undefined) return;
    try {
      const resolved = await this.resolveTarget(exec, managed.path);
      const current = await readFileState(resolved.path);
      if (managed.kind === "delete" && current === undefined) return;
      const groupKey = this.groupKey(exec);
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.id);
      const turn = exec.agent === undefined ? undefined : this.currentTurns.get(String(exec.agent.id));
      const existing = this.groups.get(groupKey) ?? {
        version: RECORD_VERSION as typeof RECORD_VERSION,
        id: checkpointId(),
        createdAt: Date.now(),
        status: "open" as const,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(turn === undefined ? {} : { turn }),
        targets: [],
      };
      let target = existing.targets.find((candidate) => candidate.path === resolved.path);
      let createdTarget = false;
      if (target === undefined) {
        let before: CheckpointTarget["before"] = null;
        if (current !== undefined) {
          const snapshot = `snapshots/${existing.targets.length}.bin`;
          await writeFileAtomic(join(this.storageRoot, existing.id, snapshot), current.bytes);
          before = { hash: current.hash, size: current.size, snapshot };
        }
        target = {
          path: resolved.path,
          displayPath: resolved.displayPath,
          action: managed.kind === "delete" ? "recreate" : current !== undefined ? "restore" : "delete",
          before,
          expectedHash: current?.hash ?? null,
          expectedVerified: false,
          tools: [managed.tool],
        };
        existing.targets.push(target);
        createdTarget = true;
      } else if (!target.tools.includes(managed.tool)) {
        target.tools.push(managed.tool);
      }
      this.groups.set(groupKey, existing);
      this.activeCalls.set(String(exec.callId), {
        groupKey,
        path: target.path,
        createdTarget,
      });
      await this.persistRecord(existing);
    } catch (error) {
      // 捕获失败不阻断工具本身；该文件在 apply 时只会因缺少记录而不可恢复。
      this.warn(`file-checkpoints: failed to capture ${managed.tool} ${managed.path}`, error);
    }
  }

  private async observeResult(exec: ToolExecution, result: ToolExecutionResult): Promise<void> {
    if (this.disposed) return;
    const call = this.activeCalls.get(String(exec.callId));
    if (call === undefined) return;
    this.activeCalls.delete(String(exec.callId));
    const group = this.groups.get(call.groupKey);
    if (group === undefined) return;
    const target = group.targets.find((candidate) => candidate.path === call.path);
    if (target === undefined) return;
    try {
      const current = await readFileState(target.path);
      target.expectedHash = current?.hash ?? null;
      target.expectedVerified = true;
      // 失败调用若没有造成任何磁盘变化，就撤销它首次新增的空目标；
      // 否则会留下一个“apply 删除不存在文件”的假检查点。
      if (
        result.isError &&
        call.createdTarget &&
        (current?.hash ?? null) === (target.before?.hash ?? null)
      ) {
        group.targets = group.targets.filter((candidate) => candidate !== target);
        if (group.targets.length === 0) {
          this.groups.delete(call.groupKey);
          await this.discardRecord(group.id);
        } else {
          await this.persistRecord(group);
        }
      } else {
        await this.persistRecord(group);
      }
    } catch (error) {
      target.expectedVerified = false;
      this.warn(`file-checkpoints: failed to verify ${exec.name} result`, error);
    }
    if (call.groupKey.startsWith("root:")) await this.closeGroup(call.groupKey);
  }

  private async discardRecord(id: string): Promise<void> {
    await rm(join(this.storageRoot, id), { recursive: true, force: true });
  }

  private groupKey(exec: ToolExecution): string {
    if (exec.agent === undefined) return `root:${String(exec.rootCallId)}`;
    const sessionId = String(exec.agent.id);
    const turn = this.currentTurns.get(sessionId);
    return turn === undefined ? `${sessionId}:auto` : `${sessionId}:turn:${String(turn)}`;
  }

  private async resolveTarget(
    exec: ToolExecution,
    requested: string,
  ): Promise<{ path: string; displayPath: string }> {
    const workingDirectory = this.ctx.get("workingDirectory") as
      | { get(session: unknown): string | undefined }
      | undefined;
    const declaredCwd =
      exec.agent === undefined
        ? undefined
        : workingDirectory?.get(exec.agent.session) ?? exec.agent.session.header.cwd;
    const cwd = declaredCwd ?? process.cwd();
    const fsService = this.ctx.get("fs") as
      | {
          resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ displayPath: string }>;
          processPath(target: { displayPath: string }): string;
        }
      | undefined;
    if (fsService !== undefined) {
      try {
        const target = await fsService.resolve(requested, { cwd, signal: exec.signal });
        return { path: fsService.processPath(target), displayPath: target.displayPath };
      } catch {
        // 后端 resolve 失败时退回主机路径解析，捕获仍按同一 cwd 进行。
      }
    }
    return {
      path: isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested),
      displayPath: requested,
    };
  }

  private async closeGroup(key: string): Promise<void> {
    const group = this.groups.get(key);
    if (group === undefined) return;
    this.groups.delete(key);
    group.status = "closed";
    group.closedAt = Date.now();
    try {
      await this.persistRecord(group);
    } catch (error) {
      this.warn(`file-checkpoints: failed to close checkpoint ${group.id}`, error);
    }
  }

  private async persistRecord(record: CheckpointRecord): Promise<void> {
    const content = serializeRecord(record);
    const path = join(this.storageRoot, record.id, "record.json");
    const save = this.saveTail.then(
      () => writeFileAtomic(path, content),
      () => writeFileAtomic(path, content),
    );
    this.saveTail = save.then(
      () => undefined,
      () => undefined,
    );
    await save;
  }

  private async readRecord(id: string): Promise<CheckpointRecord | undefined> {
    if (!CHECKPOINT_ID_PATTERN.test(id)) return undefined;
    try {
      const raw = JSON.parse(await readFile(join(this.storageRoot, id, "record.json"), "utf8")) as unknown;
      return parseCheckpointRecord(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readAllRecords(): Promise<CheckpointRecord[]> {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = (await readdir(this.storageRoot, { withFileTypes: true })) as unknown as Array<{
        name: string;
        isDirectory(): boolean;
      }>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: CheckpointRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !CHECKPOINT_ID_PATTERN.test(entry.name)) continue;
      try {
        const record = await this.readRecord(entry.name);
        if (record !== undefined) records.push(record);
      } catch {
        // 单条损坏记录不能拖垮 list；它不会出现在结果里，也不能被 apply。
      }
    }
    return records;
  }

  private async readSnapshot(checkpoint: string, relative: string): Promise<Uint8Array> {
    if (relative.includes("..") || isAbsolute(relative)) throw new Error("invalid snapshot path");
    return new Uint8Array(await readFile(join(this.storageRoot, checkpoint, relative)));
  }

  private async listText(): Promise<string> {
    const entries = await this.listCheckpoints();
    const footer = RECOVERY_BOUNDARY;
    if (entries.length === 0) return `No file checkpoints.\n${footer}`;
    const lines = entries.map((entry) => {
      const paths = entry.paths.slice(0, 3).join(", ");
      const extra = entry.paths.length > 3 ? ` (+${entry.paths.length - 3} more)` : "";
      const session = entry.sessionId === undefined ? "" : `  session=${entry.sessionId}`;
      return `${entry.id}  ${new Date(entry.createdAt).toISOString()}  ${entry.targetCount} target(s)  ${entry.status}  ${paths}${extra}${session}`;
    });
    return `${lines.join("\n")}\n${footer}`;
  }

  private previewText(preview: CheckpointPreview): string {
    const { record } = preview;
    const lines = [
      `Checkpoint ${record.id}  created=${new Date(record.createdAt).toISOString()}  status=${record.status}` +
        `${record.sessionId === undefined ? "" : `  session=${record.sessionId}`}` +
        `${record.turn === undefined ? "" : `  turn=${String(record.turn)}`}`,
    ];
    for (const entry of preview.targets) {
      const { target } = entry;
      const before = target.before === null ? "absent" : target.before.hash;
      lines.push(
        `- ${displayAction(target.action)}  ${target.displayPath}  before=${before}  ` +
          `expected=${formatHash(target.expectedHash)}  current=${formatHash(entry.currentHash)}` +
          `${target.expectedVerified ? "" : "  expected=unverified"}` +
          `${entry.changedSinceCheckpoint ? "  CONFLICT: file changed since checkpoint" : ""}` +
          `${entry.snapshotReadable ? "" : "  snapshot=invalid"}` +
          `${entry.error === undefined ? "" : `  error=${entry.error}`}`,
      );
    }
    lines.push(`canApply=${String(preview.canApply)}`);
    lines.push(RECOVERY_BOUNDARY);
    return lines.join("\n");
  }

  private applySuccessText(outcome: CheckpointApplySuccess): string {
    return (
      `Applied checkpoint to ${String(outcome.applied.length)} target(s). ` +
      `Restore record: ${outcome.restoreId} at ${outcome.restorePath}. ${RECOVERY_BOUNDARY}`
    );
  }

  private warn(message: string, error: unknown): void {
    const logger = (this.ctx as { logger?: { warn(message: string, meta?: unknown): void } }).logger;
    if (logger !== undefined) logger.warn(message, error);
    else console.warn(message, error);
  }
}

export default FileCheckpoints;
