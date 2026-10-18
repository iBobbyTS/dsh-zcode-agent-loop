/**
 * workspace hooks 插件：把 ZCode workspace hook 配置映射到 dsh 执行接缝。
 *
 * 语义边界（最小诚实）：
 * - 只映射有确切 dsh 对应语义的事件：
 *   SessionStart→agent/created、UserPromptSubmit→agent/pre-step、
 *   PreToolUse→tools/pre-execute、PostToolUse/PostToolUseFailure→tools/post-execute、
 *   Stop→session/event(turn/end, completed)。
 *   PermissionRequest 没有可观察/可改写的 dsh 接缝；未知事件与未知 hook type
 *   在导入时抛错并列出，绝不静默忽略。
 * - tools/pre-execute 只对应 PreToolUse：它既不是 PermissionRequest，也不覆盖
 *   SessionStart/UserPromptSubmit/Stop，不能当作全部 ZCode hooks 等价物。
 * - hook 命令经 dsh subprocess 服务执行；stdin 收事件 JSON，stdout 约定为
 *   ZCode HookJSONOutput（非 JSON stdout 视为诊断文本）。exit 2 按 vendor
 *   语义转成 block。subprocess 服务缺席时插件降级：不注册任何执行接缝。
 * - 信任粒度沿用 vendor：按配置来源（bundle/file）判定，而不是单条命令。
 *   未信任来源的条目在导入与每次 dispatch 都记录拒绝，绝不执行。
 *   async hook 的生命周期与 turn 解耦，输出不参与动作决策。
 * - block 按接缝能力落地：PreToolUse 拒绝工具、UserPromptSubmit 拒绝 step、
 *   PostToolUse* 把结果改写为错误反馈；Stop 在 turn/end 观测点已经无法阻止
 *   已完成的 turn，只记录 block 不可执行并把注入内容推迟到下一 turn。
 * - 提示注入不经过 systemPrompt（与 T18 召回解耦）：UserPromptSubmit 改写
 *   pre-step messages，PostToolUse 走 post-execute additionalContexts，
 *   SessionStart/Stop/PreToolUse 走 agent.inject 的 next-step 队列。
 * - dispose 中止插件信号并终止仍在运行的 hook 进程，等待全部任务收口。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  createUserMessage,
  type ContextFormed,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type {
  PostToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "workspace-hooks": {
      kind: "workspace-hooks";
    } & ContextFormed;
  }
}

/** ZCode workspace hook 词表（vendor contracts 的七个事件）。 */
export const WORKSPACE_HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;
export type WorkspaceHookEventName = (typeof WORKSPACE_HOOK_EVENT_NAMES)[number];

export type WorkspaceHookType = "command" | "process";

/** dsh 接缝；字符串只用于诊断/探针断言，不参与动态分派。 */
export type WorkspaceHookSeam =
  | "agent/created"
  | "agent/pre-step"
  | "tools/pre-execute"
  | "tools/post-execute"
  | "session/event:turn/end";

export interface WorkspaceHookDefinition {
  type: WorkspaceHookType;
  command: string;
  enabled?: boolean;
  async?: boolean;
  shell?: true | string;
  args?: string[];
  timeout?: number;
  timeoutMs?: number;
  statusMessage?: string;
  [key: string]: unknown;
}

export interface WorkspaceHookMatcherConfig {
  matcher?: string;
  hooks: WorkspaceHookDefinition[];
  [key: string]: unknown;
}

export interface WorkspaceHooksConfig {
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  events?: Partial<Record<string, WorkspaceHookMatcherConfig[]>>;
  [key: string]: unknown;
}

/** 一个配置来源；trusted 对应 vendor 的 bundle/file 信任判定。 */
export interface WorkspaceHookSourceInput {
  hooks?: WorkspaceHooksConfig;
  /** JSON 配置文件路径（ZCode workspace hook 形状）。 */
  path?: string;
  trusted?: boolean;
}

export interface WorkspaceHooksPluginConfig {
  /** 便捷形态：单来源编程面配置。 */
  config?: WorkspaceHooksConfig;
  /** 便捷形态：单来源 JSON 配置路径。 */
  configPath?: string;
  /** 便捷形态的信任标记。 */
  trusted?: boolean;
  /** 多来源形态；与 config/configPath 互斥。 */
  sources?: WorkspaceHookSourceInput[];
  /** 相对路径解析与 hook 缺省 cwd。 */
  cwd?: string;
}

/** 只映射确切对应语义的事件；PermissionRequest 在 MAPPED 之外。 */
export const WORKSPACE_HOOK_SEAMS: Readonly<
  Partial<Record<WorkspaceHookEventName, WorkspaceHookSeam>>
> = Object.freeze({
  SessionStart: "agent/created",
  UserPromptSubmit: "agent/pre-step",
  PreToolUse: "tools/pre-execute",
  PostToolUse: "tools/post-execute",
  PostToolUseFailure: "tools/post-execute",
  Stop: "session/event:turn/end",
});

/**
 * 覆盖声明：探针/调用方据此判断“不是全部 ZCode hooks 等价物”。
 * tools/pre-execute 只承载 PreToolUse。
 */
export const WORKSPACE_HOOK_COVERAGE = Object.freeze({
  mapped: [
    { event: "SessionStart" as const, seam: "agent/created" as const },
    { event: "UserPromptSubmit" as const, seam: "agent/pre-step" as const },
    { event: "PreToolUse" as const, seam: "tools/pre-execute" as const },
    { event: "PostToolUse" as const, seam: "tools/post-execute" as const },
    { event: "PostToolUseFailure" as const, seam: "tools/post-execute" as const },
    { event: "Stop" as const, seam: "session/event:turn/end" as const },
  ],
  unmapped: [
    {
      event: "PermissionRequest" as const,
      reason:
        "dsh has no observable/rewritable permission-request seam; tools/pre-execute ask delegates to the approval service and cannot host a ZCode PermissionRequest hook. Import is rejected instead of silently ignored.",
    },
  ],
  statement:
    "tools/pre-execute covers only PreToolUse; it is not equivalent to all ZCode hook events.",
});

const ROOT_FIELDS = new Set(["enabled", "timeoutMs", "maxOutputBytes", "events"]);
const MATCHER_FIELDS = new Set(["matcher", "hooks"]);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;
const KILL_GRACE_MS = 100;

interface CompiledMatcher {
  tokens?: string[];
  regex?: RegExp;
}

interface ImportedHook {
  readonly id: string;
  readonly label: string;
  readonly event: WorkspaceHookEventName;
  readonly seam: WorkspaceHookSeam;
  readonly matcher?: CompiledMatcher;
  readonly type: WorkspaceHookType;
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: true | string | undefined;
  readonly async: boolean;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly statusMessage?: string;
  readonly sourceId: string;
}

export interface ImportedWorkspaceHooks {
  readonly enabled: boolean;
  readonly hooksByEvent: Readonly<Record<string, readonly ImportedHook[]>>;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

/** 导入失败：所有问题一次性列出，调用方/日志可直接展示。 */
export class WorkspaceHooksImportError extends Error {
  readonly unknownEventTypes: readonly string[];
  readonly unmappedEventTypes: readonly string[];
  readonly unknownHookTypes: readonly string[];
  readonly invalidMatchers: readonly string[];
  readonly invalidEntries: readonly string[];

  constructor(input: {
    unknownEventTypes: string[];
    unmappedEventTypes: string[];
    unknownHookTypes: string[];
    invalidMatchers: string[];
    invalidEntries: string[];
  }) {
    const sections = [
      input.unknownEventTypes.length > 0
        ? `unknown event types: ${input.unknownEventTypes.join(", ")}`
        : undefined,
      input.unmappedEventTypes.length > 0
        ? `unmapped event types: ${input.unmappedEventTypes.join(", ")}`
        : undefined,
      input.unknownHookTypes.length > 0
        ? `unknown hook types: ${input.unknownHookTypes.join(", ")}`
        : undefined,
      input.invalidMatchers.length > 0
        ? `invalid matchers: ${input.invalidMatchers.join(", ")}`
        : undefined,
      input.invalidEntries.length > 0
        ? `invalid entries: ${input.invalidEntries.join("; ")}`
        : undefined,
    ].filter((section): section is string => section !== undefined);
    super(`Workspace hooks import rejected (${sections.join("; ")})`);
    this.name = "WorkspaceHooksImportError";
    this.unknownEventTypes = input.unknownEventTypes;
    this.unmappedEventTypes = input.unmappedEventTypes;
    this.unknownHookTypes = input.unknownHookTypes;
    this.invalidMatchers = input.invalidMatchers;
    this.invalidEntries = input.invalidEntries;
  }
}

export const Config = z.object({
  config: z.any(),
  configPath: z.string(),
  trusted: z.boolean().default(false),
  sources: z.array(z.any()),
  cwd: z.string(),
}) as unknown as z<WorkspaceHooksPluginConfig>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function compileMatcher(matcher: string): CompiledMatcher | undefined {
  if (matcher.trim().length === 0) return undefined;
  if (/^[a-zA-Z0-9_|]+$/u.test(matcher)) return { tokens: matcher.split("|") };
  try {
    return { regex: new RegExp(matcher) };
  } catch {
    return undefined;
  }
}

function matcherMatches(matcher: CompiledMatcher | undefined, value: string | undefined): boolean {
  if (matcher === undefined) return true;
  if (value === undefined) return false;
  if (matcher.tokens !== undefined) return matcher.tokens.includes(value);
  return matcher.regex!.test(value);
}

function resolveTimeout(
  definition: WorkspaceHookDefinition,
  defaultTimeoutMs: number,
  invalid: string[],
  path: string,
): number {
  const candidate =
    definition.timeoutMs ??
    (definition.type === "command" && definition.timeout !== undefined
      ? definition.timeout * 1000
      : undefined);
  if (candidate === undefined) return defaultTimeoutMs;
  if (!positive(candidate)) {
    invalid.push(`${path}: timeout must be a positive number`);
    return defaultTimeoutMs;
  }
  return Math.max(1, Math.round(candidate));
}

interface ReadSource {
  id: string;
  hooks: unknown;
  trusted: boolean;
}

function readSources(config: WorkspaceHooksPluginConfig): ReadSource[] {
  const invalid: string[] = [];
  if (config.sources !== undefined) {
    if (config.config !== undefined || config.configPath !== undefined) {
      invalid.push("sources is mutually exclusive with config/configPath");
    }
    if (!Array.isArray(config.sources)) {
      invalid.push("sources must be an array");
    }
  }
  if (invalid.length > 0) {
    throw new WorkspaceHooksImportError({
      unknownEventTypes: [],
      unmappedEventTypes: [],
      unknownHookTypes: [],
      invalidMatchers: [],
      invalidEntries: invalid,
    });
  }

  const sources: ReadSource[] = [];
  if (config.sources !== undefined) {
    for (const [index, source] of (config.sources as unknown[]).entries()) {
      if (!isRecord(source)) {
        throw new WorkspaceHooksImportError({
          unknownEventTypes: [],
          unmappedEventTypes: [],
          unknownHookTypes: [],
          invalidMatchers: [],
          invalidEntries: [`sources[${String(index)}] must be an object`],
        });
      }
      const input = source as WorkspaceHookSourceInput;
      const trusted = input.trusted === true;
      if (input.path !== undefined && input.hooks !== undefined) {
        throw new WorkspaceHooksImportError({
          unknownEventTypes: [],
          unmappedEventTypes: [],
          unknownHookTypes: [],
          invalidMatchers: [],
          invalidEntries: [`sources[${String(index)}] cannot set both path and hooks`],
        });
      }
      if (input.path !== undefined) {
        sources.push({
          id: resolveInputPath(input.path, config.cwd),
          hooks: readJsonConfig(input.path, config.cwd),
          trusted,
        });
      } else if (input.hooks !== undefined) {
        sources.push({ id: `programmatic:${String(index)}`, hooks: input.hooks, trusted });
      }
    }
    return sources;
  }

  if (config.config !== undefined && config.configPath !== undefined) {
    throw new WorkspaceHooksImportError({
      unknownEventTypes: [],
      unmappedEventTypes: [],
      unknownHookTypes: [],
      invalidMatchers: [],
      invalidEntries: ["config and configPath are mutually exclusive"],
    });
  }
  if (config.configPath !== undefined) {
    sources.push({
      id: resolveInputPath(config.configPath, config.cwd),
      hooks: readJsonConfig(config.configPath, config.cwd),
      trusted: config.trusted === true,
    });
  } else if (config.config !== undefined) {
    sources.push({
      id: "programmatic",
      hooks: config.config,
      trusted: config.trusted === true,
    });
  }
  return sources;
}

function resolveInputPath(path: string, cwd: string | undefined): string {
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
}

function readJsonConfig(path: string, cwd: string | undefined): unknown {
  const resolved = resolveInputPath(path, cwd);
  try {
    return JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (error) {
    throw new WorkspaceHooksImportError({
      unknownEventTypes: [],
      unmappedEventTypes: [],
      unknownHookTypes: [],
      invalidMatchers: [],
      invalidEntries: [
        `cannot read ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    });
  }
}

/** 纯导入/校验入口；任何未知或不可映射类型都会一次性列在错误里。 */
export function importWorkspaceHooks(config: WorkspaceHooksPluginConfig = {}): ImportedWorkspaceHooks {
  const unknownEventTypes: string[] = [];
  const unmappedEventTypes: string[] = [];
  const unknownHookTypes: string[] = [];
  const invalidMatchers: string[] = [];
  const invalidEntries: string[] = [];
  const hooksByEvent: Record<string, ImportedHook[]> = {};

  let enabled = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;

  for (const source of readSources(config)) {
    if (!isRecord(source.hooks)) {
      invalidEntries.push(`${source.id}: hooks config must be an object`);
      continue;
    }
    const root = source.hooks as WorkspaceHooksConfig;
    for (const key of Object.keys(root)) {
      if (!ROOT_FIELDS.has(key)) invalidEntries.push(`${source.id}: unknown root field "${key}"`);
    }
    const sourceEnabled = root.enabled === true;
    if (sourceEnabled) enabled = true;
    if (root.timeoutMs !== undefined) {
      if (positive(root.timeoutMs)) timeoutMs = Math.round(root.timeoutMs);
      else invalidEntries.push(`${source.id}: timeoutMs must be a positive number`);
    }
    if (root.maxOutputBytes !== undefined) {
      if (positive(root.maxOutputBytes)) maxOutputBytes = Math.round(root.maxOutputBytes);
      else invalidEntries.push(`${source.id}: maxOutputBytes must be a positive number`);
    }
    if (root.events === undefined) continue;
    if (!isRecord(root.events)) {
      invalidEntries.push(`${source.id}: events must be an object`);
      continue;
    }

    for (const [eventName, groups] of Object.entries(root.events)) {
      if (!(WORKSPACE_HOOK_EVENT_NAMES as readonly string[]).includes(eventName)) {
        if (!unknownEventTypes.includes(eventName)) unknownEventTypes.push(eventName);
        continue;
      }
      const seam = WORKSPACE_HOOK_SEAMS[eventName as WorkspaceHookEventName];
      if (seam === undefined) {
        if (!unmappedEventTypes.includes(eventName)) unmappedEventTypes.push(eventName);
        continue;
      }
      if (!Array.isArray(groups)) {
        invalidEntries.push(`${source.id}: events.${eventName} must be an array`);
        continue;
      }
      for (const [matcherIndex, group] of groups.entries()) {
        const groupPath = `${source.id}: events.${eventName}[${String(matcherIndex)}]`;
        if (!isRecord(group)) {
          invalidEntries.push(`${groupPath} must be an object`);
          continue;
        }
        for (const key of Object.keys(group)) {
          if (!MATCHER_FIELDS.has(key)) invalidEntries.push(`${groupPath}: unknown field "${key}"`);
        }
        let matcher: CompiledMatcher | undefined;
        if (group.matcher !== undefined) {
          if (!nonEmpty(group.matcher)) {
            invalidMatchers.push(`${groupPath}: matcher must be a non-empty string`);
          } else {
            matcher = compileMatcher(group.matcher);
            if (matcher === undefined) {
              invalidMatchers.push(`${groupPath}: "${group.matcher}" is not a valid matcher`);
            }
          }
        }
        if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
          invalidEntries.push(`${groupPath}.hooks must be a non-empty array`);
          continue;
        }
        for (const [hookIndex, value] of group.hooks.entries()) {
          const hookPath = `${groupPath}.hooks[${String(hookIndex)}]`;
          if (!isRecord(value)) {
            invalidEntries.push(`${hookPath} must be an object`);
            continue;
          }
          const definition = value as WorkspaceHookDefinition;
          if (definition.type !== "command" && definition.type !== "process") {
            const typeLabel = String((definition as { type?: unknown }).type);
            if (!unknownHookTypes.includes(typeLabel)) unknownHookTypes.push(typeLabel);
            continue;
          }
          // vendor 的 command/process schema 是 passthrough：插件自定义字段合法。
          if (!nonEmpty(definition.command)) {
            invalidEntries.push(`${hookPath}: command must be a non-empty string`);
            continue;
          }
          if (definition.enabled !== undefined && typeof definition.enabled !== "boolean") {
            invalidEntries.push(`${hookPath}: enabled must be a boolean`);
          }
          if (definition.async !== undefined && typeof definition.async !== "boolean") {
            invalidEntries.push(`${hookPath}: async must be a boolean`);
          }
          if (
            definition.shell !== undefined &&
            definition.shell !== true &&
            !nonEmpty(definition.shell)
          ) {
            invalidEntries.push(`${hookPath}: shell must be true or a non-empty string`);
          }
          if (definition.args !== undefined) {
            if (
              !Array.isArray(definition.args) ||
              !definition.args.every((arg) => typeof arg === "string")
            ) {
              invalidEntries.push(`${hookPath}: args must be an array of strings`);
            }
          }
          const hookTimeoutMs = resolveTimeout(definition, timeoutMs, invalidEntries, hookPath);
          const imported: ImportedHook = {
            id: `${source.id}#${eventName}:${String(matcherIndex)}:${String(hookIndex)}`,
            label: `${eventName}#${String(matcherIndex)}.${String(hookIndex)}`,
            event: eventName as WorkspaceHookEventName,
            seam,
            ...(matcher === undefined ? {} : { matcher }),
            type: definition.type,
            command: definition.command,
            args: Array.isArray(definition.args)
              ? definition.args.filter((arg): arg is string => typeof arg === "string")
              : [],
            shell:
              definition.type === "command" && definition.shell !== undefined
                ? definition.shell
                : undefined,
            async: definition.type === "command" && definition.async === true,
            enabled: sourceEnabled && definition.enabled !== false,
            trusted: source.trusted,
            timeoutMs: hookTimeoutMs,
            maxOutputBytes,
            ...(definition.statusMessage === undefined
              ? {}
              : { statusMessage: definition.statusMessage }),
            sourceId: source.id,
          };
          (hooksByEvent[eventName] ??= []).push(imported);
        }
      }
    }
  }

  if (
    unknownEventTypes.length > 0 ||
    unmappedEventTypes.length > 0 ||
    unknownHookTypes.length > 0 ||
    invalidMatchers.length > 0 ||
    invalidEntries.length > 0
  ) {
    throw new WorkspaceHooksImportError({
      unknownEventTypes,
      unmappedEventTypes,
      unknownHookTypes,
      invalidMatchers,
      invalidEntries,
    });
  }

  return { enabled, hooksByEvent, maxOutputBytes, timeoutMs };
}

interface HookInputShape {
  agentName?: string;
  cwd: string;
  hookEventName: WorkspaceHookEventName;
  mode: string;
  sessionId: string;
  timestamp: string;
  traceId: string;
  turnId?: string;
  [key: string]: unknown;
}

interface HookRunOutcome {
  blocked: boolean;
  continueRequested: boolean;
  contexts: string[];
  exitCode: number | null;
  reason?: string;
  signal: string | null;
  status: "cancelled" | "completed" | "failed" | "timed_out";
}

interface EventRunOutcome {
  blocked: boolean;
  contexts: string[];
  continueRequested: boolean;
  reason?: string;
}

const EMPTY_EVENT_RUN: EventRunOutcome = {
  blocked: false,
  contexts: [],
  continueRequested: false,
};

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

function messageText(message: UserMessage): string {
  return textOfContent(message.content);
}

function contextMessages(contexts: readonly string[]): UserMessage[] {
  return contexts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) =>
      createUserMessage({
        content: [{ type: "text", text }],
        source: {
          kind: "workspace-hooks",
          form: "notice",
          summary: "workspace hook context",
        },
      }),
    );
}

function parseHookOutput(
  event: WorkspaceHookEventName,
  stdout: string,
): { output?: Record<string, unknown>; failure?: string } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { failure: "hook stdout started with '{' but is not valid JSON" };
  }
  if (!isRecord(parsed)) return { failure: "hook stdout JSON must be an object" };
  const specific = parsed.hookSpecificOutput;
  if (specific !== undefined) {
    if (!isRecord(specific) || typeof specific.hookEventName !== "string") {
      return { failure: "hookSpecificOutput must carry hookEventName" };
    }
    if (specific.hookEventName !== event) {
      return {
        failure: `hook returned wrong event name ${specific.hookEventName} (expected ${event})`,
      };
    }
  }
  if (parsed.continue !== undefined && typeof parsed.continue !== "boolean") {
    return { failure: "hook output continue must be a boolean" };
  }
  if (
    parsed.decision !== undefined &&
    parsed.decision !== "approve" &&
    parsed.decision !== "block"
  ) {
    return { failure: "hook output decision must be approve or block" };
  }
  return { output: parsed };
}

function interpretHookOutput(
  event: WorkspaceHookEventName,
  output: Record<string, unknown> | undefined,
): Pick<HookRunOutcome, "blocked" | "continueRequested" | "contexts" | "reason"> {
  if (output === undefined) {
    return { blocked: false, continueRequested: false, contexts: [] };
  }
  const contexts: string[] = [];
  const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : {};
  const permissionDecision =
    specific.permissionDecision === "allow" ||
    specific.permissionDecision === "ask" ||
    specific.permissionDecision === "deny"
      ? specific.permissionDecision
      : undefined;
  const blockDecision = output.decision === "block";
  const continueFalse = output.continue === false;

  const blocked =
    event !== "Stop" && (continueFalse || blockDecision || permissionDecision === "deny");
  const continueRequested =
    event === "Stop" && (output.continue === true || blockDecision);

  for (const candidate of [
    output.additionalContext,
    output.additional_context,
    specific.additionalContext,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) contexts.push(candidate);
  }
  if (event === "Stop" && blockDecision) {
    if (typeof output.systemMessage === "string" && output.systemMessage.trim().length > 0) {
      contexts.push(output.systemMessage);
    }
    if (typeof output.reason === "string" && output.reason.trim().length > 0) {
      contexts.push(output.reason);
    }
  }

  const reasonCandidates = [
    output.stopReason,
    output.reason,
    specific.permissionDecisionReason,
    output.systemMessage,
  ];
  const reason = reasonCandidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
  );

  return {
    blocked,
    continueRequested,
    contexts,
    ...(reason === undefined ? {} : { reason }),
  };
}

function exitCodeBlock(
  event: WorkspaceHookEventName,
  reason: string,
): Pick<HookRunOutcome, "blocked" | "continueRequested" | "contexts" | "reason"> {
  if (event === "Stop") {
    // vendor: Stop + exit 2 => decision block => stopShouldContinue
    return { blocked: false, continueRequested: true, contexts: [], reason };
  }
  return { blocked: true, continueRequested: false, contexts: [], reason };
}

/** 去掉会破坏日志单行的控制字符。 */
function singleLine(value: string, max = 400): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

export class WorkspaceHooks extends Service {
  static inject = ["tools"];

  static Config = Config;

  private readonly imported: ImportedWorkspaceHooks;
  private readonly subprocess: SubprocessRuntime | undefined;
  private readonly defaultCwd: string;
  private readonly logger: ReturnType<Context["logger"]>;
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activeHandles = new Set<SubprocessHandle>();
  /** SessionStart 追加上下文暂存到首个 pre-step（agent.start 会因 pending 输入唤醒）。 */
  private readonly startContexts = new Map<string, UserMessage[]>();
  private disposed = false;

  /** subprocess 服务缺席时为 true；不注册任何执行接缝。 */
  readonly degraded: boolean;
  /** 实际注册的 dsh 接缝（探针断言用）。 */
  readonly registeredSeams: readonly string[];

  constructor(ctx: Context, config: WorkspaceHooksPluginConfig = {}) {
    super(ctx, "workspaceHooks");
    this.imported = importWorkspaceHooks(config);
    this.subprocess = ctx.get("subprocess") as SubprocessRuntime | undefined;
    this.defaultCwd = config.cwd ?? process.cwd();
    this.logger = ctx.logger("workspace-hooks");
    this.degraded = this.subprocess === undefined;

    if (this.degraded) {
      this.registeredSeams = [];
      this.log({
        event: "hook.runtime.degraded",
        reason: "subprocess service is absent; workspace hooks are not registered",
      });
    } else {
      this.registeredSeams = this.registerSeams();
      this.log({
        event: "hook.config.imported",
        enabled: this.imported.enabled,
        hookCount: Object.values(this.imported.hooksByEvent).reduce(
          (sum, hooks) => sum + hooks.length,
          0,
        ),
        seams: this.registeredSeams,
        trustedCount: Object.values(this.imported.hooksByEvent)
          .flat()
          .filter((hook) => hook.trusted).length,
        untrustedCount: Object.values(this.imported.hooksByEvent)
          .flat()
          .filter((hook) => !hook.trusted).length,
      });
      for (const hook of Object.values(this.imported.hooksByEvent).flat()) {
        if (hook.trusted) continue;
        this.log({
          event: "hook.trust.rejected",
          hookId: hook.id,
          hookLabel: hook.label,
          hookEventName: hook.event,
          reason: "source is not trusted; hook will not execute",
          source: hook.sourceId,
        });
      }
    }

    ctx.effect(() => async () => {
      this.disposed = true;
      this.abort.abort(new Error("workspace hooks disposed"));
      for (const handle of [...this.activeHandles]) {
        handle.terminate();
      }
      while (this.pending.size > 0) {
        await Promise.allSettled([...this.pending]);
      }
      this.activeHandles.clear();
    }, "workspaceHooks.dispose()");
  }

  /** 等待所有已触发的 hook 任务（含 async/Stop 观测）收口。 */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private registerSeams(): string[] {
    const seams: string[] = [];
    if (this.hooksFor("SessionStart").length > 0) {
      seams.push("agent/created");
      this.ctx.on("agent/created", async ({ agent, source, signal }) => {
        const result = await this.runEvent(
          "SessionStart",
          this.baseInput("SessionStart", agent, {
            model: `${agent.options.provider ?? "unknown"}/${agent.options.model ?? "unknown"}`,
            source,
          }),
          source,
          signal,
        );
        // 不能在 agent/created 里 agent.inject：agent.start() 会因 pending
        // 输入立即开一个只含注入内容的 turn。暂存到首个 pre-step 与用户输入同批。
        const messages = contextMessages(result.contexts);
        if (messages.length > 0) this.startContexts.set(String(agent.id), messages);
      });
      this.ctx.on("agent/disposed", ({ agent }) => {
        this.startContexts.delete(String(agent.id));
      });
    }
    const hasUserPromptHooks = this.hooksFor("UserPromptSubmit").length > 0;
    if (this.hooksFor("SessionStart").length > 0 || hasUserPromptHooks) {
      seams.push("agent/pre-step");
      this.ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
        if (step !== 1) return next();
        const injected: UserMessage[] = [];
        const startContext = this.startContexts.get(String(agent.id));
        if (startContext !== undefined) {
          this.startContexts.delete(String(agent.id));
          injected.push(...startContext);
        }
        if (hasUserPromptHooks) {
          const promptMessages = messages.filter((message) => message.source.kind === "user");
          if (promptMessages.length > 0) {
            const result = await this.runEvent(
              "UserPromptSubmit",
              this.baseInput("UserPromptSubmit", agent, {
                prompt: promptMessages.map(messageText).join("\n"),
              }),
              undefined,
              signal,
            );
            if (signal.aborted) return next();
            if (result.blocked) {
              this.log({
                event: "hook.action.blocked",
                hookEventName: "UserPromptSubmit",
                reason: result.reason ?? "hook blocked the prompt",
              });
              return { kind: "reject" as const };
            }
            injected.push(...contextMessages(result.contexts));
          }
        }
        const decision = await next();
        if (decision.kind === "reject" || injected.length === 0) return decision;
        return {
          ...decision,
          messages: [...decision.messages, ...injected],
        };
      });
    }
    if (this.hooksFor("PreToolUse").length > 0) {
      seams.push("tools/pre-execute");
      this.ctx.on("tools/pre-execute", async (exec, next) => {
        const result = await this.runEvent(
          "PreToolUse",
          this.toolInput("PreToolUse", exec),
          exec.name,
          exec.signal,
        );
        if (exec.signal.aborted) return next();
        if (result.blocked) {
          this.log({
            event: "hook.action.blocked",
            hookEventName: "PreToolUse",
            reason: result.reason ?? "hook denied the tool call",
            toolName: exec.name,
          });
          return {
            kind: "deny" as const,
            reason: result.reason ?? `tool "${exec.name}" blocked by workspace hook`,
          };
        }
        const decision = await next();
        if (decision.kind === "allow" && result.contexts.length > 0) {
          this.inject(exec.agent, result.contexts, "PreToolUse");
        }
        return decision;
      });
    }
    if (
      this.hooksFor("PostToolUse").length > 0 ||
      this.hooksFor("PostToolUseFailure").length > 0
    ) {
      seams.push("tools/post-execute");
      this.ctx.on("tools/post-execute", async (exec, result, next) => {
        const eventName: WorkspaceHookEventName = result.isError
          ? "PostToolUseFailure"
          : "PostToolUse";
        if (this.hooksFor(eventName).length === 0) return next();
        const hookResult = await this.runEvent(
          eventName,
          this.toolResultInput(eventName, exec, result),
          exec.name,
          exec.signal,
        );
        const contexts = contextMessages(hookResult.contexts);
        if (hookResult.blocked) {
          this.log({
            event: "hook.action.blocked",
            hookEventName: eventName,
            reason: hookResult.reason ?? "hook blocked the tool result",
            toolName: exec.name,
          });
          return {
            kind: "block" as const,
            feedback: [
              {
                type: "text" as const,
                text: hookResult.reason ?? `tool "${exec.name}" result blocked by workspace hook`,
              },
            ],
            ...(contexts.length === 0 ? {} : { additionalContexts: contexts }),
          } satisfies PostToolDecision;
        }
        const decision = await next();
        if (contexts.length === 0) return decision;
        return {
          ...decision,
          additionalContexts: [...(decision.additionalContexts ?? []), ...contexts],
        } satisfies PostToolDecision;
      });
    }
    if (this.hooksFor("Stop").length > 0) {
      seams.push("session/event:turn/end");
      this.ctx.on("session/event", (session, event) => {
        if (event.type !== "turn/end" || event.data.reason.kind !== "completed") return;
        if (!session.isOwnSeq(event.seq)) return;
        const job = this.runStopHook(session, event).catch((error: unknown) => {
          this.log({
            event: "hook.run.failed",
            hookEventName: "Stop",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        this.track(job);
      });
    }
    return seams;
  }

  private async runStopHook(
    session: Session,
    event: Extract<SessionEvent, { type: "turn/end" }>,
  ): Promise<void> {
    const agent = (
      this.ctx.get("agents") as { get(id: unknown): Agent | undefined } | undefined
    )?.get(session.id);
    const turn = event.data.turn;
    const responseText = this.turnAssistantText(session, turn, event.seq);
    const toolCallCount = session
      .snapshotEvents()
      .filter(
        (candidate) =>
          candidate.seq < event.seq &&
          candidate.type === "tool/result" &&
          candidate.data.turn === turn,
      ).length;
    const result = await this.runEvent(
      "Stop",
      this.baseInput("Stop", agent, {
        responsePreview: singleLine(responseText, 2_000),
        responseText,
        stopHookActive: false,
        toolCallCount,
      }),
      undefined,
      this.abort.signal,
    );
    if (result.continueRequested) {
      this.log({
        event: "hook.action.unactionable",
        hookEventName: "Stop",
        reason:
          "turn/end already completed; the dsh loop exposes no stop-continuation seam, so the block is recorded only",
      });
    }
    this.inject(agent, result.contexts, "Stop", true);
  }

  private turnAssistantText(session: Session, turn: number, endSeq: number): string {
    let text = "";
    for (const event of session.snapshotEvents()) {
      if (event.seq >= endSeq) break;
      if (event.type !== "assistant/message") continue;
      if (event.data.turn !== turn) continue;
      const candidate = messageText(event.data.message as unknown as UserMessage);
      if (candidate.length > 0) text = candidate;
    }
    return text;
  }

  private inject(
    agent: Agent | undefined,
    contexts: readonly string[],
    hookEventName: WorkspaceHookEventName,
    deferUntilIdle = false,
  ): void {
    if (contexts.length === 0) return;
    if (agent === undefined) {
      this.log({
        event: "hook.injection.dropped",
        hookEventName,
        reason: "no agent is bound to this execution seam",
      });
      return;
    }
    const deliver = (): void => {
      if (this.disposed) return;
      for (const message of contextMessages(contexts)) agent.inject(message);
    };
    if (!deferUntilIdle || agent.status === "idle") {
      deliver();
      return;
    }
    // turn/end 观测点仍在 running：直接 inject 会走 steerActive 重开当前轮。
    // 等 drain 真正收口后落到 next-step，下一次 wake 才消费。
    this.track(
      agent.whenIdle().then(() => {
        deliver();
      }),
    );
  }

  private baseInput(
    hookEventName: WorkspaceHookEventName,
    agent: Agent | undefined,
    extra: Record<string, unknown>,
    session?: Session,
  ): HookInputShape {
    const liveSession = session ?? agent?.session;
    const workingDirectory = this.ctx.get("workingDirectory") as
      | { get(candidate: Session): string | undefined }
      | undefined;
    const cwd =
      liveSession?.header.cwd ??
      (liveSession === undefined ? undefined : workingDirectory?.get(liveSession)) ??
      this.defaultCwd;
    const turnId =
      liveSession?.snapshotEvents().findLast((event) => event.type === "turn/start")?.data.turn;
    return {
      cwd,
      hookEventName,
      mode: "default",
      sessionId: liveSession === undefined ? "unbound" : String(liveSession.id),
      timestamp: new Date().toISOString(),
      traceId: randomUUID(),
      ...(agent === undefined ? {} : { agentName: String(agent.id) }),
      ...(turnId === undefined ? {} : { turnId: String(turnId) }),
      ...extra,
    };
  }

  private toolInput(
    hookEventName: "PreToolUse",
    exec: Readonly<ToolExecution>,
  ): HookInputShape {
    return this.baseInput(hookEventName, exec.agent, {
      toolName: exec.name,
      toolInput: exec.arguments,
      toolCallId: String(exec.callId),
      turnId: undefined,
    });
  }

  private toolResultInput(
    hookEventName: "PostToolUse" | "PostToolUseFailure",
    exec: Readonly<ToolExecution>,
    result: Readonly<ToolExecutionResult>,
  ): HookInputShape {
    const preview = textOfContent(result.content);
    if (result.isError) {
      return this.baseInput(hookEventName, exec.agent, {
        toolName: exec.name,
        toolInput: exec.arguments,
        toolCallId: String(exec.callId),
        error: {
          message: result.error.message,
          type: result.error.info?.name ?? result.error.info?.code ?? "tool_error",
        },
        isInterrupt: false,
      });
    }
    return this.baseInput(hookEventName, exec.agent, {
      toolName: exec.name,
      toolInput: exec.arguments,
      toolCallId: String(exec.callId),
      toolResponse: result.value ?? result.content,
      toolResultPreview: preview,
    });
  }

  private hooksFor(event: WorkspaceHookEventName): readonly ImportedHook[] {
    if (!this.imported.enabled || this.disposed) return [];
    return this.imported.hooksByEvent[event] ?? [];
  }

  private async runEvent(
    event: WorkspaceHookEventName,
    input: HookInputShape,
    matchValue: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<EventRunOutcome> {
    const hooks = this.hooksFor(event).filter(
      (hook) => hook.enabled && matcherMatches(hook.matcher, matchValue),
    );
    if (hooks.length === 0) return EMPTY_EVENT_RUN;

    let blocked = false;
    let continueRequested = false;
    let reason: string | undefined;
    const contexts: string[] = [];

    for (const hook of hooks) {
      if (signal?.aborted) break;
      if (!hook.trusted) {
        this.log({
          event: "hook.trust.rejected",
          hookId: hook.id,
          hookLabel: hook.label,
          hookEventName: event,
          reason: "source is not trusted; execution skipped",
          source: hook.sourceId,
        });
        continue;
      }
      if (hook.async) {
        // vendor 语义：async 生命周期独立，输出不得反向改变已继续的动作。
        const job = this.track(this.runHook(hook, input, signal));
        void job.catch(() => undefined);
        continue;
      }
      const outcome = await this.track(this.runHook(hook, input, signal));
      if (outcome.contexts.length > 0) contexts.push(...outcome.contexts);
      if (outcome.blocked) blocked = true;
      if (outcome.continueRequested) continueRequested = true;
      if (outcome.reason !== undefined && reason === undefined) reason = outcome.reason;
    }

    return {
      blocked,
      contexts,
      continueRequested,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  private async runHook(
    hook: ImportedHook,
    input: HookInputShape,
    parentSignal: AbortSignal | undefined,
  ): Promise<HookRunOutcome> {
    if (this.disposed) {
      return {
        blocked: false,
        continueRequested: false,
        contexts: [],
        exitCode: null,
        signal: null,
        status: "cancelled",
      };
    }
    const startedAt = Date.now();
    const timeout = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeout.abort(new Error("workspace hook timed out"));
    }, hook.timeoutMs);
    timer.unref?.();
    const combined =
      parentSignal === undefined
        ? AbortSignal.any([this.abort.signal, timeout.signal])
        : AbortSignal.any([this.abort.signal, parentSignal, timeout.signal]);

    let handle: SubprocessHandle | undefined;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let status: HookRunOutcome["status"] = "failed";
    let stdout = "";
    let stderr = "";
    try {
      const stdin = `${JSON.stringify(compatibleStdin(input))}\n`;
      const spec = this.spawnSpec(hook, input, stdin, combined);
      handle = this.subprocess!.spawn(spec);
      this.activeHandles.add(handle);
      const outcome = await handle.done;
      exitCode = outcome.exitCode;
      signal = outcome.signal;
      stdout = handle.collected.stdout?.readFrom(0).text ?? "";
      stderr = handle.collected.stderr?.readFrom(0).text ?? "";
      if (timedOut) status = "timed_out";
      else if (combined.aborted) status = "cancelled";
      else status = "completed";
    } catch (error) {
      this.log({
        event: "hook.run.failed",
        hookId: hook.id,
        hookLabel: hook.label,
        hookEventName: hook.event,
        error: error instanceof Error ? error.message : String(error),
      });
      status = combined.aborted ? (timedOut ? "timed_out" : "cancelled") : "failed";
    } finally {
      clearTimeout(timer);
      if (handle !== undefined) this.activeHandles.delete(handle);
    }

    const durationMs = Date.now() - startedAt;
    if (status !== "completed") {
      this.log({
        durationMs,
        event: "hook.run.failed",
        exitCode,
        hookEventName: hook.event,
        hookId: hook.id,
        hookLabel: hook.label,
        outcome: status,
        signal,
        stderrPreview: singleLine(stderr),
      });
      return {
        blocked: false,
        continueRequested: false,
        contexts: [],
        exitCode,
        signal,
        status,
      };
    }

    let interpreted: Pick<
      HookRunOutcome,
      "blocked" | "continueRequested" | "contexts" | "reason"
    > = { blocked: false, continueRequested: false, contexts: [] };
    if (exitCode === 2) {
      const reason =
        singleLine(stderr) ||
        singleLine(stdout) ||
        `${hook.label} blocked execution`;
      interpreted = exitCodeBlock(hook.event, reason);
    } else if (exitCode === 0) {
      const parsed = parseHookOutput(hook.event, stdout);
      if (parsed.failure !== undefined) {
        this.log({
          durationMs,
          event: "hook.run.failed",
          exitCode,
          hookEventName: hook.event,
          hookId: hook.id,
          hookLabel: hook.label,
          outcome: "invalid_output",
          reason: parsed.failure,
          stderrPreview: singleLine(stderr),
        });
      } else {
        interpreted = interpretHookOutput(hook.event, parsed.output);
      }
    } else {
      this.log({
        durationMs,
        event: "hook.run.failed",
        exitCode,
        hookEventName: hook.event,
        hookId: hook.id,
        hookLabel: hook.label,
        outcome: "nonzero_exit",
        stderrPreview: singleLine(stderr),
      });
      return {
        blocked: false,
        continueRequested: false,
        contexts: [],
        exitCode,
        signal,
        status,
      };
    }

    this.log({
      blocked: interpreted.blocked,
      continueRequested: interpreted.continueRequested,
      contextCount: interpreted.contexts.length,
      durationMs,
      event: "hook.run.completed",
      exitCode,
      hookEventName: hook.event,
      hookId: hook.id,
      hookLabel: hook.label,
      reason: interpreted.reason === undefined ? undefined : singleLine(interpreted.reason),
      signal,
      source: hook.sourceId,
    });
    return {
      ...interpreted,
      exitCode,
      signal,
      status,
    };
  }

  private spawnSpec(
    hook: ImportedHook,
    input: HookInputShape,
    stdin: string,
    signal: AbortSignal,
  ) {
    return {
      argv:
        hook.type === "process"
          ? [hook.command, ...hook.args]
          : this.shellArgv(hook.shell, hook.command),
      cwd: input.cwd,
      stdio: {
        stdin: { data: stdin },
        stdout: { maxBytes: hook.maxOutputBytes },
        stderr: { maxBytes: hook.maxOutputBytes },
      },
      graceMs: KILL_GRACE_MS,
      signal,
      env: {
        CLAUDE_PROJECT_DIR: input.cwd,
        CLAUDE_SESSION_ID: input.sessionId,
        ZCODE_HOOK_EVENT: hook.event,
        ZCODE_PROJECT_DIR: input.cwd,
        ZCODE_SESSION_ID: input.sessionId,
      },
    };
  }

  private shellArgv(shell: true | string | undefined, command: string): string[] {
    if (process.platform === "win32") {
      const executable =
        typeof shell === "string" ? shell : (process.env.ComSpec ?? "cmd.exe");
      return [executable, "/d", "/s", "/c", command];
    }
    const executable = typeof shell === "string" ? shell : "/bin/sh";
    return [executable, "-c", command];
  }

  private track<T>(job: Promise<T>): Promise<T> {
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
    return job;
  }

  private log(record: Record<string, unknown>): void {
    try {
      this.logger.info(JSON.stringify(record));
    } catch {
      // 日志面失败不得改变 hook 决策或阻断动作。
    }
  }
}

/** vendor 兼容 stdin：camelCase 主字段 + snake_case 别名。 */
function compatibleStdin(input: HookInputShape): Record<string, unknown> {
  const toolName = input.toolName;
  const toolInput = input.toolInput;
  const toolCallId = input.toolCallId;
  return {
    ...input,
    agent_type: input.agentName,
    hook_event_name: input.hookEventName,
    permission_mode: input.mode,
    session_id: input.sessionId,
    ...(toolName === undefined ? {} : { tool_name: toolName }),
    ...(toolInput === undefined ? {} : { tool_input: toolInput }),
    ...(toolCallId === undefined ? {} : { tool_use_id: toolCallId }),
    ...(input.toolResponse === undefined ? {} : { tool_response: input.toolResponse }),
    ...(input.error === undefined ? {} : { error_details: input.error }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.stopHookActive === undefined
      ? {}
      : { stop_hook_active: input.stopHookActive }),
  };
}

export default WorkspaceHooks;
