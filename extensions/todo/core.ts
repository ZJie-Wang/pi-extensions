export type TodoStatus = "pending" | "active" | "done";
export type TodoAction = "new" | "update" | "clear" | "list";

export interface TodoItem {
  id: number;
  title: string;
  status: TodoStatus;
}

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

export type TodoParams = {
  action?: TodoAction;
  items?: string[];
  completedIds?: number[];
  activeId?: number;
};

export interface TodoOperation extends TodoDetails {
  changed: boolean;
}

const VALID_STATUSES = new Set<TodoStatus>(["pending", "active", "done"]);
const VALID_ACTIONS = new Set<TodoAction>(["new", "update", "clear", "list"]);

const cloneItems = (items: TodoItem[]) => items.map((item) => ({ ...item }));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unexpectedFields = (
  value: Record<string, unknown>,
  allowed: readonly string[],
) => Object.keys(value).filter((key) => !allowed.includes(key));

export const isTodoItem = (value: unknown): value is TodoItem => {
  if (!isObject(value)) return false;
  return (
    Number.isInteger(value.id) &&
    (value.id as number) >= 1 &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.status === "string" &&
    VALID_STATUSES.has(value.status as TodoStatus)
  );
};

export const sanitizeItems = (value: unknown): TodoItem[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (!value.every(isTodoItem)) return undefined;

  const seen = new Set<number>();
  let activeCount = 0;
  const items = value.map((item) => {
    if (seen.has(item.id)) return undefined;
    seen.add(item.id);
    if (item.status === "active") activeCount++;
    return { id: item.id, title: item.title.trim(), status: item.status };
  });

  if (items.some((item) => item === undefined) || activeCount > 1) {
    return undefined;
  }

  return items as TodoItem[];
};

export const snapshot = (items: TodoItem[]): TodoState => ({
  schemaVersion: 2,
  items: cloneItems(items),
});

export const phaseSummary = (item: TodoItem) => `#${item.id} ${item.title}`;

export const activeItem = (items: TodoItem[]) =>
  items.find((item) => item.status === "active");

export const activeSummary = (items: TodoItem[]) => {
  const active = activeItem(items);
  return active ? `Active: ${phaseSummary(active)}` : "No active phase.";
};

export const progressText = (items: TodoItem[]) => {
  const done = items.filter((item) => item.status === "done").length;
  return `${done}/${items.length}`;
};

export const progressIcon = (items: TodoItem[], completedIds: number[] = []) => {
  if (items.some((item) => item.status === "active")) return "●";
  if (completedIds.length > 0 || (items.length > 0 && items.every((item) => item.status === "done"))) return "✓";
  return "○";
};

export const progressSummary = (items: TodoItem[]) => progressText(items);

export const activationSummary = (
  items: TodoItem[],
  activatedId?: number,
) => {
  if (activatedId === undefined) return undefined;
  const active = items.find((item) => item.id === activatedId);
  return active ? `#${active.id} activated` : undefined;
};

export const isTodoDetails = (value: unknown): value is TodoDetails => {
  if (!isObject(value)) return false;
  if (value.schemaVersion !== undefined && value.schemaVersion !== 2) return false;
  if (typeof value.action !== "string" || !VALID_ACTIONS.has(value.action as TodoAction)) {
    return false;
  }
  return sanitizeItems(value.items) !== undefined;
};

export const stateFromValue = (value: unknown): TodoState | undefined => {
  if (!isObject(value)) return undefined;
  if (value.schemaVersion !== undefined && value.schemaVersion !== 2) return undefined;
  const items = sanitizeItems(value.items);
  return items ? { schemaVersion: 2, items } : undefined;
};

export const reconstructTodoState = (branch: Iterable<any>): TodoState => {
  let state = snapshot([]);

  for (const entry of branch) {
    if (entry?.type === "message") {
      const msg = entry.message;
      if (msg?.role !== "toolResult" || msg?.toolName !== "todo") continue;
      if (!isTodoDetails(msg.details)) continue;
      state = snapshot(msg.details.items);
      continue;
    }

    if (entry?.type === "custom" && entry.customType === "todo_state") {
      const customState = stateFromValue(entry.data);
      if (customState) state = snapshot(customState.items);
    }
  }

  return state;
};

const operation = (
  action: TodoAction,
  items: TodoItem[],
  extra: Partial<Omit<TodoOperation, "schemaVersion" | "action" | "items" | "changed">> &
    { changed?: boolean } = {},
): TodoOperation => ({
  schemaVersion: 2,
  action,
  items: cloneItems(items),
  changed: action !== "list" && !extra.error,
  cleared: false,
  ...extra,
});

const errorOperation = (action: TodoAction, items: TodoItem[], error: string) =>
  operation(action, items, { error, changed: false });

export const applyTodoAction = (
  currentItems: TodoItem[],
  rawParams: TodoParams,
): TodoOperation => {
  const params = rawParams ?? {};
  const action = params.action;

  if (typeof action !== "string" || !VALID_ACTIONS.has(action as TodoAction)) {
    return errorOperation("list", [], "a valid action is required");
  }

  const sanitized = sanitizeItems(currentItems);
  if (!sanitized && action !== "new") {
    return errorOperation(action, [], "invalid todo state");
  }
  const items = cloneItems(sanitized ?? []);

  switch (action) {
    case "new": {
      const extra = unexpectedFields(params as Record<string, unknown>, [
        "action",
        "items",
      ]);
      if (extra.length > 0) {
        return errorOperation(action, items, `unexpected field for new: ${extra.join(", ")}`);
      }
      if (!Array.isArray(params.items) || params.items.length === 0) {
        return errorOperation(action, items, "items is required for new");
      }
      if (!params.items.every((item) => typeof item === "string")) {
        return errorOperation(action, items, "phase titles must be strings");
      }

      const cleaned = params.items.map((item) => item.trim());
      if (cleaned.some((title) => title.length === 0)) {
        return errorOperation(action, items, "phase titles cannot be empty");
      }

      const nextItems = cleaned.map((title, index) => ({
        id: index + 1,
        title,
        status: (index === 0 ? "active" : "pending") as TodoStatus,
      }));
      const active = nextItems[0];

      return operation(action, nextItems, {
        message: `Started with ${phaseSummary(active)}.`,
        activatedId: active.id,
      });
    }

    case "list": {
      const extra = unexpectedFields(params as Record<string, unknown>, ["action"]);
      if (extra.length > 0) {
        return errorOperation(action, items, `unexpected field for list: ${extra.join(", ")}`);
      }
      return operation(action, items, { message: activeSummary(items), changed: false });
    }

    case "clear": {
      const extra = unexpectedFields(params as Record<string, unknown>, ["action"]);
      if (extra.length > 0) {
        return errorOperation(action, items, `unexpected field for clear: ${extra.join(", ")}`);
      }
      return operation(action, [], {
        message: "Cleared todo tracker.",
        cleared: true,
        changed: items.length > 0,
      });
    }

    case "update": {
      const extra = unexpectedFields(params as Record<string, unknown>, [
        "action",
        "completedIds",
        "activeId",
      ]);
      if (extra.length > 0) {
        return errorOperation(action, items, `unexpected field for update: ${extra.join(", ")}`);
      }

      const requestedIds = params.completedIds ?? [];
      if (requestedIds.length === 0) {
        return errorOperation(action, items, "completedIds is required for update");
      }

      const seenIds = new Set<number>();
      for (const id of requestedIds) {
        if (!Number.isInteger(id) || id < 1) {
          return errorOperation(action, items, "completedIds must contain positive integers");
        }
        if (seenIds.has(id)) {
          return errorOperation(action, items, `duplicate completed id #${id}`);
        }
        seenIds.add(id);
        if (!items.some((item) => item.id === id)) {
          return errorOperation(action, items, `item #${id} not found`);
        }
      }

      if (params.activeId !== undefined) {
        const target = items.find((item) => item.id === params.activeId);
        if (!target) {
          return errorOperation(action, items, `item #${params.activeId} not found`);
        }
        if (target.status === "done" || seenIds.has(target.id)) {
          return errorOperation(action, items, `item #${target.id} is complete`);
        }
      }

      const previousActiveId = activeItem(items)?.id;
      const completedIds: number[] = [];
      for (const id of requestedIds) {
        const item = items.find((entry) => entry.id === id)!;
        if (item.status !== "done") {
          item.status = "done";
          completedIds.push(id);
        }
      }

      if (items.every((item) => item.status === "done")) {
        return operation(action, [], {
          message: "All phases complete.",
          completedIds,
          cleared: true,
          changed: completedIds.length > 0,
        });
      }

      if (params.activeId !== undefined) {
        for (const item of items) {
          if (item.status === "active") item.status = "pending";
        }
        items.find((item) => item.id === params.activeId)!.status = "active";
      } else if (!activeItem(items)) {
        items.find((item) => item.status === "pending")!.status = "active";
      }

      const active = activeItem(items);
      const activatedId = active?.id !== previousActiveId ? active?.id : undefined;
      const completed =
        completedIds.length === 1
          ? `Completed #${completedIds[0]}.`
          : completedIds.length > 1
            ? `Completed ${completedIds.map((id) => `#${id}`).join(", ")}.`
            : undefined;
      const message = completed
        ? `${completed} ${activeSummary(items)}`
        : activatedId !== undefined
          ? activeSummary(items)
          : `No change. ${activeSummary(items)}`;

      return operation(action, items, {
        message,
        completedIds,
        activatedId,
        changed: completedIds.length > 0 || activatedId !== undefined,
      });
    }
  }
};

export const todoMessage = (result: TodoOperation) =>
  result.error ? `Error: ${result.error}` : (result.message ?? "ok");

export const listContent = (items: TodoItem[]) => {
  if (items.length === 0) return "No active todo tracker.";
  return items
    .map((item) => {
      const mark = item.status === "done" ? "✓" : item.status === "active" ? "●" : "○";
      return `${mark} #${item.id} ${item.title}`;
    })
    .join("\n");
};
