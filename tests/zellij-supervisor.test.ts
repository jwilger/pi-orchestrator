import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  ZellijSupervisor,
  parsePaneInfos,
  parseTabInfos,
} from "../src/runtime/zellij-supervisor";

describe("zellij-supervisor helpers", () => {
  it("parses pane info from dump-layout output", () => {
    const layout = `layout {
  pane id="1" name="conductor"
  pane id="2" name="agent-red"
  pane id="3"
}`;

    expect(parsePaneInfos(layout)).toEqual([
      { id: "1", name: "conductor" },
      { id: "2", name: "agent-red" },
      { id: "3", name: undefined },
    ]);
  });

  it("parses panes when ids are omitted or attributes use kdl style", () => {
    const layout = `layout {
  pane split_size="50%" name "orchestra-keepalive"
  pane split_size="50%" {
    name "agent-red"
  }
}`;

    const panes = parsePaneInfos(layout);
    expect(panes.length).toBeGreaterThan(0);
    expect(panes.some((pane) => pane.name === "orchestra-keepalive")).toBe(
      true,
    );
  });

  it("parses tab names for current-session all-tab listing", () => {
    const tabs = parseTabInfos("Tab #1\nagent-red\nagent-green");
    expect(tabs).toEqual([
      { id: "tab-1", name: "Tab #1" },
      { id: "tab-2", name: "agent-red" },
      { id: "tab-3", name: "agent-green" },
    ]);
  });
});

describe("ZellijSupervisor", () => {
  it("spawns panes through zellij action new-pane", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const pi = {
      exec: async (bin: string, args: string[]) => {
        calls.push({ bin, args });
        if (args.includes("dump-layout")) {
          return {
            code: 0,
            stdout: 'pane id="44" name="agent-green"',
            stderr: "",
            killed: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;

    const supervisor = new ZellijSupervisor(pi);
    const result = await supervisor.spawnPane({
      name: "agent-green",
      cwd: "/tmp/project",
      command: ["pi", "--mode", "json"],
    });

    expect(result.ok).toBe(true);
    expect(result.paneId).toBe("44");
    expect(calls[0]?.bin).toBe("zellij");
    expect(calls[0]?.args).toContain("new-pane");
    expect(calls[0]?.args).toContain("agent-green");
  });

  it("lists current-session tabs via query-tab-names", async () => {
    const pi = {
      exec: async (_bin: string, args: string[]) => {
        if (args.includes("query-tab-names")) {
          return {
            code: 0,
            stdout: "orchestra-keepalive\nagent-review",
            stderr: "",
            killed: false,
          };
        }

        return {
          code: 1,
          stdout: "",
          stderr: "",
          killed: false,
        };
      },
    } as unknown as ExtensionAPI;

    const supervisor = new ZellijSupervisor(pi);
    const panes = await supervisor.listPanes();

    expect(panes).toEqual([
      { id: "tab-1", name: "orchestra-keepalive" },
      { id: "tab-2", name: "agent-review" },
    ]);
    expect(supervisor.getTrackedPaneIds()).toEqual({
      "orchestra-keepalive": "tab-1",
      "agent-review": "tab-2",
    });
  });

  it("reconciles missing panes and tracks id changes", async () => {
    const dumps = [
      'pane id="1" name="agent-red"',
      'pane id="1" name="agent-red"\npane id="2" name="agent-green"',
      'pane id="1" name="agent-red"\npane id="2" name="agent-green"',
      'pane id="9" name="agent-red"\npane id="2" name="agent-green"',
      'pane id="9" name="agent-red"\npane id="2" name="agent-green"',
    ];

    const pi = {
      exec: async (_bin: string, args: string[]) => {
        if (args.includes("dump-layout")) {
          return {
            code: 0,
            stdout: dumps.shift() ?? "",
            stderr: "",
            killed: false,
          };
        }

        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;

    const supervisor = new ZellijSupervisor(pi);

    const first = await supervisor.reconcilePanes([
      { name: "agent-red", cwd: "/tmp", command: ["pi"] },
      { name: "agent-green", cwd: "/tmp", command: ["pi"] },
    ]);

    expect(first.present).toHaveLength(1);
    expect(first.spawned).toHaveLength(1);
    expect(first.missing).toEqual([]);

    const second = await supervisor.reconcilePanes([
      { name: "agent-red", cwd: "/tmp", command: ["pi"] },
      { name: "agent-green", cwd: "/tmp", command: ["pi"] },
    ]);

    expect(second.idChanges).toEqual([
      { name: "agent-red", from: "1", to: "9" },
    ]);
  });

  it("focuses and closes panes by id and name", async () => {
    const calls: string[][] = [];
    const pi = {
      exec: async (_bin: string, args: string[]) => {
        calls.push(args);
        if (args.includes("dump-layout")) {
          return {
            code: 0,
            stdout: 'pane id="11" name="agent-red"',
            stderr: "",
            killed: false,
          };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;

    const supervisor = new ZellijSupervisor(pi);
    await expect(supervisor.focusPaneByName("agent-red")).resolves.toBe(true);
    await expect(supervisor.closePane("11")).resolves.toBe(true);
    await expect(supervisor.closePaneByName("agent-red")).resolves.toBe(true);
    expect(calls.some((args) => args.includes("focus-pane"))).toBe(true);
    expect(calls.some((args) => args.includes("close-pane"))).toBe(true);
  });

  it("returns empty pane list when exec is unavailable", async () => {
    const supervisor = new ZellijSupervisor({} as ExtensionAPI);
    await expect(supervisor.listPanes()).resolves.toEqual([]);
    await expect(
      supervisor.spawnPane({
        name: "x",
        cwd: "/tmp",
        command: ["pi"],
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(supervisor.closePane("x")).resolves.toBe(false);
  });
});
