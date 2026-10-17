import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, type Input } from './classifier.js';
import { assess, runCheck } from './check.js';
import { diff } from './oracle.js';
import { readOriginalCapture } from './historical.js';
import type { runMatrix } from './runner.js';
type Matrix = Awaited<ReturnType<typeof runMatrix>> & Input;
const current=JSON.parse(await readFile(process.argv[2]??'.agent-work/tmp/contract-classification/report/matrix/report.json','utf8')) as Matrix;
const checks:string[]=[];
function check(name:string,fn:()=>void){fn();checks.push(name);console.log(`[contracts:status-selftest] PASS ${name}`);}
function mutate(change:(i:Matrix)=>void){const copy=structuredClone(current);change(copy);for(const r of copy.results)r.differences=diff(r.stock,r.zcode);return copy;}
function header(i:Matrix){return i.results[0]!.zcode.events.find(e=>e.type==='request/header')!.data.header;}
function rejects(change:(i:Matrix)=>void){const m=mutate(change),report=classify(m);assert(report.counts.unknown||report.counts['bridge-gap']||report.semanticIssueCounts.unknown||report.semanticIssueCounts['bridge-gap']);assert.equal(assess(m,report,false).exitCode,1);}
const report=classify(current);
check('current actual captures have no unexplained semantic gap; raw FAIL stays explicit',()=>{assert.equal(report.counts.unknown,0);assert.equal(report.counts['bridge-gap'],0);assert.deepEqual(report.semanticIssueCounts,{'bridge-gap':0,unknown:0});assert(report.groups.some(g=>g.id==='mock-token-budget'));assert(report.groups.some(g=>g.id==='header-tool-order'));assert.equal(current.status,'FAIL');assert.equal(current.coverage,'partial');assert.equal(assess(current,report,false).exitCode,0);assert.equal(assess(current,report,true).exitCode,2);});
check('32001, another route and another config field never inherit mock budget approval',()=>{for(const change of [(i:Matrix)=>{header(i).config.maxTokens=32001;},(i:Matrix)=>{header(i).config.model='different';},(i:Matrix)=>{header(i).config.unknown=1;}])rejects(change);});
check('tool schema/unknown field under reordered tools remains unknown',()=>{for(const change of [(i:Matrix)=>{header(i).tools[0].unknownContractField='unexplained';},(i:Matrix)=>{header(i).tools[0].parameters={type:'string'};},(i:Matrix)=>{header(i).tools[0].name=header(i).tools[1].name;},(i:Matrix)=>{header(i).tools.pop();}])rejects(change);});
check('omitted context, projection, tool block, finish and deferred notice remain failures',()=>{
 for(const change of [
 (i:Matrix)=>{i.results[0]!.zcode.events=i.results[0]!.zcode.events.filter(e=>e.type!=='request/context');},
 (i:Matrix)=>{delete i.results[0]!.zcode.projections.inbox;i.results[0]!.zcode.ready.projections=i.results[0]!.zcode.ready.projections!.filter(n=>n!=='inbox');},
 (i:Matrix)=>{const e=i.results[2]!.zcode.events.find(e=>e.type==='assistant/message'&&e.data.message.content.filter((b:any)=>b.type==='tool-call').length>1)!;const index=e.data.message.content.findIndex((b:any)=>b.type==='tool-call');e.data.message.content.splice(index,1);},
 (i:Matrix)=>{const e=i.results[0]!.zcode.events.find(e=>e.type==='assistant/message')!;e.data.stream=e.data.stream.filter((r:any)=>r.chunk?.type!=='finish');},
 (i:Matrix)=>{i.results[2]!.zcode.events=i.results[2]!.zcode.events.filter(e=>!(e.type==='user/message'&&e.data.source?.kind==='tool-goal'&&e.data.source?.form==='notice'));},
 ])rejects(change);
});
check('original real gaps still fail the semantic gate',()=>{const old=readOriginalCapture();const original=classify(old);assert.equal(original.counts['bridge-gap'],91);assert.equal(assess({...current,results:old.results} as Matrix,original,false).exitCode,1);});
const scratch=await mkdtemp(join(tmpdir(),'contract-status-'));
try {
 let calls=0;
 assert.equal(await runCheck(scratch,false,async()=>{calls++;return current;}),0);assert.equal(calls,1);
 checks.push('combined gate calls capture collector once');
 assert.equal(await runCheck(scratch,true,async()=>current),2);checks.push('combined strict partial coverage exits 2');
 const unknown=mutate(i=>{header(i).tools[0].unknownContractField=true;});
 assert.equal(await runCheck(scratch,false,async()=>unknown),1);checks.push('combined unknown exits 1');
 assert.equal(await runCheck(scratch,false,async()=>({...current,results:[]})),1);checks.push('combined missing scenarios exits 1');
 const failed=structuredClone(current);failed.results[0]!.errors={stock:'simulated fixture assertion failure'};
 assert.equal(await runCheck(scratch,false,async()=>failed),1);checks.push('combined fixture/capture error exits 1');
 assert.equal(await runCheck(scratch,false,async()=>{throw new Error('simulated capture failure <unsafe>');}),1);
 const failure=JSON.parse(await readFile(join(scratch,'check.json'),'utf8'));assert.equal(failure.status,'FAIL');
 const html=await readFile(join(scratch,'index.html'),'utf8');assert(html.includes('Contract check FAIL'));assert(!html.includes('<unsafe>'));assert(html.includes('&lt;unsafe&gt;'));assert.equal(JSON.parse(await readFile(join(scratch,'classification.json'),'utf8')).status,'FAIL');assert((await readFile(join(scratch,'report.md'),'utf8')).includes('Contract check FAIL'));assert.equal(JSON.parse(await readFile(join(scratch,'matrix/report.json'),'utf8')).results.length,0);await assert.rejects(readFile(join(scratch,'raw-differences.json'),'utf8'),{code:'ENOENT'});checks.push('fresh capture failure replaces stale green HTML and escapes error');
 const wrong=structuredClone(current);wrong.anchors[0]!.packageHash='wrong';assert.equal(await runCheck(scratch,false,async()=>wrong),1);checks.push('combined installed authority mismatch exits 1');
} finally {await rm(scratch,{recursive:true,force:true});}
console.log(`[contracts:status-selftest] PASS ${checks.length} checks`);
