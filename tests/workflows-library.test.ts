import { describe, expect, it } from "vitest";
import consensusDecision from "../src/workflows/consensus-decision";
import discovery from "../src/workflows/discovery";
import eventModeling from "../src/workflows/event-modeling";
import exploratoryQa from "../src/workflows/exploratory-qa";
import pipeline from "../src/workflows/pipeline";
import prd from "../src/workflows/prd";
import retro from "../src/workflows/retro";
import tddPingPong from "../src/workflows/tdd-ping-pong";
import tddTurn from "../src/workflows/tdd-turn";
import threeStageReview from "../src/workflows/three-stage-review";

describe("workflow library", () => {
  it("exports core workflow definitions", () => {
    const names = [
      consensusDecision.name,
      tddPingPong.name,
      tddTurn.name,
      threeStageReview.name,
      pipeline.name,
      discovery.name,
      eventModeling.name,
      prd.name,
      exploratoryQa.name,
      retro.name,
    ];

    expect(names).toEqual([
      "consensus-decision",
      "tdd-ping-pong",
      "tdd-turn",
      "three-stage-review",
      "pipeline",
      "discovery",
      "event-modeling",
      "prd",
      "exploratory-qa",
      "retro",
    ]);
  });

  it("includes expected terminal states for long-lifecycle workflows", () => {
    expect(Object.keys(pipeline.states)).toContain("DONE");
    expect(Object.keys(exploratoryQa.states)).toContain("PASS");
    expect(Object.keys(retro.states)).toContain("APPLY");
    expect(Object.keys(discovery.states)).toContain("COMPLETE");
    expect(Object.keys(eventModeling.states)).toContain("COMPLETE");
    expect(Object.keys(prd.states)).toContain("COMPLETE");
  });

  it("tdd-ping-pong composes tdd-turn subworkflows", () => {
    const turnA = tddPingPong.states.TURN_A;
    const turnB = tddPingPong.states.TURN_B;
    expect(turnA).toMatchObject({ type: "subworkflow", workflow: "tdd-turn" });
    expect(turnB).toMatchObject({ type: "subworkflow", workflow: "tdd-turn" });

    // Personas come from params, not hardcoded
    expect(tddPingPong.params?.persona_a).toMatchObject({ required: true });
    expect(tddPingPong.params?.persona_b).toMatchObject({ required: true });
  });

  it("tdd-turn roles inherit persona from params via personaFrom", () => {
    for (const roleName of ["triage", "red", "green"]) {
      const role = tddTurn.roles[roleName];
      expect(role).toBeDefined();
      expect(role?.personaFrom).toBe("turn_persona");
    }
  });
});
