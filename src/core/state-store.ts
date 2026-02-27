import fs from "node:fs";
import path from "node:path";
import type { WorkflowId, WorkflowRuntimeState } from "./types";

export class StateStore {
  constructor(private readonly rootDir: string) {}

  ensure(): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(path.join(this.rootDir, "workflows"), { recursive: true });
    fs.mkdirSync(path.join(this.rootDir, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(this.rootDir, "evidence"), { recursive: true });
  }

  workflowDir(workflowId: WorkflowId): string {
    return path.join(this.rootDir, "workflows", workflowId);
  }

  statePath(workflowId: WorkflowId): string {
    return path.join(this.workflowDir(workflowId), "state.json");
  }

  saveWorkflowState(state: WorkflowRuntimeState): void {
    const dir = this.workflowDir(state.workflow_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.statePath(state.workflow_id),
      JSON.stringify(state, null, 2),
    );
  }

  loadWorkflowState(workflowId: WorkflowId): WorkflowRuntimeState | null {
    const file = this.statePath(workflowId);
    if (!fs.existsSync(file)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(file, "utf8")) as WorkflowRuntimeState;
  }

  listWorkflows(): WorkflowRuntimeState[] {
    const workflowsDir = path.join(this.rootDir, "workflows");
    if (!fs.existsSync(workflowsDir)) {
      return [];
    }

    return fs
      .readdirSync(workflowsDir)
      .flatMap((entry) => {
        const stateFile = path.join(workflowsDir, entry, "state.json");
        if (!fs.existsSync(stateFile)) {
          return [];
        }
        return [
          JSON.parse(
            fs.readFileSync(stateFile, "utf8"),
          ) as WorkflowRuntimeState,
        ];
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}
