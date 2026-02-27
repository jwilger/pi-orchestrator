import type { WorkflowRuntimeState } from "../core/types";
import type { ProposalApplyResult } from "../retro/proposal-applier";
import type { TuningRecommendation } from "../tuning/model-tuner";

export const buildOverviewLines = (input: {
  workflows: WorkflowRuntimeState[];
  paneCount: number;
  recommendationCount: number;
}): string[] => {
  const pausedCount = input.workflows.filter(
    (workflow) => workflow.paused,
  ).length;
  return [
    `workflows=${input.workflows.length}`,
    `paused=${pausedCount}`,
    `panes=${input.paneCount}`,
    `tuning_recommendations=${input.recommendationCount}`,
  ];
};

export const buildWorkflowLines = (
  workflows: WorkflowRuntimeState[],
): string[] =>
  workflows.length > 0
    ? workflows.map(
        (workflow) =>
          `${workflow.workflow_id}: ${workflow.current_state} ${workflow.paused ? "(paused)" : ""}`,
      )
    : ["No active workflows"];

export const buildTuningLines = (
  recommendations: TuningRecommendation[],
): string[] =>
  recommendations.length > 0
    ? recommendations.map(
        (rec) =>
          `${rec.role}/${rec.phase}: ${rec.current_model} -> ${rec.recommended_model}`,
      )
    : ["No tuning recommendations yet"];

export const buildRetroApplyLines = (
  results: ProposalApplyResult[],
): string[] =>
  results.length > 0
    ? results.map(
        (result) =>
          `${result.id}: ${result.applied ? "ok" : "skip"} - ${result.message}`,
      )
    : ["No retro proposals found"];

export const buildCommandHelpLines = (): string[] => [
  "/orchestra status",
  "/orchestra start <workflow> [jsonParams]",
  "/orchestra project",
  "/orchestra cutline",
  "/orchestra readiness",
  "/orchestra workflow <workflowId>",
  "/orchestra dispatch <workflowId>",
  "/orchestra pause <workflowId>",
  "/orchestra resume <workflowId>",
  "/orchestra pane-focus <paneId|paneName>",
  "/orchestra pane-close <paneId|paneName>",
  "/orchestra retro-show [workflowId]",
  "/orchestra retro-materialize <workflowId> [apply]",
  "/orchestra retro-pipeline <workflowId> [apply]",
];

export const buildActionLines = (
  workflows: WorkflowRuntimeState[],
): string[] => {
  if (workflows.length === 0) {
    return ["No actions available"];
  }

  return workflows.map((workflow) => {
    if (workflow.paused) {
      return `${workflow.workflow_id}: /orchestra resume ${workflow.workflow_id as string}`;
    }

    return `${workflow.workflow_id}: /orchestra dispatch ${workflow.workflow_id as string}`;
  });
};

export const buildWorkflowDetailLines = (
  workflow: WorkflowRuntimeState | null,
): string[] => {
  if (!workflow) {
    return ["workflow not found"];
  }

  const historyLines = workflow.history
    .slice(-3)
    .map(
      (entry) =>
        `${entry.state} -> ${entry.result ?? "pending"} retries=${entry.retries}`,
    );

  return [
    `workflow=${workflow.workflow_id}`,
    `type=${workflow.workflow_type}`,
    `state=${workflow.current_state}`,
    `paused=${workflow.paused}`,
    `retry_count=${workflow.retry_count}`,
    `history_entries=${workflow.history.length}`,
    `evidence_states=${Object.keys(workflow.evidence).join(",") || "none"}`,
    ...historyLines,
  ];
};
