import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { describe, expect, it } from "vitest";

describe("orchestra self-hosting slice plan", () => {
  it("tracks canonical slice backlog in docs/SLICES.md", () => {
    const file = path.join(process.cwd(), "docs", "SLICES.md");
    expect(fs.existsSync(file)).toBe(true);

    const text = fs.readFileSync(file, "utf8");
    expect(text.includes("S1")).toBe(true);
    expect(text.includes("S2")).toBe(true);
    expect(text.includes("S3")).toBe(true);
    expect(text.includes("S4")).toBe(true);
    expect(text.includes("S5")).toBe(true);
    expect(text.includes("orchestra-self-host-panel")).toBe(true);
  });

  it("defines executable project workflow for the slice backlog", async () => {
    const workflowPath = path.join(
      process.cwd(),
      ".orchestra",
      "workflows.d",
      "orchestra-self-host-panel.ts",
    );
    expect(fs.existsSync(workflowPath)).toBe(true);

    const jiti = createJiti(import.meta.url);
    const loaded = (await jiti.import(workflowPath)) as {
      default?: {
        name: string;
        states: Record<string, unknown>;
      };
      name?: string;
      states?: Record<string, unknown>;
    };

    const workflow =
      typeof loaded === "object" && loaded && "default" in loaded
        ? (loaded.default ?? loaded)
        : loaded;

    expect(workflow.name).toBe("orchestra-self-host-panel");
    expect(workflow.states).toBeDefined();
    const stateKeys = Object.keys(workflow.states ?? {});
    expect(stateKeys).toContain("SLICE_1_PLAN");
    expect(stateKeys).toContain("SLICE_5_REVIEW");
    expect(stateKeys).toContain("COMPLETE");
  });
});
