import { runFixture, type Scenario } from './fixture.js';
try {
 const result=await runFixture(process.argv[2] as 'stock'|'zcode',process.argv[3] as Scenario,process.argv[4] as 'missing-turnBoundary'|undefined);
 console.log(`CONTRACT_RESULT=${JSON.stringify(result)}`); process.exit(0);
} catch(error) { console.error(error); process.exit(1); }
