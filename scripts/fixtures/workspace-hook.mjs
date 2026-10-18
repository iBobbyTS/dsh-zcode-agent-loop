#!/usr/bin/env node
/**
 * workspace hooks 探针 fixture：从 stdin 读事件 JSON，按参数追加日志/输出结果。
 * 只使用 node 内置模块，确保探针在真实 subprocess 服务下运行。
 *
 * 参数：
 *   --log <path>            追加一行事件 JSON（label + hookEventName + toolName/prompt/source/turnId）
 *   --label <name>          日志标签
 *   --pid <path>            写出自身 pid（取消/卸载场景断言进程已终止）
 *   --sleep <ms>            输出前等待（长命令场景）
 *   --context <text>        stdout 输出 {"additionalContext": text}
 *   --block                 输出 {"continue":false,"reason":"<label>-blocked"}
 *   --block-exit2           stderr 写原因并 exit 2
 *   --stop-continue <text>  Stop 场景输出 decision block + systemMessage
 *   --fail <code>           直接按给定退出码失败
 */
import { appendFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(key.slice(2), true);
    } else {
      values.set(key.slice(2), next);
      index += 1;
    }
  }
  return values;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = parseArgs(process.argv.slice(2));
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

let input = {};
try {
  input = stdin.trim().length === 0 ? {} : JSON.parse(stdin);
} catch {
  // 事件 JSON 不合法也继续，让探针从退出码观察失败。
  input = { parseError: true, raw: stdin };
}

const label = String(args.get("label") ?? "hook");
const logPath = args.get("log");
if (typeof logPath === "string") {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      label,
      hookEventName: input.hook_event_name ?? input.hookEventName,
      mode: input.permission_mode ?? input.mode,
      prompt: input.prompt,
      source: input.source,
      toolName: input.tool_name ?? input.toolName,
      turnId: input.turnId ?? input.turn_id,
    })}\n`,
    "utf8",
  );
}

const pidPath = args.get("pid");
if (typeof pidPath === "string") writeFileSync(pidPath, String(process.pid), "utf8");

const sleepMs = Number(args.get("sleep") ?? 0);
if (Number.isFinite(sleepMs) && sleepMs > 0) await sleep(sleepMs);

if (args.has("fail")) {
  process.exit(Number(args.get("fail")));
}

if (args.has("block-exit2")) {
  process.stderr.write(`${label}-blocked\n`);
  process.exit(2);
}

if (args.has("block")) {
  process.stdout.write(`${JSON.stringify({ continue: false, reason: `${label}-blocked` })}\n`);
  process.exit(0);
}

if (args.has("stop-continue")) {
  const context = String(args.get("stop-continue"));
  process.stdout.write(
    `${JSON.stringify({ decision: "block", reason: context, systemMessage: context })}\n`,
  );
  process.exit(0);
}

if (args.has("context")) {
  process.stdout.write(`${JSON.stringify({ additionalContext: String(args.get("context")) })}\n`);
  process.exit(0);
}

process.exit(0);
