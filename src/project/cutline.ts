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
    "Richer interactive TUI components beyond line widgets",
    "Automated tuner A/B experiments with rollback policy",
    "Background health scheduler and autonomous escalation loops",
    "Advanced zellij pane recovery/respawn orchestration",
  ],
});
