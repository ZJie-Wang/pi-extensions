import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyTodoAction,
  listContent,
  progressIcon,
  progressSummary,
  reconstructTodoState,
  type TodoDetails,
  type TodoItem,
  type TodoOperation,
} from "./core.ts";

const TOOL_NAME = "todo";
const CONTEXT_ENTRY_TYPE = "todo";
const WIDGET_ID = "todo";
const MAX_VISIBLE_ITEMS = 9;
const PROGRESS_BAR_WIDTH = 10;
const STATUS_PRIORITY = { active: 0, pending: 1, done: 2 } as const;

const TodoParams = Type.Object(
  {
    action: StringEnum(["set", "update"] as const, {
      description:
        "set creates or replaces the tracker and activates its first phase; update completes and/or activates phases.",
    }),
    items: Type.Optional(
      Type.Array(Type.String(), {
        description: "Ordered phase titles. Required for set.",
      }),
    ),
    completeIds: Type.Optional(Type.Array(Type.Integer())),
    activateIds: Type.Optional(Type.Array(Type.Integer())),
  },
  { additionalProperties: false },
);

const TodoOutput = Type.Object(
  {
    items: Type.Array(Type.Object({
      id: Type.Integer(),
      title: Type.String(),
      status: StringEnum(["pending", "active", "done"] as const),
    }, { additionalProperties: false })),
    completedIds: Type.Optional(Type.Array(Type.Integer())),
    activatedIds: Type.Optional(Type.Array(Type.Integer())),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export default function (pi: ExtensionAPI) {
  let items: TodoItem[] = [];

  const visibleWidgetItems = () => {
    if (items.length <= MAX_VISIBLE_ITEMS) return items;
    return [...items]
      .sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])
      .slice(0, MAX_VISIBLE_ITEMS);
  };

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (items.length === 0) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }

    const total = items.length;
    const done = items.filter((item) => item.status === "done").length;
    const visible = visibleWidgetItems();
    const remaining = total - visible.length;
    const visibleDone = visible.filter((item) => item.status === "done").length;
    const hiddenDone = done - visibleDone;
    const hiddenOpen = remaining - hiddenDone;
    const hiddenSummary = [
      hiddenOpen > 0 ? `${hiddenOpen} open` : undefined,
      hiddenDone > 0 ? `${hiddenDone} done` : undefined,
    ].filter(Boolean).join(", ");
    const filled = Math.round((done / total) * PROGRESS_BAR_WIDTH);

    ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
      let cache: { width: number; lines: string[] } | undefined;
      let pulseOn = true;
      const hasActiveItem = items.some((item) => item.status === "active");
      const pulseTimer = hasActiveItem
        ? setInterval(() => {
            pulseOn = !pulseOn;
            cache = undefined;
            tui.requestRender();
          }, 1000)
        : undefined;
      pulseTimer?.unref();

      const itemMark = (item: TodoItem) => {
        if (item.status === "done") return theme.fg("success", "✓");
        if (item.status === "active") {
          return pulseOn
            ? theme.fg("warning", "●")
            : theme.fg("muted", "○");
        }
        return theme.fg("dim", "○");
      };
      const itemLabel = (item: TodoItem) => {
        if (item.status === "done") {
          return theme.fg("dim", theme.strikethrough(item.title));
        }
        if (item.status === "active") {
          return theme.fg("warning", theme.bold(item.title));
        }
        return theme.fg("muted", item.title);
      };

      return {
        render: (width: number) => {
          if (cache?.width === width) return cache.lines;

          const lines: string[] = [];
          const inset = " ";
          const progressBar =
            theme.fg("success", "━".repeat(filled)) +
            theme.fg("dim", "─".repeat(PROGRESS_BAR_WIDTH - filled));
          const headingIcon = theme.fg("toolTitle", done < total ? "●" : "✓");
          const heading = `${headingIcon} ${theme.fg("toolTitle", theme.bold("Todos"))} ${theme.fg(
            "muted",
            `${done}/${total}`,
          )} ${progressBar}`;
          lines.push(truncateToWidth(inset + heading, width));

          for (let index = 0; index < visible.length; index++) {
            const item = visible[index];
            const isLastVisible = index === visible.length - 1 && remaining === 0;
            const branch = theme.fg("dim", isLastVisible ? "└─" : "├─");
            const mark = itemMark(item);
            const id = theme.fg(
              item.status === "active" ? "warning" : "dim",
              `${item.id}.`,
            );
            const label = itemLabel(item);
            lines.push(
              truncateToWidth(
                `${inset}${branch} ${mark} ${id} ${label}`,
                width,
              ),
            );
          }

          if (remaining > 0) {
            lines.push(
              truncateToWidth(
                `${inset}${theme.fg("dim", "└─")} ${theme.fg("dim", `+${remaining} more${hiddenSummary ? ` (${hiddenSummary})` : ""}`)}`,
                width,
              ),
            );
          }

          cache = { width, lines };
          return lines;
        },
        invalidate: () => {
          cache = undefined;
        },
        dispose: () => {
          if (pulseTimer) clearInterval(pulseTimer);
        },
      };
    });
  };

  const reconstructState = (ctx: ExtensionContext) => {
    items = reconstructTodoState(ctx.sessionManager.getBranch());
    updateWidget(ctx);
  };

  const resultFromOperation = (operation: TodoOperation) => {
    const { changed: _changed, message, ...details } = operation;
    return {
      content: [{
        type: "text" as const,
        text: operation.error ? `Error: ${operation.error}` : message,
      }],
      details,
      structuredContent: details,
      isError: Boolean(operation.error),
    };
  };

  pi.on("session_start", (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", (_event, ctx) => reconstructState(ctx));
  pi.on("session_compact", (_event, ctx) => {
    if (items.length > 0) {
      pi.sendMessage({
        customType: CONTEXT_ENTRY_TYPE,
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
      "Use todo for complex work with 3+ meaningfully coordinated phases. Once a tracker is set, remember to update it in real time.",
    ],
    parameters: TodoParams,
    outputSchema: TodoOutput,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const operation = applyTodoAction(items, params);
      if (operation.changed) {
        items = operation.items;
        updateWidget(ctx);
      }

      return resultFromOperation(operation);
    },

    renderCall(args, theme: Theme) {
      const actionGlyph = args.action === "set" ? "+" : "→";
      let text =
        theme.fg("toolTitle", theme.bold("todo ")) +
        theme.fg("muted", actionGlyph);
      if (args.action === "set" && args.items !== undefined) {
        text += theme.fg(
          "dim",
          args.items.length === 0 ? " clear" : ` ${args.items.length} phases`,
        );
      }
      if (args.action === "update") {
        const parts = [
          args.completeIds?.length ? `${args.completeIds.length} completed` : undefined,
          args.activateIds?.length ? `${args.activateIds.length} activated` : undefined,
        ].filter(Boolean);
        if (parts.length > 0) text += theme.fg("dim", ` ${parts.join(", ")}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(toolResult, { expanded }, theme: Theme) {
      const details = toolResult.details as TodoDetails | undefined;
      if (!details) return new Text("", 0, 0);
      if (details.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      if (details.items.length === 0) {
        const message = details.completedIds?.length
          ? theme.fg("success", "✓ All phases complete")
          : theme.fg("dim", "No active todo tracker");
        return new Text(message, 0, 0);
      }

      const icon = progressIcon(details.items);
      const iconColor =
        icon === "●" ? "warning" : icon === "✓" ? "success" : "dim";
      let text = theme.fg(iconColor, `${icon} `) +
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
}
