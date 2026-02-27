import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelTuner } from "../src/tuning/model-tuner";

describe("ModelTuner", () => {
  it("records and summarizes samples", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-tuner-"));
    const tuner = new ModelTuner(path.join(root, ".orchestra", "tuning"));

    tuner.ensure();
    tuner.recordSample({
      model: "claude-haiku-4",
      role: "ping",
      phase: "RED",
      quality: 0.7,
      cost_usd: 0.01,
      latency_ms: 500,
      retries: 2,
    });
    tuner.recordSample({
      model: "claude-haiku-4",
      role: "ping",
      phase: "RED",
      quality: 0.9,
      cost_usd: 0.02,
      latency_ms: 700,
      retries: 1,
    });

    const summaries = tuner.summarizeByRolePhase();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.role).toBe("ping");
    expect(summaries[0]?.phase).toBe("RED");
    expect(summaries[0]?.sample_count).toBe(2);
    expect(summaries[0]?.avg_quality).toBe(0.8);
    expect(summaries[0]?.avg_retries).toBe(1.5);
    expect(summaries[0]?.model_counts["claude-haiku-4"]).toBe(2);
  });

  it("generates and persists recommendations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-tuner-"));
    const tuner = new ModelTuner(path.join(root, ".orchestra", "tuning"));

    tuner.ensure();
    for (const quality of [0.6, 0.7, 0.75]) {
      tuner.recordSample({
        model: "claude-haiku-4",
        role: "domain_reviewer",
        phase: "DOMAIN_REVIEW",
        quality,
        cost_usd: 0.03,
        latency_ms: 1500,
        retries: 2,
      });
    }

    const recommendations = tuner.generateRecommendations();
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.recommended_model).toBe("claude-sonnet-4");
    expect(tuner.listRecommendations()).toEqual(recommendations);
  });
});
