import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/core/state-store";
import type {
  AgentState,
  WorkflowDefinition,
  WorkflowRuntimeState,
} from "../src/core/types";
import { asWorkflowId, asWorkflowType } from "../src/core/types";
import {
  type BuildAgentPromptInput,
  type BuildAgentTaskInput,
  WorkflowEngine,
  applyRoleOverrides,
  buildAgentPrompt,
  buildAgentTask,
  buildScopeExtension,
  resolveAgentDefinition,
  resolveInputMap,
  resolvePersonaForDispatch,
  resolvePersonaFromParams,
  resolveWorkflowSlot,
  shellEscape,
} from "../src/core/workflow-engine";
import type { ProjectConfig } from "../src/project/config";

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
    expect(commands.some((cmd) => cmd.includes("zellij action new-tab"))).toBe(
      true,
    );
    expect(calls.at(-1)?.bin).toBe("bash");
    expect(calls.at(-1)?.args[0]).toBe("-lc");
    expect(calls.at(-1)?.args[1]).toContain("--tools read,bash");
    expect(calls.at(-1)?.args[1]).toContain("--append-system-prompt");
    // Should NOT use headless flags — agents are interactive TUI sessions
    expect(calls.at(-1)?.args[1]).not.toContain("--mode json");
    expect(calls.at(-1)?.args[1]).not.toContain("--no-session");
    expect(calls.at(-1)?.args[1]).not.toContain("--close-on-exit");
    expect(calls.at(-1)?.args[1]).not.toContain("-p ");
    // Should use @file syntax for initial task and --session-dir for persistence
    expect(calls.at(-1)?.args[1]).toContain("@");
    expect(calls.at(-1)?.args[1]).toContain("--session-dir");

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
    expect(prompt).toContain("# Role: worker");
    expect(prompt).toContain(`Workflow ID: ${state.workflow_id}`);
    expect(prompt).toContain("Current state: WORK");
    expect(prompt).toContain("submit_evidence");
    expect(prompt).toContain("send_message");
    expect(prompt).toContain("check_inbox");
    expect(task).toContain(
      `Execute state WORK for workflow ${state.workflow_id}`,
    );
    expect(task).toContain("Gate kind: verdict");

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

// --- Test fixtures for buildAgentPrompt / buildAgentTask ---

const makePromptInput = (
  overrides: Partial<BuildAgentPromptInput> = {},
): BuildAgentPromptInput => {
  const cwd = os.tmpdir();
  return {
    role: "test_role",
    roleDefinition: {
      agent: "tdd-red",
      tools: ["read", "bash"],
      fileScope: { writable: ["tests/**"], readable: ["**"] },
    },
    workflowId: "wf-123",
    workflowDefinition: {
      name: "test-workflow",
      description: "A test workflow",
      roles: {},
      states: {},
    },
    state: "RED",
    stateDefinition: {
      assign: "test_role",
      gate: {
        kind: "evidence",
        schema: { test_file: "string", failure_output: "string" },
      },
      transitions: { pass: "GREEN", fail: "RED" },
    },
    cwd,
    ...overrides,
  };
};

const makeTaskInput = (
  overrides: Partial<BuildAgentTaskInput> = {},
): BuildAgentTaskInput => ({
  workflowId: "wf-123",
  state: "RED",
  stateDefinition: {
    assign: "test_role",
    gate: {
      kind: "evidence",
      schema: { test_file: "string", failure_output: "string" },
    },
    transitions: { pass: "GREEN", fail: "RED" },
  },
  runtimeState: {
    workflow_id: asWorkflowId("wf-123"),
    workflow_type: asWorkflowType("test-workflow"),
    current_state: "RED",
    retry_count: 0,
    paused: false,
    params: {},
    evidence: {},
    metrics: {},
    history: [{ state: "RED", entered_at: "2026-01-01T00:00:00Z", retries: 0 }],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  ...overrides,
});

describe("buildAgentPrompt", () => {
  it("includes role, workflow context, gate schema, and tool instructions", () => {
    const prompt = buildAgentPrompt(makePromptInput());

    expect(prompt).toContain("# Role: test_role");
    expect(prompt).toContain("Workflow ID: wf-123");
    expect(prompt).toContain("Current state: RED");
    expect(prompt).toContain("test-workflow — A test workflow");
    expect(prompt).toContain("Gate kind: evidence");
    expect(prompt).toContain("test_file: string");
    expect(prompt).toContain("failure_output: string");
    expect(prompt).toContain("### submit_evidence");
    expect(prompt).toContain("### send_message");
    expect(prompt).toContain("### check_inbox");
    expect(prompt).toContain("Writable: tests/**");
    expect(prompt).toContain("Readable: **");
  });

  it("includes persona content when roleDefinition.persona is set", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-test-"));
    const personaDir = path.join(cwd, ".team");
    fs.mkdirSync(personaDir, { recursive: true });
    fs.writeFileSync(
      path.join(personaDir, "expert.md"),
      "# Expert TDD Specialist\n\nI am a TDD expert with 20 years of experience.",
      "utf8",
    );

    const prompt = buildAgentPrompt(
      makePromptInput({
        cwd,
        roleDefinition: {
          agent: "tdd-red",
          persona: ".team/expert.md",
          tools: ["read"],
          fileScope: { writable: [], readable: ["**"] },
        },
      }),
    );

    expect(prompt).toContain("## Persona");
    expect(prompt).toContain("Expert TDD Specialist");
    expect(prompt).toContain("20 years of experience");
  });

  it("skips persona section when persona file does not exist", () => {
    const prompt = buildAgentPrompt(
      makePromptInput({
        cwd: os.tmpdir(),
        roleDefinition: {
          agent: "tdd-red",
          persona: ".team/nonexistent.md",
          tools: ["read"],
          fileScope: { writable: [], readable: ["**"] },
        },
      }),
    );

    expect(prompt).not.toContain("## Persona");
  });

  it("includes agent definition content from built-in agents", () => {
    // Use the actual project cwd so built-in agents can be resolved
    const projectCwd = path.join(process.cwd());
    const prompt = buildAgentPrompt(
      makePromptInput({
        cwd: projectCwd,
        roleDefinition: {
          agent: "tdd-red",
          tools: ["read", "bash"],
          fileScope: { writable: ["tests/**"], readable: ["**"] },
        },
      }),
    );

    expect(prompt).toContain("## Agent Definition (tdd-red)");
    expect(prompt).toContain("RED-phase TDD specialist");
  });

  it("prefers project override agent definition over built-in", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-test-"));
    const agentsDir = path.join(cwd, ".orchestra", "agents.d");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "custom-agent.md"),
      "# Custom Agent\n\nProject-specific agent behavior.",
      "utf8",
    );

    const prompt = buildAgentPrompt(
      makePromptInput({
        cwd,
        roleDefinition: {
          agent: "custom-agent",
          tools: ["read"],
          fileScope: { writable: [], readable: ["**"] },
        },
      }),
    );

    expect(prompt).toContain("## Agent Definition (custom-agent)");
    expect(prompt).toContain("Project-specific agent behavior");
  });

  it("includes project context when projectConfig is provided", () => {
    const prompt = buildAgentPrompt(
      makePromptInput({
        projectConfig: {
          name: "my-app",
          flavor: "event-modeled",
          testRunner: "bun test",
          buildCommand: "bun run build",
          lintCommand: "bun run lint",
          formatCheck: "bun run lint",
          mutationTool: "stryker",
          ciProvider: "github-actions",
          testDir: "tests/**",
          srcDir: "src/**",
          typeDir: "src/**",
          team: [],
          autonomyLevel: "full",
          humanReviewCadence: "end",
          reworkBudget: 5,
        },
      }),
    );

    expect(prompt).toContain("## Project Context");
    expect(prompt).toContain("Project: my-app");
    expect(prompt).toContain("Flavor: event-modeled");
    expect(prompt).toContain("Test runner: bun test");
  });

  it("omits project context when projectConfig is not provided", () => {
    const prompt = buildAgentPrompt(makePromptInput({ projectConfig: undefined }));
    expect(prompt).not.toContain("## Project Context");
  });

  it("shows read-only note when writable is empty", () => {
    const prompt = buildAgentPrompt(
      makePromptInput({
        roleDefinition: {
          agent: "reviewer",
          tools: ["read"],
          fileScope: { writable: [], readable: ["**"] },
        },
      }),
    );

    expect(prompt).toContain("read-only role");
  });

  it("describes verdict gate in tool instructions", () => {
    const prompt = buildAgentPrompt(
      makePromptInput({
        state: "REVIEW",
        stateDefinition: {
          assign: "reviewer",
          gate: { kind: "verdict", options: ["approved", "flagged"] },
          transitions: { approved: "DONE", flagged: "RED" },
        },
      }),
    );

    expect(prompt).toContain("Gate kind: verdict");
    expect(prompt).toContain("approved, flagged");
    expect(prompt).toContain("One of: approved, flagged");
  });
});

describe("buildAgentTask", () => {
  it("includes state-specific instructions for RED state", () => {
    const task = buildAgentTask(makeTaskInput());

    expect(task).toContain("Execute state RED for workflow wf-123");
    expect(task).toContain("RED phase of TDD");
    expect(task).toContain("failing test");
  });

  it("includes state-specific instructions for GREEN state", () => {
    const task = buildAgentTask(
      makeTaskInput({
        state: "GREEN",
        stateDefinition: {
          assign: "pong",
          gate: {
            kind: "evidence",
            schema: { implementation_files: "string[]", test_output: "string" },
          },
          transitions: { pass: "REVIEW", fail: "GREEN" },
        },
      }),
    );

    expect(task).toContain("GREEN phase of TDD");
    expect(task).toContain("minimal production code");
  });

  it("includes state-specific instructions for TDD_CYCLE state", () => {
    const task = buildAgentTask(
      makeTaskInput({
        state: "TDD_CYCLE",
        stateDefinition: {
          assign: "pipeline_agent",
          gate: { kind: "verdict", options: ["complete", "retry"] },
          transitions: { complete: "REVIEW", retry: "TDD_CYCLE" },
        },
      }),
    );

    expect(task).toContain("pipeline agent coordinating TDD cycles");
    expect(task).toContain("acceptance criteria");
  });

  it("includes state-specific instructions for REVIEW states", () => {
    const task = buildAgentTask(
      makeTaskInput({
        state: "DOMAIN_REVIEW",
        stateDefinition: {
          assign: "reviewer",
          gate: { kind: "verdict", options: ["approved", "flagged"] },
          transitions: { approved: "DONE", flagged: "RED" },
        },
      }),
    );

    expect(task).toContain("Review the code changes");
    expect(task).toContain("approved' or 'flagged'");
  });

  it("includes evidence from prior states", () => {
    const task = buildAgentTask(
      makeTaskInput({
        state: "GREEN",
        stateDefinition: {
          assign: "pong",
          gate: {
            kind: "evidence",
            schema: { implementation_files: "string[]", test_output: "string" },
          },
          transitions: { pass: "REVIEW", fail: "GREEN" },
        },
        runtimeState: {
          workflow_id: asWorkflowId("wf-123"),
          workflow_type: asWorkflowType("tdd-ping-pong"),
          current_state: "GREEN",
          retry_count: 0,
          paused: false,
          params: { scenario: "user login" },
          evidence: {
            RED: {
              test_file: "tests/login.test.ts",
              failure_output: "FAIL: expected login to succeed",
              verified: true,
            },
          },
          metrics: {},
          history: [
            { state: "RED", entered_at: "2026-01-01T00:00:00Z", retries: 0, exited_at: "2026-01-01T00:01:00Z", result: "pass" },
            { state: "GREEN", entered_at: "2026-01-01T00:01:00Z", retries: 0 },
          ],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:01:00Z",
        },
      }),
    );

    expect(task).toContain("## Evidence from Prior States");
    expect(task).toContain("### RED");
    expect(task).toContain("tests/login.test.ts");
    expect(task).toContain("FAIL: expected login to succeed");
  });

  it("includes gate schema with example for evidence gates", () => {
    const task = buildAgentTask(makeTaskInput());

    expect(task).toContain("## Gate Schema");
    expect(task).toContain("Gate kind: evidence");
    expect(task).toContain("test_file: string");
    expect(task).toContain("Example submit_evidence call");
    expect(task).toContain('"state": "RED"');
    expect(task).toContain('"result": "pass"');
  });

  it("includes gate schema with example for verdict gates", () => {
    const task = buildAgentTask(
      makeTaskInput({
        state: "REVIEW",
        stateDefinition: {
          assign: "reviewer",
          gate: { kind: "verdict", options: ["approved", "flagged"] },
          transitions: { approved: "DONE", flagged: "RED" },
        },
      }),
    );

    expect(task).toContain("Gate kind: verdict");
    expect(task).toContain("approved, flagged");
    expect(task).toContain('"result": "approved"');
    expect(task).toContain('"rationale"');
  });

  it("includes retry context when retry_count > 0", () => {
    const task = buildAgentTask(
      makeTaskInput({
        runtimeState: {
          workflow_id: asWorkflowId("wf-123"),
          workflow_type: asWorkflowType("test-workflow"),
          current_state: "RED",
          retry_count: 2,
          paused: false,
          params: {},
          evidence: {},
          metrics: {},
          history: [
            {
              state: "RED",
              entered_at: "2026-01-01T00:00:00Z",
              retries: 2,
              last_failure: "Gate verification failed for RED",
            },
          ],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      }),
    );

    expect(task).toContain("## Retry Context");
    expect(task).toContain("retry #2");
    expect(task).toContain("Gate verification failed for RED");
    expect(task).toContain("address the failure reason");
  });

  it("omits retry context when retry_count is 0", () => {
    const task = buildAgentTask(makeTaskInput());
    expect(task).not.toContain("## Retry Context");
  });

  it("includes workflow parameters when present", () => {
    const task = buildAgentTask(
      makeTaskInput({
        runtimeState: {
          workflow_id: asWorkflowId("wf-123"),
          workflow_type: asWorkflowType("tdd-ping-pong"),
          current_state: "RED",
          retry_count: 0,
          paused: false,
          params: { scenario: "user login", test_runner: "bun test" },
          evidence: {},
          metrics: {},
          history: [{ state: "RED", entered_at: "2026-01-01T00:00:00Z", retries: 0 }],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      }),
    );

    expect(task).toContain("## Workflow Parameters");
    expect(task).toContain('scenario: "user login"');
    expect(task).toContain('test_runner: "bun test"');
  });

  it("uses testRunner from projectConfig in state instructions", () => {
    const task = buildAgentTask(
      makeTaskInput({
        projectConfig: {
          name: "my-app",
          flavor: "event-modeled",
          testRunner: "bun test",
          buildCommand: "bun run build",
          lintCommand: "bun run lint",
          formatCheck: "bun run lint",
          mutationTool: "stryker",
          ciProvider: "github-actions",
          testDir: "tests/**",
          srcDir: "src/**",
          typeDir: "src/**",
          team: [],
          autonomyLevel: "full",
          humanReviewCadence: "end",
          reworkBudget: 5,
        },
      }),
    );

    expect(task).toContain("`bun test`");
  });

  it("provides generic instructions for unknown state names", () => {
    const task = buildAgentTask(
      makeTaskInput({
        state: "CUSTOM_PHASE",
        stateDefinition: {
          assign: "r",
          gate: {
            kind: "evidence",
            schema: { output: "string" },
          },
          transitions: { pass: "DONE" },
        },
      }),
    );

    expect(task).toContain("Complete the work for state CUSTOM_PHASE");
  });
});

describe("resolveAgentDefinition", () => {
  it("returns built-in agent definition", () => {
    const content = resolveAgentDefinition("tdd-red", process.cwd());
    expect(content).not.toBeNull();
    expect(content).toContain("RED-phase TDD specialist");
  });

  it("prefers project override over built-in", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-test-"));
    const agentsDir = path.join(cwd, ".orchestra", "agents.d");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "tdd-red.md"),
      "# Custom Red Agent\n\nOverridden behavior.",
      "utf8",
    );

    const content = resolveAgentDefinition("tdd-red", cwd);
    expect(content).toContain("Custom Red Agent");
    expect(content).toContain("Overridden behavior");
  });

  it("returns null for unknown agent", () => {
    const content = resolveAgentDefinition("nonexistent-agent", os.tmpdir());
    expect(content).toBeNull();
  });
});

describe("resolvePersonaForDispatch", () => {
  const baseRole = {
    agent: "tdd-red",
    tools: ["read", "bash"],
    fileScope: { writable: ["tests/**"], readable: ["**"] },
  };

  // Mirrors tdd-ping-pong: ping→RED, domain_reviewer→DOMAIN_REVIEW, pong→GREEN
  const workflowDef: WorkflowDefinition = {
    name: "tdd-ping-pong",
    description: "test workflow",
    roles: {
      ping: { ...baseRole, agent: "tdd-red" },
      pong: { ...baseRole, agent: "tdd-green" },
      domain_reviewer: { ...baseRole, agent: "domain-review" },
    },
    states: {
      RED: {
        assign: "ping",
        gate: { kind: "evidence", schema: { out: "string" } },
        transitions: { pass: "DOMAIN_REVIEW_TEST" },
      },
      DOMAIN_REVIEW_TEST: {
        assign: "domain_reviewer",
        gate: { kind: "verdict", options: ["approved", "flagged"] },
        transitions: { approved: "GREEN", flagged: "RED" },
      },
      GREEN: {
        assign: "pong",
        gate: { kind: "evidence", schema: { out: "string" } },
        transitions: { pass: "DOMAIN_REVIEW_IMPL" },
      },
      DOMAIN_REVIEW_IMPL: {
        assign: "domain_reviewer",
        gate: { kind: "verdict", options: ["approved", "flagged"] },
        transitions: { approved: "DONE", flagged: "GREEN" },
      },
      DONE: { type: "terminal" as const, result: "success" as const },
    },
  };

  const makeRuntime = (
    historyStates: string[],
    currentState: string,
  ): WorkflowRuntimeState => ({
    workflow_id: asWorkflowId("wf-rot"),
    workflow_type: asWorkflowType("tdd-ping-pong"),
    current_state: currentState,
    retry_count: 0,
    paused: false,
    params: {},
    evidence: {},
    metrics: {},
    history: historyStates.map((s) => ({
      state: s,
      entered_at: "2026-01-01T00:00:00Z",
      retries: 0,
    })),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });

  it("returns role unchanged when no personaPool is set", () => {
    const role = { ...baseRole };
    const result = resolvePersonaForDispatch(
      role,
      "ping",
      makeRuntime(["RED"], "RED"),
      workflowDef,
    );
    expect(result).toBe(role);
    expect(result.persona).toBeUndefined();
  });

  it("returns role unchanged when personaPool is empty", () => {
    const role = { ...baseRole, personaPool: [] };
    const result = resolvePersonaForDispatch(
      role,
      "ping",
      makeRuntime(["RED"], "RED"),
      workflowDef,
    );
    expect(result).toBe(role);
  });

  it("selects first persona on first dispatch of a role", () => {
    const role = {
      ...baseRole,
      personaPool: [".team/a.md", ".team/b.md", ".team/c.md"],
    };
    // First dispatch of ping: RED is current, no prior ping states
    const result = resolvePersonaForDispatch(
      role,
      "ping",
      makeRuntime(["RED"], "RED"),
      workflowDef,
    );
    expect(result.persona).toBe(".team/a.md");
    expect(result).not.toBe(role); // shallow copy
  });

  it("counts only dispatches of the same role, ignoring other roles", () => {
    const pingPool = [".team/a.md", ".team/b.md", ".team/c.md"];
    const pingRole = { ...baseRole, personaPool: pingPool };

    // History: RED(ping) → DOMAIN_REVIEW_TEST(reviewer) → GREEN(pong) →
    //          DOMAIN_REVIEW_IMPL(reviewer) → RED(ping, current)
    // Prior ping dispatches: just the first RED → count = 1 → pool[1]
    const result = resolvePersonaForDispatch(
      pingRole,
      "ping",
      makeRuntime(
        ["RED", "DOMAIN_REVIEW_TEST", "GREEN", "DOMAIN_REVIEW_IMPL", "RED"],
        "RED",
      ),
      workflowDef,
    );
    expect(result.persona).toBe(".team/b.md"); // index 1 % 3 = 1
  });

  it("gives pong its own independent rotation", () => {
    const pongPool = [".team/x.md", ".team/y.md"];
    const pongRole = { ...baseRole, personaPool: pongPool };

    // History: RED(ping) → DOMAIN_REVIEW_TEST(reviewer) → GREEN(pong, current)
    // Prior pong dispatches: none → count = 0 → pool[0]
    const result = resolvePersonaForDispatch(
      pongRole,
      "pong",
      makeRuntime(["RED", "DOMAIN_REVIEW_TEST", "GREEN"], "GREEN"),
      workflowDef,
    );
    expect(result.persona).toBe(".team/x.md");
  });

  it("advances pong rotation only when pong states repeat", () => {
    const pongPool = [".team/x.md", ".team/y.md"];
    const pongRole = { ...baseRole, personaPool: pongPool };

    // Two full cycles through, now at second GREEN dispatch
    // Prior pong states (GREEN): 1 completed → count = 1 → pool[1]
    const result = resolvePersonaForDispatch(
      pongRole,
      "pong",
      makeRuntime(
        [
          "RED",
          "DOMAIN_REVIEW_TEST",
          "GREEN",
          "DOMAIN_REVIEW_IMPL",
          "RED",
          "DOMAIN_REVIEW_TEST",
          "GREEN",
        ],
        "GREEN",
      ),
      workflowDef,
    );
    expect(result.persona).toBe(".team/y.md"); // index 1 % 2 = 1
  });

  it("wraps around when role dispatch count exceeds pool size", () => {
    const pool = [".team/x.md", ".team/y.md"];
    const role = { ...baseRole, personaPool: pool };

    // 3 prior RED dispatches for ping → count = 3 → 3 % 2 = 1
    const result = resolvePersonaForDispatch(
      role,
      "ping",
      makeRuntime(
        [
          "RED", "DOMAIN_REVIEW_TEST", "GREEN", "DOMAIN_REVIEW_IMPL",
          "RED", "DOMAIN_REVIEW_TEST", "GREEN", "DOMAIN_REVIEW_IMPL",
          "RED", "DOMAIN_REVIEW_TEST", "GREEN", "DOMAIN_REVIEW_IMPL",
          "RED",
        ],
        "RED",
      ),
      workflowDef,
    );
    expect(result.persona).toBe(".team/y.md");
  });

  it("does not mutate the original role definition", () => {
    const role = {
      ...baseRole,
      personaPool: [".team/a.md", ".team/b.md"],
    };
    const result = resolvePersonaForDispatch(
      role,
      "ping",
      makeRuntime(["RED"], "RED"),
      workflowDef,
    );
    expect(result.persona).toBe(".team/a.md");
    expect(role.persona).toBeUndefined();
  });

  it("domain_reviewer with fixed persona is unaffected by pool logic", () => {
    const reviewerRole = {
      ...baseRole,
      persona: ".team/domain-specialist.md",
    };
    const result = resolvePersonaForDispatch(
      reviewerRole,
      "domain_reviewer",
      makeRuntime(["RED", "DOMAIN_REVIEW_TEST"], "DOMAIN_REVIEW_TEST"),
      workflowDef,
    );
    // No personaPool → returned as-is with fixed persona intact
    expect(result).toBe(reviewerRole);
    expect(result.persona).toBe(".team/domain-specialist.md");
  });
});

describe("resolveWorkflowSlot", () => {
  it("returns literal workflow names as-is", () => {
    expect(resolveWorkflowSlot("tdd-ping-pong", {})).toBe("tdd-ping-pong");
  });

  it("resolves $slot references from params.slots", () => {
    const params = {
      slots: { build: "tdd-ping-pong", review: "three-stage-review" },
    };
    expect(resolveWorkflowSlot("$build", params)).toBe("tdd-ping-pong");
    expect(resolveWorkflowSlot("$review", params)).toBe("three-stage-review");
  });

  it("throws when slot is not found", () => {
    expect(() => resolveWorkflowSlot("$missing", {})).toThrow(
      'slot "missing" not found',
    );
    expect(() =>
      resolveWorkflowSlot("$missing", { slots: { other: "x" } }),
    ).toThrow('slot "missing" not found');
  });
});

describe("resolveInputMap", () => {
  it("resolves params paths", () => {
    const state: WorkflowRuntimeState = {
      workflow_id: asWorkflowId("wf-1"),
      workflow_type: asWorkflowType("test"),
      current_state: "X",
      retry_count: 0,
      paused: false,
      params: { scenario: "login", test_runner: "bun test" },
      evidence: {},
      metrics: {},
      history: [],
      created_at: "",
      updated_at: "",
    };

    const result = resolveInputMap(
      { scenario: "params.scenario", runner: "params.test_runner" },
      state,
    );
    expect(result).toEqual({ scenario: "login", runner: "bun test" });
  });

  it("resolves evidence paths", () => {
    const state: WorkflowRuntimeState = {
      workflow_id: asWorkflowId("wf-1"),
      workflow_type: asWorkflowType("test"),
      current_state: "BUILD",
      retry_count: 0,
      paused: false,
      params: {},
      evidence: {
        SETUP: {
          branch: "feat/login",
          acceptance_criteria: ["users can login"],
        },
      },
      metrics: {},
      history: [],
      created_at: "",
      updated_at: "",
    };

    const result = resolveInputMap(
      {
        branch: "evidence.SETUP.branch",
        criteria: "evidence.SETUP.acceptance_criteria",
      },
      state,
    );
    expect(result).toEqual({
      branch: "feat/login",
      criteria: ["users can login"],
    });
  });

  it("returns undefined for missing paths", () => {
    const state: WorkflowRuntimeState = {
      workflow_id: asWorkflowId("wf-1"),
      workflow_type: asWorkflowType("test"),
      current_state: "X",
      retry_count: 0,
      paused: false,
      params: {},
      evidence: {},
      metrics: {},
      history: [],
      created_at: "",
      updated_at: "",
    };

    const result = resolveInputMap({ x: "evidence.MISSING.field" }, state);
    expect(result).toEqual({ x: undefined });
  });

  it("returns empty object for empty inputMap", () => {
    const state: WorkflowRuntimeState = {
      workflow_id: asWorkflowId("wf-1"),
      workflow_type: asWorkflowType("test"),
      current_state: "X",
      retry_count: 0,
      paused: false,
      params: { foo: "bar" },
      evidence: {},
      metrics: {},
      history: [],
      created_at: "",
      updated_at: "",
    };

    expect(resolveInputMap({}, state)).toEqual({});
  });
});

describe("subworkflow composition", () => {
  // A simple child workflow: one agent state → terminal
  const childWorkflowTs = `export default {
    name: "child-wf",
    description: "simple child",
    initialState: "WORK",
    roles: { w: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
    states: {
      WORK: { assign: "w", gate: { kind: "verdict", options: ["done"] }, transitions: { done: "DONE" } },
      DONE: { type: "terminal", result: "success" },
      FAIL: { type: "terminal", result: "failure" }
    }
  }`;

  // A parent workflow with a subworkflow state
  const parentWorkflowTs = `export default {
    name: "parent-wf",
    description: "parent with subworkflow",
    initialState: "SETUP",
    roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
    states: {
      SETUP: { assign: "r", gate: { kind: "evidence", schema: { input: "string" } }, transitions: { pass: "DELEGATE", fail: "ESCALATE" } },
      DELEGATE: { type: "subworkflow", workflow: "child-wf", inputMap: { data: "evidence.SETUP.input" }, transitions: { success: "DONE", failure: "ESCALATE" } },
      DONE: { type: "terminal", result: "success" },
      ESCALATE: { type: "terminal", result: "failure" }
    }
  }`;

  // Parent using $slot reference
  const slotParentWorkflowTs = `export default {
    name: "slot-parent-wf",
    description: "parent with slot-based subworkflow",
    initialState: "DELEGATE",
    roles: { r: { agent: "a", tools: ["read"], fileScope: { writable: [], readable: ["**"] } } },
    states: {
      DELEGATE: { type: "subworkflow", workflow: "$child", transitions: { success: "DONE", failure: "ESCALATE" } },
      DONE: { type: "terminal", result: "success" },
      ESCALATE: { type: "terminal", result: "failure" }
    }
  }`;

  it("dispatches a subworkflow state by starting a child workflow", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sub-"));
    writeWorkflow(path.join(cwd, "src", "workflows"), "child-wf", childWorkflowTs);
    writeWorkflow(path.join(cwd, "src", "workflows"), "parent-wf", parentWorkflowTs);

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);
    await engine.loadWorkflows();

    const parent = engine.start("parent-wf", {});

    // Submit SETUP evidence to advance to DELEGATE
    await engine.submitEvidence(parent.workflow_id, {
      state: "SETUP",
      result: "pass",
      evidence: { input: "hello" },
    });

    const parentAfterSetup = engine.get(parent.workflow_id)!;
    expect(parentAfterSetup.current_state).toBe("DELEGATE");

    // Dispatch triggers child workflow creation
    const dispatch = await engine.dispatchCurrentState(parent.workflow_id);
    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.details).toContain("Subworkflow");
    expect(dispatch.details).toContain("child-wf");

    // Verify parent has a child tracked
    const parentWithChild = engine.get(parent.workflow_id)!;
    expect(parentWithChild.children).toBeDefined();
    const childId = parentWithChild.children!.DELEGATE;
    expect(childId).toBeDefined();

    // Verify child has parent link
    const child = engine.get(childId as unknown as string)!;
    expect(child.parent).toBeDefined();
    expect(child.parent!.workflow_id).toBe(parent.workflow_id);
    expect(child.parent!.state).toBe("DELEGATE");
    expect(child.workflow_type).toBe("child-wf" as any);
    expect(child.current_state).toBe("WORK");

    // Verify child received mapped params
    expect(child.params.data).toBe("hello");
  });

  it("propagates child completion back to parent", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sub-"));
    writeWorkflow(path.join(cwd, "src", "workflows"), "child-wf", childWorkflowTs);
    writeWorkflow(path.join(cwd, "src", "workflows"), "parent-wf", parentWorkflowTs);

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);
    await engine.loadWorkflows();

    const parent = engine.start("parent-wf", {});
    await engine.submitEvidence(parent.workflow_id, {
      state: "SETUP",
      result: "pass",
      evidence: { input: "hello" },
    });

    await engine.dispatchCurrentState(parent.workflow_id);
    const parentWithChild = engine.get(parent.workflow_id)!;
    const childId = parentWithChild.children!.DELEGATE as unknown as string;

    // Complete the child workflow
    await engine.submitEvidence(childId, {
      state: "WORK",
      result: "done",
      evidence: { output: "finished" },
    });

    // Child should be at DONE terminal
    const childDone = engine.get(childId)!;
    expect(childDone.current_state).toBe("DONE");

    // Dispatch child's terminal state → triggers parent propagation
    await engine.dispatchCurrentState(childId);

    // Parent should have advanced past DELEGATE → DONE
    const parentDone = engine.get(parent.workflow_id)!;
    expect(parentDone.current_state).toBe("DONE");

    // Parent evidence should contain child evidence under DELEGATE
    const delegateEvidence = parentDone.evidence.DELEGATE as any;
    expect(delegateEvidence.child_workflow_id).toBe(childId);
    expect(delegateEvidence.child_result).toBe("success");
    expect(delegateEvidence.child_evidence.WORK).toBeDefined();
  });

  it("resolves $slot references from params.slots", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sub-"));
    writeWorkflow(path.join(cwd, "src", "workflows"), "child-wf", childWorkflowTs);
    writeWorkflow(path.join(cwd, "src", "workflows"), "slot-parent-wf", slotParentWorkflowTs);

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);
    await engine.loadWorkflows();

    const parent = engine.start("slot-parent-wf", {
      slots: { child: "child-wf" },
    });

    const dispatch = await engine.dispatchCurrentState(parent.workflow_id);
    expect(dispatch.dispatched).toBe(true);
    expect(dispatch.details).toContain("child-wf");

    const parentState = engine.get(parent.workflow_id)!;
    const childId = parentState.children!.DELEGATE as unknown as string;
    const child = engine.get(childId)!;
    expect(child.workflow_type).toBe("child-wf" as any);
  });

  it("throws when $slot reference cannot be resolved", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sub-"));
    writeWorkflow(path.join(cwd, "src", "workflows"), "slot-parent-wf", slotParentWorkflowTs);

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);
    await engine.loadWorkflows();

    const parent = engine.start("slot-parent-wf", {}); // no slots!
    await expect(
      engine.dispatchCurrentState(parent.workflow_id),
    ).rejects.toThrow('slot "child" not found');
  });

  it("throws when referenced subworkflow definition does not exist", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sub-"));
    writeWorkflow(path.join(cwd, "src", "workflows"), "slot-parent-wf", slotParentWorkflowTs);

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);
    await engine.loadWorkflows();

    const parent = engine.start("slot-parent-wf", {
      slots: { child: "nonexistent" },
    });
    await expect(
      engine.dispatchCurrentState(parent.workflow_id),
    ).rejects.toThrow('Subworkflow "nonexistent" not found');
  });
});

describe("applyRoleOverrides", () => {
  const baseRole = {
    agent: "tdd-red",
    tools: ["read", "bash"],
    fileScope: { writable: ["tests/**"], readable: ["**"] },
  };

  const baseConfig: ProjectConfig = {
    name: "test",
    flavor: "event-modeled",
    testRunner: "npm test",
    buildCommand: "npm run build",
    lintCommand: "npm run lint",
    formatCheck: "npm run lint",
    mutationTool: "stryker",
    ciProvider: "github-actions",
    testDir: "tests/**",
    srcDir: "src/**",
    typeDir: "src/**",
    team: [],
    roles: {},
    autonomyLevel: "full",
    humanReviewCadence: "end",
    reworkBudget: 5,
  };

  it("returns role unchanged when no projectConfig is provided", () => {
    const result = applyRoleOverrides(baseRole, "ping", undefined);
    expect(result).toBe(baseRole);
  });

  it("returns role unchanged when no overrides match", () => {
    const result = applyRoleOverrides(baseRole, "ping", baseConfig);
    expect(result).toBe(baseRole);
  });

  it("overrides agent from project config", () => {
    const config: ProjectConfig = {
      ...baseConfig,
      roles: { ping: { agent: "custom-red" } },
    };
    const result = applyRoleOverrides(baseRole, "ping", config);
    expect(result.agent).toBe("custom-red");
    expect(result.tools).toEqual(["read", "bash"]); // unchanged
  });

  it("overrides persona from project config", () => {
    const config: ProjectConfig = {
      ...baseConfig,
      roles: { ping: { persona: ".team/alice.md" } },
    };
    const result = applyRoleOverrides(baseRole, "ping", config);
    expect(result.persona).toBe(".team/alice.md");
  });

  it("overrides personaPool from project config", () => {
    const config: ProjectConfig = {
      ...baseConfig,
      roles: {
        ping: { personaPool: [".team/a.md", ".team/b.md"] },
      },
    };
    const result = applyRoleOverrides(baseRole, "ping", config);
    expect(result.personaPool).toEqual([".team/a.md", ".team/b.md"]);
  });

  it("overrides tools and fileScope from project config", () => {
    const config: ProjectConfig = {
      ...baseConfig,
      roles: {
        ping: {
          tools: ["read", "bash", "edit"],
          fileScope: { writable: ["src/**", "tests/**"] },
        },
      },
    };
    const result = applyRoleOverrides(baseRole, "ping", config);
    expect(result.tools).toEqual(["read", "bash", "edit"]);
    expect(result.fileScope.writable).toEqual(["src/**", "tests/**"]);
    expect(result.fileScope.readable).toEqual(["**"]); // preserved from base
  });

  it("resolves personaTags from team members", () => {
    const config: ProjectConfig = {
      ...baseConfig,
      team: [
        { role: "alice", persona: ".team/alice.md", tags: ["tdd", "test"] },
        { role: "bob", persona: ".team/bob.md", tags: ["tdd", "impl"] },
        { role: "carol", persona: ".team/carol.md", tags: ["review"] },
      ],
      roles: {
        ping: { personaTags: ["tdd", "test"] },
      },
    };
    const result = applyRoleOverrides(baseRole, "ping", config);
    // alice has both "tdd" and "test", bob has "tdd" — both match
    expect(result.personaPool).toEqual([
      ".team/alice.md",
      ".team/bob.md",
    ]);
    // personaTags clears fixed persona
    expect(result.persona).toBeUndefined();
  });

  it("personaTags with no matching team members leaves pool unchanged", () => {
    const config: ProjectConfig = {
      ...baseConfig,
      team: [
        { role: "carol", persona: ".team/carol.md", tags: ["review"] },
      ],
      roles: {
        ping: { personaTags: ["tdd"] },
      },
    };
    const result = applyRoleOverrides(baseRole, "ping", config);
    // No team members have "tdd" tag
    expect(result.personaPool).toBeUndefined();
  });

  it("does not affect roles not mentioned in config", () => {
    const config: ProjectConfig = {
      ...baseConfig,
      roles: { ping: { agent: "custom-red" } },
    };
    const result = applyRoleOverrides(baseRole, "pong", config);
    expect(result).toBe(baseRole); // no override for pong
  });

  it("personaTags-resolved pool is used for rotation", () => {
    const config: ProjectConfig = {
      ...baseConfig,
      team: [
        { role: "alice", persona: ".team/alice.md", tags: ["tdd"] },
        { role: "bob", persona: ".team/bob.md", tags: ["tdd"] },
        { role: "carol", persona: ".team/carol.md", tags: ["tdd"] },
      ],
      roles: {
        ping: { personaTags: ["tdd"] },
      },
    };

    const workflowDef: WorkflowDefinition = {
      name: "test",
      description: "test",
      roles: { ping: baseRole },
      states: {
        RED: {
          assign: "ping",
          gate: { kind: "evidence", schema: { out: "string" } },
          transitions: { pass: "DONE" },
        },
        DONE: { type: "terminal" as const, result: "success" as const },
      },
    };

    const configured = applyRoleOverrides(baseRole, "ping", config);
    expect(configured.personaPool).toEqual([
      ".team/alice.md",
      ".team/bob.md",
      ".team/carol.md",
    ]);

    // First dispatch → alice
    const r0 = resolvePersonaForDispatch(
      configured,
      "ping",
      {
        workflow_id: asWorkflowId("wf"),
        workflow_type: asWorkflowType("test"),
        current_state: "RED",
        retry_count: 0,
        paused: false,
        params: {},
        evidence: {},
        metrics: {},
        history: [{ state: "RED", entered_at: "", retries: 0 }],
        created_at: "",
        updated_at: "",
      },
      workflowDef,
    );
    expect(r0.persona).toBe(".team/alice.md");

    // Second dispatch (after one prior RED) → bob
    const r1 = resolvePersonaForDispatch(
      configured,
      "ping",
      {
        workflow_id: asWorkflowId("wf"),
        workflow_type: asWorkflowType("test"),
        current_state: "RED",
        retry_count: 0,
        paused: false,
        params: {},
        evidence: {},
        metrics: {},
        history: [
          { state: "RED", entered_at: "", retries: 0 },
          { state: "RED", entered_at: "", retries: 0 },
        ],
        created_at: "",
        updated_at: "",
      },
      workflowDef,
    );
    expect(r1.persona).toBe(".team/bob.md");
  });
});

describe("project config role overrides with engine dispatch", () => {
  it("uses config-specified persona in spawned agent prompt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-role-cfg-"));

    // Write a persona file
    const teamDir = path.join(cwd, ".team");
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "alice.md"),
      "# Alice\n\nI am a testing expert who values thoroughness.",
      "utf8",
    );

    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "cfg-workflow",
      `export default {
        name: "cfg-workflow",
        description: "config test",
        initialState: "WORK",
        roles: { worker: { agent: "a", tools: ["read"], fileScope: { writable: ["src/**"], readable: ["**"] } } },
        states: {
          WORK: { assign: "worker", gate: { kind: "verdict", options: ["done"] }, transitions: { done: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store, {
      name: "test-project",
      flavor: "event-modeled",
      testRunner: "bun test",
      buildCommand: "bun run build",
      lintCommand: "bun lint",
      formatCheck: "bun lint",
      mutationTool: "stryker",
      ciProvider: "github-actions",
      testDir: "tests/**",
      srcDir: "src/**",
      typeDir: "src/**",
      team: [
        { role: "alice", persona: ".team/alice.md", tags: ["dev"] },
      ],
      roles: {
        worker: { persona: ".team/alice.md" },
      },
      autonomyLevel: "full",
      humanReviewCadence: "end",
      reworkBudget: 5,
    });
    await engine.loadWorkflows();

    const state = engine.start("cfg-workflow", {});
    await engine.dispatchCurrentState(state.workflow_id);

    const runtimeDir = path.join(
      cwd,
      ".orchestra",
      "runtime",
      `${state.workflow_id}-worker`,
    );
    const prompt = fs.readFileSync(path.join(runtimeDir, "prompt.md"), "utf8");

    expect(prompt).toContain("## Persona");
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("testing expert");
  });
});

describe("resolvePersonaFromParams", () => {
  const baseRole = {
    agent: "tdd-red",
    tools: ["read", "bash"],
    fileScope: { writable: ["tests/**"], readable: ["**"] },
  };

  it("returns role unchanged when no personaFrom is set", () => {
    const result = resolvePersonaFromParams(baseRole, { turn_persona: ".team/x.md" });
    expect(result).toBe(baseRole);
  });

  it("resolves persona from params when personaFrom is set", () => {
    const role = { ...baseRole, personaFrom: "turn_persona" };
    const result = resolvePersonaFromParams(role, { turn_persona: ".team/kent.md" });
    expect(result.persona).toBe(".team/kent.md");
    expect(result.personaPool).toBeUndefined();
    expect(result).not.toBe(role); // shallow copy
  });

  it("clears personaPool when personaFrom resolves", () => {
    const role = {
      ...baseRole,
      personaFrom: "turn_persona",
      personaPool: [".team/a.md", ".team/b.md"],
    };
    const result = resolvePersonaFromParams(role, { turn_persona: ".team/kent.md" });
    expect(result.persona).toBe(".team/kent.md");
    expect(result.personaPool).toBeUndefined();
  });

  it("returns role unchanged when param value is not a string", () => {
    const role = { ...baseRole, personaFrom: "turn_persona" };
    const result = resolvePersonaFromParams(role, { turn_persona: 42 });
    expect(result).toBe(role);
  });

  it("returns role unchanged when param key is missing", () => {
    const role = { ...baseRole, personaFrom: "turn_persona" };
    const result = resolvePersonaFromParams(role, {});
    expect(result).toBe(role);
  });
});

describe("personaFrom end-to-end via subworkflow", () => {
  it("child workflow agents receive persona from parent params via inputMap", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-pf-"));

    // Write persona file
    const teamDir = path.join(cwd, ".team");
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "kent.md"),
      "# Kent Beck\n\nI write the test that expresses the intent.",
      "utf8",
    );

    // Child workflow: one role with personaFrom
    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "turn-wf",
      `export default {
        name: "turn-wf",
        description: "turn with persona from params",
        initialState: "WORK",
        roles: {
          worker: {
            agent: "a",
            personaFrom: "turn_persona",
            tools: ["read"],
            fileScope: { writable: ["src/**"], readable: ["**"] }
          }
        },
        states: {
          WORK: { assign: "worker", gate: { kind: "verdict", options: ["done"] }, transitions: { done: "DONE" } },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    // Parent workflow: subworkflow that passes persona via inputMap
    writeWorkflow(
      path.join(cwd, "src", "workflows"),
      "parent-pf",
      `export default {
        name: "parent-pf",
        description: "parent passing persona to child",
        initialState: "TURN",
        roles: {},
        states: {
          TURN: {
            type: "subworkflow",
            workflow: "turn-wf",
            inputMap: { turn_persona: "params.persona_a" },
            transitions: { success: "DONE", failure: "DONE" }
          },
          DONE: { type: "terminal", result: "success" }
        }
      }`,
    );

    const { pi } = createFakePi();
    const store = new StateStore(path.join(cwd, ".orchestra"));
    store.ensure();
    const engine = new WorkflowEngine(pi, cwd, store);
    await engine.loadWorkflows();

    // Start parent with persona_a
    const parent = engine.start("parent-pf", {
      persona_a: ".team/kent.md",
    });

    // Dispatch parent → starts child subworkflow
    await engine.dispatchCurrentState(parent.workflow_id);

    // Find the child
    const parentState = engine.get(parent.workflow_id)!;
    const childId = parentState.children!.TURN as unknown as string;
    const child = engine.get(childId)!;

    // Child should have received the persona in its params
    expect(child.params.turn_persona).toBe(".team/kent.md");

    // Dispatch child → spawns agent with personaFrom-resolved persona
    await engine.dispatchCurrentState(childId);

    // Verify the prompt contains the persona content
    const runtimeDir = path.join(
      cwd,
      ".orchestra",
      "runtime",
      `${childId}-worker`,
    );
    const prompt = fs.readFileSync(path.join(runtimeDir, "prompt.md"), "utf8");
    expect(prompt).toContain("## Persona");
    expect(prompt).toContain("Kent Beck");
    expect(prompt).toContain("expresses the intent");
  });
});
