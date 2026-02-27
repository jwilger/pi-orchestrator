import { defineWorkflow, evidence, verdict } from "../core/workflow-definition";

export default defineWorkflow({
  name: "retro",
  description: "Post-slice retrospective with structured proposals",
  initialState: "COLLECT",
  roles: {
    retro_facilitator: {
      agent: "retro-facilitator",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: [".orchestra/**", "docs/**"], readable: ["**"] },
    },
    participant: {
      agent: "reviewer",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: [".orchestra/**", "docs/**"], readable: ["**"] },
    },
  },
  states: {
    COLLECT: {
      assign: "participant",
      gate: evidence({ schema: { reflections: "string[]" } }),
      transitions: { pass: "ANALYZE", fail: "COLLECT" },
      maxRetries: 2,
    },
    ANALYZE: {
      assign: "retro_facilitator",
      gate: evidence({ schema: { themes: "string[]" } }),
      transitions: { pass: "PROPOSE", fail: "ANALYZE" },
      maxRetries: 2,
    },
    PROPOSE: {
      assign: "retro_facilitator",
      gate: evidence({ schema: { proposals_path: "string" } }),
      transitions: { pass: "HUMAN_REVIEW", fail: "PROPOSE" },
      maxRetries: 1,
    },
    HUMAN_REVIEW: {
      assign: "retro_facilitator",
      gate: verdict({ options: ["apply", "skip"] }),
      transitions: { apply: "APPLY", skip: "SKIP" },
      maxRetries: 1,
    },
    APPLY: { type: "terminal", result: "success" },
    SKIP: { type: "terminal", result: "success" },
  },
});
