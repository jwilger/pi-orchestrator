import { describe, expect, it } from "vitest";
import { asWorkflowId, asWorkflowType } from "../src/core/types";
import {
  buildActionLines,
  buildCommandHelpLines,
  buildInteractiveDashboardLines,
  buildOverviewLines,
  buildRetroApplyLines,
  buildTuningLines,
  buildWorkflowDetailLines,
  buildWorkflowLines,
} from "../src/observability/dashboard";

describe("observability dashboard helpers", () => {
  it("builds overview and workflow lines", () => {
    const workflows = [
      {
        workflow_id: asWorkflowId("wf-1"),
        workflow_type: asWorkflowType("pipeline"),
        current_state: "RED",
        retry_count: 0,
        paused: false,
        params: {},
        history: [],
        evidence: {},
        metrics: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        workflow_id: asWorkflowId("wf-2"),
        workflow_type: asWorkflowType("pipeline"),
        current_state: "GREEN",
        retry_count: 0,
        paused: true,
        params: {},
        history: [],
        evidence: {},
        metrics: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];

    expect(
      buildOverviewLines({
        workflows,
        paneCount: 3,
        recommendationCount: 1,
      }),
    ).toEqual([
      "workflows=2",
      "paused=1",
      "panes=3",
      "tuning_recommendations=1",
    ]);

    expect(buildWorkflowLines(workflows)).toEqual([
      "wf-1: RED ",
      "wf-2: GREEN (paused)",
    ]);

    expect(buildActionLines(workflows)).toEqual([
      "wf-1: /orchestra dispatch wf-1",
      "wf-2: /orchestra resume wf-2",
    ]);
  });

  it("builds fallback lines for tuning and retro sections", () => {
    expect(buildTuningLines([])).toEqual(["No tuning recommendations yet"]);
    expect(buildRetroApplyLines([])).toEqual(["No retro proposals found"]);

    expect(
      buildTuningLines([
        {
          role: "ping",
          phase: "RED",
          current_model: "claude-haiku-4",
          recommended_model: "claude-sonnet-4",
          rationale: "quality low",
        },
      ]),
    ).toEqual(["ping/RED: claude-haiku-4 -> claude-sonnet-4"]);

    expect(
      buildRetroApplyLines([
        { id: "p1", applied: true, message: "wrote docs/x.md" },
      ]),
    ).toEqual(["p1: ok - wrote docs/x.md"]);
  });

  it("builds workflow detail lines", () => {
    expect(buildWorkflowDetailLines(null)).toEqual(["workflow not found"]);
    expect(buildActionLines([])).toEqual(["No actions available"]);
    const help = buildCommandHelpLines();
    expect(help.length).toBeGreaterThan(5);
    expect(help.some((line) => line.includes("/orchestra dashboard"))).toBe(
      true,
    );

    const detail = buildWorkflowDetailLines({
      workflow_id: asWorkflowId("wf-detail"),
      workflow_type: asWorkflowType("pipeline"),
      current_state: "REVIEW",
      retry_count: 1,
      paused: false,
      params: {},
      history: [
        { state: "RED", entered_at: "x", retries: 0, result: "pass" },
        { state: "GREEN", entered_at: "x", retries: 1, result: "pass" },
        { state: "REVIEW", entered_at: "x", retries: 0 },
      ],
      evidence: { RED: { ok: true } },
      metrics: {},
      created_at: "x",
      updated_at: "y",
    });

    expect(detail[0]).toContain("workflow=wf-detail");
    expect(detail.some((line) => line.includes("state=REVIEW"))).toBe(true);
    expect(detail.some((line) => line.includes("history_entries=3"))).toBe(
      true,
    );
    expect(detail.some((line) => line.includes("RED -> pass"))).toBe(true);
  });

  it("builds interactive dashboard table views", () => {
    const workflows = [
      {
        workflow_id: asWorkflowId("wf-1"),
        workflow_type: asWorkflowType("pipeline"),
        current_state: "RED",
        retry_count: 0,
        paused: false,
        params: {},
        history: [],
        evidence: {},
        metrics: {},
        created_at: "x",
        updated_at: "x",
      },
    ];

    const lines = buildInteractiveDashboardLines({
      section: "tuning",
      page: 1,
      pageSize: 5,
      workflows,
      paneRows: [{ id: "1", name: "conductor" }],
      recommendations: [
        {
          role: "reviewer",
          phase: "REVIEW",
          current_model: "claude-haiku-4",
          recommended_model: "claude-sonnet-4",
          rationale: "quality",
        },
      ],
      experiments: [
        {
          id: "exp-1",
          role: "reviewer",
          phase: "REVIEW",
          baseline_model: "claude-haiku-4",
          challenger_model: "claude-sonnet-4",
          status: "complete",
          created_at: "x",
          completed_at: "y",
          decision: "promote_challenger",
          rationale: "better",
        },
      ],
      assignments: [
        {
          role: "reviewer",
          phase: "REVIEW",
          model: "claude-sonnet-4",
          reason: "promoted",
          updated_at: "y",
        },
      ],
      healthChecks: [{ name: "panes", ok: true, message: "panes=1" }],
    });

    expect(lines.some((line) => line.includes("=== tuning ==="))).toBe(true);
    expect(lines.some((line) => line.includes("recommendations=1"))).toBe(true);
    expect(lines.some((line) => line.includes("promote_challenger"))).toBe(
      true,
    );
  });
});
