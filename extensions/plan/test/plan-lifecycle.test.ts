import assert from "node:assert/strict";
import test from "node:test";
import { createPlanLifecycle } from "../lib/plan-lifecycle.ts";

const availableTools = ["read", "bash", "edit", "write", "present_plan"];

function createLifecycle() {
  return createPlanLifecycle({
    planTools: ["read", "bash", "missing", "present_plan"],
    planOnlyTools: ["present_plan"],
    defaultBuildTools: ["read", "bash", "edit", "write"],
  });
}

test("enter captures build tools once and returns plan-mode effects", () => {
  const lifecycle = createLifecycle();

  const entered = lifecycle.dispatch({
    type: "enter",
    activeTools: ["read", "edit", "present_plan", "edit"],
    availableTools,
  });

  assert.deepEqual(entered.activeTools, ["read", "bash", "present_plan"]);
  assert.deepEqual(entered.unavailablePlanTools, ["missing"]);
  assert.deepEqual(entered.persist, {
    planModeEnabled: true,
    previousTools: ["read", "edit"],
  });

  const repeated = lifecycle.dispatch({
    type: "enter",
    activeTools: ["bash"],
    availableTools,
  });
  assert.deepEqual(repeated.state.previousTools, ["read", "edit"]);
});

test("leave restores the captured build tools and retains the plan path", () => {
  const lifecycle = createLifecycle();
  lifecycle.dispatch({
    type: "enter",
    activeTools: ["read", "edit"],
    availableTools,
  });
  lifecycle.dispatch({ type: "plan-written", absolutePath: "/repo/PLAN.md" });

  const left = lifecycle.dispatch({ type: "leave", availableTools });

  assert.deepEqual(left.activeTools, ["read", "edit"]);
  assert.deepEqual(left.persist, {
    planModeEnabled: false,
    lastPlanPath: "/repo/PLAN.md",
  });
});

test("clear restores fallback tools and removes the plan path", () => {
  const lifecycle = createLifecycle();
  lifecycle.dispatch({ type: "plan-written", absolutePath: "/repo/PLAN.md" });

  const cleared = lifecycle.dispatch({ type: "clear", availableTools });

  assert.deepEqual(cleared.activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(cleared.persist, { planModeEnabled: false });
});

test("reconstruct uses the last state entry without writing a duplicate", () => {
  const lifecycle = createLifecycle();
  const reconstructed = lifecycle.dispatch({
    type: "reconstruct",
    persistedStates: [
      { planModeEnabled: false },
      {
        planModeEnabled: true,
        previousTools: ["read", 42, "edit", "present_plan", "read"],
        lastPlanPath: "/repo/PLAN.md",
      },
    ],
    activeTools: ["read", "edit"],
    availableTools,
    forcePlan: false,
  });

  assert.deepEqual(reconstructed.state, {
    planModeEnabled: true,
    previousTools: ["read", "edit"],
    lastPlanPath: "/repo/PLAN.md",
  });
  assert.deepEqual(reconstructed.activeTools, ["read", "bash", "present_plan"]);
  assert.equal(reconstructed.persist, undefined);
});

test("force-plan reconstruction captures current tools without persisting", () => {
  const lifecycle = createLifecycle();
  const reconstructed = lifecycle.dispatch({
    type: "reconstruct",
    persistedStates: [],
    activeTools: ["read", "edit", "present_plan"],
    availableTools,
    forcePlan: true,
  });

  assert.deepEqual(reconstructed.state, {
    planModeEnabled: true,
    previousTools: ["read", "edit"],
  });
  assert.deepEqual(reconstructed.activeTools, ["read", "bash", "present_plan"]);
  assert.equal(reconstructed.persist, undefined);
});

test("disabled reconstruction removes stale plan-only tools", () => {
  const lifecycle = createLifecycle();
  const reconstructed = lifecycle.dispatch({
    type: "reconstruct",
    persistedStates: [],
    activeTools: ["read", "present_plan", "edit"],
    availableTools,
    forcePlan: false,
  });

  assert.deepEqual(reconstructed.activeTools, ["read", "edit"]);
  assert.deepEqual(reconstructed.state, { planModeEnabled: false });
  assert.equal(reconstructed.persist, undefined);
});

test("disabled reconstruction restores tools captured before plan mode", () => {
  const lifecycle = createLifecycle();
  lifecycle.dispatch({
    type: "enter",
    activeTools: ["read", "edit"],
    availableTools,
  });

  const reconstructed = lifecycle.dispatch({
    type: "reconstruct",
    persistedStates: [{ planModeEnabled: false }],
    activeTools: ["read", "bash", "present_plan"],
    availableTools,
    forcePlan: false,
  });

  assert.deepEqual(reconstructed.activeTools, ["read", "edit"]);
  assert.deepEqual(reconstructed.state, { planModeEnabled: false });
});
