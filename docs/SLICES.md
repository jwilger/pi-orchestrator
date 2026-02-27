# Orchestra Self-Hosting Slice Plan

This document is the canonical backlog for finishing Orchestra's interactive
control-panel work using strict ping-pong TDD.

## Epic

Build an interactive Orchestra control panel in pi that provides live situational
awareness across workflows/agents and supports operator actions (dispatch,
pause/resume, focus/close zellij pane) without relying on truncated widgets.

## Slice backlog

| Slice | Goal | Primary tests first | Done when |
| --- | --- | --- | --- |
| S1 | Command entrypoint + orchestration seam | `/orchestra panel` and `/orchestra ui` route to a panel launcher; no regression for existing commands | Panel command exists and is fully test-covered at command layer |
| S2 | Read-only panel rendering | Render sectioned panel (overview/workflows/panes/health/actions) with keyboard navigation and refresh | Panel component tests cover navigation/rendering + empty states |
| S3 | Workflow actions | Dispatch + pause/resume from selected workflow row with status feedback | Action callbacks are covered with success/failure tests |
| S4 | Pane actions | Focus/close pane from panel; workflow->pane jump helper | Pane focus/close/jump behaviors are covered with success/failure tests |
| S5 | Hardening + docs | Help text, README updates, operator key hints, TDD evidence trail | Docs + tests updated; lint/typecheck/test all green |

## Execution protocol

1. Start with `tdd-ping-pong` (or `tdd-turn`) and implement **one slice only**.
2. Red test first, then minimal green, then refactor.
3. Record evidence for each slice in PR/commit notes.
4. Do not start next slice until current slice has:
   - passing tests,
   - updated docs if surface changed,
   - no lint/typecheck regressions.

## Suggested workflow commands

- `/orchestra start orchestra-self-host-panel {"objective":"Implement S1 only"}`
- `/orchestra workflow <id>`
- `/orchestra dispatch <id>`
- `/orchestra retro-show <id>`

## Source of truth

- Backlog: `docs/SLICES.md` (this file)
- Executable workflow template: `.orchestra/workflows.d/orchestra-self-host-panel.ts`
- Runtime branch readiness summary: `src/project/cutline.ts`
