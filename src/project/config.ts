import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

export interface ProjectConfig {
  name: string;
  flavor: "event-modeled" | "traditional-prd";
  testRunner: string;
  buildCommand: string;
  lintCommand: string;
  formatCheck: string;
  mutationTool: string;
  ciProvider: string;
  testDir: string;
  srcDir: string;
  typeDir: string;
  team: Array<{ role: string; persona: string }>;
  autonomyLevel: "full" | "assisted" | "manual";
  humanReviewCadence: "every-slice" | "every-n" | "end";
  reworkBudget: number;
}

const defaultProjectConfig: ProjectConfig = {
  name: "unknown-project",
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
  team: [],
  autonomyLevel: "full",
  humanReviewCadence: "end",
  reworkBudget: 5,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeProjectConfig = (parsed: unknown): ProjectConfig => {
  if (!isRecord(parsed)) {
    return defaultProjectConfig;
  }

  return {
    ...defaultProjectConfig,
    ...parsed,
    team: Array.isArray(parsed.team)
      ? parsed.team.filter(
          (entry): entry is { role: string; persona: string } =>
            isRecord(entry) &&
            typeof entry.role === "string" &&
            typeof entry.persona === "string",
        )
      : defaultProjectConfig.team,
  };
};

export const loadProjectConfig = (cwd: string): ProjectConfig => {
  const jsOrTsPath = path.join(cwd, ".orchestra", "project.ts");
  if (fs.existsSync(jsOrTsPath)) {
    try {
      const jiti = createJiti(import.meta.url);
      const loaded = jiti(jsOrTsPath) as { default?: unknown } | unknown;
      const parsed =
        typeof loaded === "object" && loaded && "default" in loaded
          ? ((loaded as { default?: unknown }).default ?? loaded)
          : loaded;
      return normalizeProjectConfig(parsed);
    } catch {
      return defaultProjectConfig;
    }
  }

  const jsonPath = path.join(cwd, ".orchestra", "project.json");
  if (!fs.existsSync(jsonPath)) {
    return defaultProjectConfig;
  }

  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as unknown;
  return normalizeProjectConfig(parsed);
};
