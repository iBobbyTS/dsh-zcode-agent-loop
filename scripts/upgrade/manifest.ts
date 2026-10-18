/**
 * upgrade:manifest — 为 vendored ZCode 快照生成 provenance 清单，或对比当前树与
 * 已存清单报告漂移。
 *
 * 清单是生成物（默认 `.agent-work/tmp/upgrade/manifest.json`），可随时重建，不入库；
 * 校验只读当前 vendor 树与 reference 元数据，不修改任何快照。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../contract-verification/oracle.js";
import { packageSourceRoots, snapshotTree, type PackageInfo, type SurfaceSnapshot } from "./surface.js";

export const defaultManifestPath = ".agent-work/tmp/upgrade/manifest.json";
export const vendorSnapshotPath = "vendor/zcode";
export const referenceSnapshotPath = "reference/ZCode";

export interface SnapshotManifest {
  schemaVersion: 1;
  generatedAt: string;
  snapshot: {
    root: string;
    treeHash: string;
    fileCount: number;
    packageCount: number;
    sourceRoots: readonly string[];
  };
  provenance: {
    reference: {
      path: string;
      commit: string | null;
      describe: string | null;
      version: string | null;
      matchesSnapshot: boolean | null;
    };
    note: string;
  };
  packages: Record<string, PackageInfo>;
  files: Record<string, string>;
}

export interface ManifestDrift {
  kind: "file-added" | "file-removed" | "file-changed" | "package-version-changed" | "package-dependency-changed" | "reference-changed";
  path: string;
  detail?: unknown;
}

function gitValue(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function referenceProvenance(repoRoot: string): SnapshotManifest["provenance"]["reference"] {
  const reference = join(repoRoot, referenceSnapshotPath);
  if (!existsSync(reference)) {
    return { path: referenceSnapshotPath, commit: null, describe: null, version: null, matchesSnapshot: null };
  }
  let version: string | null = null;
  const packageFile = join(reference, "package.json");
  if (existsSync(packageFile)) {
    const data = readJson(packageFile) as { version?: unknown };
    if (typeof data.version === "string") version = data.version;
  }
  let matchesSnapshot: boolean | null = null;
  try {
    const referenceSnapshot = snapshotTree(reference);
    const vendorSnapshot = snapshotTree(join(repoRoot, vendorSnapshotPath));
    matchesSnapshot = referenceSnapshot.treeHash === vendorSnapshot.treeHash;
  } catch {
    matchesSnapshot = null;
  }
  return {
    path: referenceSnapshotPath,
    commit: gitValue(reference, ["rev-parse", "HEAD"]),
    describe: gitValue(reference, ["describe", "--tags", "--always"]),
    version,
    matchesSnapshot,
  };
}

export function buildManifest(repoRoot: string): SnapshotManifest {
  const snapshotRoot = join(repoRoot, vendorSnapshotPath);
  const tree: SurfaceSnapshot = snapshotTree(snapshotRoot);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshot: {
      root: vendorSnapshotPath,
      treeHash: tree.treeHash,
      fileCount: Object.keys(tree.files).length,
      packageCount: Object.keys(tree.packages).length,
      sourceRoots: packageSourceRoots,
    },
    provenance: {
      reference: referenceProvenance(repoRoot),
      note:
        "vendor 树由 reference/ZCode 同源拷贝；reference 为只读来源，清单不修改它。matchesSnapshot 只比较公开源码根。",
    },
    packages: tree.packages,
    files: tree.files,
  };
}

function comparePackages(
  baseline: Record<string, PackageInfo>,
  current: Record<string, PackageInfo>,
): ManifestDrift[] {
  const drift: ManifestDrift[] = [];
  const dirs = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  for (const dir of dirs) {
    const before = baseline[dir];
    const after = current[dir];
    if (before === undefined || after === undefined) {
      drift.push({
        kind: "file-changed",
        path: `${dir}/package.json`,
        detail: before === undefined ? "package added" : "package removed",
      });
      continue;
    }
    if (before.version !== after.version) {
      drift.push({
        kind: "package-version-changed",
        path: `${dir}/package.json`,
        detail: { from: before.version, to: after.version },
      });
    }
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      if (hash(JSON.stringify(before[field])) !== hash(JSON.stringify(after[field]))) {
        drift.push({
          kind: "package-dependency-changed",
          path: `${dir}/package.json`,
          detail: { field, baseline: before[field], current: after[field] },
        });
      }
    }
  }
  return drift;
}

export function compareManifest(
  previous: SnapshotManifest,
  current: SnapshotManifest,
): ManifestDrift[] {
  if (previous.schemaVersion !== 1) throw new Error(`unsupported manifest schema: ${String(previous.schemaVersion)}`);
  const drift: ManifestDrift[] = [];
  for (const path of [...new Set([...Object.keys(previous.files), ...Object.keys(current.files)])].sort()) {
    const before = previous.files[path];
    const after = current.files[path];
    if (before === after) continue;
    drift.push({
      kind: before === undefined ? "file-added" : after === undefined ? "file-removed" : "file-changed",
      path,
    });
  }
  drift.push(...comparePackages(previous.packages, current.packages));
  const beforeReference = previous.provenance.reference;
  const afterReference = current.provenance.reference;
  if (
    beforeReference.commit !== afterReference.commit ||
    beforeReference.describe !== afterReference.describe ||
    beforeReference.matchesSnapshot !== afterReference.matchesSnapshot
  ) {
    drift.push({
      kind: "reference-changed",
      path: referenceSnapshotPath,
      detail: { previous: beforeReference, current: afterReference },
    });
  }
  if (previous.snapshot.treeHash !== current.snapshot.treeHash && drift.length === 0) {
    drift.push({
      kind: "file-changed",
      path: vendorSnapshotPath,
      detail: { from: previous.snapshot.treeHash, to: current.snapshot.treeHash },
    });
  }
  return drift;
}

function writeManifest(repoRoot: string, out: string): number {
  const manifest = buildManifest(repoRoot);
  const target = resolve(repoRoot, out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  const reference = manifest.provenance.reference;
  console.log(
    `[upgrade:manifest] wrote ${relative(repoRoot, target)}; tree=${manifest.snapshot.treeHash.slice(0, 12)} ` +
      `files=${String(manifest.snapshot.fileCount)} packages=${String(manifest.snapshot.packageCount)}`,
  );
  console.log(
    `[upgrade:manifest] reference commit=${reference.commit ?? "unavailable"} ` +
      `describe=${reference.describe ?? "unavailable"} matchesSnapshot=${String(reference.matchesSnapshot)}`,
  );
  const key = manifest.packages["apps/zcode-cli/packages/core"];
  console.log(
    `[upgrade:manifest] core=${key?.name ?? "missing"}@${key?.version ?? "?"} content=${key?.contentHash.slice(0, 12) ?? "?"}`,
  );
  return 0;
}

function checkManifest(repoRoot: string, out: string): number {
  const target = resolve(repoRoot, out);
  if (!existsSync(target)) {
    console.error(`[upgrade:manifest] FAIL: manifest not found: ${relative(repoRoot, target)}; run upgrade:manifest first`);
    return 1;
  }
  const previous = readJson(target) as SnapshotManifest;
  const current = buildManifest(repoRoot);
  const drift = compareManifest(previous, current);
  if (drift.length === 0) {
    console.log(`[upgrade:manifest] check PASS: no drift across ${String(Object.keys(current.files).length)} files`);
    return 0;
  }
  console.error(`[upgrade:manifest] check FAIL: ${String(drift.length)} drift entries`);
  for (const row of drift.slice(0, 50)) {
    console.error(`  - ${row.kind}: ${row.path}${row.detail === undefined ? "" : ` ${JSON.stringify(row.detail)}`}`);
  }
  if (drift.length > 50) console.error(`  ... and ${String(drift.length - 50)} more`);
  return 1;
}

export function main(args = process.argv.slice(2)): number {
  let out = defaultManifestPath;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") check = true;
    else if (arg === "--out" && args[index + 1] && !args[index + 1]!.startsWith("--")) out = args[++index]!;
    else throw new Error("usage: upgrade:manifest [--check] [--out FILE]");
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return check ? checkManifest(repoRoot, out) : writeManifest(repoRoot, out);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[upgrade:manifest] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
