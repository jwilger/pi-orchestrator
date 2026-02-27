import {
  defineWorkflow,
  evidence,
  verdict,
} from "../core/workflow-definition";

/**
 * A single TDD turn — one person's contribution to the ping-pong cycle.
 *
 * Receives `turn_persona` as a param (passed via inputMap from the
 * parent ping-pong workflow). Every role in this workflow uses
 * `personaFrom: "turn_persona"` so the turn-taker's personality
 * colors all decisions and work within the turn.
 *
 * Flow:
 *   TRIAGE → decides "red" or "green"
 *   RED    → writes a failing test, verifies it fails
 *   GREEN  → writes minimal implementation, verifies tests pass
 */
export default defineWorkflow({
  name: "tdd-turn",
  description: "Single TDD turn — triage then red or green work",
  initialState: "TRIAGE",
  params: {
    turn_persona: { type: "string", required: true },
    scenario: { type: "string", required: true },
    test_runner: { type: "string", default: "npm test" },
    test_dir: { type: "string", default: "tests/" },
    src_dir: { type: "string", default: "src/" },
  },
  roles: {
    triage: {
      agent: "tdd-triage",
      personaFrom: "turn_persona",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
    red: {
      agent: "tdd-red",
      personaFrom: "turn_persona",
      tools: ["read", "bash", "edit", "write"],
      fileScope: { writable: ["tests/**"], readable: ["**"] },
    },
    green: {
      agent: "tdd-green",
      personaFrom: "turn_persona",
      tools: ["read", "bash", "edit", "write"],
      fileScope: { writable: ["src/**"], readable: ["**"] },
    },
  },
  states: {
    TRIAGE: {
      assign: "triage",
      gate: verdict({ options: ["red", "green"] }),
      transitions: { red: "RED", green: "GREEN" },
      maxRetries: 2,
    },
    RED: {
      assign: "red",
      gate: evidence({
        schema: { test_file: "string", failure_output: "string" },
        verify: { command: "npm test", expectExitCode: 1 },
      }),
      transitions: { pass: "TURN_COMPLETE", fail: "RED" },
      maxRetries: 3,
    },
    GREEN: {
      assign: "green",
      gate: evidence({
        schema: { implementation_files: "string[]", test_output: "string" },
        verify: { command: "npm test", expectExitCode: 0 },
      }),
      transitions: { pass: "TURN_COMPLETE", fail: "GREEN" },
      maxRetries: 3,
    },
    TURN_COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
