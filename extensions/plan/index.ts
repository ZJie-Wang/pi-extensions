import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  isToolCallEventType,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadToolAllowlist } from "./lib/tool-allowlist.ts";
import { writePlanMarkdownFile } from "./lib/plan-file.ts";
import {
  createPlanLifecycle,
  type PlanLifecycleResult,
} from "./lib/plan-lifecycle.ts";
import {
  containsPlanHeader,
  extractPlanItems,
  getUnsafeCommandReason,
} from "./lib/utils.ts";

const PLAN_TOOL_NAME = "present_plan";
const PLAN_ONLY_TOOLS = new Set([PLAN_TOOL_NAME]);
const STATE_ENTRY_TYPE = "plan-mode-state";
const WIDGET_KEY = "plan-mode";
const PLAN_FILE_NAME = "PLAN.md";
const PLAN_TOOL_ALLOWLIST = loadToolAllowlist(
  new URL("config/tool-allowlist.json", import.meta.url),
);

/** Fallback build toolset when no snapshot was captured (corrupted state only). */
const DEFAULT_BUILD_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

interface PlanToolDetails {
  path: string;
  absolutePath: string;
  opened: boolean;
  openError?: string;
}

const PresentPlanParams = Type.Object({
  plan: Type.String({
    description:
      "The full plan in markdown. Include headings, numbered steps, notes, etc. as you see fit.",
  }),
});

function isAssistantMessage(
  message: AgentMessage,
): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is TextContent =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

function getTextContent(message: AssistantMessage): string {
  return textFromContent(message.content);
}

function loadMarkdownPrompt(
  filename: string,
  vars: Record<string, string>,
): string {
  const content = readFileSync(new URL(filename, import.meta.url), "utf8");
  return content.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, key: string) => vars[key] ?? "",
  );
}

function displayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath;
}

function openCommandForPath(path: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [path] };
  if (process.platform === "win32")
    return { command: "cmd", args: ["/c", "start", "", path] };
  return { command: "xdg-open", args: [path] };
}

function splitToWidth(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const char of Array.from(text)) {
    if (line && visibleWidth(`${line}${char}`) > maxWidth) {
      lines.push(line);
      line = "";
    }
    line += char;
  }
  if (line) lines.push(line);
  return lines;
}

function wrapText(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (visibleWidth(word) > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(...splitToWidth(word, width));
      continue;
    }
    const next = line ? `${line} ${word}` : word;
    if (visibleWidth(next) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

interface DialogOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

type PlanAction = "implement" | "implement-revised" | "revise" | "stay";
type ImplementationContextChoice = "current" | "compact";

const TOGGLE_PLAN_MODE_OFF = Symbol("toggle-plan-mode-off");
type DialogResult<T extends string> =
  | T
  | typeof TOGGLE_PLAN_MODE_OFF
  | undefined;

const PLAN_ACTION_OPTIONS: DialogOption<PlanAction>[] = [
  {
    value: "implement",
    label: "Implement plan",
    description: "Restore build mode and implement the plan as written.",
  },
  {
    value: "implement-revised",
    label: "I revised the plan — re-read & implement",
    description:
      "Restore build mode; re-read PLAN.md first to pick up your edits.",
  },
  {
    value: "revise",
    label: "Revise plan",
    description: "Stay in plan mode; collect revision notes and revise.",
  },
  {
    value: "stay",
    label: "Stay in plan mode",
    description: "Keep planning.",
  },
];

function implementationCompactionInstructions(planRevised: boolean): string {
  const planStatus = planRevised
    ? "After it was presented, the user revised PLAN.md directly and then requested implementation, so plan details in the conversation may be partially stale."
    : "The user approved the presented plan for implementation.";
  return (
    "The preceding conversation took place in plan mode. The user chose to " +
    "compact the context before implementation. The plan was presented and " +
    `saved as PLAN.md. ${planStatus} ` +
    "For this compaction, treat the default summary template as organizational " +
    "guidance rather than a rigid checklist. Preserve only supporting context " +
    "needed during implementation. Do not summarize, quote, reconstruct, infer, " +
    "or repeat plan tasks or design details from the conversation. PLAN.md on " +
    "disk is the source of truth. The next steps for the agent working in this session " +
    "after this compaction are to first read PLAN.md from disk, then implement it."
  );
}

const IMPLEMENTATION_CONTEXT_OPTIONS: DialogOption<ImplementationContextChoice>[] =
  [
    {
      value: "current",
      label: "Start in current context",
      description:
        "Keep the full planning conversation and start a build-mode turn.",
    },
    {
      value: "compact",
      label: "Compact first, then start",
      description:
        "Summarize the planning context, then start implementation automatically.",
    },
  ];

/**
 * Render a bordered picker. Pi routes extension shortcuts through its normal
 * editor, which custom UI replaces, so this component handles Ctrl+Alt+P
 * itself and reports the mode change to its caller.
 */
async function chooseDialog<T extends string>(
  ctx: ExtensionContext,
  title: string,
  subtitle: string,
  options: DialogOption<T>[],
  setDismiss: (dismiss: (() => void) | undefined) => void,
): Promise<DialogResult<T>> {
  if (ctx.mode !== "tui") {
    const choice = await ctx.ui.select(
      title,
      options.map((option) => option.label),
    );
    return options.find((option) => option.label === choice)?.value;
  }

  try {
    return await ctx.ui.custom<DialogResult<T>>(
      (tui, theme, _keybindings, done) => {
        let cursor = 0;
        let cachedLines: string[] | undefined;
        let closed = false;
        const close = (result: DialogResult<T>) => {
          if (closed) return;
          closed = true;
          setDismiss(undefined);
          done(result);
        };
        setDismiss(() => close(undefined));

        const refresh = () => {
          cachedLines = undefined;
          tui.requestRender();
        };

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;
          const lines: string[] = [];
          const add = (line = "") => lines.push(truncateToWidth(line, width));
          const rule = () => add(theme.fg("borderMuted", "─".repeat(width)));
          const contentWidth = Math.max(1, width - 1);
          rule();
          add(` ${theme.bold(theme.fg("text", title))}`);
          add(` ${theme.fg("muted", subtitle)}`);
          lines.push("");
          options.forEach((option, i) => {
            const focused = cursor === i;
            const prefix = focused ? theme.fg("accent", "> ") : "  ";
            const num = theme.fg(focused ? "accent" : "muted", `${i + 1}. `);
            const row =
              num + theme.fg(focused ? "accent" : "text", option.label);
            add(prefix + (focused ? theme.bold(row) : row));
            for (const descriptionLine of wrapText(
              option.description,
              Math.max(1, contentWidth - 5),
            ))
              add(`     ${theme.fg("muted", descriptionLine)}`);
          });
          lines.push("");
          add(
            theme.fg(
              "dim",
              " ↑↓/jk move • Enter select • Esc cancel • Ctrl+Alt+P build mode",
            ),
          );
          rule();
          cachedLines = lines;
          return lines;
        }

        function handleInput(data: string) {
          if (matchesKey(data, Key.ctrlAlt("p"))) {
            close(TOGGLE_PLAN_MODE_OFF);
            return;
          }
          if (matchesKey(data, Key.up) || data === "k") {
            cursor = Math.max(0, cursor - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            cursor = Math.min(options.length - 1, cursor + 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.escape)) {
            close(undefined);
            return;
          }
          if (matchesKey(data, Key.enter)) {
            close(options[cursor]?.value);
          }
        }

        return {
          render,
          handleInput,
          invalidate: () => {
            cachedLines = undefined;
          },
          dispose: () => setDismiss(undefined),
        };
      },
    );
  } finally {
    setDismiss(undefined);
  }
}

export default function planModeExtension(pi: ExtensionAPI): void {
  const lifecycle = createPlanLifecycle({
    planTools: PLAN_TOOL_ALLOWLIST,
    planOnlyTools: [...PLAN_ONLY_TOOLS],
    defaultBuildTools: DEFAULT_BUILD_TOOLS,
  });
  let lastPersistedState = "";

  type ImplementationHandoff =
    | {
        phase: "pending";
        prompt: string;
        context: ImplementationContextChoice;
        planRevised: boolean;
      }
    | {
        phase: "compacting" | "starting";
        prompt: string;
        releaseInput?: () => void;
      };

  // Implementation is deferred until `agent_settled`, when the planning tool
  // call has terminated and build-mode tools can safely drive a fresh turn.
  let handoff: ImplementationHandoff | undefined;
  let dismissPlanDialog: (() => void) | undefined;

  pi.registerFlag("plan", {
    description:
      "Start in plan mode (configured tools, write plan to markdown)",
    type: "boolean",
    default: false,
  });

  function availableToolNames(): string[] {
    return pi.getAllTools().map((tool) => tool.name);
  }

  function planToolNames(): string[] {
    const available = new Set(availableToolNames());
    return PLAN_TOOL_ALLOWLIST.filter((name) => available.has(name));
  }

  function applyToolEffects(
    result: PlanLifecycleResult,
    ctx: ExtensionContext,
  ): void {
    if (result.activeTools) pi.setActiveTools(result.activeTools);
    if (ctx.hasUI && result.unavailablePlanTools?.length) {
      ctx.ui.notify(
        `Plan mode ignored unavailable configured tools: ${result.unavailablePlanTools.join(", ")}`,
        "warning",
      );
    }
  }

  function persist(result: PlanLifecycleResult): void {
    if (!result.persist) return;
    const serialized = JSON.stringify(result.persist);
    if (serialized === lastPersistedState) return;
    pi.appendEntry(STATE_ENTRY_TYPE, result.persist);
    lastPersistedState = serialized;
  }

  function persistedPlanStates(ctx: ExtensionContext): unknown[] {
    const states: unknown[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        states.push(entry.data);
      }
    }
    return states;
  }

  function cancelImplementationHandoff(): void {
    if (handoff?.phase === "compacting" || handoff?.phase === "starting")
      handoff.releaseInput?.();
    handoff = undefined;
  }

  function queueImplementation(
    prompt: string,
    context: ImplementationContextChoice,
    planRevised: boolean,
  ): void {
    handoff = { phase: "pending", prompt, context, planRevised };
  }

  function closePlanDialog(): void {
    const dismiss = dismissPlanDialog;
    dismissPlanDialog = undefined;
    dismiss?.();
  }

  function updateUI(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    if (!lifecycle.state.planModeEnabled) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return [
          truncateToWidth(
            ` ${theme.fg("warning", "●")} ${theme.fg("warning", theme.bold("Plan mode"))}`,
            width,
          ),
        ];
      },
    }));
  }

  function enterPlanMode(ctx: ExtensionContext, notify = true): void {
    cancelImplementationHandoff();
    const result = lifecycle.dispatch({
      type: "enter",
      activeTools: pi.getActiveTools(),
      availableTools: availableToolNames(),
    });
    applyToolEffects(result, ctx);
    updateUI(ctx);
    persist(result);
    if (notify && ctx.hasUI)
      ctx.ui.notify(
        `Plan mode enabled. Plans are written to ${PLAN_FILE_NAME}.`,
        "info",
      );
  }

  function leavePlanMode(ctx: ExtensionContext, notify = true): void {
    closePlanDialog();
    const result = lifecycle.dispatch({
      type: "leave",
      availableTools: availableToolNames(),
    });
    applyToolEffects(result, ctx);
    updateUI(ctx);
    persist(result);
    if (notify && ctx.hasUI) ctx.ui.notify("Build mode restored.", "info");
  }

  function clearPlanState(ctx: ExtensionContext, notify = true): void {
    const result = lifecycle.dispatch({
      type: "clear",
      availableTools: availableToolNames(),
    });
    cancelImplementationHandoff();
    closePlanDialog();
    applyToolEffects(result, ctx);
    updateUI(ctx);
    persist(result);
    if (notify && ctx.hasUI) ctx.ui.notify("Plan mode state cleared.", "info");
  }

  function reconstructState(
    ctx: ExtensionContext,
    forcePlanFlag = false,
  ): void {
    cancelImplementationHandoff();
    const result = lifecycle.dispatch({
      type: "reconstruct",
      persistedStates: persistedPlanStates(ctx),
      activeTools: pi.getActiveTools(),
      availableTools: availableToolNames(),
      forcePlan: forcePlanFlag,
    });
    applyToolEffects(result, ctx);
    lastPersistedState = JSON.stringify(result.state);
    updateUI(ctx);
  }

  async function writePlanFile(
    planMarkdown: string,
    ctx: ExtensionContext,
  ): Promise<{ details: PlanToolDetails }> {
    const absolutePath = resolve(ctx.cwd, PLAN_FILE_NAME);
    await withFileMutationQueue(absolutePath, () =>
      writePlanMarkdownFile(absolutePath, planMarkdown),
    );

    const result = lifecycle.dispatch({
      type: "plan-written",
      absolutePath,
    });
    persist(result);
    updateUI(ctx);

    return {
      details: {
        path: displayPath(ctx.cwd, absolutePath),
        absolutePath,
        opened: false,
      },
    };
  }

  async function openPlanPath(
    absolutePath: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<{ opened: boolean; openError?: string }> {
    if (!ctx.hasUI || process.env.PI_PLAN_NO_OPEN === "1")
      return { opened: false };
    const command = openCommandForPath(absolutePath);
    try {
      const result = await pi.exec(command.command, command.args, {
        signal,
        timeout: 5000,
      });
      if (result.code === 0) return { opened: true };
      return {
        opened: false,
        openError:
          result.stderr ||
          result.stdout ||
          `open command exited with code ${result.code}`,
      };
    } catch (error) {
      return {
        opened: false,
        openError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function openLastPlan(ctx: ExtensionContext): Promise<void> {
    const absolutePath =
      lifecycle.state.lastPlanPath ?? resolve(ctx.cwd, PLAN_FILE_NAME);
    const result = await openPlanPath(absolutePath, ctx);
    if (ctx.hasUI) {
      if (result.opened)
        ctx.ui.notify(`Opened ${displayPath(ctx.cwd, absolutePath)}.`, "info");
      else
        ctx.ui.notify(
          result.openError ||
            `Could not open ${displayPath(ctx.cwd, absolutePath)}.`,
          "warning",
        );
    }
  }

  async function promptForPlanDecision(
    ctx: ExtensionContext,
    planPath: string,
  ): Promise<string> {
    if (!ctx.hasUI) {
      return (
        "Plan mode remains active; ask the user whether to implement, " +
        "re-read and implement a revised plan, revise, or stay in planning."
      );
    }

    const setDismiss = (dismiss: (() => void) | undefined) => {
      dismissPlanDialog = dismiss;
    };
    const choice = await chooseDialog(
      ctx,
      "Plan saved — what next?",
      planPath,
      PLAN_ACTION_OPTIONS,
      setDismiss,
    );

    if (choice === TOGGLE_PLAN_MODE_OFF) {
      leavePlanMode(ctx);
      return "User manually restored build mode; no implementation turn was queued.";
    }

    if (choice === "implement" || choice === "implement-revised") {
      const implementationContext = await chooseDialog(
        ctx,
        "How should implementation start?",
        planPath,
        IMPLEMENTATION_CONTEXT_OPTIONS,
        setDismiss,
      );
      if (implementationContext === TOGGLE_PLAN_MODE_OFF) {
        leavePlanMode(ctx);
        return "User manually restored build mode; no implementation turn was queued.";
      }
      if (implementationContext === undefined) {
        return "Implementation setup was cancelled; staying in plan mode.";
      }

      const planRevised = choice === "implement-revised";
      leavePlanMode(ctx);
      const prompt = planRevised
        ? `${planPath} was revised manually. Re-read it from disk first, then implement it.`
        : `Implement the ${planPath}.`;
      queueImplementation(prompt, implementationContext, planRevised);
      return implementationContext === "compact"
        ? "User chose to implement it after context compaction; plan mode is " +
            "off and compaction will start after this planning turn settles."
        : "User chose to implement it in the current context; plan mode is " +
            "off and a fresh build-mode turn will start after this planning turn settles.";
    }

    if (choice === "revise") {
      const revision = await ctx.ui.editor("Revision notes for the plan:", "");
      if (revision?.trim()) {
        pi.sendUserMessage(`Revise the plan: \n\n${revision.trim()}`, {
          deliverAs: "followUp",
        });
        return "User requested revisions; a fresh plan-mode follow-up turn has been queued.";
      }
      return "User chose revision but did not provide notes; staying in plan mode.";
    }

    return "Staying in plan mode for further review or revision.";
  }

  async function handlePlanCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const action = args.trim().toLowerCase();
    if (action === "on" || action === "start" || action === "enable") {
      enterPlanMode(ctx);
      return;
    }
    if (
      action === "off" ||
      action === "stop" ||
      action === "disable" ||
      action === "exit"
    ) {
      leavePlanMode(ctx);
      return;
    }
    if (action === "clear") {
      clearPlanState(ctx);
      return;
    }
    if (action === "open") {
      await openLastPlan(ctx);
      return;
    }
    if (action === "status") {
      const state = lifecycle.state;
      const status = state.planModeEnabled ? "planning" : "normal mode";
      const file = state.lastPlanPath
        ? displayPath(ctx.cwd, state.lastPlanPath)
        : PLAN_FILE_NAME;
      if (ctx.hasUI)
        ctx.ui.notify(
          `Plan extension status: ${status}\nPlan file: ${file}`,
          "info",
        );
      return;
    }
    if (lifecycle.state.planModeEnabled) leavePlanMode(ctx);
    else enterPlanMode(ctx);
  }

  pi.registerTool({
    name: PLAN_TOOL_NAME,
    label: "Present Plan",
    description: `Write a structured implementation plan to ${PLAN_FILE_NAME} and open it immediately. Only available in plan mode.`,
    parameters: PresentPlanParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!lifecycle.state.planModeEnabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${PLAN_TOOL_NAME} is only available while plan mode is active.`,
            },
          ],
          details: {
            path: PLAN_FILE_NAME,
            absolutePath: resolve(ctx.cwd, PLAN_FILE_NAME),
            opened: false,
          } satisfies PlanToolDetails,
          terminate: true,
        };
      }

      const result = await writePlanFile(params.plan, ctx);
      const openResult = await openPlanPath(
        result.details.absolutePath,
        ctx,
        signal,
      );
      const details = {
        ...result.details,
        ...openResult,
      } satisfies PlanToolDetails;
      const openNote = openResult.opened
        ? `Plan written to ${details.path} and opened.`
        : `Plan written to ${details.path}. ${openResult.openError ? `Could not open it automatically: ${openResult.openError}` : "Open it manually if needed."}`;
      const decisionNote = await promptForPlanDecision(ctx, details.path);
      updateUI(ctx);
      return {
        content: [
          { type: "text" as const, text: `${openNote}\n${decisionNote}` },
        ],
        details,
        terminate: true,
      };
    },
    renderCall(_args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`${PLAN_TOOL_NAME} `))}${theme.fg("accent", PLAN_FILE_NAME)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as PlanToolDetails | undefined;
      if (!details) return new Text("", 0, 0);
      const openStatus = details.opened
        ? theme.fg("dim", "opened")
        : theme.fg("dim", "saved");
      return new Text(
        `${theme.fg("success", "saved")} ${theme.fg("accent", details.path)} ${openStatus}`,
        0,
        0,
      );
    },
  });

  pi.registerCommand("plan", {
    description: "Toggle plan mode; args: on/off/status/open/clear",
    getArgumentCompletions(prefix) {
      const completions = ["on", "off", "status", "open", "clear"];
      return completions
        .filter((item) => item.startsWith(prefix))
        .map((item) => ({ value: item, label: item }));
    },
    handler: async (args, ctx) => handlePlanCommand(args, ctx),
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan mode",
    handler: async (ctx) => {
      if (lifecycle.state.planModeEnabled) leavePlanMode(ctx);
      else enterPlanMode(ctx);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    reconstructState(
      ctx,
      event.reason === "startup" && pi.getFlag("plan") === true,
    );
  });

  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_compact", () => {
    // Auto-compaction can finish before agent_settled. In that case the
    // requested compact-first step is already satisfied.
    if (handoff?.phase === "pending" && handoff.context === "compact")
      handoff.context = "current";
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelImplementationHandoff();
    closePlanDialog();
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  // Deliver the queued build-mode handoff once the planning run has fully
  // settled. Compaction also starts here, never from inside the still-running
  // present_plan tool call.
  pi.on("agent_settled", async (_event, ctx) => {
    if (handoff?.phase !== "pending") return;
    const pending = handoff;

    if (pending.context === "current") {
      handoff = undefined;
      pi.sendUserMessage(pending.prompt);
      return;
    }

    let releaseInput: (() => void) | undefined;
    if (ctx.hasUI)
      ctx.ui.notify("Compacting context before implementation…", "info");
    if (ctx.mode === "tui") {
      let warned = false;
      releaseInput = ctx.ui.onTerminalInput((data) => {
        // Keep Escape available for Pi's compaction cancellation handler.
        if (matchesKey(data, Key.escape)) return;
        if (!warned) {
          warned = true;
          ctx.ui.notify(
            "Input is paused until plan compaction finishes. Press Esc to cancel.",
            "info",
          );
        }
        return { consume: true };
      });
    }

    const compacting: ImplementationHandoff = {
      phase: "compacting",
      prompt: pending.prompt,
      releaseInput,
    };
    handoff = compacting;
    ctx.compact({
      customInstructions: implementationCompactionInstructions(
        pending.planRevised,
      ),
      onComplete: () => {
        if (handoff !== compacting) return;
        handoff = { ...compacting, phase: "starting" };
        if (ctx.hasUI)
          ctx.ui.notify("Context compacted. Starting implementation.", "info");
        pi.sendUserMessage(compacting.prompt);
      },
      onError: () => {
        if (handoff !== compacting) return;
        cancelImplementationHandoff();
        if (!ctx.hasUI) return;
        const draft = ctx.ui.getEditorText();
        if (!draft.trim()) ctx.ui.setEditorText(compacting.prompt);
        ctx.ui.notify(
          `Implementation did not start; ${
            draft.trim()
              ? "your editor draft was preserved."
              : "the prompt was restored to the editor."
          }`,
          "error",
        );
      },
    });
  });

  pi.on("agent_start", () => {
    if (handoff?.phase !== "starting") return;
    cancelImplementationHandoff();
  });

  pi.on("tool_call", async (event) => {
    if (!lifecycle.state.planModeEnabled) return;

    if (isToolCallEventType("bash", event)) {
      const reason = getUnsafeCommandReason(event.input.command);
      if (reason) {
        return {
          block: true,
          reason: `Plan mode: bash command blocked (${reason}). Use ${PLAN_TOOL_NAME} to finish planning, or /plan off manually before implementation.`,
        };
      }
    }
  });

  pi.on("user_bash", (event) => {
    if (!lifecycle.state.planModeEnabled) return;
    const reason = getUnsafeCommandReason(event.command);
    if (!reason) return;
    return {
      result: {
        output: `Plan mode blocked this bash command: ${reason}\nUse ${PLAN_TOOL_NAME} to finish planning, or /plan off manually before implementation.`,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("before_agent_start", async (event) => {
    if (!lifecycle.state.planModeEnabled) return;
    const activeTools = planToolNames().join(", ") || "none";
    return {
      systemPrompt: `${event.systemPrompt}\n\n${loadMarkdownPrompt(
        "config/plan-mode-instruction.md",
        {
          activeTools,
          planFile: PLAN_FILE_NAME,
        },
      )}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI || !lifecycle.state.planModeEnabled) return;

    const lastAssistant = [...event.messages]
      .reverse()
      .find(isAssistantMessage);
    if (!lastAssistant) return;

    const text = getTextContent(lastAssistant);
    if (extractPlanItems(text).length > 0) {
      ctx.ui.notify(
        `Plan-like response found but not written. Use ${PLAN_TOOL_NAME} to save the plan intentionally.`,
        "warning",
      );
      return;
    }
    if (containsPlanHeader(text))
      ctx.ui.notify(
        `Plan heading found, but no numbered steps. Prefer ${PLAN_TOOL_NAME}.`,
        "warning",
      );
  });
}
