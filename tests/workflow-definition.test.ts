import { describe, expect, it } from "vitest";
import {
  asAgentId,
  asMessageId,
  asWorkflowId,
  asWorkflowType,
} from "../src/core/types";
import {
  command,
  defineWorkflow,
  evidence,
  verdict,
} from "../src/core/workflow-definition";

describe("workflow-definition helpers", () => {
  it("builds gate definitions", () => {
    const ev = evidence({
      schema: { test_file: "string" },
      verify: { command: "npm test", expectExitCode: 1 },
    });
    expect(ev.kind).toBe("evidence");
    expect(ev.verify?.command).toBe("npm test");

    const vd = verdict({ options: ["approved", "flagged"] });
    expect(vd.kind).toBe("verdict");
    expect(vd.options).toEqual(["approved", "flagged"]);

    const cmd = command({ verify: { command: "echo ok" } });
    expect(cmd.kind).toBe("command");
    expect(cmd.verify.command).toBe("echo ok");
  });

  it("returns workflow definitions unchanged", () => {
    const wf = defineWorkflow({
      name: "wf",
      description: "wf",
      roles: {
        r: {
          agent: "a",
          tools: ["read"],
          fileScope: { writable: [], readable: ["**"] },
        },
      },
      states: {
        ONE: {
          assign: "r",
          gate: verdict({ options: ["ok"] }),
          transitions: { ok: "DONE" },
        },
        DONE: { type: "terminal", result: "success" },
      },
    });

    expect(wf.name).toBe("wf");
    expect(wf.states.DONE).toEqual({ type: "terminal", result: "success" });
  });
});

describe("type branding helpers", () => {
  it("brands identifiers", () => {
    expect(asWorkflowId("w")).toBe("w");
    expect(asWorkflowType("t")).toBe("t");
    expect(asAgentId("a")).toBe("a");
    expect(asMessageId("m")).toBe("m");
  });
});
