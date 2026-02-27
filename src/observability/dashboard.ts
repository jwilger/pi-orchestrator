import type { WorkflowRuntimeState } from "../core/types";
import type { ProposalApplyResult } from "../retro/proposal-applier";
import type {
  TuningAssignment,
  TuningExperiment,
  TuningRecommendation,
} from "../tuning/model-tuner";

export type DashboardSection =
  | "overview"
  | "workflows"
  | "tuning"
  | "panes"
  | "health";

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
  "/orchestra dashboard [overview|workflows|tuning|panes|health] [page]",
  "/orchestra start <workflow> [jsonParams]",
  "/orchestra autopilot [workflowId] [stop]",
  "/orchestra project",
  "/orchestra project-bootstrap [force]",
  "/orchestra cutline",
  "/orchestra readiness",
  "/orchestra evidence-schema [workflow]",
  "/orchestra evidence-diagnostics <workflowId>",
  "/orchestra workflow <workflowId>",
  "/orchestra dispatch <workflowId>",
  "/orchestra pause <workflowId>",
  "/orchestra resume <workflowId>",
  "/orchestra pane-focus <paneId|paneName>",
  "/orchestra pane-close <paneId|paneName>",
  "/orchestra pane-recover <jsonArrayOfPaneSpecs>",
  "/orchestra tuning-experiments [status|create-from-recommendations|run]",
  "/orchestra health",
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

const renderSection = (title: string, lines: string[]): string[] => [
  `=== ${title} ===`,
  ...(lines.length > 0 ? lines : ["(empty)"]),
];

const renderTable = (headers: string[], rows: string[][]): string[] => {
  if (rows.length === 0) {
    return ["(empty)"];
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );

  const formatRow = (values: string[]): string =>
    values.map((value, index) => value.padEnd(widths[index] ?? 0)).join(" | ");

  return [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map((row) => formatRow(row)),
  ];
};

const paginate = <T>(items: T[], page: number, pageSize: number): T[] => {
  const current = Math.max(1, page);
  const offset = (current - 1) * pageSize;
  return items.slice(offset, offset + pageSize);
};

export const buildInteractiveDashboardLines = (input: {
  section: DashboardSection;
  page: number;
  pageSize: number;
  workflows: WorkflowRuntimeState[];
  paneRows: Array<{ id: string; name: string }>;
  recommendations: TuningRecommendation[];
  experiments: TuningExperiment[];
  assignments: TuningAssignment[];
  healthChecks: Array<{ name: string; ok: boolean; message: string }>;
}): string[] => {
  const page = Math.max(1, input.page);
  const pageSize = Math.max(1, input.pageSize);

  if (input.section === "overview") {
    return [
      ...renderSection("dashboard", [
        `section=${input.section}`,
        `page=${page}`,
        `page_size=${pageSize}`,
      ]),
      ...renderSection(
        "metrics",
        buildOverviewLines({
          workflows: input.workflows,
          paneCount: input.paneRows.length,
          recommendationCount: input.recommendations.length,
        }),
      ),
      ...renderSection(
        "actions",
        buildActionLines(input.workflows).slice(0, 5),
      ),
    ];
  }

  if (input.section === "workflows") {
    const rows = paginate(input.workflows, page, pageSize).map((workflow) => [
      workflow.workflow_id as string,
      workflow.workflow_type as string,
      workflow.current_state,
      workflow.paused ? "yes" : "no",
      `${workflow.retry_count}`,
    ]);

    return [
      ...renderSection("workflows", [`page=${page}`, `page_size=${pageSize}`]),
      ...renderTable(["id", "type", "state", "paused", "retries"], rows),
    ];
  }

  if (input.section === "tuning") {
    const recommendationRows = paginate(
      input.recommendations,
      page,
      pageSize,
    ).map((rec) => [
      `${rec.role}/${rec.phase}`,
      rec.current_model,
      rec.recommended_model,
    ]);

    const experimentRows = paginate(input.experiments, page, pageSize).map(
      (exp) => [
        exp.id,
        `${exp.role}/${exp.phase}`,
        exp.status,
        exp.decision ?? "n/a",
      ],
    );

    return [
      ...renderSection("tuning", [
        `recommendations=${input.recommendations.length}`,
        `experiments=${input.experiments.length}`,
        `assignments=${input.assignments.length}`,
      ]),
      ...renderSection(
        "recommendations",
        renderTable(["scope", "current", "recommended"], recommendationRows),
      ),
      ...renderSection(
        "experiments",
        renderTable(["id", "scope", "status", "decision"], experimentRows),
      ),
    ];
  }

  if (input.section === "panes") {
    const paneRows = paginate(input.paneRows, page, pageSize).map((pane) => [
      pane.id,
      pane.name,
    ]);

    return [
      ...renderSection("panes", [`page=${page}`, `page_size=${pageSize}`]),
      ...renderTable(["id", "name"], paneRows),
    ];
  }

  const healthRows = paginate(input.healthChecks, page, pageSize).map(
    (check) => [check.ok ? "ok" : "warn", check.name, check.message],
  );

  return [
    ...renderSection("health", [`page=${page}`, `page_size=${pageSize}`]),
    ...renderTable(["status", "check", "message"], healthRows),
  ];
};
