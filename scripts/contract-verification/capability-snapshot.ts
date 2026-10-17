/** Generated drift evidence; semantic ownership stays in the small group manifest. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { anchor, hash, profiles } from './oracle.js';

export interface CapabilitySnapshot {
 schemaVersion: 1;
 surfaces: Record<string, string>;
 wiring: Record<string, string>;
 declarations: Record<string, string>;
 implementations: Record<string, string>;
 host: Record<string, string>;
}
export const snapshotPath = 'scripts/contract-verification/capabilities.snapshot.json';
const printer = ts.createPrinter({ removeComments: true });
const roots = [
 'src',
 'vendor/zcode/apps/zcode-cli/packages/core/src',
 'vendor/zcode/apps/zcode-cli/packages/contracts/src',
 'vendor/zcode/apps/zcode-cli/packages/shared-types/src',
 'vendor/zcode/apps/zcode-cli/packages/dynamic-workflow/src',
 'vendor/zcode/packages/shared/src',
 'vendor/zcode/packages/zcode-cua',
];

// Scan the complete source of the consumed packages. This deliberately catches
// referenced/result type changes without pretending to infer semantic reachability.
export function sourceSnapshot(read: (file: string) => string = f => readFileSync(f, 'utf8')) {
 const declarations: Record<string, string> = {}, implementations: Record<string, string> = {};
 function walk(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
   const file = join(dir, entry.name);
   if (entry.isDirectory()) { walk(file); continue; }
   if (entry.name === 'package.json') { implementations[file] = hash(JSON.stringify(JSON.parse(read(file)))); continue; }
   if (!/\.(?:ts|js)$/.test(file) || file.endsWith('libs.generated.ts')) continue;
   const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
   implementations[file] = hash(printer.printFile(ast));
   for (const node of ast.statements) {
    if (!(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node))) continue;
    declarations[`${file}:${node.name.text}`] = hash(printer.printNode(ts.EmitHint.Unspecified, node, ast));
   }
  }
 }
 for (const root of roots) walk(root);
 const host: Record<string, string> = {};
 for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session']) {
  const a = anchor(name); host[name] = `${a.version}:${a.packageHash}`;
  if (name === '@deepseek-ai/dsh-agent-loop') host[`${name}/lib/index.js`] = hash(readFileSync(join(a.root, 'lib/index.js'), 'utf8'));
 }
 for (const source of profiles().sources) host[source.file] = source.sha256;
 host['workspace/pnpm-lock.yaml'] = hash(readFileSync('pnpm-lock.yaml', 'utf8'));
 host['bridge/cordis.patch.yml'] = hash(readFileSync('cordis.patch.yml', 'utf8'));
 return { declarations, implementations, host };
}

export function snapshotDifferences(current: Record<string, string>, baseline: Record<string, string>, kind: string) {
 return [...new Set([...Object.keys(current), ...Object.keys(baseline)])].sort()
  .filter(id => current[id] !== baseline[id]).map(id => ({ id, kind }));
}
