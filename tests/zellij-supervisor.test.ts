import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  ZellijSupervisor,
  parsePaneInfos,
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

  it("lists panes from zellij dump-layout", async () => {
    const pi = {
      exec: async () => ({
        code: 0,
        stdout: 'pane id="7" name="agent-review"\npane id="8"',
        stderr: "",
        killed: false,
      }),
    } as unknown as ExtensionAPI;

    const supervisor = new ZellijSupervisor(pi);
    const panes = await supervisor.listPanes();

    expect(panes).toEqual([
      { id: "7", name: "agent-review" },
      { id: "8", name: undefined },
    ]);
    expect(supervisor.getTrackedPaneIds()).toEqual({ "agent-review": "7" });
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
