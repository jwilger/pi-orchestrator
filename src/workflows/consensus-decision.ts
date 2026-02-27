import { defineWorkflow, evidence, verdict } from "../core/workflow-definition";

export default defineWorkflow({
  name: "consensus-decision",
  description: "Structured multi-expert discussion and voting",
  initialState: "SEED",
  roles: {
    facilitator: {
      agent: "facilitator",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
    expert: {
      agent: "expert",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
  },
  states: {
    SEED: {
      assign: "facilitator",
      gate: evidence({ schema: { prompt: "string" } }),
      transitions: { pass: "DISCUSS", fail: "SEED" },
      maxRetries: 2,
    },
    DISCUSS: {
      assign: "expert",
      gate: evidence({ schema: { positions: "string[]" } }),
      transitions: { pass: "VOTE", fail: "DISCUSS" },
      maxRetries: 3,
    },
    VOTE: {
      assign: "expert",
      gate: verdict({ options: ["consensus", "no_consensus"] }),
      transitions: { consensus: "RESOLVE", no_consensus: "ESCALATE" },
      maxRetries: 2,
    },
    RESOLVE: {
      assign: "facilitator",
      gate: evidence({ schema: { synthesis_document: "string" } }),
      transitions: { pass: "COMPLETE", fail: "ESCALATE" },
      maxRetries: 1,
    },
    COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
