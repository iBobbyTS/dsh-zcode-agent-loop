import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, type Input } from './classifier.js';
import { escapeHtml, validateAuthority, writeHistoricalReport, writeReport } from './classify.js';
import { hash } from './oracle.js';
import { runMatrix, scenarios } from './runner.js';
import { coverageLimit } from './resolutions.js';
import { capabilityInventory, writeCapabilities, type CapabilityReport } from './capabilities.js';
type Matrix = Awaited<ReturnType<typeof runMatrix>>;
export function assess(matrix: Matrix, report: ReturnType<typeof classify>, strict: boolean, capabilities?: CapabilityReport, strictIntegration=false) {
 const executedScenarios=(matrix as unknown as Input).results.filter(r=>!Object.keys(r.errors).length&&r.stock&&r.zcode).map(r=>r.scenario);
 const valid=matrix.results.length===scenarios.length&&new Set(executedScenarios).size===scenarios.length&&scenarios.every(s=>executedScenarios.includes(s));
 const failed=!valid||report.counts.unknown>0||report.counts['bridge-gap']>0||report.semanticIssueCounts.unknown>0||report.semanticIssueCounts['bridge-gap']>0;
 const inventoryFailed=capabilities?.inventoryStatus==='FAIL';
 const overallStatus=failed||inventoryFailed?'FAIL':capabilities?.integrationStatus==='INCOMPLETE'?'INCOMPLETE':capabilities?'NO_DETECTED_GAPS_WITHIN_SCOPE':'NOT_EVALUATED';
 return {status:overallStatus,overallStatus,scenarioStatus:failed?'FAIL':'PASS',rawStatus:matrix.status,coverage:matrix.coverage,executedScenarios,capabilityInventory:capabilities?.inventoryStatus??'not evaluated',capabilityIntegration:capabilities?.integrationStatus??'not evaluated',exitCode:failed||inventoryFailed?1:(strict&&matrix.coverage==='partial')||(strictIntegration&&capabilities?.integrationStatus!=='ACCOUNTED')?2:0};
}
export async function runCheck(out:string,strict=false,collect:()=>Promise<Matrix>=runMatrix,inventory:()=>CapabilityReport=capabilityInventory,strictIntegration=false) {
 await mkdir(resolve(out,'matrix'),{recursive:true});
 let matrixWritten=false,capabilitiesWritten=false;
 try {
  const capabilities=inventory();writeCapabilities(capabilities,out);capabilitiesWritten=true;
  // One six-child matrix run; raw differences and its empty allowance list stay intact.
  const matrix=await collect();const bytes=JSON.stringify(matrix,null,2)+'\n';
  await writeFile(resolve(out,'matrix/report.json'),bytes);
  matrixWritten=true;
  validateAuthority(matrix);
  const classified=classify(matrix as unknown as Input);const gate=assess(matrix,classified,strict,capabilities,strictIntegration);
  const report={...classified,gate,capabilities,source:{input:'matrix/report.json',sha256:hash(bytes),stockVersion:'0.2.1-alpha.5'}};
  await writeHistoricalReport(resolve(out,'original'));
  await writeReport(report,out);
  await writeFile(resolve(out,'check.json'),JSON.stringify({...gate,scenarioCounts:report.counts,counts:report.counts,semanticIssueCounts:report.semanticIssueCounts,capabilities:{total:capabilities.total,counts:capabilities.counts,groupCounts:capabilities.groupCounts,openGroups:capabilities.openGroups,issues:capabilities.issues},strictCoverage:strict,strictIntegration,coverageLimit},null,2)+'\n');
  console.log(`[contracts] overall ${gate.overallStatus}; executed scenarios ${gate.scenarioStatus}; capability inventory ${gate.capabilityInventory}, integration ${gate.capabilityIntegration}; raw matrix ${gate.rawStatus}; coverage ${gate.coverage}; exit ${gate.exitCode}; ${resolve(out,'index.html')}`);
  return gate.exitCode;
 } catch(error) {
  const failure={status:'FAIL',exitCode:1,error:String(error),coverage:'not established',coverageLimit};
  await writeFile(resolve(out,'check.json'),JSON.stringify(failure,null,2)+'\n');
  await writeFile(resolve(out,'classification.json'),JSON.stringify(failure,null,2)+'\n');
  await writeFile(resolve(out,'report.md'),`# Contract check FAIL\n\n${escapeHtml(String(error))}\n`);
  await rm(resolve(out,'raw-differences.json'),{force:true});
  if(!capabilitiesWritten) {
   await writeFile(resolve(out,'capabilities.json'),JSON.stringify({inventoryStatus:'FAIL',integrationStatus:'UNKNOWN',error:String(error)},null,2)+'\n');
   await writeFile(resolve(out,'capabilities.html'),`<!doctype html><meta charset="utf-8"><h1>Capability inventory FAIL</h1><pre>${escapeHtml(String(error))}</pre>`);
   await writeFile(resolve(out,'capabilities.md'),`# Capability inventory FAIL\n\n${escapeHtml(String(error))}\n`);
  }
  if(!matrixWritten)await writeFile(resolve(out,'matrix/report.json'),JSON.stringify({...failure,results:[]},null,2)+'\n');
  // A previous green index must never survive a failed fresh capture/classification.
  await writeFile(resolve(out,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><title>Contract check failed</title><h1>Contract check FAIL</h1><pre>${escapeHtml(JSON.stringify(failure,null,2))}</pre><a href="check.json">Failure detail</a></html>`);
  console.error(`[contracts] FAIL: ${error}`);return 1;
 }
}
export async function main(args=process.argv.slice(2)) {
 let out='.agent-work/tmp/contract-classification/report',strict=false,strictIntegration=false;
 for(let i=0;i<args.length;i++)if(args[i]==='--strict-coverage')strict=true;else if(args[i]==='--strict-integration')strictIntegration=true;else if(args[i]==='--out'&&args[i+1]&&!args[i+1]!.startsWith('--'))out=args[++i]!;else throw new Error('usage: verify:contracts [--out DIR] [--strict-coverage] [--strict-integration]');
 process.exitCode=await runCheck(out,strict,runMatrix,capabilityInventory,strictIntegration);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
