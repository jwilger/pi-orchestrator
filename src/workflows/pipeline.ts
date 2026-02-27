import {
  command,
  defineWorkflow,
  evidence,
  subworkflow,
  verdict,
} from "../core/workflow-definition";

/**
 * Full slice pipeline — a composition of sub-workflows.
 *
 * Each phase is a slot: the actual workflow to run is resolved from
 * `params.slots` at runtime. This lets projects swap implementations
 * (e.g. use "prd" instead of "discovery" for requirements, or a
 * custom "build" workflow instead of "tdd-ping-pong").
 *
 * Default slot bindings are documented below. Override any slot by
 * passing `{ slots: { build: "my-custom-build" } }` in params.
 *
 * The pipeline threads evidence through: each sub-workflow's output
 * evidence is available to subsequent phases under
 * `evidence.<STATE_NAME>.child_evidence.*`.
 */
export default defineWorkflow({
  name: "pipeline",
  description:
    "Full slice pipeline — composes discovery, modeling, planning, build, review, and approval workflows",
  initialState: "SETUP",
  params: {
    branch: { type: "string", required: true },
    slice: { type: "string", required: true },
    slots: {
      type: "object",
      default: {
        discovery: "discovery",
        modeling: "event-modeling",
        planning: "prd",
        build: "tdd-ping-pong",
        review: "three-stage-review",
        qa: "exploratory-qa",
      },
    },
  },
  roles: {
    pipeline_agent: {
      agent: "pipeline-agent",
      tools: ["read", "bash", "write", "edit"],
      fileScope: { writable: [".orchestra/**", "docs/**"], readable: ["**"] },
    },
  },
  states: {
    // --- Setup: pipeline agent gathers branch/slice metadata ---
    SETUP: {
      assign: "pipeline_agent",
      gate: evidence({
        schema: {
          branch: "string",
          slice: "string",
          acceptance_criteria: "string[]",
        },
      }),
      transitions: { pass: "DISCOVERY", fail: "ESCALATE" },
      maxRetries: 2,
    },

    // --- Phase 1: Discovery ---
    DISCOVERY: subworkflow({
      workflow: "$discovery",
      inputMap: {
        problem_statement: "evidence.SETUP.slice",
        goals: "evidence.SETUP.acceptance_criteria",
      },
      transitions: { success: "MODELING", failure: "ESCALATE" },
    }),

    // --- Phase 2: Event Modeling (or PRD, depending on flavor) ---
    MODELING: subworkflow({
      workflow: "$modeling",
      inputMap: {
        context: "evidence.DISCOVERY.child_evidence",
      },
      transitions: { success: "PLANNING", failure: "ESCALATE" },
    }),

    // --- Phase 3: Planning / Story Breakdown ---
    PLANNING: subworkflow({
      workflow: "$planning",
      inputMap: {
        model: "evidence.MODELING.child_evidence",
        acceptance_criteria: "evidence.SETUP.acceptance_criteria",
      },
      transitions: { success: "BUILD", failure: "ESCALATE" },
    }),

    // --- Phase 4: Build (TDD cycles) ---
    BUILD: subworkflow({
      workflow: "$build",
      inputMap: {
        scenario: "evidence.SETUP.slice",
      },
      transitions: { success: "REVIEW", failure: "ESCALATE" },
      maxRetries: 3,
    }),

    // --- Phase 5: Review ---
    REVIEW: subworkflow({
      workflow: "$review",
      transitions: { success: "QA", failure: "BUILD" },
    }),

    // --- Phase 6: QA ---
    QA: subworkflow({
      workflow: "$qa",
      inputMap: {
        scope: "evidence.SETUP.slice",
        acceptance_criteria: "evidence.SETUP.acceptance_criteria",
      },
      transitions: { success: "CI", failure: "BUILD" },
    }),

    // --- Post-build gates (action states, not sub-workflows) ---
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
