import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { getThreadStatus, type SubagentThread } from "./manager.ts";

export class SubagentStatusWidget implements Component {
  constructor(
    private readonly getThreads: () => readonly SubagentThread[],
    private readonly getTheme: () => Theme,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const status = getThreadStatus(this.getThreads());
    if (!status) return [];
    const theme = this.getTheme();
    const groups: string[] = [];
    for (const state of ["running", "queued"] as const) {
      if (!status[state].length) continue;
      const names = status[state].map((name) => name.replace(/\s+/g, " ").trim()).join(", ");
      groups.push(`${state} ${names}`);
    }
    const heading = `${theme.fg("mdLink", "●")} ${theme.fg("mdLink", theme.bold("Subagents"))} ${theme.fg("muted", groups.join(" · "))}`;
    return [truncateToWidth(` ${heading}`, width)];
  }

  invalidate(): void {}
}
