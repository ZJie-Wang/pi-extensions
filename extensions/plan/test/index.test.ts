import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import planModeExtension from "../index.ts";

test("plan command switches tool sets and persists lifecycle state", async () => {
  const availableTools = [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
    "ask_user",
    "subagent_run",
    "subagent_control",
    "present_plan",
  ];
  let activeTools = ["read", "edit", "bash"];
  const persisted: Array<{ type: string; data: unknown }> = [];
  const notifications: string[] = [];
  let planCommand:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;

  const pi = {
    registerFlag() {},
    registerTool() {},
    registerShortcut() {},
    on() {},
    registerCommand(name: string, command: { handler: typeof planCommand }) {
      if (name === "plan") planCommand = command.handler;
    },
    getAllTools: () => availableTools.map((name) => ({ name })),
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    appendEntry(type: string, data: unknown) {
      persisted.push({ type, data });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    hasUI: true,
    ui: {
      setWidget() {},
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;

  planModeExtension(pi);
  assert.ok(planCommand);

  await planCommand("on", ctx);
  assert.deepEqual(activeTools, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "ask_user",
    "subagent_run",
    "subagent_control",
    "present_plan",
  ]);
  assert.deepEqual(persisted.at(-1), {
    type: "plan-mode-state",
    data: {
      planModeEnabled: true,
      previousTools: ["read", "edit", "bash"],
    },
  });

  await planCommand("on", ctx);
  assert.equal(persisted.length, 1);

  await planCommand("off", ctx);
  assert.deepEqual(activeTools, ["read", "edit", "bash"]);
  assert.deepEqual(persisted.at(-1), {
    type: "plan-mode-state",
    data: { planModeEnabled: false },
  });
  assert.deepEqual(notifications, [
    "Plan mode enabled. Plans are written to PLAN.md.",
    "Plan mode enabled. Plans are written to PLAN.md.",
    "Build mode restored.",
  ]);
});
