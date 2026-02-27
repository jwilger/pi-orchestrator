# Task

Deliver the pi-orchestrator PRD implementation in production-ready increments, with enforced quality gates and deterministic orchestration behavior.

## Goals
- Ship the orchestrator foundations (engine, bus, extension tools, workflow definitions, CI/release pipeline, branch protections).
- Reach and enforce 100% mutation kill rate before merge, then continue implementing remaining PRD phases.

## Checklist
- [x] Create repository, push branch, and open PR for foundation work
- [x] Add GitHub Actions CI (lint/typecheck/test/mutation)
- [x] Add Release Please + npm publish workflow
- [x] Configure branch protection requiring PR + required checks
- [x] Keep `.orchestra` committed as team infrastructure
- [x] Install `@tmustier/pi-ralph-wiggum` globally in pi (not as project dependency)
- [x] Raise mutation score to 100% (strict threshold met)
- [x] Complete remaining PRD phases for this branch cut-line (advanced milestones explicitly deferred in `docs/ROADMAP.md`)

## Notes
- Mutation threshold remains strict at 100/100/100 in `stryker.conf.json`.
- Iteration 2 score: **62.08% → 67.74%**.
- Iteration 3 score: **67.74% → 74.72%**.
- Iteration 4 score: **74.72% → 78.30%**.
- Iteration 5 score: **78.30% → 81.70%**.
- Iteration 6 score: **81.70% → 85.98%**.
- Iteration 7 score: **85.98% → 86.74%**.
- Iteration 8 score: **86.74% → 89.20%**.
- Iteration 9 score: **89.20% → 91.59%**.
- Iteration 10 score: **91.59% → 94.46%**.
- Iteration 11 score: **94.46% → 100.00%**.
- Iteration 12 score: **100.00% → 100.00%** (maintained).
- Iteration 13 score: **100.00% → 100.00%** (maintained).
- Iteration 14 score: **100.00% → 100.00%** (maintained).
- Iteration 15 score: **100.00% → 100.00%** (maintained).
- Iteration 16 score: **100.00% → 100.00%** (maintained).
- Iteration 17 score: **100.00% → 100.00%** (maintained).
- Iteration 18 score: **100.00% → 100.00%** (maintained).
- Iteration 19 score: **100.00% → 100.00%** (maintained).
- Iteration 20 score: **100.00% → 100.00%** (maintained).
- Iteration 21 score: **100.00% → 100.00%** (maintained).
- Iteration 22 score: **100.00% → 100.00%** (maintained).
- Iteration 23 score: **100.00% → 100.00%** (maintained).
- Iteration 24 score: **100.00% → 100.00%** (maintained).
- Iteration 25 score: **100.00% → 100.00%** (maintained).
- Iteration 26 score: **100.00% → 100.00%** (maintained).
- Completion decision:
  - Branch cut-line is now explicit and implemented (`src/project/cutline.ts`, `docs/ROADMAP.md`, `orchestra_cutline_status`, `/orchestra cutline`, `orchestra_readiness`, `/orchestra readiness`).
  - Ship-now scope for this PRD slice is complete and validated.
  - Deferred advanced milestones are intentionally documented for follow-on milestones rather than blocking this branch.
- Final validation remains green:
  - `npm run lint` ✅
  - `npm test` ✅ (63 tests)
  - `npm run test:mutate` ✅ (**100.00%**, 527/527 killed)
- Foundation PR: https://github.com/jwilger/pi-orchestrator/pull/1
- Branch: `feat/prd-foundation-phase1`
