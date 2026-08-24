import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTodoAction,
  reconstructTodoState,
  type TodoItem,
} from "../core.ts";

const phases: TodoItem[] = [
  { id: 1, title: "Inspect", status: "active" },
  { id: 2, title: "Implement", status: "pending" },
  { id: 3, title: "Verify", status: "pending" },
];

test("new creates an ordered tracker with the first phase active", () => {
  const result = applyTodoAction([], {
    action: "new",
    items: [" Inspect ", "Implement", "Verify"],
  });

  assert.equal(result.error, undefined);
  assert.equal(result.changed, true);
  assert.deepEqual(result.items, phases);
  assert.equal(result.activatedId, 1);
});

test("update completes phases and activates the next pending phase", () => {
  const result = applyTodoAction(phases, {
    action: "update",
    completedIds: [1],
  });

  assert.deepEqual(result.items, [
    { id: 1, title: "Inspect", status: "done" },
    { id: 2, title: "Implement", status: "active" },
    { id: 3, title: "Verify", status: "pending" },
  ]);
  assert.deepEqual(result.completedIds, [1]);
  assert.equal(result.activatedId, 2);
});

test("completing every phase clears the tracker", () => {
  const result = applyTodoAction(
    [
      { id: 1, title: "Inspect", status: "done" },
      { id: 2, title: "Implement", status: "active" },
    ],
    { action: "update", completedIds: [2] },
  );

  assert.deepEqual(result.items, []);
  assert.equal(result.cleared, true);
  assert.equal(result.message, "All phases complete.");
});

test("invalid updates preserve the current tracker", () => {
  const result = applyTodoAction(phases, {
    action: "update",
    completedIds: [99],
  });

  assert.equal(result.error, "item #99 not found");
  assert.equal(result.changed, false);
  assert.deepEqual(result.items, phases);
});

test("reconstruction uses the latest valid todo state on the branch", () => {
  const reconstructed = reconstructTodoState([
    {
      type: "custom",
      customType: "todo_state",
      data: { schemaVersion: 2, items: phases },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: {
          schemaVersion: 2,
          action: "update",
          items: [
            { id: 1, title: "Inspect", status: "done" },
            { id: 2, title: "Implement", status: "active" },
          ],
        },
      },
    },
  ]);

  assert.deepEqual(reconstructed.items, [
    { id: 1, title: "Inspect", status: "done" },
    { id: 2, title: "Implement", status: "active" },
  ]);
});
