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

## Deferred milestone closure status (`$200` loop)

All previously deferred follow-on milestones are now implemented:

1. ✅ Rich custom TUI components with interactive tables/sections (`/orchestra dashboard`, `orchestra_dashboard_view`)
2. ✅ Automated background scheduler for periodic health checks/escalations (`HealthScheduler`, `/orchestra health`, `orchestra_health_status`)
3. ✅ Model tuner A/B experiment automation and rollback policies (`orchestra_tuning_experiment_*`, persisted experiments/assignments)
4. ✅ Deep zellij recovery orchestration (pane-id tracking + auto-respawn via `reconcilePanes`, `/orchestra pane-recover`)
5. ✅ Rich evidence schema registry + validation diagnostics UI (`orchestra_evidence_schema_registry`, `orchestra_evidence_diagnostics`)
6. ✅ Full packaged defaults for `.orchestra/project.ts` bootstrap generation command (`orchestra_project_bootstrap`, `/orchestra project-bootstrap`)

## Remaining deferred items

- Self-hosted interactive control panel delivery via ping-pong TDD slices (see `docs/SLICES.md`)
  - S1: command entrypoint + panel launcher seam
  - S2: read-only interactive panel rendering/navigation
  - S3: workflow action controls (dispatch/pause/resume)
  - S4: pane action controls (focus/close/workflow->pane jump)
  - S5: hardening/docs/help updates + evidence trail
