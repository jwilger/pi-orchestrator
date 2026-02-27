import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface PaneInfo {
  id: string;
  name?: string;
}

export interface PaneSpawnSpec {
  name: string;
  cwd: string;
  command: string[];
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
  private readonly paneIdsByName = new Map<string, string>();

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

  private indexTrackedPanes(panes: PaneInfo[]): void {
    const knownNames = new Set(
      panes.map((pane) => pane.name).filter((name) => Boolean(name)),
    );
    for (const [name] of this.paneIdsByName.entries()) {
      if (!knownNames.has(name)) {
        this.paneIdsByName.delete(name);
      }
    }

    for (const pane of panes) {
      if (pane.name) {
        this.paneIdsByName.set(pane.name, pane.id);
      }
    }
  }

  async spawnPane(input: PaneSpawnSpec): Promise<{
    ok: boolean;
    command: string[];
    paneId?: string;
  }> {
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
    if (result.code !== 0) {
      return { ok: false, command: args };
    }

    const panes = await this.listPanes();
    const pane = panes.find((entry) => entry.name === input.name);
    return {
      ok: true,
      command: args,
      ...(pane ? { paneId: pane.id } : {}),
    };
  }

  async listPanes(): Promise<PaneInfo[]> {
    const result = await this.runZellij(["action", "dump-layout"]);
    if (result.code !== 0) {
      return [];
    }
    const panes = parsePaneInfos(result.stdout);
    this.indexTrackedPanes(panes);
    return panes;
  }

  getTrackedPaneIds(): Record<string, string> {
    return Object.fromEntries(this.paneIdsByName.entries());
  }

  async reconcilePanes(expected: PaneSpawnSpec[]): Promise<{
    paneCount: number;
    present: PaneInfo[];
    spawned: Array<{ name: string; paneId?: string }>;
    missing: string[];
    idChanges: Array<{ name: string; from: string; to: string }>;
  }> {
    const previousIds = new Map(this.paneIdsByName);
    const panes = await this.listPanes();
    const byName = new Map(
      panes
        .filter((pane) => pane.name)
        .map((pane) => [pane.name as string, pane] as const),
    );

    const present: PaneInfo[] = [];
    const spawned: Array<{ name: string; paneId?: string }> = [];
    const missing: string[] = [];

    for (const spec of expected) {
      const existing = byName.get(spec.name);
      if (existing) {
        present.push(existing);
        continue;
      }

      const created = await this.spawnPane(spec);
      if (!created.ok) {
        missing.push(spec.name);
        continue;
      }

      spawned.push({
        name: spec.name,
        ...(created.paneId ? { paneId: created.paneId } : {}),
      });
    }

    const finalPanes = await this.listPanes();
    const finalByName = new Map(
      finalPanes
        .filter((pane) => pane.name)
        .map((pane) => [pane.name as string, pane.id] as const),
    );

    const idChanges: Array<{ name: string; from: string; to: string }> = [];
    for (const spec of expected) {
      const previous = previousIds.get(spec.name);
      const current = finalByName.get(spec.name);
      if (previous && current && previous !== current) {
        idChanges.push({ name: spec.name, from: previous, to: current });
      }
    }

    return {
      paneCount: finalPanes.length,
      present,
      spawned,
      missing,
      idChanges,
    };
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
