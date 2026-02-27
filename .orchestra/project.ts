export default {
  name: "@jwilger/pi-orchestrator",
  flavor: "traditional-prd",
  testRunner: "npm test",
  buildCommand: "npm run build",
  lintCommand: "npm run lint",
  formatCheck: "npm run lint",
  mutationTool: "npm run test:mutate",
  ciProvider: "github-actions",
  testDir: "tests/**",
  srcDir: "src/**",
  typeDir: "src/**",
  team: [
    {
      role: "orchestrator-facilitator",
      persona: ".team/orchestrator-facilitator.md",
      tags: ["facilitator", "orchestration", "planning"],
    },
    {
      role: "tdd-red-strategist",
      persona: ".team/tdd-red-strategist.md",
      tags: ["tdd", "red", "testing"],
    },
    {
      role: "tdd-green-minimalist",
      persona: ".team/tdd-green-minimalist.md",
      tags: ["tdd", "green", "implementation"],
    },
    {
      role: "domain-guardian",
      persona: ".team/domain-guardian.md",
      tags: ["domain", "review", "quality"],
    },
    {
      role: "syntax-sentinel",
      persona: ".team/syntax-sentinel.md",
      tags: ["syntax", "review", "ci"],
    },
    {
      role: "holistic-systems-reviewer",
      persona: ".team/holistic-systems-reviewer.md",
      tags: ["holistic", "review", "systems"],
    },
  ],
  roles: {
    facilitator: {
      personaTags: ["facilitator"],
    },
    triage: {
      personaTags: ["tdd", "red"],
    },
    red: {
      personaTags: ["tdd", "red"],
    },
    green: {
      personaTags: ["tdd", "green"],
    },
    domain_reviewer: {
      personaTags: ["domain", "review"],
    },
    reviewer: {
      personaTags: ["domain", "review"],
    },
    syntax_reviewer: {
      personaTags: ["syntax", "review"],
      agent: "reviewer",
    },
    holistic_reviewer: {
      personaTags: ["holistic", "review"],
      agent: "reviewer",
    },
  },
  autonomyLevel: "full",
  humanReviewCadence: "end",
  reworkBudget: 5,
};
