import { defineWorkflow, evidence, verdict } from "../core/workflow-definition";

export default defineWorkflow({
  name: "event-modeling",
  description: "Event-modeled requirements capture",
  initialState: "COLLECT_EVENTS",
  roles: {
    facilitator: {
      agent: "facilitator",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
    domain_architect: {
      agent: "domain-architect",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
  },
  states: {
    COLLECT_EVENTS: {
      assign: "domain_architect",
      gate: evidence({ schema: { events: "string[]", commands: "string[]" } }),
      transitions: { pass: "MAP_SCENARIOS", fail: "COLLECT_EVENTS" },
      maxRetries: 3,
    },
    MAP_SCENARIOS: {
      assign: "domain_architect",
      gate: evidence({
        schema: { scenarios: "string[]", read_models: "string[]" },
      }),
      transitions: { pass: "REVIEW", fail: "MAP_SCENARIOS" },
      maxRetries: 3,
    },
    REVIEW: {
      assign: "facilitator",
      gate: verdict({ options: ["approved", "rework"] }),
      transitions: { approved: "COMPLETE", rework: "COLLECT_EVENTS" },
      maxRetries: 2,
    },
    COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
