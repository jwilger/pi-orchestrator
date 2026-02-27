# pi-orchestrator

Deterministic multi-agent workflow orchestration for pi.

## Install

### Local development

```bash
npm install
pi -e ./src/extension/index.ts
```

### Package manager install

```bash
npm install @jwilger/pi-orchestrator
# or
pnpm add @jwilger/pi-orchestrator
```

## `.orchestra` is committed infra

This repository treats `.orchestra/` as team-level infrastructure and commits it.

## Quality pipeline

GitHub Actions CI runs on every PR and push to `main`:

- `lint` (`npm run lint`)
- `typecheck` (`npm run typecheck`)
- `test` (`npm test`)
- `mutation` (`npm run test:mutate`)

Mutation testing is configured to require **100% mutant kill rate** (`high/low/break = 100`).

## Releases and publishing

- Semantic releases are managed by **Release Please** (`.github/workflows/release-please.yml`).
- Release Please opens/updates release PRs and creates tags + GitHub releases.
- On published release, `.github/workflows/publish.yml` runs checks again and publishes to npm with provenance.

Required repo secret:

- `NPM_TOKEN` (npm automation token with publish rights)

## Branch protection

`main` is configured to require:

- Pull request before merge
- 1 approving review
- Passing required checks: `lint`, `typecheck`, `test`, `mutation`
- Up-to-date branch before merge

## Orchestra command quick reference

- `/orchestra help`
- `/orchestra status`
- `/orchestra dashboard [overview|workflows|tuning|panes|health] [page]`
- `/orchestra start <workflow> [jsonParams]`
- `/orchestra workflow <workflowId>`
- `/orchestra dispatch <workflowId>`
- `/orchestra pause <workflowId>`
- `/orchestra resume <workflowId>`
- `/orchestra panes`
- `/orchestra pane-focus <paneId|paneName>`
- `/orchestra pane-close <paneId|paneName>`
- `/orchestra pane-recover <jsonArrayOfPaneSpecs>`
- `/orchestra health`
- `/orchestra tuning`
- `/orchestra tuning-experiments [status|create-from-recommendations|run]`
- `/orchestra observe`
- `/orchestra project`
- `/orchestra project-bootstrap [force]`
- `/orchestra cutline`
- `/orchestra readiness`
- `/orchestra evidence-schema [workflow]`
- `/orchestra evidence-diagnostics <workflowId>`
- `/orchestra actions`
- `/orchestra retro-show [workflowId]`
- `/orchestra retro-materialize <workflowId> [apply]`
- `/orchestra retro-apply [workflowId|path/to/proposals.json] [apply]`
- `/orchestra retro-pipeline <workflowId> [apply]`

## Project configuration

Orchestra loads project config from:

1. `.orchestra/project.ts` (preferred)
2. `.orchestra/project.json` (fallback)

If neither exists, built-in defaults are used.
