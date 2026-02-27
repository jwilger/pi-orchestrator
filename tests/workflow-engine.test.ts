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

const createFakePi = (
  commandResults: Record<string, ExecResult> = {},
  withExec = true,
) => {
  const commands: string[] = [];
  const calls: Array<{ bin: string; args: string[] }> = [];
  if (!withExec) {
    return { pi: {} as ExtensionAPI, commands, calls };
  }

  const pi = {
    exec: async (bin: string, args: string[]) => {
      calls.push({ bin, args });
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

  return { pi, commands, calls };
};

const writeWorkflow = (dir: string, name: string, content: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.ts`), content, "utf8");
};

const tamperState = (
  cwd: string,
  workflowId: string,
  mutate: (state: Record<string, unknown>) => void,
) => {
  const statePath = path.join(
    cwd,
    ".orchestra",
    "workflows",
    workflowId,
    "state.json",
  );
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(state);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
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
    fs.writeFileSync(
      path.join(cwd, ".orchestra", "workflows.d", "sample.js.bak"),
      `export default {
        name: "sample",
        description: "bad backup override",
        initialState: "BROKEN",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          BROKEN: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "failure" }
        }
      }`,
      "utf8",
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("sample", {});

    expect(state.workflow_id.startsWith("sample-")).toBe(true);
    expect(state.current_state).toBe("TWO");
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.state).toBe("TWO");
    expect(engine.list()).toHaveLength(1);
    expect(engine.list()[0]?.workflow_id).toBe(state.workflow_id);
  });

  it("loads workflows defined in .js files", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    fs.mkdirSync(path.join(cwd, "src", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "src", "workflows", "js-workflow.js"),
      `export default {
        name: "js-workflow",
        description: "js",
        initialState: "STEP",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          STEP: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
      "utf8",
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("js-workflow", {});
    expect(state.current_state).toBe("STEP");
  });

  it("respects explicit initialState over declaration order", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "ordered-workflow",
      `export default {
        name: "ordered-workflow",
        description: "ordered",
        initialState: "SECOND",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          FIRST: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "SECOND" } },
          SECOND: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("ordered-workflow", {});
    expect(state.current_state).toBe("SECOND");
  });

  it("uses first state when initialState is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "fallback-workflow",
      `export default {
        name: "fallback-workflow",
        description: "fallback",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          FIRST: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("fallback-workflow", {});
    expect(state.current_state).toBe("FIRST");
  });

  it("throws for submitEvidence on unknown workflow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));
    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await expect(
      engine.submitEvidence("missing-workflow", {
        state: "X",
        result: "pass",
        evidence: {},
      }),
    ).rejects.toThrow("Unknown workflow instance");
  });

  it("accepts evidence gate verify with non-zero expected exit code", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "evidence-nonzero-verify",
      `export default {
        name: "evidence-nonzero-verify",
        description: "evidence",
        initialState: "RED",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          RED: { assign: "r", gate: { kind: "evidence", schema: { out: "string" }, verify: { command: "verify-red", expectExitCode: 1 } }, transitions: { pass: "DONE", fail: "ESC" } },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const { pi } = createFakePi({
      "verify-red": { code: 1, stdout: "", stderr: "", killed: false },
    });
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("evidence-nonzero-verify", {});
    const result = await engine.submitEvidence(state.workflow_id, {
      state: "RED",
      result: "pass",
      evidence: { out: "x" },
    });

    expect(result.status).toBe("advanced");
  });

  it("accepts evidence gate without verify command", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "evidence-no-verify",
      `export default {
        name: "evidence-no-verify",
        description: "evidence",
        initialState: "RED",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          RED: { assign: "r", gate: { kind: "evidence", schema: { out: "string" } }, transitions: { pass: "DONE", fail: "ESC" } },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const { pi, calls } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("evidence-no-verify", {});
    const result = await engine.submitEvidence(state.workflow_id, {
      state: "RED",
      result: "pass",
      evidence: { out: "x" },
    });

    expect(result.status).toBe("advanced");
    expect(calls).toHaveLength(0);
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
          REVIEW: { assign: "r", gate: { kind: "verdict", options: ["approved", "flagged"] }, transitions: { approved: "DONE", flagged: "ESC" }, maxRetries: 2 },
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
    expect(rejected.reason).toContain("Expected REVIEW");

    const rejectedVerdict = await engine.submitEvidence(state.workflow_id, {
      state: "REVIEW",
      result: "not-in-options",
      evidence: {},
    });
    expect(rejectedVerdict.status).toBe("failed");

    const accepted = await engine.submitEvidence(state.workflow_id, {
      state: "REVIEW",
      result: "approved",
      evidence: { note: "ok" },
      submitted_by: "agent-a",
    });

    expect(accepted.status).toBe("advanced");
    const persisted = engine.get(state.workflow_id);
    expect(persisted?.current_state).toBe("DONE");
    expect(persisted?.history[0]?.result).toBe("approved");
    expect(persisted?.history[0]?.exited_at?.length).toBeGreaterThan(0);
    expect(persisted?.history.at(-1)?.state).toBe("DONE");
    expect(persisted?.history.at(-1)?.retries).toBe(0);
    expect(persisted?.history.at(-1)?.entered_at?.length).toBeGreaterThan(0);
    expect((persisted?.evidence.REVIEW as { verified: boolean }).verified).toBe(
      true,
    );
    expect(
      (persisted?.evidence.REVIEW as { submitted_by: string }).submitted_by,
    ).toBe("agent-a");
  });

  it("defaults escalation transition to ESCALATE when fail transition is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "default-escalate",
      `export default {
        name: "default-escalate",
        description: "default escalate",
        initialState: "RED",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          RED: { assign: "r", gate: { kind: "evidence", schema: { out: "string" }, verify: { command: "verify-red", expectExitCode: 0 } }, transitions: { pass: "DONE" }, maxRetries: 1 },
          DONE: { type: "terminal", result: "success" },
          ESCALATE: { type: "terminal", result: "failure" }
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
    const state = engine.start("default-escalate", {});
    await engine.submitEvidence(state.workflow_id, {
      state: "RED",
      result: "pass",
      evidence: { out: "f" },
    });

    expect(engine.get(state.workflow_id)?.current_state).toBe("ESCALATE");
  });

  it("tracks retry progression before escalation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "retry-workflow",
      `export default {
        name: "retry-workflow",
        description: "retry",
        initialState: "RED",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          RED: { assign: "r", gate: { kind: "evidence", schema: { out: "string" }, verify: { command: "verify-red", expectExitCode: 0 } }, transitions: { pass: "DONE", fail: "ESC" }, maxRetries: 2 },
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
    const state = engine.start("retry-workflow", {});

    const firstFail = await engine.submitEvidence(state.workflow_id, {
      state: "RED",
      result: "pass",
      evidence: { out: "f1" },
    });
    expect(firstFail.status).toBe("failed");
    expect((firstFail.retries as number) > 0).toBe(true);
    expect(engine.get(state.workflow_id)?.current_state).toBe("RED");

    const secondFail = await engine.submitEvidence(state.workflow_id, {
      state: "RED",
      result: "pass",
      evidence: { out: "f2" },
    });
    expect(secondFail.status).toBe("failed");
    const escalated = engine.get(state.workflow_id);
    expect(escalated?.current_state).toBe("ESC");
    expect(escalated?.history.at(-2)?.result).toBe("fail");
    expect(escalated?.history.at(-2)?.last_failure).toContain(
      "Gate verification failed",
    );
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
    const failedState = engine.get(state.workflow_id);
    expect(failedState?.current_state).toBe("ESC");
    expect((failedState?.evidence.ESC as { verified: boolean }).verified).toBe(
      false,
    );
    expect((failedState?.evidence.ESC as { out: string }).out).toBe(
      "still failing",
    );

    const beat = engine.heartbeat("agent-x");
    expect(beat.ok).toBe(true);
    expect(beat.agentId).toBe("agent-x");
    expect(beat.at.length).toBeGreaterThan(0);

    engine.override(state.workflow_id, "DONE", "manual recovery");
    const overridden = engine.get(state.workflow_id);
    expect(overridden?.current_state).toBe("DONE");
    expect(overridden?.history.at(-2)?.result).toContain("override:");
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

    const { pi, commands, calls } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("dispatch-workflow", {});

    fs.rmSync(path.join(cwd, ".orchestra", "runtime"), {
      recursive: true,
      force: true,
    });

    const firstDispatch = await engine.dispatchCurrentState(state.workflow_id);
    expect(firstDispatch.dispatched).toBe(true);
    expect(firstDispatch.details).toContain(`${state.workflow_id}-worker`);
    expect(commands.some((cmd) => cmd.includes("zellij action new-pane"))).toBe(
      true,
    );
    expect(calls.at(-1)?.bin).toBe("bash");
    expect(calls.at(-1)?.args[0]).toBe("-lc");
    expect(calls.at(-1)?.args[1]).toContain("--tools read,bash");
    expect(calls.at(-1)?.args[1]).toContain("--append-system-prompt");

    const runtimeDir = path.join(
      cwd,
      ".orchestra",
      "runtime",
      `${state.workflow_id}-worker`,
    );
    const scope = fs.readFileSync(path.join(runtimeDir, "scope.ts"), "utf8");
    const prompt = fs.readFileSync(path.join(runtimeDir, "prompt.md"), "utf8");
    const task = fs.readFileSync(
      path.join(runtimeDir, "initial-task.md"),
      "utf8",
    );
    expect(scope).toContain("send_message");
    expect(scope).toContain("submit_evidence");
    expect(scope).toContain(".orchestra/bus.sock");
    expect(scope).toContain(`const AGENT_ID = "${state.workflow_id}-worker"`);
    expect(scope).toContain(`const WORKFLOW_ID = "${state.workflow_id}"`);
    expect(scope).toContain('const WRITABLE = ["src/**"]');
    expect(prompt).toContain("# Role worker");
    expect(prompt).toContain(`Workflow: ${state.workflow_id}`);
    expect(prompt).toContain("State: WORK");
    expect(task).toContain(
      `Execute state WORK for workflow ${state.workflow_id}`,
    );

    await engine.submitEvidence(state.workflow_id, {
      state: "WORK",
      result: "done",
      evidence: {},
    });

    const actionDispatch = await engine.dispatchCurrentState(state.workflow_id);
    expect(actionDispatch.dispatched).toBe(false);
    expect(actionDispatch.details).toContain("Action state commands executed");
    expect(commands).toContain("echo one");
    expect(commands).toContain("echo two");
  });

  it("supports command gate with non-zero expected exit code", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "command-nonzero",
      `export default {
        name: "command-nonzero",
        description: "command gate",
        initialState: "CHECK",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          CHECK: { assign: "r", gate: { kind: "command", verify: { command: "verify-command", expectExitCode: 1 } }, transitions: { pass: "DONE", fail: "ESC" }, maxRetries: 1 },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const { pi } = createFakePi({
      "verify-command": { code: 1, stdout: "ok", stderr: "", killed: false },
    });

    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("command-nonzero", {});
    const advanced = await engine.submitEvidence(state.workflow_id, {
      state: "CHECK",
      result: "pass",
      evidence: { proof: true },
    });

    expect(advanced.status).toBe("advanced");
    expect(engine.get(state.workflow_id)?.current_state).toBe("DONE");
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

    const { pi, calls } = createFakePi({
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
    expect(calls).toHaveLength(1);

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

  it("throws dispatch error when persisted workflow definition is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "dispatch-missing-def",
      `export default {
        name: "dispatch-missing-def",
        description: "x",
        initialState: "STEP",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: { STEP: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } }, DONE: { type: "terminal", result: "success" } }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("dispatch-missing-def", {});
    tamperState(cwd, state.workflow_id, (raw) => {
      raw.workflow_type = "ghost-def";
    });

    await expect(
      engine.dispatchCurrentState(state.workflow_id),
    ).rejects.toThrow("Unknown workflow definition");
  });

  it("handles corrupted persisted state with deterministic errors", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "corrupt-workflow",
      `export default {
        name: "corrupt-workflow",
        description: "corrupt",
        initialState: "STEP",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          STEP: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("corrupt-workflow", {});

    tamperState(cwd, state.workflow_id, (raw) => {
      raw.workflow_type = "missing-definition";
    });
    await expect(
      engine.submitEvidence(state.workflow_id, {
        state: "STEP",
        result: "ok",
        evidence: {},
      }),
    ).rejects.toThrow("Workflow definition missing");

    tamperState(cwd, state.workflow_id, (raw) => {
      raw.workflow_type = "corrupt-workflow";
      raw.current_state = "MISSING_STATE";
    });
    const badStateResult = await engine.submitEvidence(state.workflow_id, {
      state: "MISSING_STATE",
      result: "ok",
      evidence: {},
    });
    expect(badStateResult.status).toBe("rejected");
    expect(badStateResult.reason).toContain("does not accept evidence");

    await expect(
      engine.dispatchCurrentState(state.workflow_id),
    ).rejects.toThrow("Unknown state");
  });

  it("throws deterministic errors when workflow history is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "history-workflow",
      `export default {
        name: "history-workflow",
        description: "history",
        initialState: "STEP",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          STEP: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("history-workflow", {});
    tamperState(cwd, state.workflow_id, (raw) => {
      raw.history = [];
    });

    await expect(
      engine.submitEvidence(state.workflow_id, {
        state: "STEP",
        result: "ok",
        evidence: {},
      }),
    ).rejects.toThrow("Workflow history missing");

    expect(() => engine.override(state.workflow_id, "DONE", "manual")).toThrow(
      "Workflow history missing",
    );
  });

  it("throws when assigned role is not defined", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "missing-role-workflow",
      `export default {
        name: "missing-role-workflow",
        description: "missing role",
        initialState: "STEP",
        roles: {},
        states: {
          STEP: { assign: "ghost", gate: { kind: "verdict", options: ["ok"] }, transitions: { ok: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("missing-role-workflow", {});

    await expect(
      engine.dispatchCurrentState(state.workflow_id),
    ).rejects.toThrow("Role ghost not defined");
  });

  it("throws when no transition exists for submitted result", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "transition-workflow",
      `export default {
        name: "transition-workflow",
        description: "transitions",
        initialState: "STEP",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          STEP: { assign: "r", gate: { kind: "verdict", options: ["ok"] }, transitions: {} },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("transition-workflow", {});

    await expect(
      engine.submitEvidence(state.workflow_id, {
        state: "STEP",
        result: "ok",
        evidence: {},
      }),
    ).rejects.toThrow("No transition for state STEP");
  });

  it("throws when verification fails and workflow history is missing", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "missing-history-fail",
      `export default {
        name: "missing-history-fail",
        description: "missing history fail",
        initialState: "STEP",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          STEP: { assign: "r", gate: { kind: "command", verify: { command: "verify", expectExitCode: 0 } }, transitions: { pass: "DONE", fail: "ESC" }, maxRetries: 1 },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const { pi } = createFakePi({
      verify: { code: 1, stdout: "", stderr: "boom", killed: false },
    });
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("missing-history-fail", {});
    tamperState(cwd, state.workflow_id, (raw) => {
      raw.history = [];
    });

    await expect(
      engine.submitEvidence(state.workflow_id, {
        state: "STEP",
        result: "pass",
        evidence: {},
      }),
    ).rejects.toThrow("Workflow history missing");
  });

  it("fails command verification when exec is unavailable", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-engine-"));

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "noexec-workflow",
      `export default {
        name: "noexec-workflow",
        description: "no exec",
        initialState: "CHECK",
        roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
        states: {
          CHECK: { assign: "r", gate: { kind: "command", verify: { command: "verify", expectExitCode: 0 } }, transitions: { pass: "DONE", fail: "ESC" }, maxRetries: 1 },
          DONE: { type: "terminal", result: "success" },
          ESC: { type: "terminal", result: "failure" }
        }
      }`,
    );

    const { pi } = createFakePi({}, false);
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);

    await engine.loadWorkflows();
    const state = engine.start("noexec-workflow", {});
    const result = await engine.submitEvidence(state.workflow_id, {
      state: "CHECK",
      result: "pass",
      evidence: {},
    });

    expect(result.status).toBe("failed");
    expect(engine.get(state.workflow_id)?.current_state).toBe("ESC");

    const execResult = await (
      engine as unknown as {
        execCommand: (command: string) => Promise<{
          code: number;
          stdout: string;
          stderr: string;
        }>;
      }
    ).execCommand("echo hi");
    expect(execResult).toEqual({
      code: 127,
      stdout: "",
      stderr: "exec unavailable",
    });
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
