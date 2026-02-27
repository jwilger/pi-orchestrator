import { defineWorkflow, evidence, verdict } from "../core/workflow-definition";

export default defineWorkflow({
  name: "discovery",
  description: "Domain discovery and problem framing",
  initialState: "SEED",
  roles: {
    facilitator: {
      agent: "facilitator",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
    domain_expert: {
      agent: "domain-expert",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
  },
  states: {
    SEED: {
      assign: "facilitator",
      gate: evidence({
        schema: { problem_statement: "string", goals: "string[]" },
      }),
      transitions: { pass: "DISCUSS", fail: "SEED" },
      maxRetries: 2,
    },
    DISCUSS: {
      assign: "domain_expert",
      gate: evidence({
        schema: { findings: "string[]", open_questions: "string[]" },
      }),
      transitions: { pass: "ALIGN", fail: "DISCUSS" },
      maxRetries: 3,
    },
    ALIGN: {
      assign: "facilitator",
      gate: verdict({ options: ["aligned", "needs_more_discovery"] }),
      transitions: { aligned: "COMPLETE", needs_more_discovery: "DISCUSS" },
      maxRetries: 2,
    },
    COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
