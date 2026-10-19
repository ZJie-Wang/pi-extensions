import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createChildSession, resolveToolExtensionPaths, snapshotParent } from "./child.ts";
import {
  addUsage,
  capOutput,
  capOutputWithArtifact,
  emptyUsage,
  formatDuration,
  formatUsage,
  preview,
  type RunOutcome,
} from "./core.ts";
import {
  getThreadStatus,
  type SubagentThread,
  ThreadManager,
} from "./manager.ts";
import { resolveProfileOverrides } from "./model-overrides.ts";
import { ProfileStore } from "./profiles.ts";
import { SubagentStatusWidget } from "./status-widget.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");
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
  if (outcome.fullOutputPath) return capOutput(text, outcome.fullOutputPath);
  const capped = capOutputWithArtifact(text);
  outcome.fullOutputPath = capped.fullOutputPath;
  return capped.output;
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
    prompt: thread.lastPrompt,
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

function elapsedText(startedAt: number | undefined, endedAt?: number): string {
  return startedAt === undefined ? "" : formatDuration((endedAt ?? Date.now()) - startedAt);
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
  showPrompt = true,
) {
  const outcome = details.outcome;
  const status = isPartial ? details.state : (outcome?.status ?? details.state);
  const active = status === "running" || status === "queued";
  const { container, icon } = threadContainer(context, status, theme);
  const elapsed = elapsedText(outcome?.startedAt ?? details.startedAt, outcome?.endedAt);
  const stats = `${details.toolCount} tools${elapsed ? ` · ${elapsed}` : ""}`;
  const identity = showName
    ? `${theme.fg("toolTitle", theme.bold(details.threadId))} — `
    : "";
  container.addChild(
    new Text(`${icon} ${identity}${theme.fg("dim", stats)}`, 0, 0),
  );
  if (expanded && showPrompt) renderPrompt(container, details, theme);
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
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", formatUsage(outcome.usage)), 0, 0));
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
  const status = details.state === "queued" ? "queued" : "running in background";
  container.addChild(
    new Text(
      `${theme.fg("accent", "↗")} ${theme.fg("toolTitle", theme.bold(details.threadId))} — ${theme.fg("dim", status)}`,
      0,
      0,
    ),
  );
  if (expanded) renderPrompt(container, details, theme);
  return container;
}

function renderStatus(
  details: ToolDetails,
  theme: Theme,
  expanded: boolean,
  context: ToolRenderContext,
) {
  const status = details.state;
  const { container, icon } = threadContainer(context, status, theme);
  const elapsed = elapsedText(details.startedAt);
  const current = status === "idle"
    ? undefined
    : details.tools.find((tool) => tool.status === "running") ?? details.tools.at(-1);
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
  const profiles = new ProfileStore(AGENTS_DIR);
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
    const refresh = profiles.refresh();
    if (refresh.warning) ctx.ui.notify(refresh.warning, "warning");
    return refresh.changed;
  };

  const SubagentRunParams = () =>
    Type.Object({
      action: StringEnum(["new", "continue"] as const),
      profile: Type.Optional(
        StringEnum(profiles.names(), {
          description: `Required for new; omit for continue. Available:\n${profiles.describe()}`,
        }),
      ),
      thread: Type.String({
        description:
          "Unique and human-readable name, like Tom, Jerry, slop_hunter, etc.",
      }),
      prompt: Type.String({
        description: "Natural-language message for the child.",
      }),
      inheritContext: Type.Optional(Type.Boolean({
        description: "Inherit the parent's active conversation when creating new threads.",
        default: false,
      })),
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
        "Give the child a clear task. Set inheritContext to true when the child needs the earlier parent conversation as context; otherwise include the necessary context in the prompt. Continue an existing thread when its history matters.",
      ],
      parameters: SubagentRunParams(),
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        currentContext = ctx;
        refreshProfiles(ctx);
        signal?.throwIfAborted();
        if (!params.prompt.trim()) throw new Error("prompt must be non-empty");
        let thread: SubagentThread;
        if (params.action === "new") {
          if (!params.profile) throw new Error("profile is required for new");
          const profile = profiles.get(params.profile);
          if (!profile)
            throw new Error(
              `Unknown subagent profile "${params.profile}". Available: ${profiles.names().join(", ")}`,
            );
          const parent = snapshotParent(ctx, pi.getSettings(), params.inheritContext ? toolCallId : undefined);
          const profileSnapshot = resolveProfileOverrides(
            profile,
            parent.model,
            path.join(getAgentDir(), "subagents.json"),
          );
          const extensionPaths = resolveToolExtensionPaths(profileSnapshot, pi.getAllTools());
          thread = manager.create(
            profileSnapshot,
            params.prompt,
            () => createChildSession(profileSnapshot, parent, extensionPaths),
            params.thread,
          );
        } else {
          if (params.profile) throw new Error("omit profile for continue");
          if (params.inheritContext !== undefined) throw new Error("omit inheritContext for continue");
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
          `${theme.fg("toolTitle", theme.bold("subagent_run"))} ${theme.fg("accent", args.thread ?? "thread")}${args.profile ? theme.fg("dim", ` (${args.profile})`) : ""} ${theme.fg("dim", preview(args.prompt ?? "", 70))}`,
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
          );
        const text =
          result.content.find((part) => part.type === "text")?.text ?? "";
        return new Text(theme.fg("thinkingText", preview(text, 180)), 0, 0);
      },
    });

  const ControlParams = Type.Object({
    thread: Type.String({
      description: "Existing thread name.",
    }),
    action: StringEnum(["status", "wait", "steer", "stop"] as const, {
      description:
        "status returns state; wait joins the child; steer injects message; stop aborts the thread",
    }),
    message: Type.Optional(
      Type.String({ description: "Required only for steer" }),
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
        const state = thread.activity
          ? `${thread.state} · ${thread.activity}`
          : thread.state;
        const { outcome: _outcome, ...details } = detailsFor(thread);
        return {
          content: [{ type: "text", text: `${thread.id}: ${state}` }],
          details: { ...details, lastMessage: "" },
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
