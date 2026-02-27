import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapProjectConfig } from "../src/project/bootstrap";

describe("project bootstrap", () => {
  it("creates .orchestra/project.ts from defaults and package name", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-bootstrap-"));
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "demo-project" }),
      "utf8",
    );

    const result = bootstrapProjectConfig(cwd);
    expect(result.created).toBe(true);
    expect(result.overwritten).toBe(false);
    expect(result.skipped).toBe(false);

    const target = path.join(cwd, ".orchestra", "project.ts");
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, "utf8");
    expect(content).toContain('name: "demo-project"');
    expect(content).toContain('flavor: "traditional-prd"');
  });

  it("skips when file exists unless force is true", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-bootstrap-"));
    const target = path.join(cwd, ".orchestra", "project.ts");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export default { name: 'existing' };\n", "utf8");

    const skipped = bootstrapProjectConfig(cwd);
    expect(skipped.skipped).toBe(true);

    const forced = bootstrapProjectConfig(cwd, {
      force: true,
      overrides: { name: "forced", flavor: "event-modeled" },
    });
    expect(forced.overwritten).toBe(true);

    const content = fs.readFileSync(target, "utf8");
    expect(content).toContain('name: "forced"');
    expect(content).toContain('flavor: "event-modeled"');
  });
});
