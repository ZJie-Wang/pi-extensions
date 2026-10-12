import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type TodoStatus = "pending" | "active" | "done";
export type TodoAction = "new" | "update" | "clear" | "list";

export type TodoItem = {
  id: number;
  title: string;
  status: TodoStatus;
};

export interface TodoDetails {
  schemaVersion: 2;
  action: TodoAction;
  items: TodoItem[];
  error?: string;
  message?: string;
  completedIds?: number[];
  activatedId?: number;
  cleared?: boolean;
}

export interface TodoState {
  schemaVersion: 2;
  items: TodoItem[];
}

export interface TodoParams {
  action: TodoAction;
  items?: string[];
  completedIds?: number[];
  activeId?: number;
}

export interface TodoOperation extends TodoDetails {
  changed: boolean;
}

export const snapshot = (items: TodoItem[]): TodoState => ({
  schemaVersion: 2,
  items: items.map((item) => ({ ...item })),
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readState = (value: unknown): TodoState | undefined => {
  if (!isObject(value) || value.schemaVersion !== 2 || !Array.isArray(value.items)) return;
  const items: TodoItem[] = [];
  const seen = new Set<number>();
  let hasActive = false;
  for (const item of value.items) {
    if (
      !isObject(item) ||
      typeof item.id !== "number" || !Number.isInteger(item.id) || item.id < 1 ||
      typeof item.title !== "string" || !item.title.trim() ||
      (item.status !== "pending" && item.status !== "active" && item.status !== "done") ||
      seen.has(item.id) || (item.status === "active" && hasActive)
    ) return;
    seen.add(item.id);
    if (item.status === "active") hasActive = true;
    items.push({ id: item.id, title: item.title.trim(), status: item.status });
  }
  return { schemaVersion: 2, items };
};

export const reconstructTodoState = (branch: SessionEntry[]): TodoState => {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    let value: unknown;
    if (entry.type === "custom" && entry.customType === "todo_state") {
      value = entry.data;
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" && entry.message.toolName === "todo"
    ) {
      value = entry.message.details;
    } else {
      continue;
    }
    const state = readState(value);
    if (state) return state;
  }
  return snapshot([]);
};

const phaseSummary = (item: TodoItem) => `#${item.id} ${item.title}`;
const activeItem = (items: TodoItem[]) => items.find((item) => item.status === "active");
const activeSummary = (items: TodoItem[]) => {
  const active = activeItem(items);
  return active ? `Active: ${phaseSummary(active)}` : "No active phase.";
};

export const progressSummary = (items: TodoItem[]) =>
  `${items.filter((item) => item.status === "done").length}/${items.length}`;

export const progressIcon = (items: TodoItem[], completedIds: number[] = []) => {
  if (activeItem(items)) return "●";
  if (completedIds.length > 0 || (items.length > 0 && items.every((item) => item.status === "done"))) return "✓";
  return "○";
};

const ACTION_FIELDS = {
  new: ["action", "items"],
  update: ["action", "completedIds", "activeId"],
  list: ["action"],
  clear: ["action"],
};

// Pi validates the parameter schema; only action-specific rules belong here.
export const applyTodoAction = (items: TodoItem[], params: TodoParams): TodoOperation => {
  const { action } = params;
  const operation = (
    nextItems: TodoItem[],
    extra: Partial<Omit<TodoOperation, "schemaVersion" | "action" | "items">>,
  ): TodoOperation => ({
    schemaVersion: 2,
    action,
    items: nextItems,
    changed: false,
    cleared: false,
    ...extra,
  });
  const error = (message: string) => operation(items, { error: message });
  const extra = Object.keys(params).filter((key) => !ACTION_FIELDS[action].includes(key));
  if (extra.length) return error(`unexpected field for ${action}: ${extra.join(", ")}`);

  switch (action) {
    case "new": {
      if (!params.items?.length) return error("items is required for new");
      const titles = params.items.map((title) => title.trim());
      if (titles.some((title) => !title)) return error("phase titles cannot be empty");
      const next = titles.map((title, index): TodoItem => ({
        id: index + 1,
        title,
        status: index === 0 ? "active" : "pending",
      }));
      return operation(next, {
        message: `Started with ${phaseSummary(next[0])}.`,
        activatedId: next[0].id,
        changed: true,
      });
    }
    case "list":
      return operation(items, { message: activeSummary(items) });
    case "clear":
      return operation([], {
        message: "Cleared todo tracker.",
        cleared: true,
        changed: items.length > 0,
      });
    case "update": {
      if (params.completedIds === undefined && params.activeId === undefined) {
        return error("completedIds or activeId is required for update");
      }
      const byId = new Map(items.map((item) => [item.id, item]));
      const requestedIds = new Set(params.completedIds);
      for (const id of requestedIds) {
        if (!byId.has(id)) return error(`item #${id} not found`);
      }
      if (params.activeId !== undefined) {
        const target = byId.get(params.activeId);
        if (!target) return error(`item #${params.activeId} not found`);
        if (target.status === "done" || requestedIds.has(target.id)) {
          return error(`item #${target.id} is complete`);
        }
      }

      const previousActiveId = activeItem(items)?.id;
      const completedIds = [...requestedIds].filter((id) => byId.get(id)!.status !== "done");
      const next = items.map((item): TodoItem => ({
        ...item,
        status: requestedIds.has(item.id) ? "done" : item.status,
      }));
      if (next.every((item) => item.status === "done")) {
        return operation([], {
          message: "All phases complete.",
          completedIds,
          cleared: true,
          changed: completedIds.length > 0,
        });
      }

      const nextActiveId = params.activeId ?? activeItem(next)?.id ??
        next.find((item) => item.status === "pending")!.id;
      for (const item of next) {
        if (item.id === nextActiveId) item.status = "active";
        else if (item.status === "active") item.status = "pending";
      }
      const activated = nextActiveId !== previousActiveId;
      const completed = completedIds.length > 0
        ? `Completed ${completedIds.map((id) => `#${id}`).join(", ")}.`
        : undefined;
      return operation(next, {
        message: completed
          ? `${completed} ${activeSummary(next)}`
          : activated ? activeSummary(next) : `No change. ${activeSummary(next)}`,
        completedIds,
        ...(activated ? { activatedId: nextActiveId } : {}),
        changed: completedIds.length > 0 || activated,
      });
    }
  }
};

export const todoMessage = (result: TodoOperation) =>
  result.error ? `Error: ${result.error}` : (result.message ?? "ok");

export const listContent = (items: TodoItem[]) => {
  if (items.length === 0) return "No active todo tracker.";
  return items.map((item) => {
    const mark = item.status === "done" ? "✓" : item.status === "active" ? "●" : "○";
    return `${mark} #${item.id} ${item.title}`;
  }).join("\n");
};
