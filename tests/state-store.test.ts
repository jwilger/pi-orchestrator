import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/core/state-store";
import { asWorkflowId, asWorkflowType } from "../src/core/types";

describe("StateStore", () => {
  it("returns null and empty lists for missing state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-store-"));
    const store = new StateStore(path.join(root, ".orchestra"));

    expect(store.loadWorkflowState(asWorkflowId("missing"))).toBeNull();
    expect(store.listWorkflows()).toEqual([]);
  });

  it("ignores workflow directories missing state files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-store-"));
    const store = new StateStore(path.join(root, ".orchestra"));
    store.ensure();

    fs.mkdirSync(path.join(root, ".orchestra", "workflows", "dangling"), {
      recursive: true,
    });

    expect(store.listWorkflows()).toEqual([]);
  });

  it("saves, loads, and lists workflow states", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-store-"));
    const store = new StateStore(path.join(root, ".orchestra"));
    store.ensure();
    expect(fs.existsSync(path.join(root, ".orchestra", "workflows"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, ".orchestra", "runtime"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".orchestra", "evidence"))).toBe(true);

    store.ensure();

    const a = {
      workflow_id: asWorkflowId("wf-z"),
      workflow_type: asWorkflowType("type-a"),
      current_state: "ONE",
      retry_count: 0,
      paused: false,
      params: {},
      history: [
        { state: "ONE", entered_at: "2026-01-01T00:00:00Z", retries: 0 },
      ],
      evidence: {},
      metrics: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    const b = {
      ...a,
      workflow_id: asWorkflowId("wf-a"),
      workflow_type: asWorkflowType("type-b"),
      current_state: "TWO",
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    };

    store.saveWorkflowState(b);
    store.saveWorkflowState(a);

    expect(store.loadWorkflowState(asWorkflowId("wf-z"))?.current_state).toBe(
      "ONE",
    );

    const listed = store.listWorkflows();
    expect(listed.map((item) => item.workflow_id)).toEqual([
      asWorkflowId("wf-z"),
      asWorkflowId("wf-a"),
    ]);
  });
});
