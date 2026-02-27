import { describe, expect, it } from "vitest";
import consensusDecision from "../src/workflows/consensus-decision";
import discovery from "../src/workflows/discovery";
import eventModeling from "../src/workflows/event-modeling";
import exploratoryQa from "../src/workflows/exploratory-qa";
import pipeline from "../src/workflows/pipeline";
import prd from "../src/workflows/prd";
import retro from "../src/workflows/retro";
import tddPingPong from "../src/workflows/tdd-ping-pong";
import threeStageReview from "../src/workflows/three-stage-review";

describe("workflow library", () => {
  it("exports core workflow definitions", () => {
    const names = [
      consensusDecision.name,
      tddPingPong.name,
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
});
