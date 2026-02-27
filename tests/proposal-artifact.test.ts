import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { asWorkflowId, asWorkflowType } from "../src/core/types";
import { RetroProposalArtifact } from "../src/retro/proposal-artifact";

describe("RetroProposalArtifact", () => {
  it("materializes inline proposals from workflow evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-artifact-"));
    const artifact = new RetroProposalArtifact(root);

    const result = artifact.materializeFromWorkflow(
      {
        workflow_id: asWorkflowId("wf-inline"),
        workflow_type: asWorkflowType("retro"),
        current_state: "PROPOSE",
        retry_count: 0,
        paused: false,
        params: {},
        history: [],
        evidence: {
          PROPOSE: {
            proposals: [
              {
                id: "p1",
                action: "write_file",
                target: "docs/x.md",
                content: "x",
              },
            ],
          },
        },
        metrics: {},
        created_at: "x",
        updated_at: "y",
      },
      () => [],
      false,
    );

    expect(result.source).toBe("inline:PROPOSE.proposals");
    expect(result.proposalCount).toBe(1);
    expect(result.proposals).toHaveLength(1);
    expect(fs.existsSync(result.target)).toBe(true);
  });

  it("materializes from proposals_path or falls back to empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-artifact-"));
    const artifact = new RetroProposalArtifact(root);

    const fromPath = artifact.materializeFromWorkflow(
      {
        workflow_id: asWorkflowId("wf-path"),
        workflow_type: asWorkflowType("retro"),
        current_state: "PROPOSE",
        retry_count: 0,
        paused: false,
        params: {},
        history: [],
        evidence: {
          PROPOSE: {
            proposals_path: "custom/proposals.json",
          },
        },
        metrics: {},
        created_at: "x",
        updated_at: "y",
      },
      (filePath) => {
        expect(filePath).toBe("custom/proposals.json");
        return [
          {
            id: "p2",
            action: "append_file",
            target: "docs/y.md",
            content: "y",
          },
        ];
      },
      true,
    );

    expect(fromPath.source).toBe("custom/proposals.json");
    expect(fromPath.proposalCount).toBe(1);
    expect(fromPath.proposals).toHaveLength(1);
    expect(fromPath.wrote).toBe(false);

    const fallback = artifact.materializeFromWorkflow(
      {
        workflow_id: asWorkflowId("wf-empty"),
        workflow_type: asWorkflowType("retro"),
        current_state: "PROPOSE",
        retry_count: 0,
        paused: false,
        params: {},
        history: [],
        evidence: {},
        metrics: {},
        created_at: "x",
        updated_at: "y",
      },
      () => [],
      false,
    );

    expect(fallback.source).toBeNull();
    expect(fallback.proposalCount).toBe(0);
    expect(fallback.proposals).toEqual([]);
    expect(fs.readFileSync(fallback.target, "utf8")).toBe("[]");
  });
});
