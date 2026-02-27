import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/core/state-store";
import { WorkflowEngine } from "../src/core/workflow-engine";
import {
  buildWorkflowEvidenceDiagnostics,
  collectEvidenceSchemas,
  validateEvidenceForState,
} from "../src/evidence/schema-registry";

const writeWorkflow = (dir: string, name: string, content: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.ts`), content, "utf8");
};

describe("evidence schema registry", () => {
  it("collects schemas from workflow definitions and validates evidence", () => {
    const entries = collectEvidenceSchemas([
      {
        name: "demo",
        description: "demo",
        roles: {
          r: {
            agent: "a",
            tools: ["read"],
            fileScope: { writable: [], readable: ["**"] },
          },
        },
        states: {
          RED: {
            assign: "r",
            gate: {
              kind: "evidence",
              schema: { note: "string", score: "number" },
            },
            transitions: { pass: "DONE" },
          },
          DONE: { type: "terminal", result: "success" },
        },
      },
    ]);

    expect(entries).toEqual([
      {
        workflow: "demo",
        state: "RED",
        schema: { note: "string", score: "number" },
      },
    ]);

    expect(
      validateEvidenceForState("RED", { note: "string" }, { note: "ok" }),
    ).toEqual({ state: "RED", ok: true, errors: [] });

    const invalid = validateEvidenceForState(
      "RED",
      { note: "string", score: "number" },
      { note: 1 },
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toEqual([
      "type mismatch for note: expected string, got number",
      "missing key: score",
    ]);
  });

  it("records diagnostics in workflow evidence when schema validation fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-evidence-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "evidence-demo",
      `export default {
        name: "evidence-demo",
        description: "demo",
        roles: {
          r: {
            agent: "a",
            tools: ["read"],
            fileScope: { writable: [], readable: ["**"] }
          }
        },
        states: {
          RED: {
            assign: "r",
            gate: { kind: "evidence", schema: { note: "string" } },
            transitions: { pass: "DONE", fail: "ESC" },
            maxRetries: 1
          },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine({} as ExtensionAPI, cwd, store);
    await engine.loadWorkflows();

    const definitions = engine.listDefinitions();
    expect(
      definitions.some((definition) => definition.name === "evidence-demo"),
    ).toBe(true);
    expect(engine.getDefinition("evidence-demo")?.name).toBe("evidence-demo");

    const started = engine.start("evidence-demo", {});

    const result = await engine.submitEvidence(started.workflow_id, {
      state: "RED",
      result: "pass",
      evidence: { note: 123 },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("schema validation");

    const persisted = engine.get(started.workflow_id as unknown as string);
    expect(persisted).not.toBeNull();
    if (!persisted) {
      throw new Error("expected persisted workflow state");
    }

    const diagnostics = buildWorkflowEvidenceDiagnostics(persisted);
    expect(diagnostics.some((entry) => !entry.ok)).toBe(true);
    expect(diagnostics.find((entry) => entry.state === "RED")?.errors).toEqual([
      "type mismatch for note: expected string, got number",
    ]);

    const redEvidence = persisted.evidence.RED as { verified?: boolean };
    expect(redEvidence.verified).toBe(false);
  });
});
