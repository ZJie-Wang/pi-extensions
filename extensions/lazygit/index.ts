import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMMAND = "lazygit";
const SHORTCUT = "ctrl+alt+l";

type Notice = { message: string; type: "warning" | "error" };

function runLazygit(ctx: ExtensionContext): Promise<Notice | undefined> {
  return ctx.ui.custom<Notice | undefined>((tui, _theme, _keybindings, done) => {
    tui.stop();
    process.stdout.write("\x1b[2J\x1b[H");

    const result = spawnSync(COMMAND, [], { cwd: ctx.cwd, stdio: "inherit" });

    tui.start();
    tui.requestRender(true);

    let notice: Notice | undefined;
    if (result.error) {
      notice = { message: `Could not start lazygit: ${result.error.message}`, type: "error" };
    } else if (result.signal) {
      notice = { message: `lazygit stopped after receiving ${result.signal}`, type: "warning" };
    } else if (result.status !== 0) {
      notice = { message: `lazygit exited with status ${result.status}`, type: "warning" };
    }

    done(notice);
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

  const notice = await runLazygit(ctx);
  if (notice) ctx.ui.notify(notice.message, notice.type);
}

export default function lazygitExtension(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND, {
    description: "Open lazygit in the current working directory",
    handler: (_args, ctx) => openLazygit(ctx),
  });

  pi.registerShortcut(SHORTCUT, {
    description: "Open lazygit",
    handler: openLazygit,
  });
}
