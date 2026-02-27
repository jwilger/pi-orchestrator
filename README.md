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
