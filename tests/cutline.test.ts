import { describe, expect, it } from "vitest";
import { buildCutlineStatus } from "../src/project/cutline";

describe("cutline status", () => {
  it("returns ship-now and deferred milestone groups", () => {
    const cutline = buildCutlineStatus();
    expect(cutline.branch).toBe("feat/prd-foundation-phase1");
    expect(cutline.shipNow.length).toBeGreaterThan(3);
    expect(cutline.deferred.length).toBeGreaterThan(0);
    expect(cutline.deferred.some((item) => item.includes("S1:"))).toBe(true);
  });
});
