/**
 * upgrade:drill — 隔离升级演练。把 DSH_HOME（sessions/profiles/config 凭证）复制到
 * 本次演练目录，以候选快照替换 vendor 并运行核心门禁；无论结果如何都不触碰原数据。
 *
 * 无候选快照时只记录「演练未完成」并以 0 退出——这是诚实语义，不是成功演练。
 * 所有路径解析都基于本仓库，演练副本位于 `.agent-work/tmp/upgrade/`。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSurfaceDiff, type SurfaceDiff } from "./surface.js";

const SOURCE_ROOTS = [
  "apps/zcode-cli/packages/core/src",
  "apps/zcode-cli/packages/contracts/src",
] as const;
const REQUIRED_DIST = [
  "apps/zcode-cli/packages/core/dist/index.js",
  "apps/zcode-cli/packages/contracts/dist/index.js",
] as const;

export const defaultDrillReportPath = ".agent-work/tmp/upgrade/drill/last-report.json";
export const defaultDrillRoot = ".agent-work/tmp/upgrade/drill";

export interface GateResult {
  name: string;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface LocalizedFailure {
  gate: string;
  file: string;
  line?: number;
  column?: number;
  message: string;
  seam: "facade" | "bridge" | "harness" | "candidate-engine" | "other";
  changeIds: string[];
}

export interface HomeEvidence {
  original: string;
  originalHashBefore: string;
  originalHashAfter: string;
  unchanged: boolean;
  copy?: string;
  copyHash?: string;
  copyIntact?: boolean;
}

export interface DrillReport {
  schemaVersion: 1;
  status: "NOT_RUN" | "PASS" | "FAIL" | "INVALID";
  reason?: string;
  candidate?: string;
  candidateSnapshot?: string;
  workspace?: string;
  home: HomeEvidence;
  gates: GateResult[];
  preparation: { contractsBaselineRecaptured: boolean };
  diff?: Pick<SurfaceDiff, "schemaVersion" | "baseline" | "candidate" | "summary" | "changes" | "facadeImports">;
  failureLocalization: LocalizedFailure[];
  createdAt: string;
}

export interface DrillOptions {
  repoRoot: string;
  candidate?: string;
  home?: string;
  runRoot?: string;
  workspace?: string;
  reuse?: boolean;
  out?: string;
}

interface DrillMetadata {
  schemaVersion: 1;
  candidate: string;
  home: string;
  runDir: string;
  createdAt: string;
}

interface TreeHash {
  hash: string;
  files: number;
  bytes: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

/** 对目录做字节级快照：路径、类型、内容 hash 全部纳入，用于断言原数据未变。 */
export function hashTree(root: string): TreeHash {
  const rows: string[] = [];
  let files = 0;
  let bytes = 0;
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name);
      const rel = posix(relative(root, absolute));
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        rows.push(`link:${rel}:${readlinkSync(absolute)}`);
        continue;
      }
      if (stats.isDirectory()) {
        rows.push(`dir:${rel}`);
        walk(absolute);
        continue;
      }
      const content = readFileSync(absolute);
      rows.push(`file:${rel}:${digest(content.toString("base64"))}`);
      files += 1;
      bytes += content.byteLength;
    }
  }
  if (!existsSync(root)) throw new Error(`path does not exist: ${root}`);
  walk(root);
  return { hash: digest(rows.join("\n")), files, bytes };
}

function copyTree(
  source: string,
  target: string,
  options: { skipTests?: boolean; skipDotStore?: boolean } = {},
): void {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter: (candidate) => {
      const rel = relative(source, candidate);
      if (rel === "") return true;
      const segments = rel.split(sep);
      if (options.skipTests && (segments.includes("tests") || segments.includes("test"))) return false;
      if (options.skipDotStore && segments.includes(".DS_Store")) return false;
      return true;
    },
  });
}

function replacePath(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
}

function symlink(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  replacePath(path);
  symlinkSync(target, path, "dir");
}

function packageNameOf(packageDir: string): string | undefined {
  const file = join(packageDir, "package.json");
  if (!existsSync(file)) return undefined;
  const data = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown };
  return typeof data.name === "string" ? data.name : undefined;
}

function candidatePackages(candidateRoot: string): { name: string; dir: string }[] {
  const rows: { name: string; dir: string }[] = [];
  for (const parent of ["apps/zcode-cli/packages", "packages"]) {
    const root = join(candidateRoot, parent);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const name = packageNameOf(dir);
      if (name?.startsWith("@zcode/")) rows.push({ name, dir });
    }
  }
  return rows;
}

export function validateCandidate(candidateRoot: string): string | null {
  for (const root of SOURCE_ROOTS) {
    if (!existsSync(join(candidateRoot, root))) return `候选快照缺少源码根: ${root}`;
  }
  for (const file of REQUIRED_DIST) {
    if (!existsSync(join(candidateRoot, file))) return `候选快照缺少构建产物: ${file}`;
  }
  const core = packageNameOf(join(candidateRoot, "apps/zcode-cli/packages/core"));
  const contracts = packageNameOf(join(candidateRoot, "apps/zcode-cli/packages/contracts"));
  if (core !== "@zcode/core" || contracts !== "@zcode/contracts") {
    return "候选快照的 core/contracts 包名不符合 @zcode/core、@zcode/contracts";
  }
  return null;
}

function readMetadata(runDir: string): DrillMetadata | undefined {
  const file = join(runDir, ".drill.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as DrillMetadata;
}

/**
 * 副本布局：
 *   <runDir>/repo/vendor/zcode      候选快照（与 node_modules 同深度，保留包内相对链接）
 *   <runDir>/repo/node_modules      指向原仓库依赖树的只读链接
 *   <runDir>/workspace              隔离源码与 @zcode 覆盖层
 */
function stageRun(repoRoot: string, candidate: string, home: string, runDir: string): DrillMetadata {
  mkdirSync(runDir, { recursive: true });
  const repoDir = join(runDir, "repo");
  const vendorDir = join(repoDir, "vendor", "zcode");
  if (existsSync(vendorDir)) throw new Error(`演练目录已存在候选快照: ${vendorDir}; 使用 --reuse 或清理后重试`);
  copyTree(candidate, vendorDir, { skipTests: true, skipDotStore: true });
  symlink(join(repoRoot, "node_modules"), join(repoDir, "node_modules"));

  const workspace = join(runDir, "workspace");
  if (existsSync(workspace)) throw new Error(`演练目录已存在 workspace: ${workspace}; 使用 --reuse 或清理后重试`);
  mkdirSync(workspace, { recursive: true });
  copyTree(join(repoRoot, "src"), join(workspace, "src"), { skipDotStore: true });
  copyTree(join(repoRoot, "scripts"), join(workspace, "scripts"), { skipDotStore: true });
  for (const file of ["package.json", "tsconfig.json", "pnpm-lock.yaml", "cordis.patch.yml"]) {
    cpSync(join(repoRoot, file), join(workspace, file));
  }
  mkdirSync(join(workspace, "docs"), { recursive: true });
  cpSync(join(repoRoot, "docs", "CONTRACT-ORIGINAL-289.json"), join(workspace, "docs", "CONTRACT-ORIGINAL-289.json"));
  symlink(join("..", "repo", "vendor"), join(workspace, "vendor"));

  const nodeModules = join(workspace, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  for (const entry of readdirSync(join(repoRoot, "node_modules"), { withFileTypes: true })) {
    if (entry.name === "@zcode") continue;
    symlink(join(repoRoot, "node_modules", entry.name), join(nodeModules, entry.name));
  }
  const zcodeScope = join(nodeModules, "@zcode");
  mkdirSync(zcodeScope, { recursive: true });
  for (const pkg of candidatePackages(vendorDir)) {
    const shortName = pkg.name.slice("@zcode/".length);
    symlink(pkg.dir, join(zcodeScope, shortName));
  }
  for (const required of ["core", "contracts"]) {
    if (!existsSync(join(zcodeScope, required))) {
      const dir = join(vendorDir, "apps", "zcode-cli", "packages", required);
      if (existsSync(dir)) symlink(dir, join(zcodeScope, required));
    }
  }

  mkdirSync(join(workspace, ".agent-work", "evidence", "integration"), { recursive: true });
  copyTree(home, join(workspace, "home"));

  const metadata: DrillMetadata = {
    schemaVersion: 1,
    candidate: resolve(candidate),
    home: resolve(home),
    runDir: resolve(runDir),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(runDir, ".drill.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

function runGate(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<GateResult> {
  return new Promise((resolveGate) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number | null, signal: string | null): void => {
      clearTimeout(timer);
      resolveGate({
        name,
        command,
        args,
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        stdout,
        stderr,
      });
    };
    child.on("error", (error) => {
      stderr += `\n${String(error)}`;
      finish(1, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function seamOf(file: string): LocalizedFailure["seam"] {
  if (file === "src/engine-facade.ts") return "facade";
  if (file.startsWith("src/bridges/")) return "bridge";
  if (file.startsWith("scripts/")) return "harness";
  if (file.startsWith("vendor/")) return "candidate-engine";
  return "other";
}

function normalizeFile(file: string, workspace: string): string {
  let value = file.startsWith("file://") ? file.slice("file://".length) : file;
  if (value.startsWith(workspace + sep)) value = relative(workspace, value);
  value = posix(value);
  if (value.startsWith("./")) value = value.slice(2);
  return value;
}

function localizeFailures(
  gates: readonly GateResult[],
  workspace: string,
  changes: SurfaceDiff["changes"],
): LocalizedFailure[] {
  const failures: LocalizedFailure[] = [];
  const seen = new Set<string>();
  for (const gate of gates) {
    if (gate.exitCode === 0) continue;
    const output = `${gate.stdout}\n${gate.stderr}`;
    const push = (file: string, line: number | undefined, column: number | undefined, message: string): void => {
      const normalized = normalizeFile(file, workspace);
      const key = `${gate.name}:${normalized}:${String(line)}:${message.slice(0, 120)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const changeIds = changes
        .filter((change) =>
          change.facadeConsumers.some((consumer) => consumer.file === normalized) ||
          (change.facadeConsumers.length > 0 && (normalized === "src/engine-facade.ts" || normalized.startsWith("src/bridges/"))),
        )
        .map((change) => change.id)
        .slice(0, 10);
      failures.push({
        gate: gate.name,
        file: normalized,
        line,
        column,
        message: message.trim().slice(0, 400),
        seam: seamOf(normalized),
        changeIds,
      });
    };

    const diagnostic = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (?:TS\d+: )?(.*)$/gm;
    for (const match of output.matchAll(diagnostic)) {
      push(match[1]!, Number(match[2]), Number(match[3]), match[4]!);
    }
    if (failures.some((row) => row.gate === gate.name)) continue;
    const stack = /([^\s()]+\.(?:ts|mts|cts|js|mjs|cjs)):(\d+):(\d+)/g;
    for (const match of output.matchAll(stack)) {
      push(match[1]!, Number(match[2]), Number(match[3]), output.slice(Math.max(0, match.index - 120), match.index + 200));
    }
    if (failures.some((row) => row.gate === gate.name)) continue;
    const first = output.split("\n").find((line) => line.trim() !== "");
    push("", undefined, undefined, first ?? `${gate.name} exited ${String(gate.exitCode)}`);
  }
  return failures.slice(0, 30);
}

function writeReport(repoRoot: string, out: string, report: DrillReport): void {
  const target = resolve(repoRoot, out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
}

function printReport(report: DrillReport, out: string): void {
  if (report.status === "NOT_RUN") {
    console.log(`[upgrade:drill] ${report.reason === "no-candidate" ? "无候选快照，演练未完成" : report.reason ?? "演练未完成"}（exit 0，未修改任何数据）`);
    console.log(`[upgrade:drill] report: ${out}`);
    return;
  }
  const gates = report.gates.map((gate) => `${gate.name}=${gate.exitCode === 0 ? "PASS" : "FAIL"}`).join(", ");
  console.log(`[upgrade:drill] status ${report.status}; gates: ${gates || "none"}`);
  if (report.diff) {
    console.log(
      `[upgrade:drill] diff: ${String(report.diff.summary.total)} changes, ${String(report.diff.summary.facadeLinked)} facade-linked`,
    );
  }
  console.log(
    `[upgrade:drill] original home unchanged=${String(report.home.unchanged)} ` +
      `copy-intact=${String(report.home.copyIntact ?? "n/a")}`,
  );
  if (report.failureLocalization.length > 0) {
    for (const row of report.failureLocalization.slice(0, 10)) {
      console.log(`  - ${row.gate} ${row.file}${row.line === undefined ? "" : `:${String(row.line)}`} [${row.seam}] ${row.message.slice(0, 160)}`);
    }
  }
  if (report.workspace) console.log(`[upgrade:drill] workspace: ${report.workspace}`);
  console.log(`[upgrade:drill] report: ${out}`);
}

async function executeGates(
  repoRoot: string,
  workspace: string,
  home: string,
): Promise<{ gates: GateResult[]; contractsBaselineRecaptured: boolean }> {
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, NO_COLOR: "1" };
  const gates: GateResult[] = [];
  gates.push(await runGate("typecheck", process.execPath, [tsc, "-p", "tsconfig.json", "--noEmit"], workspace, env, 180_000));
  gates.push(await runGate(
    "home-readback",
    process.execPath,
    [tsx, "scripts/upgrade/home-readback.ts", "--home", home],
    workspace,
    env,
    60_000,
  ));
  gates.push(await runGate("cold-start", process.execPath, [tsx, "scripts/cold-start.ts"], workspace, env, 120_000));
  gates.push(await runGate("facade", process.execPath, ["scripts/assert-facade-isolation.mjs"], workspace, env, 120_000));
  gates.push(await runGate("step-boundary", process.execPath, [tsx, "scripts/step-boundary-integration.ts"], workspace, env, 120_000));

  const rebaseline = await runGate(
    "contracts-rebaseline",
    process.execPath,
    [tsx, "scripts/contract-verification/capabilities.ts", "--record-snapshot"],
    workspace,
    env,
    120_000,
  );
  gates.push(rebaseline);
  gates.push(await runGate(
    "contracts",
    process.execPath,
    [tsx, "scripts/contract-verification/check.ts", "--out", ".agent-work/upgrade-drill/contracts"],
    workspace,
    env,
    300_000,
  ));
  return { gates, contractsBaselineRecaptured: rebaseline.exitCode === 0 };
}

export async function runDrill(options: DrillOptions): Promise<{ report: DrillReport; exitCode: number }> {
  const repoRoot = resolve(options.repoRoot);
  const home = resolve(options.home ?? process.env.DSH_HOME ?? join(repoRoot, ".agent-work/dsh-home"));
  const out = options.out ?? defaultDrillReportPath;
  const createdAt = new Date().toISOString();

  if (options.reuse) {
    if (options.workspace === undefined) throw new Error("--reuse 需要 --workspace <演练目录>");
    const runDir = resolve(repoRoot, options.workspace);
    const metadata = readMetadata(runDir);
    if (metadata === undefined) throw new Error(`演练目录缺少 .drill.json: ${runDir}`);
    if (options.candidate !== undefined && resolve(options.candidate) !== metadata.candidate) {
      throw new Error(`--reuse 的候选快照与演练元数据不一致: ${options.candidate} != ${metadata.candidate}`);
    }
    const workspace = join(runDir, "workspace");
    const candidateSnapshot = join(runDir, "repo", "vendor", "zcode");
    const sandboxHome = join(workspace, "home");
    if (!existsSync(workspace) || !existsSync(sandboxHome)) throw new Error(`演练副本不完整: ${runDir}`);

    const before = hashTree(metadata.home);
    const { gates, contractsBaselineRecaptured } = await executeGates(repoRoot, workspace, sandboxHome);
    const after = hashTree(metadata.home);
    const copy = hashTree(sandboxHome);
    const diff = buildSurfaceDiff(repoRoot, join(repoRoot, "vendor/zcode"), candidateSnapshot);
    const failureLocalization = localizeFailures(gates, workspace, diff.changes);
    const passed = gates.every((gate) => gate.exitCode === 0) && before.hash === after.hash && copy.hash === before.hash;
    const report: DrillReport = {
      schemaVersion: 1,
      status: passed ? "PASS" : "FAIL",
      candidate: metadata.candidate,
      candidateSnapshot,
      workspace,
      home: {
        original: metadata.home,
        originalHashBefore: before.hash,
        originalHashAfter: after.hash,
        unchanged: before.hash === after.hash,
        copy: sandboxHome,
        copyHash: copy.hash,
        copyIntact: copy.hash === before.hash,
      },
      gates,
      preparation: { contractsBaselineRecaptured },
      diff,
      failureLocalization,
      createdAt,
    };
    writeReport(repoRoot, out, report);
    printReport(report, out);
    return { report, exitCode: passed ? 0 : 1 };
  }

  if (options.candidate === undefined || options.candidate.trim() === "") {
    const report: DrillReport = {
      schemaVersion: 1,
      status: "NOT_RUN",
      reason: "no-candidate",
      home: { original: home, originalHashBefore: "", originalHashAfter: "", unchanged: true },
      gates: [],
      preparation: { contractsBaselineRecaptured: false },
      failureLocalization: [],
      createdAt,
    };
    writeReport(repoRoot, out, report);
    printReport(report, out);
    return { report, exitCode: 0 };
  }

  const candidate = resolve(repoRoot, options.candidate);
  const candidateError = validateCandidate(candidate);
  if (candidateError !== null) {
    const report: DrillReport = {
      schemaVersion: 1,
      status: "INVALID",
      reason: candidateError,
      candidate,
      home: { original: home, originalHashBefore: "", originalHashAfter: "", unchanged: true },
      gates: [],
      preparation: { contractsBaselineRecaptured: false },
      failureLocalization: [],
      createdAt,
    };
    writeReport(repoRoot, out, report);
    console.error(`[upgrade:drill] 候选快照不可用: ${candidateError}`);
    console.error(`[upgrade:drill] report: ${out}`);
    return { report, exitCode: 2 };
  }

  const runRoot = resolve(repoRoot, options.runRoot ?? defaultDrillRoot);
  const runDir = options.workspace !== undefined
    ? resolve(repoRoot, options.workspace)
    : join(runRoot, `${createdAt.replaceAll(":", "-").replaceAll(".", "-")}-${digest(candidate).slice(0, 8)}`);
  const before = hashTree(home);
  const metadata = stageRun(repoRoot, candidate, home, runDir);
  const workspace = join(runDir, "workspace");
  const sandboxHome = join(workspace, "home");
  const copy = hashTree(sandboxHome);
  const afterStage = hashTree(home);
  const { gates, contractsBaselineRecaptured } = await executeGates(repoRoot, workspace, sandboxHome);
  const after = hashTree(home);
  const copyAfter = hashTree(sandboxHome);
  const candidateSnapshot = join(runDir, "repo", "vendor", "zcode");
  const diff = buildSurfaceDiff(repoRoot, join(repoRoot, "vendor/zcode"), candidateSnapshot);
  const failureLocalization = localizeFailures(gates, workspace, diff.changes);
  const unchanged = before.hash === after.hash && afterStage.hash === before.hash;
  const copyIntact = copy.hash === before.hash && copyAfter.hash === before.hash;
  const passed = gates.every((gate) => gate.exitCode === 0) && unchanged && copyIntact;
  const report: DrillReport = {
    schemaVersion: 1,
    status: passed ? "PASS" : "FAIL",
    candidate,
    candidateSnapshot,
    workspace,
    home: {
      original: metadata.home,
      originalHashBefore: before.hash,
      originalHashAfter: after.hash,
      unchanged,
      copy: sandboxHome,
      copyHash: copy.hash,
      copyIntact,
    },
    gates,
    preparation: { contractsBaselineRecaptured },
    diff,
    failureLocalization,
    createdAt,
  };
  writeReport(repoRoot, out, report);
  printReport(report, out);
  return { report, exitCode: passed ? 0 : 1 };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let candidate: string | undefined;
  let home: string | undefined;
  let runRoot: string | undefined;
  let workspace: string | undefined;
  let out: string | undefined;
  let reuse = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = args[index + 1];
    if (arg === "--reuse") reuse = true;
    else if (arg === "--candidate" && next && !next.startsWith("--")) candidate = args[++index]!;
    else if (arg === "--home" && next && !next.startsWith("--")) home = args[++index]!;
    else if (arg === "--run-root" && next && !next.startsWith("--")) runRoot = args[++index]!;
    else if (arg === "--workspace" && next && !next.startsWith("--")) workspace = args[++index]!;
    else if (arg === "--out" && next && !next.startsWith("--")) out = args[++index]!;
    else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else if (candidate === undefined) candidate = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await runDrill({ repoRoot, candidate, home, runRoot, workspace, reuse, out });
  return result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`[upgrade:drill] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
