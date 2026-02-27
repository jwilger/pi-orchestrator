import { describe, expect, it } from "vitest";
import { buildCutlineStatus } from "../src/project/cutline";
import { buildReadinessReport } from "../src/project/readiness";

describe("readiness report", () => {
  it("reports ready when ship-now capabilities exist", () => {
    const report = buildReadinessReport(buildCutlineStatus());
    expect(report.ready).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.summary.shipNowCount).toBeGreaterThan(0);
    expect(report.summary.requiredChecks).toContain("mutation");
  });
});
