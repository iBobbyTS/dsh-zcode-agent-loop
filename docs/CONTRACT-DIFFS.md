# Installed stock contract differential

`pnpm verify:matrix` improves a declaration-only capability audit by running the installed npm stock agent-loop and the ZCode loop against the same mock fixture. Each side starts in a separate child process and fresh Cordis Context; only the loop plugin changes. The authority is `@deepseek-ai/dsh@0.2.1-alpha.5` and its installed same-version loop, never `reference/`.

The initial fixtures execute basic text, `todo_write`, and goal creation → automatic round → completion. Both sides must assert request counts, durable source, actual todo writes, goal round prompt, complete goal state, and absence of `GOAL_TOOL_*` authority rejection where applicable. Assembly, activation, assertion, cleanup, missing oracle and timeout errors are execution failures. A child process has a 30-second hard deadline, including cleanup.

```sh
# One fresh capture + semantic gate + current/historical reports:
pnpm verify:contracts
pnpm verify:contracts --strict-coverage
pnpm verify:contracts:status-selftest
# Raw positional comparator (unchanged, zero allowances):
pnpm verify:matrix
pnpm verify:matrix --out /tmp/dsh-contract-report
pnpm verify:matrix --strict-coverage
pnpm verify:contracts:selftest
```

`report.json` and a readable `evidence.md` matrix are written to the output directory (default `.agent-work/tmp/contract-verification`). Existing manual documentation is never rewritten. Exit 0 means valid initial scenarios with no unallowed differences; exit 1 means a differential or infrastructure failure; exit 2 means execution passed but strict coverage rejected remaining gaps. Execution and coverage are independent: partial coverage alone is allowed by the default command. The raw matrix reports **FAIL** for retained intentional/order differences; successful fixture assertions do not imply oracle equivalence.

Each report contains package versions and hashes, shipped profile patch hashes and expanded rows, runtime registration keys at readiness and completion, full normalized events in original order, every registered projection's final state, structural differences with both values, separate missing/extra registration keys, source inventory, family matrix, and counts. Fields and events are never filtered out before comparison. Thus insertion or ordering differences can produce many positional differences. The original capture exposed missing inbox/request/tool/finish/deferred-context contracts; later repairs are recorded separately in [CONTRACT-ROOT-CAUSES.md](CONTRACT-ROOT-CAUSES.md). Current raw differences still retain loop service names, exact mock token budget, tool array order, stream chunking and event/reference order.

Normalization only maps generated UUID identities belonging to messages/goals, retaining equal and unequal references, including references embedded in textual tool results. Fixed fixture call IDs stay literal. Only explicit session-event times, stream times/delta arrays, and goal create/update timestamps at known contract locations are clock values. Source, revisions, rounds, event sequences, unknown fields and error content survive. Normalization does not reorder events or approve semantic differences.

The allowance validator requires a scenario, exact JSON pointer, difference kind, both exact values, nonempty rationale and source citation. Wildcard pointers and wildcard scenarios are rejected, and unused entries are surfaced as stale. The production allowance list starts empty: unknown differences remain failures. Future allowances must be backed by existing intentional design evidence and reviewed alongside the named scenario, rather than generated from a failing run.

To add a scenario, extend the single adapter/driver in `scripts/contract-verification/fixture.ts`, add its name in the runner, and add assertions that prove the claimed consumer actually ran in both loops. Update the explicit evidence-to-family associations only for those consumers. A loaded plugin or profile row does not prove it was triggered. Extend the clock/identity normalizer only for documented field semantics and add negative preservation tests.

For an upgrade, install and pin the intended npm version, deliberately update the runner's version guard, rerun the matrix and selftests, and compare package/source/profile hashes and call-site fingerprints. New or changed inventory calls remain unknown until explicit evidence or an intentional-difference rationale is attached; line moves do not by themselves change fingerprints. Review every unallowed or stale difference. Do not copy old green statuses onto new fingerprints.

The negative selftest consumes actual matrix captures, exercises an actual plugin activation with `turnBoundary` registration suppressed, and mutates captured source, goal error content, unknown fields, events and projections. It also checks reference/revision preservation, allowance precision/staleness, new source obligations, new profile families and strict coverage exit policy, then reruns all six runtime/scenario combinations to verify deterministic normalized captures. Run the matrix first; it may legitimately exit 1 while still producing valid captures for selftests.

The [root-cause classifier](CONTRACT-ROOT-CAUSES.md) preserves the original 289 historical members and separately classifies current captures. `pnpm verify:contracts` calls the existing matrix collector exactly once, validates authority, then writes `.agent-work/tmp/contract-classification/report/` with current standalone HTML/Markdown/JSON, `check.json`, complete raw captures under `matrix/`, and all original groups/membership/citations under `original/`. The immutable ledger is copied byte-for-byte. This semantic gate exits 0 for valid executed scenarios without known/unknown semantic gaps, 1 for capture/authority/semantic failure, or 2 for strict partial coverage. It explicitly preserves raw matrix FAIL and never updates the empty allowance list. Unknown fields/schema changes and any mock budget other than the exact evidenced 32000 remain failing.

`pnpm verify:classify --input PATH --out DIR` inspects saved captures without executing scenarios or certifying coverage. It exits 1 for real gaps as well as unknowns. `pnpm verify:classify:selftest` uses the deterministic compressed original mock capture and verifies original ledger bytes, member hashes, saved source citations and negative preservation. `pnpm verify:contracts:status-selftest` uses the latest combined-command capture for narrow-rule regressions, omitted repaired contracts, failure/strict exits and single-collector behavior. Run the combined command first. These focused tests do not rerun the six model captures; the existing broader `verify:contracts:selftest` retains its original independent determinism/negative checks.
