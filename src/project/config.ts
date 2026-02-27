import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

export interface TeamMember {
  role: string;
  persona: string;
  tags?: string[];
}

/**
 * Partial overrides for a workflow role definition. Merged over the
 * workflow's built-in role at dispatch time. Every field is optional —
 * only the fields you set will override the default.
 */
export interface RoleOverride {
  agent?: string;
  persona?: string;
  personaPool?: string[];
  personaTags?: string[];
  personaFrom?: string;
  tools?: string[];
  fileScope?: {
    writable?: string[];
    readable?: string[];
  };
}

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
  team: TeamMember[];
  /**
   * Per-role overrides, keyed by workflow role name (e.g. "ping", "pong",
   * "domain_reviewer", "pipeline_agent"). Applied to any workflow that
   * uses a role with that name.
   */
  roles?: Record<string, RoleOverride>;
  autonomyLevel: "full" | "assisted" | "manual";
  humanReviewCadence: "every-slice" | "every-n" | "end";
  reworkBudget: number;
}

export const defaultProjectConfig: ProjectConfig = {
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
  roles: {},
  autonomyLevel: "full",
  humanReviewCadence: "end",
  reworkBudget: 5,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeTeamMember = (entry: unknown): TeamMember | null => {
  if (!isRecord(entry)) return null;
  if (typeof entry.role !== "string" || typeof entry.persona !== "string")
    return null;
  return {
    role: entry.role,
    persona: entry.persona,
    ...(Array.isArray(entry.tags) &&
    entry.tags.every((t: unknown) => typeof t === "string")
      ? { tags: entry.tags as string[] }
      : {}),
  };
};

const normalizeRoles = (
  raw: unknown,
): Record<string, RoleOverride> | undefined => {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, RoleOverride> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const override: RoleOverride = {};
    if (typeof value.agent === "string") override.agent = value.agent;
    if (typeof value.persona === "string") override.persona = value.persona;
    if (typeof value.personaFrom === "string")
      override.personaFrom = value.personaFrom;
    if (
      Array.isArray(value.personaPool) &&
      value.personaPool.every((v: unknown) => typeof v === "string")
    )
      override.personaPool = value.personaPool as string[];
    if (
      Array.isArray(value.personaTags) &&
      value.personaTags.every((v: unknown) => typeof v === "string")
    )
      override.personaTags = value.personaTags as string[];
    if (
      Array.isArray(value.tools) &&
      value.tools.every((v: unknown) => typeof v === "string")
    )
      override.tools = value.tools as string[];
    if (isRecord(value.fileScope)) {
      const fs: RoleOverride["fileScope"] = {};
      if (
        Array.isArray(value.fileScope.writable) &&
        value.fileScope.writable.every((v: unknown) => typeof v === "string")
      )
        fs.writable = value.fileScope.writable as string[];
      if (
        Array.isArray(value.fileScope.readable) &&
        value.fileScope.readable.every((v: unknown) => typeof v === "string")
      )
        fs.readable = value.fileScope.readable as string[];
      if (fs.writable || fs.readable) override.fileScope = fs;
    }
    if (Object.keys(override).length > 0) result[key] = override;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const normalizeProjectConfig = (parsed: unknown): ProjectConfig => {
  if (!isRecord(parsed)) {
    return defaultProjectConfig;
  }

  return {
    ...defaultProjectConfig,
    ...parsed,
    team: Array.isArray(parsed.team)
      ? parsed.team
          .map(normalizeTeamMember)
          .filter((m): m is TeamMember => m !== null)
      : defaultProjectConfig.team,
    roles: normalizeRoles(parsed.roles) ?? defaultProjectConfig.roles ?? {},
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
