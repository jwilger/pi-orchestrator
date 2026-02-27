import {
  command,
  defineWorkflow,
  subworkflow,
  verdict,
} from "../../src/core/workflow-definition";

/**
 * End-to-end self-hosting workflow to deliver docs/SLICES.md without human stops.
 *
 * For each slice:
 * 1) Plan slice objective
 * 2) Build with ping-pong TDD (includes domain review)
 * 3) Run three-stage review
 * 4) Validate full CI gates
 * 5) Open PR
 * 6) Wait for checks
 * 7) Merge PR
 * 8) Sync local main
 */
export default defineWorkflow({
  name: "orchestra-self-host-panel",
  description:
    "Execute control-panel delivery via autonomous ping-pong TDD slices and PR automation",
  initialState: "PRECHECK",
  params: {
    objective: { type: "string", required: true },
    persona_a: { type: "string", default: "src/agents/tdd-red.md" },
    persona_b: { type: "string", default: "src/agents/tdd-green.md" },
    test_runner: { type: "string", default: "npm test" },
    test_dir: { type: "string", default: "tests/" },
    src_dir: { type: "string", default: "src/" },
    lint_command: { type: "string", default: "npm run lint" },
    typecheck_command: { type: "string", default: "npm run typecheck" },
    mutation_command: { type: "string", default: "npm run test:mutate" },
  },
  roles: {
    facilitator: {
      agent: "facilitator",
      tools: ["read", "bash", "edit", "write"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
  },
  states: {
    PRECHECK: {
      type: "action",
      commands: [
        "bash scripts/orchestra/precheck.sh",
        "bash scripts/orchestra/sync-main.sh",
      ],
      gate: command({ verify: { command: "bash scripts/orchestra/precheck.sh" } }),
      transitions: { pass: "SLICE_1_PLAN", fail: "ESCALATE" },
    },

    // --- Slice 1 ---
    SLICE_1_PLAN: {
      assign: "facilitator",
      gate: verdict({ options: ["ready", "rework", "escalate"] }),
      transitions: {
        ready: "SLICE_1_BUILD",
        rework: "SLICE_1_PLAN",
        escalate: "ESCALATE",
      },
      maxRetries: 2,
    },
    SLICE_1_BUILD: subworkflow({
      workflow: "tdd-ping-pong",
      inputMap: {
        persona_a: "params.persona_a",
        persona_b: "params.persona_b",
        scenario: "params.objective",
        test_runner: "params.test_runner",
        test_dir: "params.test_dir",
        src_dir: "params.src_dir",
      },
      transitions: { success: "SLICE_1_REVIEW", failure: "ESCALATE" },
      maxRetries: 2,
    }),
    SLICE_1_REVIEW: subworkflow({
      workflow: "three-stage-review",
      transitions: { success: "SLICE_1_VALIDATE", failure: "SLICE_1_BUILD" },
      maxRetries: 1,
    }),
    SLICE_1_VALIDATE: {
      type: "action",
      commands: [
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run test:mutate",
      ],
      gate: command({ verify: { command: "npm run ci" } }),
      transitions: { pass: "SLICE_1_PR_OPEN", fail: "SLICE_1_BUILD" },
    },
    SLICE_1_PR_OPEN: {
      type: "action",
      commands: [
        "bash scripts/orchestra/open-pr.sh S1 'S1: panel command entrypoint + launcher seam'",
      ],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S1 open" },
      }),
      transitions: { pass: "SLICE_1_PR_WAIT", fail: "ESCALATE" },
    },
    SLICE_1_PR_WAIT: {
      type: "action",
      commands: ["bash scripts/orchestra/wait-pr-ready.sh S1 10800"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S1 ready" },
      }),
      transitions: { pass: "SLICE_1_PR_MERGE", fail: "ESCALATE" },
    },
    SLICE_1_PR_MERGE: {
      type: "action",
      commands: ["bash scripts/orchestra/merge-pr.sh S1"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S1 merged" },
      }),
      transitions: { pass: "SLICE_1_SYNC", fail: "ESCALATE" },
    },
    SLICE_1_SYNC: {
      type: "action",
      commands: ["bash scripts/orchestra/sync-main.sh"],
      gate: command({ verify: { command: "bash scripts/orchestra/sync-main.sh" } }),
      transitions: { pass: "SLICE_2_PLAN", fail: "ESCALATE" },
    },

    // --- Slice 2 ---
    SLICE_2_PLAN: {
      assign: "facilitator",
      gate: verdict({ options: ["ready", "rework", "escalate"] }),
      transitions: {
        ready: "SLICE_2_BUILD",
        rework: "SLICE_2_PLAN",
        escalate: "ESCALATE",
      },
      maxRetries: 2,
    },
    SLICE_2_BUILD: subworkflow({
      workflow: "tdd-ping-pong",
      inputMap: {
        persona_a: "params.persona_a",
        persona_b: "params.persona_b",
        scenario: "params.objective",
        test_runner: "params.test_runner",
        test_dir: "params.test_dir",
        src_dir: "params.src_dir",
      },
      transitions: { success: "SLICE_2_REVIEW", failure: "ESCALATE" },
      maxRetries: 2,
    }),
    SLICE_2_REVIEW: subworkflow({
      workflow: "three-stage-review",
      transitions: { success: "SLICE_2_VALIDATE", failure: "SLICE_2_BUILD" },
      maxRetries: 1,
    }),
    SLICE_2_VALIDATE: {
      type: "action",
      commands: [
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run test:mutate",
      ],
      gate: command({ verify: { command: "npm run ci" } }),
      transitions: { pass: "SLICE_2_PR_OPEN", fail: "SLICE_2_BUILD" },
    },
    SLICE_2_PR_OPEN: {
      type: "action",
      commands: [
        "bash scripts/orchestra/open-pr.sh S2 'S2: read-only panel rendering + navigation'",
      ],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S2 open" },
      }),
      transitions: { pass: "SLICE_2_PR_WAIT", fail: "ESCALATE" },
    },
    SLICE_2_PR_WAIT: {
      type: "action",
      commands: ["bash scripts/orchestra/wait-pr-ready.sh S2 10800"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S2 ready" },
      }),
      transitions: { pass: "SLICE_2_PR_MERGE", fail: "ESCALATE" },
    },
    SLICE_2_PR_MERGE: {
      type: "action",
      commands: ["bash scripts/orchestra/merge-pr.sh S2"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S2 merged" },
      }),
      transitions: { pass: "SLICE_2_SYNC", fail: "ESCALATE" },
    },
    SLICE_2_SYNC: {
      type: "action",
      commands: ["bash scripts/orchestra/sync-main.sh"],
      gate: command({ verify: { command: "bash scripts/orchestra/sync-main.sh" } }),
      transitions: { pass: "SLICE_3_PLAN", fail: "ESCALATE" },
    },

    // --- Slice 3 ---
    SLICE_3_PLAN: {
      assign: "facilitator",
      gate: verdict({ options: ["ready", "rework", "escalate"] }),
      transitions: {
        ready: "SLICE_3_BUILD",
        rework: "SLICE_3_PLAN",
        escalate: "ESCALATE",
      },
      maxRetries: 2,
    },
    SLICE_3_BUILD: subworkflow({
      workflow: "tdd-ping-pong",
      inputMap: {
        persona_a: "params.persona_a",
        persona_b: "params.persona_b",
        scenario: "params.objective",
        test_runner: "params.test_runner",
        test_dir: "params.test_dir",
        src_dir: "params.src_dir",
      },
      transitions: { success: "SLICE_3_REVIEW", failure: "ESCALATE" },
      maxRetries: 2,
    }),
    SLICE_3_REVIEW: subworkflow({
      workflow: "three-stage-review",
      transitions: { success: "SLICE_3_VALIDATE", failure: "SLICE_3_BUILD" },
      maxRetries: 1,
    }),
    SLICE_3_VALIDATE: {
      type: "action",
      commands: [
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run test:mutate",
      ],
      gate: command({ verify: { command: "npm run ci" } }),
      transitions: { pass: "SLICE_3_PR_OPEN", fail: "SLICE_3_BUILD" },
    },
    SLICE_3_PR_OPEN: {
      type: "action",
      commands: [
        "bash scripts/orchestra/open-pr.sh S3 'S3: workflow actions with tests'",
      ],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S3 open" },
      }),
      transitions: { pass: "SLICE_3_PR_WAIT", fail: "ESCALATE" },
    },
    SLICE_3_PR_WAIT: {
      type: "action",
      commands: ["bash scripts/orchestra/wait-pr-ready.sh S3 10800"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S3 ready" },
      }),
      transitions: { pass: "SLICE_3_PR_MERGE", fail: "ESCALATE" },
    },
    SLICE_3_PR_MERGE: {
      type: "action",
      commands: ["bash scripts/orchestra/merge-pr.sh S3"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S3 merged" },
      }),
      transitions: { pass: "SLICE_3_SYNC", fail: "ESCALATE" },
    },
    SLICE_3_SYNC: {
      type: "action",
      commands: ["bash scripts/orchestra/sync-main.sh"],
      gate: command({ verify: { command: "bash scripts/orchestra/sync-main.sh" } }),
      transitions: { pass: "SLICE_4_PLAN", fail: "ESCALATE" },
    },

    // --- Slice 4 ---
    SLICE_4_PLAN: {
      assign: "facilitator",
      gate: verdict({ options: ["ready", "rework", "escalate"] }),
      transitions: {
        ready: "SLICE_4_BUILD",
        rework: "SLICE_4_PLAN",
        escalate: "ESCALATE",
      },
      maxRetries: 2,
    },
    SLICE_4_BUILD: subworkflow({
      workflow: "tdd-ping-pong",
      inputMap: {
        persona_a: "params.persona_a",
        persona_b: "params.persona_b",
        scenario: "params.objective",
        test_runner: "params.test_runner",
        test_dir: "params.test_dir",
        src_dir: "params.src_dir",
      },
      transitions: { success: "SLICE_4_REVIEW", failure: "ESCALATE" },
      maxRetries: 2,
    }),
    SLICE_4_REVIEW: subworkflow({
      workflow: "three-stage-review",
      transitions: { success: "SLICE_4_VALIDATE", failure: "SLICE_4_BUILD" },
      maxRetries: 1,
    }),
    SLICE_4_VALIDATE: {
      type: "action",
      commands: [
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run test:mutate",
      ],
      gate: command({ verify: { command: "npm run ci" } }),
      transitions: { pass: "SLICE_4_PR_OPEN", fail: "SLICE_4_BUILD" },
    },
    SLICE_4_PR_OPEN: {
      type: "action",
      commands: [
        "bash scripts/orchestra/open-pr.sh S4 'S4: pane controls and workflow->pane jump'",
      ],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S4 open" },
      }),
      transitions: { pass: "SLICE_4_PR_WAIT", fail: "ESCALATE" },
    },
    SLICE_4_PR_WAIT: {
      type: "action",
      commands: ["bash scripts/orchestra/wait-pr-ready.sh S4 10800"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S4 ready" },
      }),
      transitions: { pass: "SLICE_4_PR_MERGE", fail: "ESCALATE" },
    },
    SLICE_4_PR_MERGE: {
      type: "action",
      commands: ["bash scripts/orchestra/merge-pr.sh S4"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S4 merged" },
      }),
      transitions: { pass: "SLICE_4_SYNC", fail: "ESCALATE" },
    },
    SLICE_4_SYNC: {
      type: "action",
      commands: ["bash scripts/orchestra/sync-main.sh"],
      gate: command({ verify: { command: "bash scripts/orchestra/sync-main.sh" } }),
      transitions: { pass: "SLICE_5_PLAN", fail: "ESCALATE" },
    },

    // --- Slice 5 ---
    SLICE_5_PLAN: {
      assign: "facilitator",
      gate: verdict({ options: ["ready", "rework", "escalate"] }),
      transitions: {
        ready: "SLICE_5_BUILD",
        rework: "SLICE_5_PLAN",
        escalate: "ESCALATE",
      },
      maxRetries: 2,
    },
    SLICE_5_BUILD: subworkflow({
      workflow: "tdd-ping-pong",
      inputMap: {
        persona_a: "params.persona_a",
        persona_b: "params.persona_b",
        scenario: "params.objective",
        test_runner: "params.test_runner",
        test_dir: "params.test_dir",
        src_dir: "params.src_dir",
      },
      transitions: { success: "SLICE_5_REVIEW", failure: "ESCALATE" },
      maxRetries: 2,
    }),
    SLICE_5_REVIEW: subworkflow({
      workflow: "three-stage-review",
      transitions: { success: "SLICE_5_VALIDATE", failure: "SLICE_5_BUILD" },
      maxRetries: 1,
    }),
    SLICE_5_VALIDATE: {
      type: "action",
      commands: [
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run test:mutate",
      ],
      gate: command({ verify: { command: "npm run ci" } }),
      transitions: { pass: "SLICE_5_PR_OPEN", fail: "SLICE_5_BUILD" },
    },
    SLICE_5_PR_OPEN: {
      type: "action",
      commands: [
        "bash scripts/orchestra/open-pr.sh S5 'S5: hardening and docs updates'",
      ],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S5 open" },
      }),
      transitions: { pass: "SLICE_5_PR_WAIT", fail: "ESCALATE" },
    },
    SLICE_5_PR_WAIT: {
      type: "action",
      commands: ["bash scripts/orchestra/wait-pr-ready.sh S5 10800"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S5 ready" },
      }),
      transitions: { pass: "SLICE_5_PR_MERGE", fail: "ESCALATE" },
    },
    SLICE_5_PR_MERGE: {
      type: "action",
      commands: ["bash scripts/orchestra/merge-pr.sh S5"],
      gate: command({
        verify: { command: "bash scripts/orchestra/pr-state.sh S5 merged" },
      }),
      transitions: { pass: "SLICE_5_SYNC", fail: "ESCALATE" },
    },
    SLICE_5_SYNC: {
      type: "action",
      commands: ["bash scripts/orchestra/sync-main.sh"],
      gate: command({ verify: { command: "bash scripts/orchestra/sync-main.sh" } }),
      transitions: { pass: "COMPLETE", fail: "ESCALATE" },
    },

    COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
