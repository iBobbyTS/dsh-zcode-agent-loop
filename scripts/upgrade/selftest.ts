/**
 * verify:upgrade — 升级工具链的注入式自验闭环。
 *
 * 全部变更发生在 `.agent-work/tmp/upgrade/selftest/` 的候选副本与演练副本：
 *   真实接口形状变更 → upgrade:diff 捕获并关联 facade 消费点 → drill 门禁失败并
 *   定位接缝 → 在演练副本的 facade/桥件做最小修复 → drill 门禁恢复。
 * 结束时断言原仓库 vendor/src 与原始 DSH_HOME 字节未变。
 *
 * 这不是真实升级演练：候选来自当前快照的注入副本，报告必须把两者分开记录。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashTree, type DrillReport } from "./drill.js";
import type { SurfaceDiff } from "./surface.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const selftestRoot = join(repoRoot, ".agent-work", "tmp", "upgrade", "selftest");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const home = resolve(process.env.DSH_HOME ?? join(repoRoot, ".agent-work", "dsh-home"));

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(script: string, args: string[]): CommandResult {
  const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function copyCandidate(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (candidate) => {
      const rel = relative(source, candidate);
      if (rel === "") return true;
      const segments = rel.split(sep);
      return !segments.includes("tests") && !segments.includes(".DS_Store");
    },
  });
}

function replaceOnce(file: string, from: string, to: string): void {
  const text = readFileSync(file, "utf8");
  const index = text.indexOf(from);
  if (index < 0) throw new Error(`注入锚点不存在: ${file}`);
  writeFileSync(file, `${text.slice(0, index)}${to}${text.slice(index + from.length)}`);
}

function injectShapeChange(candidate: string): void {
  const source = join(candidate, "apps/zcode-cli/packages/contracts/src/model/model.ts");
  const declaration = join(candidate, "apps/zcode-cli/packages/contracts/dist/model/model.d.ts");
  replaceOnce(
    source,
    "  readonly options: ModelOptions;\n",
    "  readonly options: ModelOptions;\n  /** 注入式自验：候选快照新增的必填字段（仅隔离副本）。 */\n  readonly candidateShapeProbe: string;\n",
  );
  replaceOnce(
    declaration,
    "    readonly options: ModelOptions;\n",
    "    readonly options: ModelOptions;\n    readonly candidateShapeProbe: string;\n",
  );
}

function patchSandboxBridge(workspace: string): void {
  const facade = join(workspace, "src", "engine-facade.ts");
  const bridge = join(workspace, "src", "bridges", "model-bridge.ts");
  replaceOnce(
    facade,
    ": Model => ({\n      providerId,",
    ': Model => ({\n      candidateShapeProbe: "candidate-shape-probe",\n      providerId,',
  );
  replaceOnce(
    bridge,
    "      return {\n        providerId: createModelProviderId(provider),",
    '      return {\n        candidateShapeProbe: "candidate-shape-probe",\n        providerId: createModelProviderId(provider),',
  );
}

function fail(message: string): never {
  console.error(`[verify:upgrade] FAIL: ${message}`);
  process.exit(1);
}

function assertStatus(result: CommandResult, expected: number, label: string): void {
  if (result.status !== expected) {
    fail(
      `${label} exited ${String(result.status)} (expected ${String(expected)})\n` +
        `stdout:\n${result.stdout.slice(-4000)}\nstderr:\n${result.stderr.slice(-8000)}`,
    );
  }
}

async function main(): Promise<void> {
  const vendorHashBefore = hashTree(join(repoRoot, "vendor", "zcode")).hash;
  const srcHashBefore = hashTree(join(repoRoot, "src")).hash;
  const homeHashBefore = hashTree(home).hash;

  rmSync(selftestRoot, { recursive: true, force: true });
  mkdirSync(selftestRoot, { recursive: true });

  // 1. manifest 生成与漂移校验
  console.log("[verify:upgrade] 1/7 manifest 生成与校验");
  const manifestOut = join(selftestRoot, "manifest.json");
  const generated = runCli("scripts/upgrade/manifest.ts", ["--out", manifestOut]);
  assertStatus(generated, 0, "upgrade:manifest");
  assert.ok(existsSync(manifestOut), "manifest file must exist");
  const manifest = readJson<{
    schemaVersion: number;
    snapshot: { root: string; treeHash: string; fileCount: number };
    packages: Record<string, { name: string; version: string }>;
    provenance: { reference: { commit: string | null; matchesSnapshot: boolean | null } };
  }>(manifestOut);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.snapshot.root, "vendor/zcode");
  assert.ok(manifest.snapshot.fileCount > 1000, "manifest must cover the source tree");
  assert.equal(manifest.packages["apps/zcode-cli/packages/core"]?.name, "@zcode/core");
  assert.equal(manifest.provenance.reference.matchesSnapshot, true, "vendor must match the read-only reference source roots");
  const checked = runCli("scripts/upgrade/manifest.ts", ["--check", "--out", manifestOut]);
  assertStatus(checked, 0, "upgrade:manifest --check");
  assert.match(checked.stdout, /check PASS/);

  // 漂移校验必须在不改 vendor 的前提下报告漂移
  const driftManifest = readJson<{ files: Record<string, string> }>(manifestOut);
  const driftFile = Object.keys(driftManifest.files).sort()[0]!;
  driftManifest.files[driftFile] = "0000000000000000000000000000000000000000000000000000000000000000";
  const driftOut = join(selftestRoot, "manifest-drift.json");
  writeFileSync(driftOut, `${JSON.stringify(driftManifest, null, 2)}\n`);
  const driftCheck = runCli("scripts/upgrade/manifest.ts", ["--check", "--out", driftOut]);
  assertStatus(driftCheck, 1, "upgrade:manifest --check (drift)");
  assert.match(`${driftCheck.stdout}\n${driftCheck.stderr}`, /check FAIL/);
  assert.match(`${driftCheck.stdout}\n${driftCheck.stderr}`, new RegExp(driftFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // 2. 无候选时 drill 的诚实语义
  console.log("[verify:upgrade] 2/7 无候选 drill 诚实退出");
  const notRunOut = join(selftestRoot, "drill-not-run.json");
  const notRun = runCli("scripts/upgrade/drill.ts", ["--out", notRunOut]);
  assertStatus(notRun, 0, "upgrade:drill (no candidate)");
  assert.match(notRun.stdout, /无候选快照，演练未完成/);
  const notRunReport = readJson<DrillReport>(notRunOut);
  assert.equal(notRunReport.status, "NOT_RUN");
  assert.equal(notRunReport.reason, "no-candidate");

  // 3. 构造注入式候选副本（真实接口形状变更）
  console.log("[verify:upgrade] 3/7 构造注入式候选快照");
  const candidate = join(selftestRoot, "candidate");
  copyCandidate(join(repoRoot, "vendor", "zcode"), candidate);
  injectShapeChange(candidate);

  // 4. diff 捕获并关联 facade 消费点
  console.log("[verify:upgrade] 4/7 diff 捕获注入变更");
  const diffOut = join(selftestRoot, "diff.json");
  const diffRun = runCli("scripts/upgrade/diff.ts", [join(repoRoot, "vendor", "zcode"), candidate, "--out", diffOut]);
  assertStatus(diffRun, 0, "upgrade:diff");
  const diff = readJson<SurfaceDiff>(diffOut);
  const modelChange = diff.changes.find(
    (change) =>
      change.path === "apps/zcode-cli/packages/contracts/src/model/model.ts" &&
      change.symbol === "Model" &&
      change.kind === "declaration-changed",
  );
  if (modelChange === undefined) fail("diff 未捕获 contracts Model 声明变更");
  const facadeLinked = modelChange.facadeConsumers.some(
    (consumer) => consumer.file === "src/engine-facade.ts" && consumer.imported === "Model",
  );
  assert.ok(facadeLinked, "diff 未把 Model 变更关联到 src/engine-facade.ts");
  assert.ok(diff.summary.facadeLinked >= 1);

  // 5. drill 失败并定位到 facade/bridge 接缝
  console.log("[verify:upgrade] 5/7 drill 捕获门禁失败");
  const drillDir = join(selftestRoot, "drill");
  const failedOut = join(selftestRoot, "drill-failed.json");
  const failedRun = runCli("scripts/upgrade/drill.ts", [candidate, "--workspace", drillDir, "--out", failedOut]);
  assertStatus(failedRun, 1, "upgrade:drill (injected candidate)");
  const failed = readJson<DrillReport>(failedOut);
  assert.equal(failed.status, "FAIL");
  const typecheck = failed.gates.find((gate) => gate.name === "typecheck");
  if (typecheck === undefined) fail("drill 未运行 typecheck 门禁");
  assert.notEqual(typecheck.exitCode, 0, "注入变更必须让 typecheck 失败");
  const typecheckOutput = `${typecheck.stdout}\n${typecheck.stderr}`;
  assert.match(typecheckOutput, /candidateShapeProbe/, "失败信息必须指出注入的必填字段");
  assert.match(typecheckOutput, /src\/engine-facade\.ts/, "失败定位必须指向 facade");
  const facadeFailure = failed.failureLocalization.find((row) => row.file === "src/engine-facade.ts");
  if (facadeFailure === undefined) fail("drill 失败定位未指向 src/engine-facade.ts");
  assert.ok(
    facadeFailure.changeIds.includes(modelChange.id),
    "失败定位必须关联 diff 捕获的 Model 声明变更",
  );
  assert.equal(failed.home.unchanged, true, "drill 必须保持原 DSH_HOME 不变");
  assert.equal(failed.preparation.contractsBaselineRecaptured, true);

  // 6. 在隔离副本的 facade 与必要桥件做最小修复
  console.log("[verify:upgrade] 6/7 隔离副本最小桥件修复");
  if (failed.workspace === undefined) fail("drill 报告缺少 workspace");
  patchSandboxBridge(failed.workspace);

  // 7. 复用同一演练副本重跑门禁，确认恢复
  console.log("[verify:upgrade] 7/7 重跑门禁确认恢复");
  const fixedOut = join(selftestRoot, "drill-fixed.json");
  const fixedRun = runCli("scripts/upgrade/drill.ts", ["--workspace", drillDir, "--reuse", "--out", fixedOut]);
  assertStatus(fixedRun, 0, "upgrade:drill --reuse (fixed bridge)");
  const fixed = readJson<DrillReport>(fixedOut);
  assert.equal(fixed.status, "PASS");
  assert.ok(fixed.gates.every((gate) => gate.exitCode === 0), "修复后全部门禁必须通过");
  assert.equal(fixed.home.unchanged, true);
  assert.equal(fixed.home.copyIntact, true);

  // 原仓库与原数据零改动断言
  assert.equal(hashTree(join(repoRoot, "vendor", "zcode")).hash, vendorHashBefore, "原 vendor 树必须零改动");
  assert.equal(hashTree(join(repoRoot, "src")).hash, srcHashBefore, "原 src 必须零改动");
  assert.equal(hashTree(home).hash, homeHashBefore, "原 DSH_HOME 必须零改动");

  const report = {
    schemaVersion: 1,
    kind: "injected-toolchain-selftest",
    note: "注入式自验不是真实升级演练；真实候选快照不可得时 drill 记录未完成。",
    generatedAt: new Date().toISOString(),
    manifest: { treeHash: manifest.snapshot.treeHash, files: manifest.snapshot.fileCount },
    injectedChange: {
      path: "apps/zcode-cli/packages/contracts/src/model/model.ts",
      symbol: "Model",
      field: "candidateShapeProbe",
    },
    diff: {
      changes: diff.summary.total,
      facadeLinked: diff.summary.facadeLinked,
      capturedChangeId: modelChange.id,
      capturedConsumers: modelChange.facadeConsumers,
    },
    failedDrill: {
      status: failed.status,
      failedGates: failed.gates.filter((gate) => gate.exitCode !== 0).map((gate) => gate.name),
      localization: failed.failureLocalization.filter((row) => row.seam === "facade" || row.seam === "bridge"),
      homeUnchanged: failed.home.unchanged,
    },
    fixedDrill: {
      status: fixed.status,
      gates: fixed.gates.map((gate) => ({ name: gate.name, exitCode: gate.exitCode })),
      homeUnchanged: fixed.home.unchanged,
    },
    originals: {
      vendorUnchanged: true,
      srcUnchanged: true,
      homeUnchanged: true,
    },
  };
  writeFileSync(join(selftestRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `[verify:upgrade] PASS: diff captured ${modelChange.id} -> facade; ` +
      "gate failed then recovered after isolated facade/bridge fix; originals unchanged",
  );
}

main().catch((error: unknown) => {
  console.error(`[verify:upgrade] FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
