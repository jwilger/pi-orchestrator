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

  it("runs A/B experiments and applies rollback decision policy", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-tuner-"));
    const tuner = new ModelTuner(path.join(root, ".orchestra", "tuning"));

    tuner.ensure();

    for (const quality of [0.92, 0.91, 0.9]) {
      tuner.recordSample({
        model: "claude-sonnet-4",
        role: "qa_analyst",
        phase: "QA",
        quality,
        cost_usd: 0.05,
        latency_ms: 800,
        retries: 0,
      });
    }

    for (const quality of [0.7, 0.68, 0.65]) {
      tuner.recordSample({
        model: "claude-haiku-4",
        role: "qa_analyst",
        phase: "QA",
        quality,
        cost_usd: 0.02,
        latency_ms: 550,
        retries: 1,
      });
    }

    tuner.createExperiment({
      role: "qa_analyst",
      phase: "QA",
      baseline_model: "claude-sonnet-4",
      challenger_model: "claude-haiku-4",
    });

    const run = tuner.runExperiments();
    expect(run.completed).toHaveLength(1);
    expect(run.completed[0]?.decision).toBe("rollback_to_baseline");
    expect(run.assignments).toEqual([
      expect.objectContaining({
        role: "qa_analyst",
        phase: "QA",
        model: "claude-sonnet-4",
      }),
    ]);
  });

  it("creates pending A/B experiments from recommendations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-tuner-"));
    const tuner = new ModelTuner(path.join(root, ".orchestra", "tuning"));

    tuner.ensure();
    for (const quality of [0.6, 0.62, 0.64]) {
      tuner.recordSample({
        model: "claude-haiku-4",
        role: "reviewer",
        phase: "REVIEW",
        quality,
        cost_usd: 0.02,
        latency_ms: 600,
        retries: 2,
      });
    }

    tuner.generateRecommendations();
    const created = tuner.createExperimentsFromRecommendations();

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      role: "reviewer",
      phase: "REVIEW",
      baseline_model: "claude-haiku-4",
      challenger_model: "claude-sonnet-4",
      status: "pending",
    });
  });
});
