import fs from "node:fs";
import path from "node:path";
import type { WorkflowRuntimeState } from "../core/types";
import type { RetroProposal } from "./proposal-applier";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const extractInlineProposals = (value: unknown): RetroProposal[] => {
  const record = asRecord(value);
  const proposals = record?.proposals;
  if (!Array.isArray(proposals)) {
    return [];
  }

  return proposals.filter(
    (proposal): proposal is RetroProposal =>
      typeof proposal === "object" &&
      proposal !== null &&
      typeof (proposal as { id?: unknown }).id === "string" &&
      typeof (proposal as { action?: unknown }).action === "string" &&
      typeof (proposal as { target?: unknown }).target === "string",
  );
};

export class RetroProposalArtifact {
  constructor(private readonly projectRoot: string) {}

  materializeFromWorkflow(
    workflow: WorkflowRuntimeState,
    loadProposals: (filePath: string) => RetroProposal[],
    dryRun = false,
  ): {
    source: string | null;
    target: string;
    proposals: RetroProposal[];
    proposalCount: number;
    wrote: boolean;
  } {
    const target = path.join(
      this.projectRoot,
      ".orchestra",
      "retro",
      workflow.workflow_id as unknown as string,
      "proposals.json",
    );

    const proposeEvidence = workflow.evidence.PROPOSE;
    const inline = extractInlineProposals(proposeEvidence);
    if (inline.length > 0) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(inline, null, 2));
      }
      return {
        source: "inline:PROPOSE.proposals",
        target,
        proposals: inline,
        proposalCount: inline.length,
        wrote: !dryRun,
      };
    }

    const record = asRecord(proposeEvidence);
    const pathFromEvidence = record?.proposals_path;
    if (typeof pathFromEvidence === "string") {
      const loaded = loadProposals(pathFromEvidence);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(loaded, null, 2));
      }
      return {
        source: pathFromEvidence,
        target,
        proposals: loaded,
        proposalCount: loaded.length,
        wrote: !dryRun,
      };
    }

    if (!dryRun) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "[]");
    }

    return {
      source: null,
      target,
      proposals: [],
      proposalCount: 0,
      wrote: !dryRun,
    };
  }
}
