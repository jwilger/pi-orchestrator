import fs from "node:fs";
import path from "node:path";

export type RetroProposalAction =
  | "write_file"
  | "append_file"
  | "replace_in_file";

export interface RetroProposal {
  id: string;
  action: RetroProposalAction;
  target: string;
  content?: string;
  oldText?: string;
  newText?: string;
}

export interface ProposalApplyResult {
  id: string;
  applied: boolean;
  message: string;
}

export interface LoadedProposals {
  source: string | null;
  proposals: RetroProposal[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAction = (value: unknown): value is RetroProposalAction =>
  value === "write_file" ||
  value === "append_file" ||
  value === "replace_in_file";

export class RetroProposalApplier {
  constructor(private readonly projectRoot: string) {}

  listProposalFiles(workflowId?: string): string[] {
    const retroRoot = path.join(this.projectRoot, ".orchestra", "retro");
    if (!fs.existsSync(retroRoot)) {
      return [];
    }

    const entries = fs.readdirSync(retroRoot);
    const selected = workflowId
      ? entries.filter((entry) => entry === workflowId)
      : entries;

    return selected
      .flatMap((entry) => {
        const candidate = path.join(retroRoot, entry, "proposals.json");
        return fs.existsSync(candidate) ? [candidate] : [];
      })
      .sort((a, b) =>
        fs.statSync(b).mtimeMs === fs.statSync(a).mtimeMs
          ? 0
          : fs.statSync(b).mtimeMs > fs.statSync(a).mtimeMs
            ? 1
            : -1,
      );
  }

  loadLatestProposals(workflowId?: string): RetroProposal[] {
    return this.loadLatestProposalsWithSource(workflowId).proposals;
  }

  loadLatestProposalsWithSource(workflowId?: string): LoadedProposals {
    const latest = this.listProposalFiles(workflowId)[0];
    if (!latest) {
      return { source: null, proposals: [] };
    }

    return {
      source: latest,
      proposals: this.loadProposals(latest),
    };
  }

  loadProposals(filePath: string): RetroProposal[] {
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);
    if (!fs.existsSync(absolute)) {
      return [];
    }

    const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const validated: RetroProposal[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) {
        continue;
      }
      const id = item.id;
      const action = item.action;
      const target = item.target;
      if (
        typeof id !== "string" ||
        !isAction(action) ||
        typeof target !== "string"
      ) {
        continue;
      }

      const content = typeof item.content === "string" ? item.content : null;
      const oldText = typeof item.oldText === "string" ? item.oldText : null;
      const newText = typeof item.newText === "string" ? item.newText : null;

      validated.push({
        id,
        action,
        target,
        ...(content ? { content } : {}),
        ...(oldText ? { oldText } : {}),
        ...(newText ? { newText } : {}),
      });
    }

    return validated;
  }

  applyProposals(
    proposals: RetroProposal[],
    dryRun = false,
  ): ProposalApplyResult[] {
    return proposals.map((proposal) => this.applyProposal(proposal, dryRun));
  }

  private applyProposal(
    proposal: RetroProposal,
    dryRun: boolean,
  ): ProposalApplyResult {
    const relativeTarget = proposal.target;
    if (path.isAbsolute(relativeTarget) || relativeTarget.startsWith("..")) {
      return {
        id: proposal.id,
        applied: false,
        message: "target must be project-relative",
      };
    }

    const targetPath = path.join(this.projectRoot, relativeTarget);

    if (proposal.action === "write_file") {
      if (!proposal.content) {
        return {
          id: proposal.id,
          applied: false,
          message: "missing content",
        };
      }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, proposal.content);
      }
      return {
        id: proposal.id,
        applied: true,
        message: `wrote ${proposal.target}`,
      };
    }

    if (proposal.action === "append_file") {
      if (!proposal.content) {
        return {
          id: proposal.id,
          applied: false,
          message: "missing content",
        };
      }
      if (!dryRun) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.appendFileSync(targetPath, proposal.content);
      }
      return {
        id: proposal.id,
        applied: true,
        message: `appended ${proposal.target}`,
      };
    }

    if (!proposal.oldText || proposal.newText === undefined) {
      return {
        id: proposal.id,
        applied: false,
        message: "missing oldText/newText",
      };
    }

    if (!fs.existsSync(targetPath)) {
      return {
        id: proposal.id,
        applied: false,
        message: `target missing: ${proposal.target}`,
      };
    }

    const current = fs.readFileSync(targetPath, "utf8");
    if (!current.includes(proposal.oldText)) {
      return {
        id: proposal.id,
        applied: false,
        message: "oldText not found",
      };
    }

    if (!dryRun) {
      fs.writeFileSync(
        targetPath,
        current.replace(proposal.oldText, proposal.newText),
      );
    }

    return {
      id: proposal.id,
      applied: true,
      message: `replaced text in ${proposal.target}`,
    };
  }
}
