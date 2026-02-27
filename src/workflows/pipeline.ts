import {
  command,
  defineWorkflow,
  evidence,
  verdict,
} from "../core/workflow-definition";

export default defineWorkflow({
  name: "pipeline",
  description: "Full slice pipeline",
  initialState: "SETUP",
  roles: {
    pipeline_agent: {
      agent: "pipeline-agent",
      tools: ["read", "bash", "write", "edit"],
      fileScope: { writable: [".orchestra/**", "docs/**"], readable: ["**"] },
    },
    reviewer: {
      agent: "reviewer",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
  },
  states: {
    SETUP: {
      assign: "pipeline_agent",
      gate: evidence({ schema: { branch: "string", slice: "string" } }),
      transitions: { pass: "TDD_CYCLE", fail: "ESCALATE" },
      maxRetries: 2,
    },
    TDD_CYCLE: {
      assign: "pipeline_agent",
      gate: verdict({ options: ["complete", "retry"] }),
      transitions: { complete: "REVIEW", retry: "TDD_CYCLE" },
      maxRetries: 10,
    },
    REVIEW: {
      assign: "reviewer",
      gate: verdict({ options: ["approved", "flagged"] }),
      transitions: { approved: "MUTATION", flagged: "TDD_CYCLE" },
      maxRetries: 3,
    },
    MUTATION: {
      type: "action",
      commands: ["npm run test || true"],
      gate: command({ verify: { command: "npm run test" } }),
      transitions: { pass: "CI", fail: "ESCALATE" },
    },
    CI: {
      type: "action",
      commands: ["echo 'wait for ci'"],
      gate: command({ verify: { command: "echo ci-green" } }),
      transitions: { pass: "MERGE", fail: "ESCALATE" },
    },
    MERGE: {
      type: "action",
      commands: ["echo merge"],
      gate: command({ verify: { command: "echo merged" } }),
      transitions: { pass: "DONE", fail: "ESCALATE" },
    },
    DONE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
