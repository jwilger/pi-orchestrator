import { defineWorkflow, evidence, verdict } from "../core/workflow-definition";

export default defineWorkflow({
  name: "prd",
  description: "Traditional PRD requirements workflow",
  initialState: "DRAFT",
  roles: {
    product_manager: {
      agent: "product-manager",
      tools: ["read", "write", "edit", "bash"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
    reviewer: {
      agent: "domain-review",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
  },
  states: {
    DRAFT: {
      assign: "product_manager",
      gate: evidence({ schema: { prd_path: "string", stories: "string[]" } }),
      transitions: { pass: "REVIEW", fail: "DRAFT" },
      maxRetries: 3,
    },
    REVIEW: {
      assign: "reviewer",
      gate: verdict({ options: ["approved", "rework"] }),
      transitions: { approved: "TRACKING_SETUP", rework: "DRAFT" },
      maxRetries: 2,
    },
    TRACKING_SETUP: {
      assign: "product_manager",
      gate: evidence({ schema: { tracker: "string", item_count: "number" } }),
      transitions: { pass: "COMPLETE", fail: "ESCALATE" },
      maxRetries: 2,
    },
    COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
