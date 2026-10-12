import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getAgentDir,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createChildSession, snapshotParent } from "./child.ts";
import {
  addUsage,
  BUILTIN_TOOLS,
  capOutput,
  emptyUsage,
  formatDuration,
  formatUsage,
  preview,
  type RunOutcome,
} from "./core.ts";
import {
  getThreadStatus,
  THREAD_NAME_PATTERN,
  type SubagentThread,
  ThreadManager,
} from "./manager.ts";
import { resolveProfileOverrides } from "./model-overrides.ts";
import { ProfileStore } from "./profiles.ts";
import { SubagentStatusWidget } from "./status-widget.ts";
import { ChildToolRegistry } from "./tool-loader.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(EXTENSION_DIR, "agents");
const TOOLS_DIR = path.join(EXTENSION_DIR, "tools");
const MAX_CONCURRENCY = 4;
const COMPLETION_TYPE = "subagents-complete";
const WIDGET_KEY = "subagents";
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

interface ToolDetails {
  threadId: string;
  profile: string;
  state: string;
  activity?: string;
  tools: SubagentThread["tools"];
  toolCount: number;
  lastMessage: string;
  prompt: string;
  startedAt?: number;
  scheduled?: boolean;
  outcome?: RunOutcome;
}

/** Text visible to the parent model. Cost is deliberately omitted. */
function outcomeText(thread: SubagentThread, outcome: RunOutcome): string {
  const heading = `Thread ${thread.id} (${thread.profile.name}) · ${outcome.status}`;
  const text = outcome.status === "completed"
    ? `${heading}\n\n${outcome.output}`
    : `${heading}\n\n${outcome.error ?? "Subagent did not complete"}${outcome.output ? `\n\nPartial output:\n${outcome.output}` : ""}`;
  const capped = capOutput(text, outcome.fullOutputPath);
  if (!outcome.fullOutputPath && capped !== text) {
    try {
      const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
      const outputPath = path.join(directory, "output.txt");
      writeFileSync(outputPath, text, { encoding: "utf8", mode: 0o600 });
      outcome.fullOutputPath = outputPath;
      return capOutput(text, outputPath);
    } catch {
      // Keep the capped result if the artifact cannot be written.
    }
  }
  return capped;
}

function detailsFor(thread: SubagentThread, scheduled = false): ToolDetails {
  return {
    threadId: thread.id,
    profile: thread.profile.name,
    state: thread.state,
    activity: thread.activity,
    tools: thread.tools.map((tool) => ({ ...tool })),
    toolCount: thread.toolCount,
    lastMessage: thread.lastMessage,
    prompt: thread.promptPreview,
    startedAt: thread.current?.startedAt,
    scheduled,
    outcome: thread.lastOutcome,
  };
}

function partialResult(thread: SubagentThread) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${thread.id}: ${thread.state} · ${thread.activity || "working"}`,
      },
    ],
    details: detailsFor(thread),
  };
}

function finalResult(thread: SubagentThread, outcome: RunOutcome) {
  return {
    content: [{ type: "text" as const, text: outcomeText(thread, outcome) }],
    details: { ...detailsFor(thread), outcome },
    isError: outcome.status === "failed",
  };
}

function threadContainer(
  context: ToolRenderContext,
  status: string,
  theme: Theme,
): { container: Container; icon: string } {
  const container = context.lastComponent instanceof Container
    ? context.lastComponent
    : new Container();
  container.clear();
  const icon = status === "running" ? theme.fg("warning", "▸")
    : status === "queued" ? theme.fg("warning", "◷")
    : status === "completed" ? theme.fg("success", "✓")
    : status === "idle" ? theme.fg("muted", "·")
    : theme.fg("error", "✗");
  return { container, icon };
}

function renderPrompt(
  container: Container,
  details: ToolDetails,
  theme: Theme,
): void {
  if (!details.prompt) return;
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(theme.fg("muted", theme.italic(details.prompt)), 0, 0),
  );
  container.addChild(
    new DynamicBorder((text: string) =>
      theme.fg("dim", text.replaceAll("─", "┄")),
    ),
  );
  container.addChild(new Spacer(1));
}

function renderToolLines(
  container: Container,
  details: ToolDetails,
  theme: Theme,
): void {
  for (const tool of details.tools) {
    const symbol = tool.status === "running" ? "▸" : " ";
    const color =
      tool.status === "running"
        ? "warning"
        : tool.status === "failed"
          ? "error"
          : "muted";
    const body = tool.args ? `${tool.tool}: ${tool.args}` : tool.tool;
    container.addChild(new Text(theme.fg(color, `${symbol} ${body}`), 0, 0));
  }
}

function renderThread(
  details: ToolDetails,
  theme: Theme,
  expanded: boolean,
  isPartial: boolean,
  context: ToolRenderContext,
  showName = true,
) {
  const outcome = details.outcome;
  const status = isPartial ? details.state : (outcome?.status ?? details.state);
  const active = status === "running" || status === "queued";
  const { container, icon } = threadContainer(context, status, theme);
  const elapsed = outcome
    ? formatDuration(outcome.endedAt - outcome.startedAt)
    : details.startedAt
      ? formatDuration(Date.now() - details.startedAt)
      : "";
  const stats = `${details.toolCount} tools${elapsed ? ` · ${elapsed}` : ""}`;
  const identity = showName
    ? `${theme.fg("toolTitle", theme.bold(details.threadId))} — `
    : "";
  container.addChild(
    new Text(`${icon} ${identity}${theme.fg("dim", stats)}`, 0, 0),
  );
  if (expanded) renderPrompt(container, details, theme);
  renderToolLines(container, details, theme);

  if (details.lastMessage && (active || !expanded || !outcome?.output)) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("thinkingText", details.lastMessage), 0, 0),
    );
  }
  if (outcome && expanded) {
    if (outcome.output) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Markdown(outcome.output, 0, 0, getMarkdownTheme(), {
          color: (text: string) => theme.fg("thinkingText", text),
        }),
      );
    }
    const usage = formatUsage(outcome.usage);
    if (usage) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", usage), 0, 0));
    }
    if (outcome.error)
      container.addChild(
        new Text(
          theme.fg("error", `${outcome.status}: ${outcome.error}`),
          0,
          0,
        ),
      );
  }
  return container;
}

function renderLaunch(
  details: ToolDetails,
  theme: Theme,
  expanded: boolean,
) {
  const container = new Container();
  container.addChild(
    new Text(
      `${theme.fg("accent", "↗")} ${theme.fg("toolTitle", theme.bold(details.threadId))} — ${theme.fg("dim", `scheduled · ${details.state}`)}`,
      0,
      0,
    ),
  );
  if (expanded) {
    renderPrompt(container, details, theme);
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          "Live snapshot: subagent_control status · detailed result: subagent_control wait",
        ),
        0,
        0,
      ),
    );
  }
  return container;
}

function renderStatus(
  details: ToolDetails,
  theme: Theme,
  expanded: boolean,
  context: ToolRenderContext,
) {
  const outcome = details.outcome;
  const status =
    details.state === "running" || details.state === "queued"
      ? details.state
      : (outcome?.status ?? details.state);
  const { container, icon } = threadContainer(context, status, theme);
  const elapsed = outcome
    ? formatDuration(outcome.endedAt - outcome.startedAt)
    : details.startedAt
      ? formatDuration(Date.now() - details.startedAt)
      : "";
  const current =
    details.tools.find((tool) => tool.status === "running") ??
    details.tools.at(-1);
  const activity = current
    ? `${current.tool}${current.args ? `: ${current.args}` : ""}`
    : details.activity;
  const summary = [status, `${details.toolCount} tools`, elapsed, activity]
    .filter(Boolean)
    .join(" · ");
  container.addChild(new Text(`${icon} ${theme.fg("dim", summary)}`, 0, 0));
  if (expanded) renderToolLines(container, details, theme);
  return container;
}

export default function subagentsExtension(pi: ExtensionAPI): void {
  const toolRegistry = new ChildToolRegistry(TOOLS_DIR);
  const knownTools = () => new Set([...BUILTIN_TOOLS, ...toolRegistry.names()]);
  const profiles = new ProfileStore(AGENTS_DIR, knownTools());
  let currentContext: ExtensionContext | undefined;
  let statusTimer: NodeJS.Timeout | undefined;
  let lastStatus: string | undefined;
  let requestStatusRender: (() => void) | undefined;

  const clearWidget = () => {
    lastStatus = undefined;
    requestStatusRender = undefined;
  };
  const paintStatus = () => {
    statusTimer = undefined;
    const ctx = currentContext;
    if (!ctx || ctx.mode !== "tui") return;
    const status = getThreadStatus(manager.list());
    const signature = JSON.stringify(status ?? null);
    if (signature === lastStatus) return;
    if (!requestStatusRender) {
      ctx.ui.setWidget(WIDGET_KEY, (tui) => {
        const widget = new SubagentStatusWidget(
          () => manager.list(),
          () => currentContext?.ui.theme ?? ctx.ui.theme,
        );
        requestStatusRender = () => tui.requestRender();
        return {
          render: (width) => widget.render(width),
          invalidate: () => widget.invalidate(),
          dispose: clearWidget,
        };
      }, { placement: "aboveEditor" });
    }
    lastStatus = signature;
    requestStatusRender?.();
  };
  const updateStatus = () => {
    if (!currentContext || currentContext.mode !== "tui" || statusTimer) return;
    statusTimer = setTimeout(paintStatus, 120);
    statusTimer.unref();
  };
  const manager = new ThreadManager(MAX_CONCURRENCY, {
    onThreadChange: updateStatus,
    onComplete: (thread, outcome) => {
      if (!currentContext) return;
      pi.sendMessage({
        customType: COMPLETION_TYPE,
        content: outcomeText(thread, outcome),
        display: false,
        details: { threadId: thread.id, status: outcome.status },
      }, { triggerTurn: false });
    },
  });

  // Pi counts nested usage on tool results. Drain completed child usage only once.
  pi.on("tool_result", (event) => {
    const pending = manager.takeUsage();
    if (!pending) return;
    const usage = emptyUsage();
    if (event.usage) addUsage(usage, event.usage);
    addUsage(usage, pending);
    return { usage };
  });

  const refreshProfiles = (ctx: ExtensionContext): boolean => {
    try {
      const toolsChanged = toolRegistry.refresh();
      const refresh = profiles.refresh(knownTools());
      if (refresh.warning) ctx.ui.notify(refresh.warning, "warning");
      return toolsChanged || refresh.changed;
    } catch (error) {
      ctx.ui.notify(
        `Subagent tools were not refreshed. ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return false;
    }
  };

  const SubagentRunParams = () =>
    Type.Object({
      action: StringEnum(["new", "continue"] as const, {
        description: "Create a new thread or send another task to an idle thread.",
      }),
      profile: Type.Optional(
        StringEnum(
          profiles.list().map((item) => item.name),
          {
            description: `Required for new; omit for continue. Available:\n${profiles.describe()}`,
          },
        ),
      ),
      thread: Type.String({
        description:
          "Unique and human-readable name, like Tom, Jerry, slop_hunter, etc.",
        minLength: 1,
        maxLength: 32,
        pattern: THREAD_NAME_PATTERN,
      }),
      prompt: Type.String({
        description: "Natural-language message for the child.",
        minLength: 1,
      }),
    }, { additionalProperties: false });

  const registerSubagentRunTool = () =>
    pi.registerTool({
      name: "subagent_run",
      label: "Subagent Run",
      description:
        "Start or continue a named thread with an isolated child pi agent.",
      exposure: "model-only",
      promptSnippet:
        "Schedule substantial independent work in named subagent threads",
      promptGuidelines: [
        "Use subagents for tasks that benefit from specialized focus, parallel execution, or keeping noisy exploration out of the main context. Skip them for simple I/O or small tasks.",
        "New subagent threads start without the parent's transcript. Provide a self-contained initial prompt with the context the child needs. Continue an existing thread when its prior context matters. Keep work in the parent when passing the necessary context would be cumbersome.",
      ],
      parameters: SubagentRunParams(),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        currentContext = ctx;
        if (refreshProfiles(ctx)) registerSubagentRunTool();
        if (!params.prompt.trim()) throw new Error("prompt must be non-empty");
        let thread: SubagentThread;
        if (params.action === "new") {
          if (!params.profile) throw new Error("profile is required for new");
          const profile = profiles.get(params.profile);
          if (!profile)
            throw new Error(
              `Unknown subagent profile "${params.profile}". Available: ${profiles
                .list()
                .map((item) => item.name)
                .join(", ")}`,
            );
          const parent = snapshotParent(ctx, pi.getSettings());
          const profileSnapshot = resolveProfileOverrides(
            profile,
            parent.model,
            path.join(getAgentDir(), "subagents.json"),
          );
          thread = manager.create(
            profileSnapshot,
            params.prompt,
            () => createChildSession(profileSnapshot, parent, toolRegistry),
            params.thread,
          );
        } else {
          if (params.profile) throw new Error("omit profile for continue");
          thread = manager.continue(params.thread, params.prompt);
        }
        return {
          content: [{
            type: "text",
            text: `Scheduled ${thread.id} (${thread.profile.name}). Use subagent_control wait while blocked on the result; do not poll.`,
          }],
          details: detailsFor(thread, true),
        };
      },
      renderCall(args, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent_run"))} ${args.action === "continue" ? `${theme.fg("dim", "continue")} ` : ""}${theme.fg("accent", args.thread ?? "thread")}${args.profile ? theme.fg("dim", ` (${args.profile})`) : ""} ${theme.fg("dim", preview(args.prompt ?? "", 70))}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme, context) {
        const details = result.details as ToolDetails | undefined;
        if (details?.scheduled)
          return renderLaunch(details, theme, options.expanded);
        if (details)
          return renderThread(
            details,
            theme,
            options.expanded,
            options.isPartial,
            context,
            true,
          );
        const text =
          result.content.find((part) => part.type === "text")?.text ?? "";
        return new Text(theme.fg("thinkingText", preview(text, 180)), 0, 0);
      },
    });

  const ControlParams = Type.Object({
    thread: Type.String({
      description: "Existing thread name; case-insensitive.",
      minLength: 1,
      maxLength: 32,
      pattern: THREAD_NAME_PATTERN,
    }),
    action: StringEnum(["status", "wait", "steer", "stop"] as const, {
      description:
        "status returns state; wait joins the child; steer injects message; stop aborts the thread",
    }),
    message: Type.Optional(
      Type.String({ description: "Required only for steer", minLength: 1 }),
    ),
  }, { additionalProperties: false });

  pi.registerTool({
    name: "subagent_control",
    label: "Subagent Control",
    description:
      "Inspect, join, redirect, or stop an existing named subagent thread.",
    exposure: "model-only",
    promptSnippet: "Interact with existing subagent threads",
    parameters: ControlParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      currentContext = ctx;
      signal?.throwIfAborted();
      if (params.action !== "steer" && params.message !== undefined)
        throw new Error("message is only accepted for steer");
      const thread = manager.status(params.thread);
      if (params.action === "status") {
        const text = thread.current
          ? `${thread.id}: ${thread.state} · ${thread.activity}`
          : thread.lastOutcome
            ? outcomeText(thread, thread.lastOutcome)
            : `${thread.id}: idle`;
        return {
          content: [{ type: "text", text }],
          details: detailsFor(thread),
          isError: !thread.current && thread.lastOutcome?.status === "failed",
        };
      }
      if (params.action === "wait") {
        const outcome = await manager.wait(params.thread, signal, (thread) =>
          onUpdate?.(partialResult(thread)),
        );
        return finalResult(thread, outcome);
      }
      if (params.action === "steer") {
        if (!params.message?.trim())
          throw new Error("message is required for steer");
        await manager.steer(params.thread, params.message);
        return {
          content: [
            { type: "text", text: `Steering message queued for ${thread.id}.` },
          ],
          details: detailsFor(thread),
        };
      }
      if (!thread.current) {
        return {
          content: [{ type: "text", text: `${thread.id} is already idle.` }],
          details: detailsFor(thread),
        };
      }
      const outcome = await manager.stop(params.thread);
      return finalResult(thread, outcome);
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent_control"))} ${theme.fg("accent", args.action)} ${theme.fg("dim", args.thread)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      const details = result.details as ToolDetails | undefined;
      if (details && context.args.action === "status")
        return renderStatus(details, theme, options.expanded, context);
      if (details && context.args.action === "wait")
        return renderThread(
          details,
          theme,
          options.expanded,
          options.isPartial,
          context,
          false,
        );
      const text =
        result.content.find((part) => part.type === "text")?.text ?? "";
      return new Text(theme.fg("thinkingText", preview(text, 180)), 0, 0);
    },
  });

  registerSubagentRunTool();

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    paintStatus();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    currentContext = ctx;
    if (refreshProfiles(ctx)) registerSubagentRunTool();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
    clearWidget();
    currentContext = undefined;
    await manager.shutdown();
  });
}
