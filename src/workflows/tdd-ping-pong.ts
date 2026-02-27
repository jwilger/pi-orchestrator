import {
  command,
  defineWorkflow,
  subworkflow,
  verdict,
} from "../core/workflow-definition";

/**
 * Two-personality TDD ping-pong with mandatory domain review.
 *
 * Two people (persona_a, persona_b) alternate turns. Each turn is a
 * tdd-turn subworkflow where the turn-taker triages the test state
 * and then does red or green work — all colored by their personality.
 *
 * Domain review sits between every turn as a mandatory gateway.
 * The domain reviewer is always the domain design specialist — their
 * persona comes from the project config, not the turn.
 *
 * Cycle: TURN_A → REVIEW_A → TURN_B → REVIEW_B → TURN_A → ...
 * until a reviewer submits "complete".
 */
export default defineWorkflow({
  name: "tdd-ping-pong",
  description:
    "Two-personality TDD cycle with mandatory domain review between turns",
  initialState: "TURN_A",
  params: {
    persona_a: { type: "string", required: true },
    persona_b: { type: "string", required: true },
    scenario: { type: "string", required: true },
    test_runner: { type: "string", default: "npm test" },
    test_dir: { type: "string", default: "tests/" },
    src_dir: { type: "string", default: "src/" },
  },
  roles: {
    domain_reviewer: {
      agent: "domain-review",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
  },
  states: {
    // --- Person A's turn ---
    TURN_A: subworkflow({
      workflow: "tdd-turn",
      inputMap: {
        turn_persona: "params.persona_a",
        scenario: "params.scenario",
        test_runner: "params.test_runner",
        test_dir: "params.test_dir",
        src_dir: "params.src_dir",
      },
      transitions: { success: "REVIEW_A", failure: "ESCALATE" },
    }),

    REVIEW_A: {
      assign: "domain_reviewer",
      gate: verdict({ options: ["continue", "flagged", "complete"] }),
      transitions: {
        continue: "TURN_B",
        flagged: "TURN_A",
        complete: "COMMIT",
      },
      maxRetries: 2,
    },

    // --- Person B's turn ---
    TURN_B: subworkflow({
      workflow: "tdd-turn",
      inputMap: {
        turn_persona: "params.persona_b",
        scenario: "params.scenario",
        test_runner: "params.test_runner",
        test_dir: "params.test_dir",
        src_dir: "params.src_dir",
      },
      transitions: { success: "REVIEW_B", failure: "ESCALATE" },
    }),

    REVIEW_B: {
      assign: "domain_reviewer",
      gate: verdict({ options: ["continue", "flagged", "complete"] }),
      transitions: {
        continue: "TURN_A",
        flagged: "TURN_B",
        complete: "COMMIT",
      },
      maxRetries: 2,
    },

    // --- Wrap up ---
    COMMIT: {
      type: "action",
      commands: ["git add -A", "git commit -m 'TDD cycle complete'"],
      gate: command({
        verify: { command: "git status --porcelain", expectExitCode: 0 },
      }),
      transitions: { pass: "CYCLE_COMPLETE", fail: "ESCALATE" },
    },
    CYCLE_COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
