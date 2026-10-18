/**
 * upgrade:diff — 对比两份 ZCode 快照树的公开面，输出结构化差异并把变更交叉引用到
 * `src/engine-facade.ts` 的导入消费点。
 *
 * 差异存在是正常数据，命令以 0 退出；只有参数或快照无效才以 2 退出。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSurfaceDiff, type SurfaceDiff } from "./surface.js";

export const defaultDiffPath = ".agent-work/tmp/upgrade/diff.json";

export function writeDiff(repoRoot: string, baseline: string, candidate: string, out: string): SurfaceDiff {
  const diff = buildSurfaceDiff(repoRoot, resolve(repoRoot, baseline), resolve(repoRoot, candidate));
  const target = resolve(repoRoot, out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(diff, null, 2)}\n`);
  return diff;
}

export function printDiff(diff: SurfaceDiff, out: string): void {
  const counts = Object.entries(diff.summary.byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind}=${String(count)}`)
    .join(", ");
  console.log(
    `[upgrade:diff] baseline=${diff.baseline.treeHash.slice(0, 12)} candidate=${diff.candidate.treeHash.slice(0, 12)} ` +
      `changes=${String(diff.summary.total)} facade-linked=${String(diff.summary.facadeLinked)}`,
  );
  console.log(`[upgrade:diff] kinds: ${counts || "none"}`);
  for (const change of diff.changes.filter((row) => row.facadeConsumers.length > 0).slice(0, 20)) {
    const consumers = change.facadeConsumers
      .map((row) => `${row.imported}(${row.reason})`)
      .join(",");
    console.log(`  - ${change.kind} ${change.path}${change.symbol ? `:${change.symbol}` : ""} -> ${consumers}`);
  }
  if (diff.summary.facadeLinked > 20) console.log(`  ... and ${String(diff.summary.facadeLinked - 20)} more facade-linked changes`);
  console.log(`[upgrade:diff] report: ${out}`);
}

export function main(args = process.argv.slice(2)): number {
  const positional: string[] = [];
  let out = defaultDiffPath;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out" && args[index + 1] && !args[index + 1]!.startsWith("--")) out = args[++index]!;
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new Error("usage: upgrade:diff <baseline> <candidate> [--out FILE]");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const diff = writeDiff(repoRoot, positional[0]!, positional[1]!, out);
  printDiff(diff, out);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[upgrade:diff] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
