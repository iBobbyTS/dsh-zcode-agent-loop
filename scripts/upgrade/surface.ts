/**
 * 快照树公开面清单：声明/实现指纹沿用 contract-verification 的 sourceSnapshot
 * 手法（打印 AST 后取 SHA256，不靠文件 mtime），并在其上加导出签名与包元数据，
 * 供 manifest 漂移校验与 baseline→candidate 差异生成共用。
 *
 * 只扫描包源码根（不扫 tests/dist/node_modules）：差异报告描述的是可审阅的
 * 上游源码，不是构建产物；候选快照的运行门禁另由 drill 用其 dist 执行。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import { hash } from "../contract-verification/oracle.js";

/** 与 capability-snapshot 的扫描根保持一致，路径相对快照根。 */
export const packageSourceRoots = [
  "apps/zcode-cli/packages/core/src",
  "apps/zcode-cli/packages/contracts/src",
  "apps/zcode-cli/packages/shared-types/src",
  "apps/zcode-cli/packages/dynamic-workflow/src",
  "packages/shared/src",
  "packages/zcode-cua",
] as const;

export interface PackageInfo {
  name: string;
  version: string | null;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  contentHash: string;
  fileCount: number;
}

export interface SurfaceSnapshot {
  root: string;
  treeHash: string;
  files: Record<string, string>;
  implementations: Record<string, string>;
  declarations: Record<string, string>;
  exports: Record<string, string>;
  packages: Record<string, PackageInfo>;
}

export interface FacadeImport {
  module: string;
  packageName: string;
  imported: string;
  kind: "value" | "type" | "namespace";
}

export interface FacadeConsumer {
  file: string;
  module: string;
  imported: string;
  reason: "symbol" | "package-surface";
}

export type SurfaceChangeKind =
  | "declaration-added"
  | "declaration-removed"
  | "declaration-changed"
  | "export-added"
  | "export-removed"
  | "export-changed"
  | "file-added"
  | "file-removed"
  | "implementation-changed"
  | "package-added"
  | "package-removed"
  | "package-version-changed"
  | "package-dependency-changed";

export interface SurfaceChange {
  id: string;
  kind: SurfaceChangeKind;
  path: string;
  symbol?: string;
  packageName?: string;
  baselineHash?: string;
  candidateHash?: string;
  detail?: Record<string, unknown>;
  facadeConsumers: FacadeConsumer[];
}

export interface SurfaceDiff {
  schemaVersion: 1;
  baseline: { root: string; treeHash: string; fileCount: number; packageCount: number };
  candidate: { root: string; treeHash: string; fileCount: number; packageCount: number };
  facadeImports: FacadeImport[];
  summary: {
    total: number;
    byKind: Record<string, number>;
    facadeLinked: number;
  };
  changes: SurfaceChange[];
}

const printer = ts.createPrinter({ removeComments: true });

function posix(path: string): string {
  return path.split(sep).join("/");
}

function readText(file: string): string {
  return readFileSync(file, "utf8");
}

function statementSignature(node: ts.Node, source: ts.SourceFile): string {
  return hash(printer.printNode(ts.EmitHint.Unspecified, node, source));
}

function declarationKind(node: ts.Node): boolean {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  );
}

function nodeName(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (!("name" in node)) return undefined;
  const name = (node as { name?: ts.Node }).name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
  return undefined;
}

function exportNames(node: ts.Node, source: ts.SourceFile): { name: string; signature: string }[] {
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    if (!clause) return [];
    if (ts.isNamedExports(clause)) {
      return clause.elements.map((element) => ({
        name: element.name.text,
        signature: statementSignature(node, source),
      }));
    }
    return [{ name: clause.name.text, signature: statementSignature(node, source) }];
  }

  if (ts.isExportAssignment(node)) {
    return [{ name: "default", signature: statementSignature(node, source) }];
  }

  if (!ts.canHaveModifiers(node)) return [];
  const modifiers = ts.getModifiers(node);
  const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  if (!exported) return [];
  const isDefault = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

  if (ts.isVariableStatement(node)) {
    const rows: { name: string; signature: string }[] = [];
    for (const declaration of node.declarationList.declarations) {
      const text = posix(declaration.name.getText(source));
      rows.push({ name: text === "" ? "default" : text, signature: statementSignature(declaration, source) });
    }
    return rows;
  }

  const name = nodeName(node, source);
  if (name === undefined) return isDefault ? [{ name: "default", signature: statementSignature(node, source) }] : [];
  return [{ name, signature: statementSignature(node, source) }];
}

function walkFiles(dir: string, onFile: (file: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".DS_Store") continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(file, onFile);
      continue;
    }
    onFile(file);
  }
}

function packageManifest(file: string): {
  name: string;
  version: string | null;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
} {
  const data = JSON.parse(readText(file)) as {
    name?: unknown;
    version?: unknown;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  if (typeof data.name !== "string") {
    throw new Error(`package.json missing name: ${file}`);
  }
  return {
    name: data.name,
    version: typeof data.version === "string" ? data.version : null,
    dependencies: data.dependencies ?? {},
    peerDependencies: data.peerDependencies ?? {},
    optionalDependencies: data.optionalDependencies ?? {},
  };
}

/**
 * 源码根只覆盖 `src`，package.json 在上一级；把包根单独补进来，保证清单记录
 * 包版本与依赖。`packages/model-option-map` 是 shared 的运行时依赖，一并登记。
 */
function packageRootsFor(roots: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const root of roots) {
    dirs.add(root.endsWith("/src") ? root.slice(0, -"/src".length) : root);
  }
  dirs.add("packages/model-option-map");
  return [...dirs].sort();
}

/**
 * 扫描一份快照树的公开面。键统一为相对快照根的 POSIX 路径，保证 baseline 与
 * candidate 可直接逐键比较。
 */
export function snapshotTree(root: string, roots: readonly string[] = packageSourceRoots): SurfaceSnapshot {
  if (!existsSync(root)) throw new Error(`snapshot root does not exist: ${root}`);
  const files: Record<string, string> = {};
  const implementations: Record<string, string> = {};
  const declarations: Record<string, string> = {};
  const exports: Record<string, string> = {};
  const packageRows: Record<string, ReturnType<typeof packageManifest>> = {};

  for (const sourceRoot of roots) {
    const absoluteRoot = join(root, sourceRoot);
    walkFiles(absoluteRoot, (file) => {
      const rel = posix(relative(root, file));
      if (rel.endsWith(".DS_Store")) return;
      if (file.endsWith("package.json")) {
        files[rel] = hash(readText(file));
        packageRows[posix(relative(root, dirname(file)))] = packageManifest(file);
        return;
      }
      if (!/\.(?:ts|js)$/.test(file) || file.endsWith(".d.ts") || file.endsWith("libs.generated.ts")) return;
      const source = ts.createSourceFile(file, readText(file), ts.ScriptTarget.Latest, true);
      files[rel] = hash(readText(file));
      implementations[rel] = hash(printer.printFile(source));
      for (const node of source.statements) {
        if (declarationKind(node)) {
          const name = nodeName(node, source);
          if (name !== undefined) declarations[`${rel}:${name}`] = statementSignature(node, source);
        }
        for (const exported of exportNames(node, source)) {
          exports[`${rel}:${exported.name}`] = exported.signature;
        }
      }
    });
  }

  for (const packageDir of packageRootsFor(roots)) {
    const file = join(root, packageDir, "package.json");
    if (!existsSync(file)) continue;
    const rel = posix(relative(root, file));
    files[rel] = hash(readText(file));
    packageRows[packageDir] = packageManifest(file);
  }

  const packageEntries = Object.entries(packageRows).sort(([a], [b]) => a.localeCompare(b));
  const packages: Record<string, PackageInfo> = {};
  for (const [packageDir, info] of packageEntries) {
    const owned = Object.keys(files).filter(
      (file) => file === `${packageDir}/package.json` || file.startsWith(`${packageDir}/`),
    );
    const contentHash = hash(
      owned
        .sort()
        .map((file) => `${file}:${files[file]}`)
        .join("\n"),
    );
    packages[packageDir] = {
      ...info,
      contentHash,
      fileCount: owned.length,
    };
  }

  const treeHash = hash(
    Object.keys(files)
      .sort()
      .map((file) => `${file}:${files[file]}`)
      .join("\n"),
  );

  return { root, treeHash, files, implementations, declarations, exports, packages };
}

/** 从 src/engine-facade.ts 的 import 面推导门面消费点。 */
export function readFacadeImports(repoRoot: string): FacadeImport[] {
  const file = join(repoRoot, "src/engine-facade.ts");
  const source = ts.createSourceFile(file, readText(file), ts.ScriptTarget.Latest, true);
  const rows: FacadeImport[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const module = statement.moduleSpecifier;
    if (!ts.isStringLiteral(module) || !module.text.startsWith("@zcode/")) continue;
    const packageName = module.text.split("/").slice(0, 2).join("/");
    const clause = statement.importClause;
    if (!clause) continue;
    const kind: FacadeImport["kind"] = clause.isTypeOnly ? "type" : "value";
    if (clause.name) {
      rows.push({ module: module.text, packageName, imported: "default", kind });
    }
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      rows.push({ module: module.text, packageName, imported: "*", kind });
      continue;
    }
    for (const element of bindings.elements) {
      rows.push({ module: module.text, packageName, imported: element.name.text, kind });
    }
  }
  return rows;
}

function symbolsInPath(
  path: string,
  snapshots: readonly SurfaceSnapshot[],
): Set<string> {
  const prefix = `${path}:`;
  const symbols = new Set<string>();
  for (const snapshot of snapshots) {
    for (const id of Object.keys(snapshot.declarations)) {
      if (id.startsWith(prefix)) symbols.add(id.slice(prefix.length));
    }
    for (const id of Object.keys(snapshot.exports)) {
      if (id.startsWith(prefix)) symbols.add(id.slice(prefix.length));
    }
  }
  return symbols;
}

function consumersFor(
  change: SurfaceChange,
  baseline: SurfaceSnapshot,
  candidate: SurfaceSnapshot,
  facadeImports: readonly FacadeImport[],
): FacadeConsumer[] {
  const packageImports = facadeImports.filter((row) => row.packageName === change.packageName);
  if (change.kind.startsWith("package-")) {
    return packageImports.map((row) => ({
      file: "src/engine-facade.ts",
      module: row.module,
      imported: row.imported,
      reason: "package-surface" as const,
    }));
  }
  const symbols =
    change.symbol !== undefined
      ? new Set([change.symbol])
      : symbolsInPath(change.path, [baseline, candidate]);
  return packageImports
    .filter((row) => row.imported === "*" || symbols.has(row.imported))
    .map((row) => ({
      file: "src/engine-facade.ts",
      module: row.module,
      imported: row.imported,
      reason: row.imported === "*" ? ("package-surface" as const) : ("symbol" as const),
    }));
}

function compareEntryMap(
  addedKind: SurfaceChangeKind,
  removedKind: SurfaceChangeKind,
  changedKind: SurfaceChangeKind,
  baseline: Record<string, string>,
  candidate: Record<string, string>,
  pathOf: (id: string) => string,
  symbolOf: (id: string) => string | undefined,
  packageOf: (path: string) => string | undefined,
): SurfaceChange[] {
  const ids = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  const changes: SurfaceChange[] = [];
  for (const id of ids) {
    const before = baseline[id];
    const after = candidate[id];
    if (before === after) continue;
    const path = pathOf(id);
    changes.push({
      id,
      kind: before === undefined ? addedKind : after === undefined ? removedKind : changedKind,
      path,
      symbol: symbolOf(id),
      packageName: packageOf(path),
      baselineHash: before,
      candidateHash: after,
      facadeConsumers: [],
    });
  }
  return changes;
}

export function buildSurfaceDiff(
  repoRoot: string,
  baselineRoot: string,
  candidateRoot: string,
): SurfaceDiff {
  const baseline = snapshotTree(baselineRoot);
  const candidate = snapshotTree(candidateRoot);
  if (!baseline.packages["apps/zcode-cli/packages/core"]) {
    throw new Error(`baseline is not a vendor snapshot: ${baselineRoot}`);
  }
  if (!candidate.packages["apps/zcode-cli/packages/core"]) {
    throw new Error(`candidate is not a vendor snapshot: ${candidateRoot}`);
  }
  const facadeImports = readFacadeImports(repoRoot);

  const packageOf = (path: string): string | undefined => {
    const packageDir = Object.keys(baseline.packages)
      .concat(Object.keys(candidate.packages))
      .sort((a, b) => b.length - a.length)
      .find((dir) => path === `${dir}/package.json` || path.startsWith(`${dir}/`));
    if (packageDir === undefined) return undefined;
    return (candidate.packages[packageDir] ?? baseline.packages[packageDir])?.name;
  };
  const pathOfDeclaration = (id: string): string => id.slice(0, id.lastIndexOf(":"));
  const symbolOfDeclaration = (id: string): string => id.slice(id.lastIndexOf(":") + 1);

  const changes: SurfaceChange[] = [
    ...compareEntryMap(
      "declaration-added",
      "declaration-removed",
      "declaration-changed",
      baseline.declarations,
      candidate.declarations,
      pathOfDeclaration,
      symbolOfDeclaration,
      packageOf,
    ),
    ...compareEntryMap(
      "export-added",
      "export-removed",
      "export-changed",
      baseline.exports,
      candidate.exports,
      pathOfDeclaration,
      symbolOfDeclaration,
      packageOf,
    ),
  ];

  const implementationIds = [...new Set([
    ...Object.keys(baseline.implementations),
    ...Object.keys(candidate.implementations),
  ])].sort();
  for (const path of implementationIds) {
    const before = baseline.implementations[path];
    const after = candidate.implementations[path];
    if (before === after) continue;
    changes.push({
      id: path,
      kind: before === undefined ? "file-added" : after === undefined ? "file-removed" : "implementation-changed",
      path,
      packageName: packageOf(path),
      baselineHash: before,
      candidateHash: after,
      facadeConsumers: [],
    });
  }

  for (const path of [...new Set([
    ...Object.keys(baseline.files),
    ...Object.keys(candidate.files),
  ])].sort()) {
    if (!path.endsWith("/package.json")) continue;
    const before = baseline.files[path];
    const after = candidate.files[path];
    if (before === after) continue;
    const packageDir = path.slice(0, -"/package.json".length);
    const beforePackage = baseline.packages[packageDir];
    const afterPackage = candidate.packages[packageDir];
    if (beforePackage === undefined) {
      changes.push({
        id: packageDir,
        kind: "package-added",
        path,
        packageName: afterPackage?.name,
        candidateHash: after,
        facadeConsumers: [],
      });
      continue;
    }
    if (afterPackage === undefined) {
      changes.push({
        id: packageDir,
        kind: "package-removed",
        path,
        packageName: beforePackage.name,
        baselineHash: before,
        facadeConsumers: [],
      });
      continue;
    }
    if (beforePackage.version !== afterPackage.version) {
      changes.push({
        id: `${packageDir}@${beforePackage.version}->${afterPackage.version}`,
        kind: "package-version-changed",
        path,
        packageName: afterPackage.name,
        baselineHash: before,
        candidateHash: after,
        detail: { from: beforePackage.version, to: afterPackage.version },
        facadeConsumers: [],
      });
    }
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      const beforeDeps = beforePackage[field];
      const afterDeps = afterPackage[field];
      const keys = [...new Set([...Object.keys(beforeDeps), ...Object.keys(afterDeps)])].sort();
      const added: Record<string, string> = {};
      const removed: Record<string, string> = {};
      const changed: Record<string, { from: string; to: string }> = {};
      for (const key of keys) {
        if (beforeDeps[key] === afterDeps[key]) continue;
        if (beforeDeps[key] === undefined) added[key] = afterDeps[key];
        else if (afterDeps[key] === undefined) removed[key] = beforeDeps[key];
        else changed[key] = { from: beforeDeps[key], to: afterDeps[key] };
      }
      if (Object.keys(added).length + Object.keys(removed).length + Object.keys(changed).length === 0) continue;
      changes.push({
        id: `${packageDir}:${field}`,
        kind: "package-dependency-changed",
        path,
        packageName: afterPackage.name,
        detail: { field, added, removed, changed },
        facadeConsumers: [],
      });
    }
  }

  for (const change of changes) {
    change.facadeConsumers = consumersFor(change, baseline, candidate, facadeImports);
  }
  changes.sort((a, b) => `${a.kind}:${a.path}:${a.symbol ?? ""}`.localeCompare(`${b.kind}:${b.path}:${b.symbol ?? ""}`));

  const byKind: Record<string, number> = {};
  for (const change of changes) byKind[change.kind] = (byKind[change.kind] ?? 0) + 1;

  return {
    schemaVersion: 1,
    baseline: {
      root: baselineRoot,
      treeHash: baseline.treeHash,
      fileCount: Object.keys(baseline.files).length,
      packageCount: Object.keys(baseline.packages).length,
    },
    candidate: {
      root: candidateRoot,
      treeHash: candidate.treeHash,
      fileCount: Object.keys(candidate.files).length,
      packageCount: Object.keys(candidate.packages).length,
    },
    facadeImports,
    summary: {
      total: changes.length,
      byKind,
      facadeLinked: changes.filter((change) => change.facadeConsumers.length > 0).length,
    },
    changes,
  };
}
