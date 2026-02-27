import {
  command,
  defineWorkflow,
  evidence,
  verdict,
} from "../core/workflow-definition";

export default defineWorkflow({
  name: "tdd-ping-pong",
  description: "Two-agent TDD cycle with domain review",
  initialState: "RED",
  params: {
    scenario: { type: "string", required: true },
    test_runner: { type: "string", default: "npm test" },
    test_dir: { type: "string", default: "tests/" },
    src_dir: { type: "string", default: "src/" },
  },
  roles: {
    ping: {
      agent: "tdd-red",
      tools: ["read", "bash", "edit", "write"],
      fileScope: { writable: ["tests/**"], readable: ["**"] },
    },
    pong: {
      agent: "tdd-green",
      tools: ["read", "bash", "edit", "write"],
      fileScope: { writable: ["src/**"], readable: ["**"] },
    },
    domain_reviewer: {
      agent: "domain-review",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
  },
  states: {
    RED: {
      assign: "ping",
      gate: evidence({
        schema: { test_file: "string", failure_output: "string" },
        verify: { command: "npm test", expectExitCode: 1 },
      }),
      transitions: { pass: "DOMAIN_REVIEW_TEST", fail: "RED" },
      maxRetries: 3,
    },
    DOMAIN_REVIEW_TEST: {
      assign: "domain_reviewer",
      gate: verdict({ options: ["approved", "flagged"] }),
      transitions: { approved: "GREEN", flagged: "RED" },
      maxRetries: 2,
    },
    GREEN: {
      assign: "pong",
      gate: evidence({
        schema: { implementation_files: "string[]", test_output: "string" },
        verify: { command: "npm test", expectExitCode: 0 },
      }),
      transitions: { pass: "DOMAIN_REVIEW_IMPL", fail: "GREEN" },
      maxRetries: 3,
    },
    DOMAIN_REVIEW_IMPL: {
      assign: "domain_reviewer",
      gate: verdict({ options: ["approved", "flagged"] }),
      transitions: { approved: "COMMIT", flagged: "GREEN" },
      maxRetries: 2,
    },
    COMMIT: {
      type: "action",
      commands: ["git add -A", "git commit -m 'TDD cycle complete'"],
      gate: command({
        verify: { command: "git status --porcelain", expectExitCode: 0 },
      }),
      transitions: { pass: "CYCLE_COMPLETE", fail: "ESCALATE" },
    },
    CYCLE_COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
