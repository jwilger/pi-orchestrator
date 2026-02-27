import { defineWorkflow, verdict } from "../../src/core/workflow-definition";

/**
 * Self-hosted workflow for implementing the Orchestra control panel in slices.
 *
 * Canonical slice definitions live in docs/SLICES.md.
 */
export default defineWorkflow({
  name: "orchestra-self-host-panel",
  description:
    "Execute control-panel delivery via strict ping-pong TDD slices",
  initialState: "SLICE_1_PLAN",
  params: {
    objective: { type: "string", required: true },
  },
  roles: {
    facilitator: {
      agent: "facilitator",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
    tdd_red: {
      agent: "tdd-red",
      tools: ["read", "bash", "edit", "write"],
      fileScope: { writable: ["tests/**"], readable: ["**"] },
    },
    tdd_green: {
      agent: "tdd-green",
      tools: ["read", "bash", "edit", "write"],
      fileScope: { writable: ["src/**", "README.md", "docs/**"], readable: ["**"] },
    },
    reviewer: {
      agent: "reviewer",
      tools: ["read", "bash"],
      fileScope: { writable: [], readable: ["**"] },
    },
  },
  states: {
    SLICE_1_PLAN: {
      assign: "facilitator",
      gate: verdict({ options: ["ready", "rework", "escalate"] }),
      transitions: {
        ready: "SLICE_1_RED",
        rework: "SLICE_1_PLAN",
        escalate: "ESCALATE",
      },
    },
    SLICE_1_RED: {
      assign: "tdd_red",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_1_GREEN",
        rework: "SLICE_1_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_1_GREEN: {
      assign: "tdd_green",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_1_REVIEW",
        rework: "SLICE_1_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_1_REVIEW: {
      assign: "reviewer",
      gate: verdict({ options: ["approved", "changes", "escalate"] }),
      transitions: {
        approved: "SLICE_2_RED",
        changes: "SLICE_1_RED",
        escalate: "ESCALATE",
      },
    },

    SLICE_2_RED: {
      assign: "tdd_red",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_2_GREEN",
        rework: "SLICE_2_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_2_GREEN: {
      assign: "tdd_green",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_2_REVIEW",
        rework: "SLICE_2_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_2_REVIEW: {
      assign: "reviewer",
      gate: verdict({ options: ["approved", "changes", "escalate"] }),
      transitions: {
        approved: "SLICE_3_RED",
        changes: "SLICE_2_RED",
        escalate: "ESCALATE",
      },
    },

    SLICE_3_RED: {
      assign: "tdd_red",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_3_GREEN",
        rework: "SLICE_3_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_3_GREEN: {
      assign: "tdd_green",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_3_REVIEW",
        rework: "SLICE_3_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_3_REVIEW: {
      assign: "reviewer",
      gate: verdict({ options: ["approved", "changes", "escalate"] }),
      transitions: {
        approved: "SLICE_4_RED",
        changes: "SLICE_3_RED",
        escalate: "ESCALATE",
      },
    },

    SLICE_4_RED: {
      assign: "tdd_red",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_4_GREEN",
        rework: "SLICE_4_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_4_GREEN: {
      assign: "tdd_green",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_4_REVIEW",
        rework: "SLICE_4_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_4_REVIEW: {
      assign: "reviewer",
      gate: verdict({ options: ["approved", "changes", "escalate"] }),
      transitions: {
        approved: "SLICE_5_RED",
        changes: "SLICE_4_RED",
        escalate: "ESCALATE",
      },
    },

    SLICE_5_RED: {
      assign: "tdd_red",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_5_GREEN",
        rework: "SLICE_5_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_5_GREEN: {
      assign: "tdd_green",
      gate: verdict({ options: ["done", "rework", "escalate"] }),
      transitions: {
        done: "SLICE_5_REVIEW",
        rework: "SLICE_5_RED",
        escalate: "ESCALATE",
      },
    },
    SLICE_5_REVIEW: {
      assign: "reviewer",
      gate: verdict({ options: ["approved", "changes", "escalate"] }),
      transitions: {
        approved: "COMPLETE",
        changes: "SLICE_5_RED",
        escalate: "ESCALATE",
      },
    },

    COMPLETE: { type: "terminal", result: "success" },
    ESCALATE: { type: "terminal", result: "failure", action: "notify_human" },
  },
});
