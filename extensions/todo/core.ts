import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type TodoStatus = "pending" | "active" | "done";
export type TodoAction = "set" | "update";

export type TodoItem = {
  id: number;
  title: string;
  status: TodoStatus;
};

export interface TodoDetails {
  items: TodoItem[];
  completedIds?: number[];
  activatedIds?: number[];
  error?: string;
}

export interface TodoParams {
  action: TodoAction;
  items?: string[];
  completeIds?: number[];
  activateIds?: number[];
}

export interface TodoOperation extends TodoDetails {
  changed: boolean;
  message: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readItem = (value: unknown): TodoItem | undefined => {
  if (!isObject(value)) return;
  const { id, title, status } = value;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return;
  if (typeof title !== "string" || !title.trim()) return;
  if (status !== "pending" && status !== "active" && status !== "done") return;
  return { id, title: title.trim(), status };
};

const readItems = (value: unknown): TodoItem[] | undefined => {
  if (!isObject(value) || !Array.isArray(value.items)) return;
  const items: TodoItem[] = [];
  const seen = new Set<number>();
  for (const raw of value.items) {
    const item = readItem(raw);
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  }
  return items;
};

export const reconstructTodoState = (branch: SessionEntry[]): TodoItem[] => {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== "todo"
    ) continue;
    const items = readItems(entry.message.details);
    if (items) return items;
  }
  return [];
};

const phaseSummary = (item: TodoItem) => `#${item.id} ${item.title}`;
const activeSummary = (items: TodoItem[]) => {
  const active = items.filter((item) => item.status === "active");
  return active.length > 0
    ? `Active: ${active.map(phaseSummary).join(", ")}`
    : "No active phase.";
};

export const progressSummary = (items: TodoItem[]) =>
  `${items.filter((item) => item.status === "done").length}/${items.length}`;

export const progressIcon = (items: TodoItem[]) => {
  if (items.some((item) => item.status === "active")) return "●";
  if (items.length > 0 && items.every((item) => item.status === "done")) return "✓";
  return "○";
};

export const applyTodoAction = (items: TodoItem[], params: TodoParams): TodoOperation => {
  const { action } = params;
  const result = (
    nextItems: TodoItem[],
    message: string,
    details: Partial<Omit<TodoDetails, "items">> & { changed?: boolean } = {},
  ): TodoOperation => ({
    items: nextItems,
    message,
    changed: true,
    ...details,
  });
  const error = (message: string) => result(items, "", { changed: false, error: message });

  switch (action) {
    case "set": {
      if (params.items === undefined) {
        return error("items is required for set (pass an empty list to clear)");
      }
      const titles = params.items.map((title) => title.trim());
      if (titles.some((title) => !title)) return error("phase titles cannot be empty");
      if (titles.length === 0) {
        return result([], "Cleared todo tracker.", { changed: items.length > 0 });
      }
      const next = titles.map((title, index): TodoItem => ({
        id: index + 1,
        title,
        status: index === 0 ? "active" : "pending",
      }));
      return result(next, `Set tracker. Active: ${phaseSummary(next[0])}.`);
    }
    case "update": {
      const complete = new Set(params.completeIds ?? []);
      const activate = new Set(params.activateIds ?? []);
      if (complete.size === 0 && activate.size === 0) {
        return error("completeIds or activateIds is required for update");
      }

      const byId = new Map(items.map((item) => [item.id, item]));
      const missingId = [...complete, ...activate].find((id) => !byId.has(id));
      if (missingId !== undefined) return error(`item #${missingId} not found`);
      const overlapId = [...activate].find((id) => complete.has(id));
      if (overlapId !== undefined) return error(`cannot complete and activate #${overlapId}`);
      const alreadyDoneId = [...activate].find((id) => byId.get(id)?.status === "done");
      if (alreadyDoneId !== undefined) return error(`item #${alreadyDoneId} is complete`);

      const completedIds = [...complete].filter((id) => byId.get(id)?.status !== "done");
      const activatedIds = [...activate].filter((id) => byId.get(id)?.status !== "active");
      if (completedIds.length === 0 && activatedIds.length === 0) {
        return result(items, `No change. ${activeSummary(items)}`, { changed: false });
      }

      const next = items.map((item): TodoItem => {
        if (complete.has(item.id)) return { ...item, status: "done" };
        if (activate.has(item.id)) return { ...item, status: "active" };
        return item;
      });

      if (next.every((item) => item.status === "done")) {
        return result([], "All phases complete.", { completedIds });
      }

      const parts: string[] = [];
      if (completedIds.length > 0) {
        parts.push(`Completed ${completedIds.map((id) => `#${id}`).join(", ")}.`);
      }
      if (activatedIds.length > 0) {
        parts.push(`Activated ${activatedIds.map((id) => `#${id}`).join(", ")}.`);
      }
      return result(next, `${parts.join(" ")} ${activeSummary(next)}`, {
        completedIds,
        activatedIds,
      });
    }
  }
};

export const listContent = (items: TodoItem[]) =>
  items.map((item) => {
    const mark = item.status === "done" ? "✓" : item.status === "active" ? "●" : "○";
    return `${mark} #${item.id} ${item.title}`;
  }).join("\n");
