# Orchestrator Roadmap / Cut-line

## Landed in `feat/prd-foundation-phase1`

- Core deterministic workflow engine
- Unix-socket message bus with WAL replay
- Extension tools and slash command surface
- Workflow library (tdd/pipeline/review/discovery/event-modeling/prd/exploratory-qa/retro)
- Zellij pane supervision controls (spawn/list/focus/close)
- Tuning sample capture + recommendation scaffolding
- Observability widget line builders and command affordances
- Retro proposal load/validate/materialize/apply pipeline primitives
- CI + release + publish + branch protections
- Mutation testing gate at 100%

## Candidate follow-on milestones (explicitly deferred unless needed)

1. Rich custom TUI components with interactive tables/sections (beyond text widgets)
2. Automated background scheduler for periodic health checks/escalations
3. Model tuner A/B experiment automation and rollback policies
4. Deep zellij recovery orchestration (pane-id tracking + auto-respawn strategies)
5. Rich evidence schema registry + validation diagnostics UI
6. Full packaged defaults for `.orchestra/project.ts` bootstrap generation command
