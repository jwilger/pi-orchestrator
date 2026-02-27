export interface CutlineStatus {
  branch: string;
  shipNow: string[];
  deferred: string[];
}

export const buildCutlineStatus = (): CutlineStatus => ({
  branch: "feat/prd-foundation-phase1",
  shipNow: [
    "Deterministic workflow engine + message bus",
    "Core workflow library and agent definitions",
    "Extension tools/commands for orchestration and observability",
    "Zellij pane lifecycle supervision (spawn/list/focus/close)",
    "Model tuning scaffolding and recommendation persistence",
    "Retro proposal validation/materialize/apply pipeline",
    "CI/release/publish pipeline with 100% mutation gate",
  ],
  deferred: [
    "S1: Command entrypoint + panel launcher seam with tests",
    "S2: Read-only interactive panel rendering + keyboard navigation",
    "S3: Workflow actions (dispatch/pause/resume) with TDD coverage",
    "S4: Pane controls (focus/close/jump) with TDD coverage",
    "S5: Hardening/docs/help updates and evidence trail",
  ],
});
