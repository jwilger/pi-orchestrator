import fs from "node:fs";
import path from "node:path";
import { type ProjectConfig, defaultProjectConfig } from "./config";

const toLiteral = (value: unknown): string => JSON.stringify(value, null, 2);

const buildTemplate = (config: ProjectConfig): string => {
  const team = config.team.length > 0 ? toLiteral(config.team) : "[]";
  return `export default {
  name: ${toLiteral(config.name)},
  flavor: ${toLiteral(config.flavor)},
  testRunner: ${toLiteral(config.testRunner)},
  buildCommand: ${toLiteral(config.buildCommand)},
  lintCommand: ${toLiteral(config.lintCommand)},
  formatCheck: ${toLiteral(config.formatCheck)},
  mutationTool: ${toLiteral(config.mutationTool)},
  ciProvider: ${toLiteral(config.ciProvider)},
  testDir: ${toLiteral(config.testDir)},
  srcDir: ${toLiteral(config.srcDir)},
  typeDir: ${toLiteral(config.typeDir)},
  team: ${team},
  autonomyLevel: ${toLiteral(config.autonomyLevel)},
  humanReviewCadence: ${toLiteral(config.humanReviewCadence)},
  reworkBudget: ${config.reworkBudget},
};
`;
};

export interface ProjectBootstrapOptions {
  force?: boolean;
  overrides?: Partial<ProjectConfig>;
}

export interface ProjectBootstrapResult {
  file: string;
  created: boolean;
  overwritten: boolean;
  skipped: boolean;
  reason?: string;
}

const loadPackageName = (cwd: string): string | undefined => {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      name?: unknown;
    };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
};

export const bootstrapProjectConfig = (
  cwd: string,
  options: ProjectBootstrapOptions = {},
): ProjectBootstrapResult => {
  const file = path.join(cwd, ".orchestra", "project.ts");
  const exists = fs.existsSync(file);

  if (exists && !options.force) {
    return {
      file,
      created: false,
      overwritten: false,
      skipped: true,
      reason: "project.ts already exists (use force to overwrite)",
    };
  }

  const packageName = loadPackageName(cwd);
  const merged: ProjectConfig = {
    ...defaultProjectConfig,
    ...(packageName ? { name: packageName } : {}),
    ...(options.overrides ?? {}),
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildTemplate(merged), "utf8");

  return {
    file,
    created: !exists,
    overwritten: exists,
    skipped: false,
  };
};
