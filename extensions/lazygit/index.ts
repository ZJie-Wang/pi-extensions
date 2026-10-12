import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMMAND = "lazygit";
const SHORTCUT = "ctrl+alt+l";

let isOpen = false;

type LaunchResult =
  | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "failed"; message: string };

function launch(cwd: string): Promise<Extract<LaunchResult, { kind: "exited" }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(COMMAND, [], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ kind: "exited", code, signal }));
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runInTerminal(ctx: ExtensionContext): Promise<LaunchResult> {
  return ctx.ui.custom<LaunchResult>((tui, _theme, _keybindings, done) => {
    void (async () => {
      let result: LaunchResult;

      try {
        tui.stop();
        process.stdout.write("\x1b[2J\x1b[H");
        result = await launch(ctx.cwd);
      } catch (error) {
        result = { kind: "failed", message: errorMessage(error) };
      } finally {
        tui.start();
        tui.requestRender(true);
      }

      done(result);
    })();

    return { render: () => [], invalidate: () => {} };
  });
}

async function openLazygit(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("lazygit requires Pi's interactive terminal", "error");
    return;
  }

  if (!ctx.isIdle()) {
    ctx.ui.notify("Wait for the current agent run to finish before opening lazygit", "warning");
    return;
  }

  if (isOpen) return;
  isOpen = true;

  try {
    const result = await runInTerminal(ctx);
    if (result.kind === "failed") {
      ctx.ui.notify(`Could not start lazygit: ${result.message}`, "error");
    } else if (result.signal) {
      ctx.ui.notify(`lazygit stopped after receiving ${result.signal}`, "warning");
    } else if (result.code !== 0) {
      ctx.ui.notify(`lazygit exited with status ${result.code}`, "warning");
    }
  } finally {
    isOpen = false;
  }
}

export default function lazygitExtension(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND, {
    description: "Open lazygit in the current working directory",
    handler: async (_args, ctx) => openLazygit(ctx),
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Open lazygit",
    handler: openLazygit,
  });
}
