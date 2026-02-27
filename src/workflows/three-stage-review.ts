import { defineWorkflow, verdict } from "../core/workflow-definition";

export default defineWorkflow({
  name: "three-stage-review",
  description: "Syntax, domain, and holistic review",
  initialState: "SYNTAX_REVIEW",
  roles: {
    syntax_reviewer: {
      agent: "syntax-reviewer",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
    domain_reviewer: {
      agent: "domain-reviewer",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
    holistic_reviewer: {
      agent: "holistic-reviewer",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
  },
  states: {
    SYNTAX_REVIEW: {
      assign: "syntax_reviewer",
      gate: verdict({ options: ["approved", "flagged"] }),
      transitions: { approved: "DOMAIN_REVIEW", flagged: "REWORK" },
      maxRetries: 1,
    },
    DOMAIN_REVIEW: {
      assign: "domain_reviewer",
      gate: verdict({ options: ["approved", "flagged"] }),
      transitions: { approved: "HOLISTIC_REVIEW", flagged: "REWORK" },
      maxRetries: 1,
    },
    HOLISTIC_REVIEW: {
      assign: "holistic_reviewer",
      gate: verdict({ options: ["approved", "flagged"] }),
      transitions: { approved: "APPROVED", flagged: "REWORK" },
      maxRetries: 1,
    },
    APPROVED: { type: "terminal", result: "success" },
    REWORK: { type: "terminal", result: "failure", action: "route_rework" },
  },
});
