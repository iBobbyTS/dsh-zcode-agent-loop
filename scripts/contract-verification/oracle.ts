import { createRequire } from 'node:module';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const installedRequire = createRequire(realpathSync('node_modules/@deepseek-ai/dsh/package.json'));
export const packageFile = (name: string) => installedRequire.resolve(`${name}/package.json`);
export function anchor(name: string) { const file = packageFile(name); const data = JSON.parse(readFileSync(file, 'utf8')); return { name, version: data.version as string, packageHash: hash(readFileSync(file, 'utf8')), root: dirname(file) }; }
export interface Difference { path: string; kind: 'added'|'removed'|'value'; stock?: unknown; zcode?: unknown }
export function diff(a: unknown, b: unknown, path = ''): Difference[] {
  if (Object.is(a,b)) return [];
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
    return [...new Set([...Object.keys(aa),...Object.keys(bb)])].sort().flatMap(k => {
      const p = `${path}/${k.replaceAll('~','~0').replaceAll('/','~1')}`;
      if (!Object.hasOwn(aa,k)) return [{path:p,kind:'added' as const,zcode:bb[k]}];
      if (!Object.hasOwn(bb,k)) return [{path:p,kind:'removed' as const,stock:aa[k]}];
      return diff(aa[k],bb[k],p);
    });
  }
  return [{path,kind:'value',stock:a,zcode:b}];
}
// Collect identities before traversing: embedded JSON/text references receive the same token.
// Only declared identity fields and UUID-shaped values are identities; unknown fields survive.
export function normalize(input: unknown): unknown {
  const ids = new Map<string,string>();
  const generatedId = /[0-9a-f]{8}-[0-9a-f-]{27}$/i;
  function collect(v: unknown) {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (!v || typeof v !== 'object') return;
    const record=v as Record<string,unknown>;
    for(const [key,value] of Object.entries(record)) {
      const identity = key==='id' && (typeof record.role==='string' || 'objective' in record && 'revision' in record) || key==='goalId' && record.kind==='goal';
      if(identity && typeof value==='string' && generatedId.test(value) && !ids.has(value)) ids.set(value,`<id:${ids.size+1}>`);
      collect(value);
    }
  }
  collect(input);
  function walk(v: unknown, path = ''): unknown {
    const clock = /^\/events\/\d+\/time$/.test(path)
      || /^\/events\/\d+\/data\/stream\/\d+\/(time|time0|dt\/\d+)$/.test(path)
      || /^\/(assertions\/goal|projections\/goal\/current)\/(createdAt|updatedAt)$/.test(path)
      || /^\/events\/\d+\/data\/(createdAt|updatedAt)$/.test(path)
         && (input as {events?:{type:string}[]}).events?.[Number(path.split('/')[2])]?.type==='goal/change';
    if (typeof v === 'number' && clock) return '<clock>';
    if (typeof v === 'string') { let s=v; for(const [id,token] of ids) s=s.replaceAll(id,token); return s; }
    if (Array.isArray(v)) return v.map((x,i)=>walk(x,`${path}/${i}`));
    if (v && typeof v==='object') return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,walk(x,`${path}/${k}`)]));
    return v;
  }
  return walk(input);
}
export interface Allowance { scenario: string; path: string; kind: Difference['kind']; stock?: unknown; zcode?: unknown; reason: string; source: string }
export function applyAllowances(scenario: string, differences: Difference[], allowances: Allowance[]) {
  for (const a of allowances) if (!a.path.startsWith('/') || /[*?]/.test(a.path) || !a.reason || !a.source || a.scenario==='*') throw new Error('invalid broad allowance');
  const used = new Set<Allowance>();
  const unallowed = differences.filter(d=> { const a=allowances.find(a=>a.scenario===scenario && a.path===d.path && a.kind===d.kind && JSON.stringify(a.stock)===JSON.stringify(d.stock) && JSON.stringify(a.zcode)===JSON.stringify(d.zcode)); if(a) used.add(a); return !a; });
  return {unallowed, allowed:differences.length-unallowed.length, stale:allowances.filter(a=>a.scenario===scenario&&!used.has(a))};
}
export function scanSource(source: string, file: string) {
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS); const rows: {file:string;line:number;category:string;fingerprint:string;call:string;status:string;scenarios:string[]}[]=[];
  const occurrence=new Map<string,number>();
  function visit(n: ts.Node) { if(ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) { const method=n.expression.name.text; const receiver=n.expression.expression.getText(ast); if (['register','withInitiator','stateOf','on'].includes(method) || method==='append'&&/session/i.test(receiver)) { const call=n.getText(ast); const signature=hash(ts.createPrinter({removeComments:true}).printNode(ts.EmitHint.Unspecified,n,ast)); const count=occurrence.get(signature)??0; occurrence.set(signature,count+1); rows.push({file,line:ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1,category:method,fingerprint:hash(`${file}:${signature}:${count}`),call,status:'unknown',scenarios:[]}); }} ts.forEachChild(n,visit); }
  visit(ast); return rows;
}
export function inventory() {
 const root=anchor('@deepseek-ai/dsh-agent-loop').root; const files: {file:string;sha256:string}[]=[]; const obligations: ReturnType<typeof scanSource>=[];
 function scan(dir:string) { for(const f of readdirSync(dir,{withFileTypes:true})) { const p=join(dir,f.name); if(f.isDirectory()) scan(p); else if(f.name.endsWith('.js')) { const source=readFileSync(p,'utf8'), file=relative(root,p); files.push({file,sha256:hash(source)}); obligations.push(...scanSource(source,file)); } } }
 scan(join(root,'lib')); if(!obligations.length) throw new Error('stock source inventory has zero matches'); return {granularity:'installed bundled JavaScript AST call sites; static matches are not semantic coverage',files,obligations};
}
export interface ProfileRow { id:string; name?:string; disabled?:unknown; [key:string]:unknown }
export function profiles() {
 const yaml=installedRequire('js-yaml') as {load:(s:string,o:unknown)=>unknown;Type:new (...args:unknown[])=>unknown;DEFAULT_SCHEMA:{extend:(a:unknown[])=>unknown}};
 const schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:(s:string)=>({expression:s})})]);
 const sources: {file:string;sha256:string}[]=[]; const rows=new Map<string,ProfileRow>();
 function apply(name:string, file:string) {const root=anchor(name).root; const path=join(root,file); const text=readFileSync(path,'utf8'); sources.push({file:`${name}/${file}`,sha256:hash(text)}); const patches=yaml.load(text,{schema}) as (ProfileRow & {insert?:ProfileRow[];remove?:string[]})[];
 for(const patch of patches) { if(patch.insert) for(const row of patch.insert) {if(!row.id||!row.name) throw new Error('unrecognized inserted profile row'); rows.set(row.id,row);} else if(patch.id) {if(!rows.has(patch.id)) throw new Error(`patch refers to missing row ${patch.id}`); rows.set(patch.id,{...rows.get(patch.id)!,...patch});} else throw new Error(`unsupported profile patch in ${file}`); }
 }
 // Follow the actual bundle declarations in host order. Presets are declarations
 // in the same profile; their nested plugins activate only when that preset runs.
 for(const name of ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']) {
  const metadata=JSON.parse(readFileSync(packageFile(name),'utf8'));
  const patches=metadata.dsh?.bundle?.patch;
  if(!patches) throw new Error(`missing bundle patches: ${name}`);
  for(const file of Array.isArray(patches)?patches:[patches]) apply(name,file);
 }
 const names=new Set<string>();
 function collect(entries:ProfileRow[]) {
  for(const row of entries) {
   if(typeof row.name==='string' && row.name.startsWith('@deepseek-ai/')) names.add(row.name);
   if(row.group===true && Array.isArray(row.config)) collect(row.config as ProfileRow[]);
   const config=row.config as {plugins?:ProfileRow[]}|undefined;
   if(row.name==='@deepseek-ai/dsh-agent-preset' && Array.isArray(config?.plugins)) collect(config.plugins);
  }
 }
 const expanded=[...rows.values()]; collect(expanded);
 return {sources,rows:expanded,names:[...names].sort()};
}
export function familyMatrix(names:string[], triggered: Record<string,string[]>) {return [...new Set(names)].sort().map(name=>({family:name,scenarios:triggered[name]??[],status:triggered[name]?.length?'triggered':'no-scenario'}));}
