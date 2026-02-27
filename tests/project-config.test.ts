import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/project/config";

describe("project config", () => {
  it("returns defaults when project config file is missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-project-"));
    const config = loadProjectConfig(cwd);

    expect(config.name).toBe("unknown-project");
    expect(config.flavor).toBe("traditional-prd");
    expect(config.team).toEqual([]);
  });

  it("loads and filters project config from .orchestra/project.json", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-project-"));
    const configPath = path.join(cwd, ".orchestra", "project.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        name: "bread-log",
        flavor: "event-modeled",
        autonomyLevel: "assisted",
        humanReviewCadence: "every-slice",
        team: [{ role: "pm", persona: ".team/pm.md" }, { nope: true }],
      }),
    );

    const config = loadProjectConfig(cwd);
    expect(config.name).toBe("bread-log");
    expect(config.flavor).toBe("event-modeled");
    expect(config.autonomyLevel).toBe("assisted");
    expect(config.humanReviewCadence).toBe("every-slice");
    expect(config.team).toEqual([{ role: "pm", persona: ".team/pm.md" }]);
  });

  it("prefers .orchestra/project.ts when present", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-project-"));
    const tsPath = path.join(cwd, ".orchestra", "project.ts");
    const jsonPath = path.join(cwd, ".orchestra", "project.json");
    fs.mkdirSync(path.dirname(tsPath), { recursive: true });

    fs.writeFileSync(
      tsPath,
      `export default {
        name: "from-ts",
        flavor: "event-modeled",
        autonomyLevel: "manual",
        team: [{ role: "architect", persona: ".team/a.md" }]
      };`,
    );
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        name: "from-json",
      }),
    );

    const config = loadProjectConfig(cwd);
    expect(config.name).toBe("from-ts");
    expect(config.flavor).toBe("event-modeled");
    expect(config.autonomyLevel).toBe("manual");
    expect(config.team).toEqual([{ role: "architect", persona: ".team/a.md" }]);
  });
});
