import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/core/state-store";
import { WorkflowEngine } from "../src/core/workflow-engine";

const fakePi = {
  exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
} as unknown as ExtensionAPI;

describe("WorkflowEngine", () => {
  it("starts a workflow and stores state", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-engine-"));
    const srcWorkflowDir = path.join(cwd, "src", "workflows");
    fs.mkdirSync(srcWorkflowDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcWorkflowDir, "sample.ts"),
      `
      export default {
        name: "sample",
        description: "sample",
        initialState: "ONE",
        roles: {
          r1: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } }
        },
        states: {
          ONE: {
            assign: "r1",
            gate: { kind: "verdict", options: ["pass"] },
            transitions: { pass: "DONE" }
          },
          DONE: { type: "terminal", result: "success" }
        }
      }
      `,
      "utf8",
    );

    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(fakePi, cwd, store);

    await engine.loadWorkflows();
    const workflow = engine.start("sample", {});

    expect(workflow.current_state).toBe("ONE");
    expect(store.loadWorkflowState(workflow.workflow_id)?.current_state).toBe(
      "ONE",
    );
  });
});
