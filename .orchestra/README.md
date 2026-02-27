# .orchestra

Team-level orchestration infrastructure for this repository.

This directory is intentionally committed.

## Layout

- `project.ts` — project configuration consumed by the orchestrator
- `workflows.d/` — project workflow overrides/extensions
- `agents.d/` — project agent definition overrides/extensions
- `runtime/` — generated runtime artifacts (can still be versioned when useful)
- `workflows/` — workflow instance state snapshots
- `evidence/` — evidence artifacts per workflow/gate
- `tuning/` — model tuning data and recommendations
