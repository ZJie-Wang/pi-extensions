import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createChildSession, snapshotParent } from "./child.ts";
import {
  BUILTIN_TOOLS,
  capOutput,
  formatDuration,
  formatUsage,
  preview,
  type RunOutcome,
} from "./core.ts";
import {
  getBackgroundStatus,
  type SubagentThread,
  ThreadManager,
} from "./manager.ts";
import { ProfileStore } from "./profiles.ts";
import { ChildToolRegistry } from "./tool-loader.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(EXTENSION_DIR, "agents");
const TOOLS_DIR = path.join(EXTENSION_DIR, "tools");
const MAX_CONCURRENCY = 4;
const COMPLETION_TYPE = "subagents-complete";
const STATUS_KEY = "subagents";

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
  detached?: boolean;
  outcome?: RunOutcome;
}

/** Text visible to the parent model. Cost is deliberately omitted. */
function outcomeText(thread: SubagentThread, outcome: RunOutcome): string {
  const heading = `Thread ${thread.id} (${thread.profile.name}) · ${outcome.status}`;
  if (outcome.status === "completed")
    return capOutput(`${heading}\n\n${outcome.output}`);
  return capOutput(
    `${heading}\n\n${outcome.error ?? "Subagent did not complete"}${outcome.output ? `\n\nPartial output:\n${outcome.output}` : ""}`,
  );
}

function detailsFor(thread: SubagentThread, detached = false): ToolDetails {
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
    detached,
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

function finalResult(
  thread: SubagentThread,
  outcome: RunOutcome,
  accountUsage = true,
) {
  return {
    content: [{ type: "text" as const, text: outcomeText(thread, outcome) }],
    details: detailsFor(thread),
    ...(accountUsage ? { usage: outcome.usage } : {}),
  };
}

const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class ThreadContainer extends Container {
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private requestRender?: () => void;

  setWorking(working: boolean, requestRender: () => void): void {
    this.requestRender = requestRender;
    if (!working) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.frame = 0;
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % WORKING_FRAMES.length;
      this.requestRender?.();
    }, 80);
    this.timer.unref();
  }

  statusIcon(status: string, theme: any, animated: boolean): string {
    if (status === "running")
      return theme.fg("warning", animated ? WORKING_FRAMES[this.frame] : "▸");
    if (status === "queued") return theme.fg("warning", "◷");
    if (status === "completed") return theme.fg("success", "✓");
    return theme.fg("error", "✗");
  }
}

function threadContainer(
  context: any,
  status: string,
  theme: any,
  animate = false,
): { container: ThreadContainer; icon: string } {
  const container =
    context.lastComponent instanceof ThreadContainer
      ? context.lastComponent
      : new ThreadContainer();
  container.setWorking(animate && status === "running", context.invalidate);
  container.clear();
  return {
    container,
    icon: container.statusIcon(status, theme, animate),
  };
}

function renderPrompt(
  container: Container,
  details: ToolDetails,
  theme: any,
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
  theme: any,
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
  theme: any,
  expanded: boolean,
  isPartial: boolean,
  context: any,
  showName = true,
) {
  const outcome = details.outcome;
  const status = isPartial ? details.state : (outcome?.status ?? details.state);
  const active = status === "running" || status === "queued";
  const { container, icon } = threadContainer(
    context,
    status,
    theme,
    isPartial,
  );
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

function renderBackgroundLaunch(
  details: ToolDetails,
  theme: any,
  expanded: boolean,
) {
  const container = new Container();
  container.addChild(
    new Text(
      `${theme.fg("accent", "↗")} ${theme.fg("toolTitle", theme.bold(details.threadId))} — ${theme.fg("dim", "started in background")}`,
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
  theme: any,
  expanded: boolean,
  context: any,
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
  const pendingNotifications = new Set<string>();
  let currentContext: ExtensionContext | undefined;
  let lastStatus: string | undefined;
  let statusTimer: NodeJS.Timeout | undefined;

  const paintBackgroundStatus = () => {
    statusTimer = undefined;
    const ctx = currentContext;
    if (!ctx) return;
    const status = getBackgroundStatus(manager.list());
    const signature = status ? JSON.stringify(status) : undefined;
    if (signature === lastStatus) return;
    lastStatus = signature;
    if (!status) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const marker = ctx.ui.theme.fg("muted", "◇");
    const label = ctx.ui.theme.fg("muted", "Running in the background:");
    const names = ctx.ui.theme.fg("warning", status.names.join(", "));
    ctx.ui.setStatus(STATUS_KEY, `${marker} ${label} ${names}`);
  };
  const updateBackgroundStatus = () => {
    if (!currentContext) return;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(paintBackgroundStatus, 120);
    statusTimer.unref();
  };
  const callbacks = {
    onThreadChange: updateBackgroundStatus,
    onBackgroundComplete: (thread: SubagentThread) =>
      pendingNotifications.add(thread.id),
    onResultConsumed: (threadId: string) =>
      pendingNotifications.delete(threadId),
  };
  let manager = new ThreadManager(MAX_CONCURRENCY, callbacks);

  const refreshProfiles = (ctx: ExtensionContext): boolean => {
    try {
      const toolsChanged = toolRegistry.refresh();
      profiles.setKnownTools(knownTools());
      const refresh = profiles.refresh();
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
      profile: Type.Optional(
        StringEnum(
          profiles.list().map((item) => item.name),
          {
            description: `Profile for the named child. Include a profile to start a new thread; omit it when continuing an existing one. Available:\n${profiles.describe()}`,
          },
        ),
      ),
      thread: Type.String({
        description:
          "Human-readable thread name, like Tom, Jerry, overengineering_hunter, etc.",
        minLength: 1,
        maxLength: 32,
      }),
      prompt: Type.String({
        description: "Natural-language message for the child.",
        minLength: 1,
      }),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Run independently and notify the parent on completion. Default: false.",
          default: false,
        }),
      ),
    });

  const registerSubagentRunTool = () =>
    pi.registerTool({
      name: "subagent_run",
      label: "Subagent Run",
      description:
        "Start or continue a named thread with an isolated child pi agent.",
      promptSnippet:
        "Start or continue substantial independent work in named subagent threads",
      promptGuidelines: [
        "Use subagents for tasks that benefit from specialized focus, parallel execution, or keeping noisy exploration out of the main context. Avoid overuse; direct tools are enough for simple I/O and small tasks.",
        "Give each new subagent thread a short memorable name and a self-contained initial prompt; continue that thread when its prior context matters.",
        "Default to foreground subagent_run calls. Use background only to work in parallel with subagents. Do not poll; wait while blocked on the result.",
      ],
      parameters: SubagentRunParams(),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        currentContext = ctx;
        if (refreshProfiles(ctx)) registerSubagentRunTool();
        if (!params.prompt.trim()) throw new Error("prompt must be non-empty");
        const background = params.background ?? false;
        const report = background
          ? undefined
          : (thread: SubagentThread) => onUpdate?.(partialResult(thread));
        let thread: SubagentThread;
        if (params.profile) {
          const profile = profiles.get(params.profile);
          if (!profile)
            throw new Error(
              `Unknown subagent profile "${params.profile}". Available: ${profiles
                .list()
                .map((item) => item.name)
                .join(", ")}`,
            );
          const parent = snapshotParent(ctx);
          const profileSnapshot = structuredClone(profile);
          thread = manager.create(
            profileSnapshot,
            params.prompt,
            background,
            () => createChildSession(profileSnapshot, parent, toolRegistry),
            report,
            params.thread,
          );
        } else {
          thread = manager.continue(
            params.thread,
            params.prompt,
            background,
            report,
          );
        }
        if (background) {
          return {
            content: [
              {
                type: "text",
                text: `Started ${thread.id} (${thread.profile.name}) in the background. Its result will be available on the next parent turn or through subagent_control.`,
              },
            ],
            details: detailsFor(thread, true),
          };
        }

        const stop = () => {
          void manager.stop(thread.id);
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
        try {
          const outcome = await manager.wait(thread.id);
          return finalResult(thread, outcome);
        } finally {
          signal?.removeEventListener("abort", stop);
        }
      },
      renderCall(args, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent_run"))} ${theme.fg("accent", args.thread ?? "thread")}${args.profile ? theme.fg("dim", ` (${args.profile})`) : ""}${args.background ? theme.fg("dim", " background") : ""} ${theme.fg("dim", preview(args.prompt ?? "", 70))}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme, context) {
        const details = result.details as ToolDetails | undefined;
        if (details?.detached)
          return renderBackgroundLaunch(details, theme, options.expanded);
        if (details)
          return renderThread(
            details,
            theme,
            options.expanded,
            options.isPartial,
            context,
            Boolean(context.args.profile),
          );
        if (context.lastComponent instanceof ThreadContainer)
          context.lastComponent.setWorking(false, context.invalidate);
        const text =
          result.content.find((part) => part.type === "text")?.text ?? "";
        return new Text(theme.fg("thinkingText", preview(text, 180)), 0, 0);
      },
    });

  const ControlParams = Type.Object({
    thread: Type.String({
      description: "Human-readable thread name used by subagent_run",
      minLength: 1,
      maxLength: 32,
    }),
    action: StringEnum(["status", "wait", "steer", "stop"] as const, {
      description:
        "status is non-blocking; wait joins; steer redirects; stop aborts",
    }),
    message: Type.Optional(
      Type.String({ description: "Required only for steer", minLength: 1 }),
    ),
  });

  pi.registerTool({
    name: "subagent_control",
    label: "Subagent Control",
    description:
      "Inspect, join, redirect, or stop an existing named subagent thread.",
    promptSnippet: "Control existing subagent threads",
    parameters: ControlParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      currentContext = ctx;
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
      return finalResult(thread, outcome, false);
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
      if (context.lastComponent instanceof ThreadContainer)
        context.lastComponent.setWorking(false, context.invalidate);
      const text =
        result.content.find((part) => part.type === "text")?.text ?? "";
      return new Text(theme.fg("thinkingText", preview(text, 180)), 0, 0);
    },
  });

  registerSubagentRunTool();

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    paintBackgroundStatus();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    currentContext = ctx;
    if (refreshProfiles(ctx)) registerSubagentRunTool();
    const completed = [...pendingNotifications]
      .map((id) => manager.get(id))
      .filter((thread): thread is SubagentThread =>
        Boolean(thread?.lastOutcome),
      );
    for (const thread of completed) pendingNotifications.delete(thread.id);
    if (!completed.length) return;
    return {
      message: {
        customType: COMPLETION_TYPE,
        content: capOutput(
          [
            completed.length === 1
              ? "Background subagent completed since the previous turn."
              : `${completed.length} background subagents completed since the previous turn.`,
            ...completed.map(
              (thread) => `\n${outcomeText(thread, thread.lastOutcome!)}`,
            ),
          ].join("\n"),
        ),
        display: false,
        details: { threadIds: completed.map((thread) => thread.id) },
      },
    };
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    lastStatus = undefined;
    pendingNotifications.clear();
    await manager.shutdown();
    manager = new ThreadManager(MAX_CONCURRENCY, callbacks);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    lastStatus = undefined;
    pendingNotifications.clear();
    await manager.shutdown();
    currentContext = undefined;
  });
}
