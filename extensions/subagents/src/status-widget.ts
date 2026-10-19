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
    const names = status.map((thread) => {
      const color = thread.status === "running" || thread.status === "queued" ? "warning"
        : thread.status === "completed" ? "success"
        : thread.status === "failed" || thread.status === "aborted" ? "error"
        : "muted";
      return theme.fg(color, thread.id);
    }).join(theme.fg("muted", ", "));
    const heading = `${theme.fg("mdLink", "●")} ${theme.fg("mdLink", theme.bold("Subagents:"))} ${names}`;
    return [truncateToWidth(` ${heading}`, width)];
  }

  invalidate(): void {}
}
