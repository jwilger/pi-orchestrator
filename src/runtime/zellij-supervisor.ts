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

export const parseTabInfos = (output: string): PaneInfo[] => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line, index) => ({
    id: `tab-${index + 1}`,
    name: line,
  }));
};

const parseAttribute = (input: string, key: string): string | undefined => {
  const equalsStyle = input.match(new RegExp(`${key}="([^"]+)"`));
  if (equalsStyle?.[1]) {
    return equalsStyle[1];
  }

  const kdlStyle = input.match(new RegExp(`${key}\\s+"([^"]+)"`));
  return kdlStyle?.[1];
};

export const parsePaneInfos = (layout: string): PaneInfo[] => {
  const panes: PaneInfo[] = [];
  for (const [index, line] of layout.split("\n").entries()) {
    const trimmed = line.trim();
    if (!/^pane\b/.test(trimmed)) {
      continue;
    }

    const id = parseAttribute(trimmed, "id") ?? `pane-${index + 1}`;
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
    const tabsResult = await this.runZellij(["action", "query-tab-names"]);
    if (tabsResult.code === 0) {
      const tabs = parseTabInfos(tabsResult.stdout);
      if (tabs.length > 0) {
        this.indexTrackedPanes(tabs);
        return tabs;
      }
    }

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
    const paneResult = await this.runZellij(["action", "focus-pane", paneId]);
    if (paneResult.code === 0) {
      return true;
    }

    const tabIndex = paneId.startsWith("tab-") ? paneId.slice(4) : paneId;
    const tabResult = await this.runZellij(["action", "go-to-tab", tabIndex]);
    return tabResult.code === 0;
  }

  async closePane(paneId: string): Promise<boolean> {
    const focused = await this.focusPane(paneId);
    if (!focused) {
      return false;
    }

    const closePaneResult = await this.runZellij(["action", "close-pane"]);
    if (closePaneResult.code === 0) {
      return true;
    }

    const closeTabResult = await this.runZellij(["action", "close-tab"]);
    return closeTabResult.code === 0;
  }

  async focusPaneByName(name: string): Promise<boolean> {
    const tabResult = await this.runZellij(["action", "go-to-tab-name", name]);
    if (tabResult.code === 0) {
      return true;
    }

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
