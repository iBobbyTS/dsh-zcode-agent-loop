import { main } from './contract-verification/runner.js';
main().catch(error=>{console.error(error);process.exitCode=1;});
