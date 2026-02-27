import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RetroProposalApplier } from "../src/retro/proposal-applier";

describe("RetroProposalApplier", () => {
  it("loads proposals and applies file operations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-retro-"));
    const applier = new RetroProposalApplier(root);

    const proposalsPath = path.join(
      root,
      ".orchestra",
      "retro",
      "wf-1",
      "proposals.json",
    );
    fs.mkdirSync(path.dirname(proposalsPath), { recursive: true });
    fs.writeFileSync(
      proposalsPath,
      JSON.stringify([
        {
          id: "p1",
          action: "write_file",
          target: "docs/one.md",
          content: "hello",
        },
        {
          id: "p2",
          action: "append_file",
          target: "docs/one.md",
          content: " world",
        },
        {
          id: 123,
          action: "nope",
          target: false,
        },
      ]),
    );

    const proposals = applier.loadProposals(proposalsPath);
    const results = applier.applyProposals(proposals, false);

    expect(proposals).toHaveLength(2);
    expect(results.every((result) => result.applied)).toBe(true);
    expect(fs.readFileSync(path.join(root, "docs", "one.md"), "utf8")).toBe(
      "hello world",
    );

    expect(applier.listProposalFiles("wf-1")).toHaveLength(1);
    expect(applier.loadLatestProposals("wf-1")).toHaveLength(2);
    const loaded = applier.loadLatestProposalsWithSource("wf-1");
    expect(loaded.source).toContain("wf-1");
    expect(loaded.proposals).toHaveLength(2);
  });

  it("handles replace and dry-run semantics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-retro-"));
    const applier = new RetroProposalApplier(root);
    const target = path.join(root, "docs", "target.md");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "alpha beta");

    const dryRun = applier.applyProposals(
      [
        {
          id: "replace",
          action: "replace_in_file",
          target: "docs/target.md",
          oldText: "beta",
          newText: "gamma",
        },
      ],
      true,
    );
    expect(dryRun[0]?.applied).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("alpha beta");

    const applied = applier.applyProposals(
      [
        {
          id: "replace",
          action: "replace_in_file",
          target: "docs/target.md",
          oldText: "beta",
          newText: "gamma",
        },
      ],
      false,
    );
    expect(applied[0]?.applied).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("alpha gamma");

    const traversal = applier.applyProposals(
      [
        {
          id: "bad",
          action: "write_file",
          target: "../escape.txt",
          content: "x",
        },
      ],
      false,
    );
    expect(traversal[0]?.applied).toBe(false);
    expect(traversal[0]?.message).toContain("project-relative");
  });
});
