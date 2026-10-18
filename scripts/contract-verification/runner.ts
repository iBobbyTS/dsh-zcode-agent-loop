import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchor, normalize, diff, applyAllowances, profiles, inventory, familyMatrix, hash } from './oracle.js';
import type { Scenario } from './fixture.js';
export const scenarios:Scenario[]=['basic-text','todo-tool','goal-round','tool-round-trip','cancel-mid-stream','queued-followup'];
export function capture(engine:'stock'|'zcode',scenario:Scenario,mutation?:'missing-turnBoundary'):Promise<unknown> {
 return new Promise((accept,reject)=>{ const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./child.ts',import.meta.url)),engine,scenario,...(mutation?[mutation]:[])],{stdio:['ignore','pipe','pipe']});let stdout='',stderr=''; const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${engine}/${scenario} timed out (30s); ${stderr.slice(-2000)}`));},30000);
 child.stdout.on('data',b=>stdout+=String(b)); child.stderr.on('data',b=>stderr+=String(b)); child.on('error',e=>{clearTimeout(timer);reject(e);}); child.on('close',code=>{clearTimeout(timer);const line=stdout.split('\n').find(s=>s.startsWith('CONTRACT_RESULT=')); if(code!==0||!line) reject(new Error(`${engine}/${scenario} exited ${code}: ${stderr.slice(-4000)} ${stdout.slice(-1000)}`)); else {try{accept(JSON.parse(line.slice('CONTRACT_RESULT='.length)));}catch(e){reject(e);}} }); });
}
export function exitStatus(status:string,coverage:string,strict:boolean) {return status==='FAIL'?1:strict&&coverage==='partial'?2:0;}
export function registrationDifferences(stock:unknown,zcode:unknown) {
 const a=stock as Record<string,Record<string,string[]>>, b=zcode as typeof a;
 return ['ready','complete'].flatMap(phase=>['projections','services','tools'].map(registry=>({phase,registry,missing:(a[phase]?.[registry]??[]).filter(k=>!b[phase]?.[registry]?.includes(k)),extra:(b[phase]?.[registry]??[]).filter(k=>!a[phase]?.[registry]?.includes(k))}))).filter(r=>r.missing.length||r.extra.length);
}
export async function runMatrix() {
 const anchors=['@deepseek-ai/dsh','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'].map(anchor);
 if(anchors.some(a=>a.version!=='0.2.1-alpha.5')) throw new Error('oracle version mismatch; review version upgrade explicitly');
 const profile=profiles(); const stockInventory=inventory();
 const results=[];
 for(const scenario of scenarios) { const pair: Record<string,unknown>={}; const errors:Record<string,string>={}; for(const engine of ['stock','zcode'] as const) { try{pair[engine]=normalize(await capture(engine,scenario));}catch(e){errors[engine]=String(e);} }
 const differences=Object.keys(errors).length?[]:diff(pair.stock,pair.zcode); const disposition=applyAllowances(scenario,differences,[]);
 results.push({scenario,...pair,errors,registrationDifferences:Object.keys(errors).length?[]:registrationDifferences(pair.stock,pair.zcode),differences,...disposition,status:Object.keys(errors).length||disposition.unallowed.length||disposition.stale.length?'FAIL':'PASS'});
 console.log(`[matrix] ${scenario}: ${results.at(-1)!.status}, ${differences.length} differences`);
 }
 // Evidence maps identify exercised consumers, never all loaded plugins.
 const triggered:Record<string,string[]>={}; for(const r of results) if(Object.keys(r.errors).length===0) {for(const name of ['agent-loop','agent','session','llm']) (triggered[`@deepseek-ai/dsh-${name}`]??=[]).push(r.scenario); if(['todo-tool','tool-round-trip','goal-round'].includes(r.scenario)) for(const name of ['tools','tool-todo']) (triggered[`@deepseek-ai/dsh-${name}`]??=[]).push(r.scenario); if(r.scenario==='goal-round') for(const name of ['goal','goal-round-driver','tool-goal','session-projection']) (triggered[`@deepseek-ai/dsh-${name}`]??=[]).push(r.scenario); }
 const families=familyMatrix(profile.names,triggered);
 const gaps={families:families.filter(r=>r.status==='no-scenario').length,obligations:stockInventory.obligations.filter(r=>r.status==='unknown').length};
 const counts={scenarios:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,differences:results.reduce((n,r)=>n+r.differences.length,0),allowed:0,...gaps};
 return {schemaVersion:1,status:counts.failed?'FAIL':'PASS',coverage:gaps.families||gaps.obligations?'partial':'complete',anchors:anchors.map(({root,...a})=>a),fixture:{scope:'minimal shared mock fixture; only loop replaced; not full effective deployment',plugins:['llm','session','system-prompt','tools','session-projection','goal','goal-round-driver','tool-todo','tool-goal','agent'].map(n=>`@deepseek-ai/dsh-${n}`)},profile,inventory:stockInventory,families,results,counts};
}
export async function main() {
 const args=process.argv.slice(2);let output='.agent-work/tmp/contract-verification';let strict=false;
 for(let i=0;i<args.length;i++) {
  if(args[i]==='--strict-coverage') strict=true;
  else if(args[i]==='--out' && args[i+1] && !args[i+1]!.startsWith('--')) output=args[++i]!;
  else throw new Error('usage: verify:matrix [--out DIR] [--strict-coverage]');
 }
 const out=resolve(output);
 await mkdir(out,{recursive:true});
 try {const report=await runMatrix(); const bytes=JSON.stringify(report,null,2)+'\n';await writeFile(resolve(out,'report.json'),bytes);await writeFile(resolve(out,'evidence.md'),evidenceMarkdown(report,hash(bytes)));console.log(`[matrix] ${report.status}; coverage ${report.coverage}; ${out}/report.json`);process.exitCode=exitStatus(report.status,report.coverage,strict);} catch(e) {await writeFile(resolve(out,'report.json'),JSON.stringify({status:'FAIL',error:String(e)},null,2)+'\n');throw e;}
}

function evidenceMarkdown(report:Awaited<ReturnType<typeof runMatrix>>, digest:string) {
 const lines=[
  '# Stock contract evidence', '',
  `Stock 0.2.1-alpha.5; report SHA256 ${digest}`, '',
  `Execution **${report.status}**; coverage **${report.coverage}**. ${report.counts.differences} unallowed field differences; ${report.counts.families} plugin entries without scenarios; ${report.counts.obligations} unknown static obligations.`, '',
  'Runtime scope: shared core/goal/todo fixture, not full web activation. Profile scope: shipped base/web bundles, including nested preset/group declarations and conditional or disabled rows.', '',
  '| Scenario | Execution | Field differences | Missing registration keys |',
  '| --- | --- | ---: | --- |',
  ...report.results.map(r=>`| ${r.scenario} | ${r.status} | ${r.differences.length} | ${[...new Set(r.registrationDifferences.flatMap(d=>d.missing.map(k=>`${d.registry}:${k}`)))].join(', ')} |`), '',
  '| Plugin entry | Coverage | Triggered scenarios |', '| --- | --- | --- |',
  ...report.families.map(r=>`| ${r.family} | ${r.status} | ${r.scenarios.join(', ') || '无场景'} |`), '',
  '| Stock call site | Category | Evidence |', '| --- | --- | --- |',
  ...report.inventory.obligations.map(r=>`| ${r.file}:${r.line} | ${r.category} | unknown |`), '',
  'Full captures, hashes, call fingerprints, values and exact JSON pointers: [report.json](report.json).', '',
 ];
 return lines.join('\n');
}
