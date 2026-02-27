import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface PaneInfo {
  id: string;
  name?: string;
}

const parseAttribute = (input: string, key: string): string | undefined => {
  const match = input.match(new RegExp(`${key}="([^"]+)"`));
  return match?.[1];
};

export const parsePaneInfos = (layout: string): PaneInfo[] => {
  const panes: PaneInfo[] = [];
  for (const line of layout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("pane ")) {
      continue;
    }

    const id = parseAttribute(trimmed, "id");
    if (!id) {
      continue;
    }

    const name = parseAttribute(trimmed, "name");
    panes.push({
      id,
      ...(name ? { name } : {}),
    });
  }
  return panes;
};

export class ZellijSupervisor {
  constructor(private readonly pi: ExtensionAPI) {}

  private async runZellij(
    args: string[],
  ): Promise<{ code: number; stdout: string }> {
    const exec = (this.pi as unknown as { exec?: ExtensionAPI["exec"] }).exec;
    if (!exec) {
      return { code: 127, stdout: "" };
    }

    const result = await exec("zellij", args, {});
    return { code: result.code, stdout: result.stdout };
  }

  async spawnPane(input: {
    name: string;
    cwd: string;
    command: string[];
  }): Promise<{ ok: boolean; command: string[] }> {
    const args = [
      "action",
      "new-pane",
      "--name",
      input.name,
      "--cwd",
      input.cwd,
      "--close-on-exit",
      "--",
      ...input.command,
    ];

    const result = await this.runZellij(args);
    return { ok: result.code === 0, command: args };
  }

  async listPanes(): Promise<PaneInfo[]> {
    const result = await this.runZellij(["action", "dump-layout"]);
    if (result.code !== 0) {
      return [];
    }
    return parsePaneInfos(result.stdout);
  }

  async focusPane(paneId: string): Promise<boolean> {
    const result = await this.runZellij(["action", "focus-pane", paneId]);
    return result.code === 0;
  }

  async closePane(paneId: string): Promise<boolean> {
    const focused = await this.focusPane(paneId);
    if (!focused) {
      return false;
    }

    const result = await this.runZellij(["action", "close-pane"]);
    return result.code === 0;
  }

  async focusPaneByName(name: string): Promise<boolean> {
    const panes = await this.listPanes();
    const pane = panes.find((entry) => entry.name === name);
    if (!pane) {
      return false;
    }

    return this.focusPane(pane.id);
  }

  async closePaneByName(name: string): Promise<boolean> {
    const panes = await this.listPanes();
    const pane = panes.find((entry) => entry.name === name);
    if (!pane) {
      return false;
    }

    return this.closePane(pane.id);
  }
}
