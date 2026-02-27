import fs from "node:fs";
import path from "node:path";

export interface TuningSample {
  model: string;
  role: string;
  phase: string;
  quality: number;
  cost_usd: number;
  latency_ms: number;
  retries: number;
  created_at: string;
}

export interface TuningRecommendation {
  role: string;
  phase: string;
  current_model: string;
  recommended_model: string;
  rationale: string;
}

export interface TuningExperiment {
  id: string;
  role: string;
  phase: string;
  baseline_model: string;
  challenger_model: string;
  status: "pending" | "complete";
  created_at: string;
  completed_at?: string;
  decision?: "promote_challenger" | "rollback_to_baseline" | "keep_baseline";
  rationale?: string;
  metrics?: {
    baseline_score: number;
    challenger_score: number;
    delta: number;
    baseline_samples: number;
    challenger_samples: number;
  };
}

export interface TuningAssignment {
  role: string;
  phase: string;
  model: string;
  reason: string;
  updated_at: string;
}

export interface ExperimentPolicy {
  minSamplesPerModel: number;
  rollbackDeltaThreshold: number;
  costWeight: number;
  latencyWeight: number;
  retryWeight: number;
}

const defaultPolicy: ExperimentPolicy = {
  minSamplesPerModel: 3,
  rollbackDeltaThreshold: 0.02,
  costWeight: 0.1,
  latencyWeight: 0.02,
  retryWeight: 0.05,
};

export class ModelTuner {
  constructor(private readonly tuningDir: string) {}

  private metricsPath(): string {
    return path.join(this.tuningDir, "metrics.json");
  }

  private recommendationsPath(): string {
    return path.join(this.tuningDir, "recommendations.json");
  }

  private experimentsPath(): string {
    return path.join(this.tuningDir, "experiments.json");
  }

  private assignmentsPath(): string {
    return path.join(this.tuningDir, "assignments.json");
  }

  ensure(): void {
    fs.mkdirSync(this.tuningDir, { recursive: true });
    if (!fs.existsSync(this.metricsPath())) {
      fs.writeFileSync(this.metricsPath(), "[]");
    }
    if (!fs.existsSync(this.recommendationsPath())) {
      fs.writeFileSync(this.recommendationsPath(), "[]");
    }
    if (!fs.existsSync(this.experimentsPath())) {
      fs.writeFileSync(this.experimentsPath(), "[]");
    }
    if (!fs.existsSync(this.assignmentsPath())) {
      fs.writeFileSync(this.assignmentsPath(), "[]");
    }
  }

  listSamples(): TuningSample[] {
    this.ensure();
    return JSON.parse(
      fs.readFileSync(this.metricsPath(), "utf8"),
    ) as TuningSample[];
  }

  recordSample(input: Omit<TuningSample, "created_at">): TuningSample {
    const sample: TuningSample = {
      ...input,
      created_at: new Date().toISOString(),
    };
    const samples = this.listSamples();
    samples.push(sample);
    fs.writeFileSync(this.metricsPath(), JSON.stringify(samples, null, 2));
    return sample;
  }

  summarizeByRolePhase(): Array<{
    role: string;
    phase: string;
    sample_count: number;
    avg_quality: number;
    avg_cost_usd: number;
    avg_latency_ms: number;
    avg_retries: number;
    model_counts: Record<string, number>;
  }> {
    const samples = this.listSamples();
    const grouped = new Map<string, TuningSample[]>();

    for (const sample of samples) {
      const key = `${sample.role}::${sample.phase}`;
      const list = grouped.get(key) ?? [];
      list.push(sample);
      grouped.set(key, list);
    }

    return [...grouped.entries()].map(([key, entries]) => {
      const [role, phase] = key.split("::");
      const totalQuality = entries.reduce((sum, s) => sum + s.quality, 0);
      const totalCost = entries.reduce((sum, s) => sum + s.cost_usd, 0);
      const totalLatency = entries.reduce((sum, s) => sum + s.latency_ms, 0);
      const totalRetries = entries.reduce((sum, s) => sum + s.retries, 0);
      const modelCounts: Record<string, number> = {};
      for (const entry of entries) {
        modelCounts[entry.model] = (modelCounts[entry.model] ?? 0) + 1;
      }

      return {
        role: role ?? "",
        phase: phase ?? "",
        sample_count: entries.length,
        avg_quality: totalQuality / entries.length,
        avg_cost_usd: totalCost / entries.length,
        avg_latency_ms: totalLatency / entries.length,
        avg_retries: totalRetries / entries.length,
        model_counts: modelCounts,
      };
    });
  }

  generateRecommendations(minSamples = 3): TuningRecommendation[] {
    const summaries = this.summarizeByRolePhase();
    const recommendations: TuningRecommendation[] = [];

    for (const summary of summaries) {
      if (summary.sample_count < minSamples) {
        continue;
      }

      const modelEntries = Object.entries(summary.model_counts).sort(
        (a, b) => b[1] - a[1],
      );
      const currentModel = modelEntries[0]?.[0];
      if (!currentModel) {
        continue;
      }

      if (summary.avg_quality < 0.8 && currentModel.includes("haiku")) {
        recommendations.push({
          role: summary.role,
          phase: summary.phase,
          current_model: currentModel,
          recommended_model: "claude-sonnet-4",
          rationale:
            "Average quality is below target; recommend a stronger reasoning model.",
        });
        continue;
      }

      if (summary.avg_quality > 0.95 && summary.avg_retries <= 0.5) {
        recommendations.push({
          role: summary.role,
          phase: summary.phase,
          current_model: currentModel,
          recommended_model: currentModel,
          rationale:
            "Current model is performing well; keep assignment unchanged.",
        });
      }
    }

    fs.writeFileSync(
      this.recommendationsPath(),
      JSON.stringify(recommendations, null, 2),
    );
    return recommendations;
  }

  listRecommendations(): TuningRecommendation[] {
    this.ensure();
    return JSON.parse(
      fs.readFileSync(this.recommendationsPath(), "utf8"),
    ) as TuningRecommendation[];
  }

  listExperiments(): TuningExperiment[] {
    this.ensure();
    return JSON.parse(
      fs.readFileSync(this.experimentsPath(), "utf8"),
    ) as TuningExperiment[];
  }

  createExperiment(input: {
    role: string;
    phase: string;
    baseline_model: string;
    challenger_model: string;
  }): TuningExperiment {
    const experiments = this.listExperiments();
    const experiment: TuningExperiment = {
      id: `exp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      role: input.role,
      phase: input.phase,
      baseline_model: input.baseline_model,
      challenger_model: input.challenger_model,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    experiments.push(experiment);
    fs.writeFileSync(
      this.experimentsPath(),
      JSON.stringify(experiments, null, 2),
    );
    return experiment;
  }

  createExperimentsFromRecommendations(): TuningExperiment[] {
    const recommendations = this.listRecommendations();
    const created: TuningExperiment[] = [];

    for (const rec of recommendations) {
      if (rec.current_model === rec.recommended_model) {
        continue;
      }

      const existing = this.listExperiments().find(
        (exp) =>
          exp.status === "pending" &&
          exp.role === rec.role &&
          exp.phase === rec.phase &&
          exp.baseline_model === rec.current_model &&
          exp.challenger_model === rec.recommended_model,
      );
      if (existing) {
        continue;
      }

      created.push(
        this.createExperiment({
          role: rec.role,
          phase: rec.phase,
          baseline_model: rec.current_model,
          challenger_model: rec.recommended_model,
        }),
      );
    }

    return created;
  }

  listAssignments(): TuningAssignment[] {
    this.ensure();
    return JSON.parse(
      fs.readFileSync(this.assignmentsPath(), "utf8"),
    ) as TuningAssignment[];
  }

  private upsertAssignment(assignment: TuningAssignment): void {
    const assignments = this.listAssignments();
    const index = assignments.findIndex(
      (entry) =>
        entry.role === assignment.role && entry.phase === assignment.phase,
    );

    if (index >= 0) {
      assignments[index] = assignment;
    } else {
      assignments.push(assignment);
    }

    fs.writeFileSync(
      this.assignmentsPath(),
      JSON.stringify(assignments, null, 2),
    );
  }

  private scoreModel(
    role: string,
    phase: string,
    model: string,
    policy: ExperimentPolicy,
  ): { score: number; sampleCount: number } {
    const samples = this.listSamples().filter(
      (sample) =>
        sample.role === role &&
        sample.phase === phase &&
        sample.model === model,
    );

    if (samples.length === 0) {
      return { score: 0, sampleCount: 0 };
    }

    const avgQuality =
      samples.reduce((sum, sample) => sum + sample.quality, 0) / samples.length;
    const avgCost =
      samples.reduce((sum, sample) => sum + sample.cost_usd, 0) /
      samples.length;
    const avgLatency =
      samples.reduce((sum, sample) => sum + sample.latency_ms, 0) /
      samples.length;
    const avgRetries =
      samples.reduce((sum, sample) => sum + sample.retries, 0) / samples.length;

    const score =
      avgQuality -
      avgCost * policy.costWeight -
      (avgLatency / 1000) * policy.latencyWeight -
      avgRetries * policy.retryWeight;

    return { score, sampleCount: samples.length };
  }

  runExperiments(customPolicy: Partial<ExperimentPolicy> = {}): {
    completed: TuningExperiment[];
    pending: TuningExperiment[];
    assignments: TuningAssignment[];
  } {
    const policy: ExperimentPolicy = {
      ...defaultPolicy,
      ...customPolicy,
    };

    const experiments = this.listExperiments();
    const completed: TuningExperiment[] = [];
    const pending: TuningExperiment[] = [];

    for (const experiment of experiments) {
      if (experiment.status !== "pending") {
        continue;
      }

      const baseline = this.scoreModel(
        experiment.role,
        experiment.phase,
        experiment.baseline_model,
        policy,
      );
      const challenger = this.scoreModel(
        experiment.role,
        experiment.phase,
        experiment.challenger_model,
        policy,
      );

      if (
        baseline.sampleCount < policy.minSamplesPerModel ||
        challenger.sampleCount < policy.minSamplesPerModel
      ) {
        pending.push(experiment);
        continue;
      }

      const delta = challenger.score - baseline.score;
      let decision: TuningExperiment["decision"] = "keep_baseline";
      let selectedModel = experiment.baseline_model;
      let rationale =
        "Performance delta is within guardrails; keep baseline assignment.";

      if (delta > policy.rollbackDeltaThreshold) {
        decision = "promote_challenger";
        selectedModel = experiment.challenger_model;
        rationale =
          "Challenger outperformed baseline beyond threshold; promote challenger.";
      } else if (delta < -policy.rollbackDeltaThreshold) {
        decision = "rollback_to_baseline";
        selectedModel = experiment.baseline_model;
        rationale =
          "Challenger underperformed baseline beyond rollback threshold; rollback.";
      }

      experiment.status = "complete";
      experiment.completed_at = new Date().toISOString();
      experiment.decision = decision;
      experiment.rationale = rationale;
      experiment.metrics = {
        baseline_score: baseline.score,
        challenger_score: challenger.score,
        delta,
        baseline_samples: baseline.sampleCount,
        challenger_samples: challenger.sampleCount,
      };

      this.upsertAssignment({
        role: experiment.role,
        phase: experiment.phase,
        model: selectedModel,
        reason: `${decision}: ${rationale}`,
        updated_at: experiment.completed_at,
      });

      completed.push(experiment);
    }

    fs.writeFileSync(
      this.experimentsPath(),
      JSON.stringify(experiments, null, 2),
    );

    return {
      completed,
      pending,
      assignments: this.listAssignments(),
    };
  }
}
