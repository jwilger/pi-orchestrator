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

export class ModelTuner {
  constructor(private readonly tuningDir: string) {}

  private metricsPath(): string {
    return path.join(this.tuningDir, "metrics.json");
  }

  private recommendationsPath(): string {
    return path.join(this.tuningDir, "recommendations.json");
  }

  ensure(): void {
    fs.mkdirSync(this.tuningDir, { recursive: true });
    if (!fs.existsSync(this.metricsPath())) {
      fs.writeFileSync(this.metricsPath(), "[]");
    }
    if (!fs.existsSync(this.recommendationsPath())) {
      fs.writeFileSync(this.recommendationsPath(), "[]");
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
}
