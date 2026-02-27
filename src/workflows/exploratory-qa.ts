import { defineWorkflow, evidence, verdict } from "../core/workflow-definition";

export default defineWorkflow({
  name: "exploratory-qa",
  description: "Exploratory QA for design/system gaps",
  initialState: "SETUP",
  roles: {
    qa_analyst: {
      agent: "qa-analyst",
      tools: ["read", "bash", "write", "edit"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
    triage_lead: {
      agent: "pipeline-agent",
      tools: ["read", "bash", "write", "edit"],
      fileScope: { writable: ["docs/**", ".orchestra/**"], readable: ["**"] },
    },
  },
  states: {
    SETUP: {
      assign: "qa_analyst",
      gate: evidence({
        schema: { scope: "string", acceptance_criteria: "string[]" },
      }),
      transitions: { pass: "EXPLORE", fail: "SETUP" },
      maxRetries: 2,
    },
    EXPLORE: {
      assign: "qa_analyst",
      gate: evidence({ schema: { findings: "string[]", severity: "string" } }),
      transitions: { pass: "TRIAGE", fail: "EXPLORE" },
      maxRetries: 2,
    },
    TRIAGE: {
      assign: "triage_lead",
      gate: verdict({ options: ["fix", "pass"] }),
      transitions: { fix: "FIX", pass: "PASS" },
      maxRetries: 1,
    },
    FIX: { type: "terminal", result: "failure", action: "route_rework" },
    PASS: { type: "terminal", result: "success" },
  },
});
