import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/core/state-store";
import {
  WorkflowEngine,
  buildScopeExtension,
  shellEscape,
} from "../src/core/workflow-engine";

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
};

const createFakePi = (commandResults: Record<string, ExecResult> = {}) => {
  const commands: string[] = [];
  const pi = {
    exec: async (_bin: string, args: string[]) => {
      const command = args[1] ?? "";
      commands.push(command);
      return (
        commandResults[command] ?? {
          code: 0,
          stdout: "",
          stderr: "",
          killed: false,
        }
      );
    },
  } as unknown as ExtensionAPI;

  return { pi, commands };
};

const writeWorkflow = (dir: string, name: string, content: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.ts`), content, "utf8");
};

describe("WorkflowEngine", () => {
  it("throws for unknown workflow and for workflow with no states", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));
    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "empty",
      `export default {
        name: "empty",
        description: "empty",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {}
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);
    await engine.loadWorkflows();

    expect(() => engine.start("missing", {})).toThrow("Unknown workflow");
    expect(() => engine.start("empty", {})).toThrow("has no states");
  });

  it("loads project workflow overrides and starts in overridden initial state", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "sample",
      `export default {
        name: "sample",
        description: "builtin",
        initialState: "ONE",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          ONE: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    writeWorkflow(
      path.join(cwd, ".orchestra", "workflows.d"),
      "sample",
      `export default {
        name: "sample",
        description: "project override",
        initialState: "TWO",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          TWO: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    fs.writeFileSync(
      path.join(cwd, "src", "workflows", "ignored.txt"),
      "nope",
      "utf8",
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("sample", {});

    expect(state.current_state).toBe("TWO");
  });

  it("rejects invalid evidence state and advances on valid verdict", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "verdict-workflow",
      `export default {
        name: "verdict-workflow",
        description: "verdict",
        initialState: "REVIEW",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          REVIEW: { assign: "r", gate: { kind: "verdict", options: ["approved", "flagged"] }, transitions: { approved: "DONE", flagged: "ESC" }, maxRetries: 1 },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("verdict-workflow", {});

    const rejected = await engine.submitEvidence(state.workflow_id, {
      state: "WRONG",
      result: "approved",
      evidence: {},
    });

    expect(rejected.status).toBe("rejected");

    const accepted = await engine.submitEvidence(state.workflow_id, {
      state: "REVIEW",
      result: "approved",
      evidence: { note: "ok" },
      submitted_by: "agent-a",
    });

    expect(accepted.status).toBe("advanced");
    expect(engine.get(state.workflow_id)?.current_state).toBe("DONE");
  });

  it("handles verification failures, pause/resume, and override", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "evidence-workflow",
      `export default {
        name: "evidence-workflow",
        description: "evidence",
        initialState: "RED",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          RED: { assign: "r", gate: { kind: "evidence", schema: { out: "string" }, verify: { command: "verify-red", expectExitCode: 0 } }, transitions: { pass: "GREEN", fail: "ESC" }, maxRetries: 1 },
          GREEN: { assign: "r", gate: { kind: "verdict", options: ["done"] }, transitions: { done: "DONE" } },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const { pi } = createFakePi({
      "verify-red": { code: 1, stdout: "", stderr: "boom", killed: false },
    });
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("evidence-workflow", {});

    engine.pause(state.workflow_id);
    const paused = await engine.submitEvidence(state.workflow_id, {
      state: "RED",
      result: "pass",
      evidence: {},
    });
    expect(paused.status).toBe("paused");

    engine.resume(state.workflow_id);
    const failed = await engine.submitEvidence(state.workflow_id, {
      state: "RED",
      result: "pass",
      evidence: { out: "still failing" },
    });

    expect(failed.status).toBe("failed");
    expect(engine.get(state.workflow_id)?.current_state).toBe("ESC");

    engine.override(state.workflow_id, "DONE", "manual recovery");
    expect(engine.get(state.workflow_id)?.current_state).toBe("DONE");
  });

  it("dispatches terminal states without spawning", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "terminal-workflow",
      `export default {
        name: "terminal-workflow",
        description: "terminal",
        initialState: "DONE",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi, commands } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("terminal-workflow", {});
    const result = await engine.dispatchCurrentState(state.workflow_id);

    expect(result.dispatched).toBe(false);
    expect(result.details).toContain("terminal");
    expect(commands).toHaveLength(0);
  });

  it("dispatches action and agent states and generates runtime scope", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "dispatch-workflow",
      `export default {
        name: "dispatch-workflow",
        description: "dispatch",
        initialState: "WORK",
        roles: { worker: { agent: "a", tools: ["read", "bash"], fileScope: { writable: ["src/**"], readable: ["**"] } } },
        states: {
          WORK: { assign: "worker", gate: { kind: "verdict", options: ["done"] }, transitions: { done: "ACT" } },
          ACT: { type: "action", commands: ["echo one", "echo two"], transitions: { pass: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi, commands } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("dispatch-workflow", {});

    const firstDispatch = await engine.dispatchCurrentState(state.workflow_id);
    expect(firstDispatch.dispatched).toBe(true);
    expect(commands.some((cmd) => cmd.includes("zellij action new-pane"))).toBe(
      true,
    );

    const runtimeDir = path.join(
      cwd,
      ".orchestra",
      "runtime",
      `${state.workflow_id}-worker`,
    );
    const scope = fs.readFileSync(path.join(runtimeDir, "scope.ts"), "utf8");
    expect(scope).toContain("send_message");
    expect(scope).toContain("submit_evidence");
    expect(scope).toContain(".orchestra/bus.sock");

    await engine.submitEvidence(state.workflow_id, {
      state: "WORK",
      result: "done",
      evidence: {},
    });

    const actionDispatch = await engine.dispatchCurrentState(state.workflow_id);
    expect(actionDispatch.details).toContain("Action state commands executed");
    expect(commands).toContain("echo one");
    expect(commands).toContain("echo two");
  });

  it("handles command gate evidence and unknown workflow instance errors", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "command-workflow",
      `export default {
        name: "command-workflow",
        description: "command gate",
        initialState: "CHECK",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          CHECK: { assign: "r", gate: { kind: "command", verify: { command: "verify-command", expectExitCode: 0 } }, transitions: { pass: "DONE", fail: "ESC" }, maxRetries: 1 },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const { pi } = createFakePi({
      "verify-command": { code: 0, stdout: "ok", stderr: "", killed: false },
    });

    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("command-workflow", {});

    const advanced = await engine.submitEvidence(state.workflow_id, {
      state: "CHECK",
      result: "pass",
      evidence: { proof: true },
    });

    expect(advanced.status).toBe("advanced");
    expect(engine.get(state.workflow_id)?.current_state).toBe("DONE");

    await expect(engine.dispatchCurrentState("missing-id")).rejects.toThrow(
      "Unknown workflow instance",
    );
    expect(() => engine.pause("missing-id")).toThrow(
      "Unknown workflow instance",
    );
    expect(() => engine.resume("missing-id")).toThrow(
      "Unknown workflow instance",
    );
    expect(() => engine.override("missing-id", "DONE", "x")).toThrow(
      "Unknown workflow instance",
    );
  });
});

describe("workflow-engine helpers", () => {
  it("shellEscape escapes single quotes", () => {
    expect(shellEscape("ab'cd")).toBe("ab'\\''cd");
  });

  it("buildScopeExtension generates full scope tool contract", () => {
    const source = buildScopeExtension({
      agentId: "agent-1",
      workflowId: "wf-1",
      writable: ["tests/**"],
    });

    expect(source).toContain('const AGENT_ID = "agent-1"');
    expect(source).toContain('const WORKFLOW_ID = "wf-1"');
    expect(source).toContain('const WRITABLE = ["tests/**"]');
    expect(source).toContain('name: "send_message"');
    expect(source).toContain('name: "check_inbox"');
    expect(source).toContain('name: "submit_evidence"');
    expect(source).toContain("socketPath: SOCKET_PATH");
  });
});
