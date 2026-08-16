import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  activationSummary,
  applyTodoAction,
  listContent,
  progressIcon,
  progressSummary,
  reconstructTodoState,
  snapshot,
  todoMessage,
  type TodoDetails,
  type TodoItem,
  type TodoOperation,
  type TodoState,
} from "./core.ts";

const TOOL_NAME = "todo";
const STATE_ENTRY_TYPE = "todo_state";
const WIDGET_ID = "todo";

const TodoParams = Type.Object(
  {
    action: StringEnum(["new", "update", "list", "clear"] as const, {
      description:
        "Action: new creates or replaces the tracker and activates its first phase; update records the progress; list returns the tracker; clear removes it.",
    }),
    items: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          description: "Phase title.",
        }),
        {
          minItems: 1,
          description: "Ordered phase titles. Required for new.",
        },
      ),
    ),
    completedIds: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1 }), {
        minItems: 1,
        uniqueItems: true,
        description:
          "IDs completed; required for update. If the active phase is completed, the next pending phase becomes active automatically.",
      }),
    ),
    activeId: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "ID of an unfinished phase to jump to manually.",
      }),
    ),
  },
  { additionalProperties: false },
);

export default function (pi: ExtensionAPI) {
  let items: TodoItem[] = [];

  const reconstructState = (ctx: ExtensionContext) => {
    items = reconstructTodoState(ctx.sessionManager.getBranch()).items;
    updateWidget(ctx);
  };

  const visibleWidgetItems = (limit: number) => {
    if (items.length <= limit) return items;

    const activeItems = items.filter((item) => item.status === "active");
    const pendingItems = items.filter((item) => item.status === "pending");
    const doneItems = items.filter((item) => item.status === "done");
    const prioritized = [...activeItems, ...pendingItems, ...doneItems];
    return prioritized.slice(0, limit);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (items.length === 0) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
      let cachedLines: string[] | undefined;
      let cacheWidth = -1;
      let pulseOn = true;
      const hasActiveItem = items.some((item) => item.status === "active");
      const pulseTimer = hasActiveItem
        ? setInterval(() => {
            pulseOn = !pulseOn;
            cachedLines = undefined;
            tui.requestRender();
          }, 1000)
        : undefined;
      (pulseTimer as any)?.unref?.();

      return {
        render: (width: number) => {
          if (cachedLines && cacheWidth === width) return cachedLines;

          const lines: string[] = [];
          const done = items.filter((item) => item.status === "done").length;
          const visible = visibleWidgetItems(9);
          const hasOpenWork = items.some((item) => item.status !== "done");
          const progressWidth = 10;
          const filled =
            items.length > 0
              ? Math.round((done / items.length) * progressWidth)
              : 0;
          const inset = " ";
          const progressBar =
            theme.fg("success", "━".repeat(filled)) +
            theme.fg("dim", "─".repeat(progressWidth - filled));
          const headingIcon = theme.fg("toolTitle", hasOpenWork ? "●" : "✓");
          const heading = `${headingIcon} ${theme.fg("toolTitle", theme.bold("Todos"))} ${theme.fg(
            "muted",
            `${done}/${items.length}`,
          )} ${progressBar}`;
          lines.push(truncateToWidth(inset + heading, width));

          for (let index = 0; index < visible.length; index++) {
            const item = visible[index];
            const isLastVisible =
              index === visible.length - 1 && items.length === visible.length;
            const branch = theme.fg("dim", isLastVisible ? "└─" : "├─");
            const mark =
              item.status === "done"
                ? theme.fg("success", "✓")
                : item.status === "active"
                  ? pulseOn
                    ? theme.fg("warning", "●")
                    : theme.fg("muted", "○")
                  : theme.fg("dim", "○");
            const id = theme.fg(
              item.status === "active" ? "warning" : "dim",
              `${item.id}.`,
            );
            const label =
              item.status === "done"
                ? theme.fg("dim", theme.strikethrough(item.title))
                : item.status === "active"
                  ? theme.fg("warning", theme.bold(item.title))
                  : theme.fg("muted", item.title);
            lines.push(
              truncateToWidth(
                `${inset}${branch} ${mark} ${id} ${label}`,
                width,
              ),
            );
          }

          if (items.length > visible.length) {
            const visibleIds = new Set(visible.map((item) => item.id));
            const hidden = items.filter((item) => !visibleIds.has(item.id));
            const remaining = hidden.length;
            const hiddenDone = hidden.filter(
              (item) => item.status === "done",
            ).length;
            const hiddenOpen = remaining - hiddenDone;
            const extra = [
              hiddenOpen > 0 ? `${hiddenOpen} open` : undefined,
              hiddenDone > 0 ? `${hiddenDone} done` : undefined,
            ]
              .filter(Boolean)
              .join(", ");
            lines.push(
              truncateToWidth(
                `${inset}${theme.fg("dim", "└─")} ${theme.fg("dim", `+${remaining} more${extra ? ` (${extra})` : ""}`)}`,
                width,
              ),
            );
          }

          cachedLines = lines;
          cacheWidth = width;
          return lines;
        },
        invalidate: () => {
          cachedLines = undefined;
        },
        dispose: () => {
          if (pulseTimer) clearInterval(pulseTimer);
        },
      };
    });
  };

  const persistState = () => {
    pi.appendEntry(STATE_ENTRY_TYPE, snapshot(items) satisfies TodoState);
  };

  const resultFromOperation = (operation: TodoOperation) => ({
    content: [
      {
        type: "text" as const,
        text:
          operation.action === "list" && !operation.error
            ? listContent(operation.items)
            : todoMessage(operation),
      },
    ],
    details: {
      schemaVersion: 2,
      action: operation.action,
      items: operation.items.map((item) => ({ ...item })),
      error: operation.error,
      message: operation.message,
      completedIds: operation.completedIds,
      activatedId: operation.activatedId,
      cleared: operation.cleared,
    } satisfies TodoDetails,
  });

  pi.on("session_start", (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", (_event, ctx) => reconstructState(ctx));
  pi.on("session_compact", (_event, ctx) => {
    if (items.length > 0) {
      persistState();
      pi.sendMessage({
        customType: STATE_ENTRY_TYPE,
        content: `Todo tracker:\n${listContent(items)}`,
        display: false,
      });
    }
    updateWidget(ctx);
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Todo",
    description: "Track complex work in phases.",
    promptSnippet: "Track multi-phase progress",
    promptGuidelines: [
      "Use todo for complex, multi-step work with at least three meaningfully coordinated phases. Skip it for simple tasks or when coordination adds no value.",
      "Once a todo tracker is started, remember to update it promptly after each phase completes.",
    ],
    parameters: TodoParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const operation = applyTodoAction(
        items,
        params as Parameters<typeof applyTodoAction>[1],
      );

      if (!operation.error) {
        items = operation.items.map((item) => ({ ...item }));
        if (operation.changed) persistState();
        updateWidget(ctx);
      }

      return resultFromOperation(operation);
    },

    renderCall(args, theme: Theme) {
      const actionGlyph =
        args.action === "new"
          ? "+"
          : args.action === "update"
            ? "→"
            : args.action === "list"
              ? "?"
              : "∅";
      let text =
        theme.fg("toolTitle", theme.bold("todo ")) +
        theme.fg("muted", actionGlyph);
      if (args.action === "new" && args.items) {
        text += theme.fg("dim", ` ${args.items.length} phases`);
      }
      if (args.action === "update" && args.completedIds?.length) {
        text += theme.fg("dim", ` ${args.completedIds.length} completed`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(toolResult, { expanded }, theme: Theme) {
      const details = toolResult.details as TodoDetails | undefined;
      if (!details) return new Text("", 0, 0);
      if (details.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      const completedIds = details.completedIds ?? [];
      if (details.items.length === 0) {
        const emptyMessage =
          completedIds.length > 0
            ? theme.fg("success", "✓ All phases complete")
            : theme.fg("dim", "No active todo tracker");
        return new Text(emptyMessage, 0, 0);
      }

      const icon = progressIcon(details.items, completedIds);
      const iconColor =
        icon === "●" ? "warning" : icon === "✓" ? "success" : "dim";
      const activated = activationSummary(details.items, details.activatedId);
      let text = activated
        ? `${theme.fg("muted", "→")} ${theme.fg("accent", activated)}`
        : theme.fg(iconColor, `${icon} `) +
          theme.fg("muted", progressSummary(details.items));

      if (expanded) {
        for (const item of details.items) {
          const mark =
            item.status === "done"
              ? theme.fg("success", "✓")
              : item.status === "active"
                ? theme.fg("warning", "●")
                : theme.fg("dim", "○");
          const label =
            item.status === "done"
              ? theme.fg("dim", item.title)
              : item.status === "active"
                ? theme.fg("warning", item.title)
                : theme.fg("muted", item.title);
          text += `\n${mark} ${theme.fg("accent", `${item.id}.`)} ${label}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("todos", {
    description: "Show or clear the todo tracker (/todos clear)",
    handler: async (args, ctx) => {
      if (args?.trim().toLowerCase() === "clear") {
        items = [];
        persistState();
        updateWidget(ctx);
        if (ctx.hasUI) ctx.ui.notify("Cleared todo tracker.", "info");
        return;
      }

      updateWidget(ctx);
      if (ctx.hasUI) {
        const pending = items.filter((item) => item.status === "pending");
        const active = items.filter((item) => item.status === "active");
        const done = items.filter((item) => item.status === "done");
        const lines: string[] = [];

        if (active.length > 0) {
          lines.push("── Active ──");
          for (const item of active)
            lines.push(`  ● ${item.id}. ${item.title}`);
        }
        if (pending.length > 0) {
          lines.push("── Pending ──");
          for (const item of pending)
            lines.push(`  ○ ${item.id}. ${item.title}`);
        }
        if (done.length > 0) {
          lines.push("── Done ──");
          for (const item of done) lines.push(`  ✓ ${item.id}. ${item.title}`);
        }

        ctx.ui.notify(
          lines.length > 0 ? lines.join("\n") : "No active todo tracker.",
          "info",
        );
      }
    },
  });
}
