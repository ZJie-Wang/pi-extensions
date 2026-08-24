export interface PlanState {
  planModeEnabled: boolean;
  previousTools?: string[];
  lastPlanPath?: string;
}

export interface PlanLifecycleConfig {
  planTools: readonly string[];
  planOnlyTools: readonly string[];
  defaultBuildTools: readonly string[];
}

type PlanLifecycleEvent =
  | {
      type: "enter";
      activeTools: readonly string[];
      availableTools: readonly string[];
    }
  | { type: "leave" | "clear"; availableTools: readonly string[] }
  | {
      type: "reconstruct";
      persistedStates: Iterable<unknown>;
      activeTools: readonly string[];
      availableTools: readonly string[];
      forcePlan: boolean;
    }
  | { type: "plan-written"; absolutePath: string };

export interface PlanLifecycleResult {
  state: PlanState;
  activeTools?: string[];
  unavailablePlanTools?: string[];
  persist?: PlanState;
}

export interface PlanLifecycle {
  readonly state: PlanState;
  dispatch(event: PlanLifecycleEvent): PlanLifecycleResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueToolNames(
  values: readonly unknown[],
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  const names = values.filter(
    (value): value is string =>
      typeof value === "string" && value.length > 0 && !excluded.has(value),
  );
  return [...new Set(names)];
}

function copyState(state: PlanState): PlanState {
  return {
    planModeEnabled: state.planModeEnabled,
    ...(state.previousTools
      ? { previousTools: [...state.previousTools] }
      : {}),
    ...(state.lastPlanPath !== undefined
      ? { lastPlanPath: state.lastPlanPath }
      : {}),
  };
}

export function createPlanLifecycle(
  config: PlanLifecycleConfig,
): PlanLifecycle {
  const planOnlyTools = new Set(config.planOnlyTools);
  const planTools = uniqueToolNames(config.planTools);
  const defaultBuildTools = uniqueToolNames(
    config.defaultBuildTools,
    planOnlyTools,
  );
  let state: PlanState = { planModeEnabled: false };

  const withoutPlanOnlyTools = (values: readonly unknown[]) =>
    uniqueToolNames(values, planOnlyTools);

  const snapshot = () => copyState(state);

  const availableNames = (values: readonly string[]) => new Set(values);

  const filterAvailable = (
    values: readonly string[],
    availableTools: readonly string[],
  ) => {
    const available = availableNames(availableTools);
    return uniqueToolNames(values).filter((name) => available.has(name));
  };

  const planToolEffect = (
    availableTools: readonly string[],
  ): Pick<PlanLifecycleResult, "activeTools" | "unavailablePlanTools"> => {
    const available = availableNames(availableTools);
    return {
      activeTools: planTools.filter((name) => available.has(name)),
      unavailablePlanTools: planTools.filter((name) => !available.has(name)),
    };
  };

  const readState = (value: unknown): PlanState | undefined => {
    if (!isRecord(value)) return undefined;
    return {
      planModeEnabled: value.planModeEnabled === true,
      ...(Array.isArray(value.previousTools)
        ? { previousTools: withoutPlanOnlyTools(value.previousTools) }
        : {}),
      ...(typeof value.lastPlanPath === "string"
        ? { lastPlanPath: value.lastPlanPath }
        : {}),
    };
  };

  const createLifecycleResult = (
    effects: Omit<PlanLifecycleResult, "state"> = {},
  ): PlanLifecycleResult => ({ state: snapshot(), ...effects });

  return {
    get state() {
      return snapshot();
    },

    dispatch(event) {
      switch (event.type) {
        case "enter": {
          if (!state.planModeEnabled) {
            state.previousTools = withoutPlanOnlyTools(event.activeTools);
          }
          state.planModeEnabled = true;
          return createLifecycleResult({
            ...planToolEffect(event.availableTools),
            persist: snapshot(),
          });
        }

        case "leave":
        case "clear": {
          const restore = state.previousTools ?? defaultBuildTools;
          state.planModeEnabled = false;
          state.previousTools = undefined;
          if (event.type === "clear") state.lastPlanPath = undefined;
          return createLifecycleResult({
            activeTools: filterAvailable(
              withoutPlanOnlyTools(restore),
              event.availableTools,
            ),
            persist: snapshot(),
          });
        }

        case "reconstruct": {
          const oldPreviousTools = state.previousTools;
          state = { planModeEnabled: false };

          for (const value of event.persistedStates) {
            const restored = readState(value);
            if (restored) state = restored;
          }

          if (event.forcePlan) {
            if (!state.planModeEnabled) {
              state.previousTools =
                oldPreviousTools ?? withoutPlanOnlyTools(event.activeTools);
            }
            state.planModeEnabled = true;
          }

          let effects: Omit<PlanLifecycleResult, "state"> = {};
          if (state.planModeEnabled) {
            state.previousTools ??=
              oldPreviousTools ?? withoutPlanOnlyTools(event.activeTools);
            effects = planToolEffect(event.availableTools);
          } else if (oldPreviousTools) {
            effects.activeTools = filterAvailable(
              withoutPlanOnlyTools(oldPreviousTools),
              event.availableTools,
            );
          } else if (
            event.activeTools.some((name) => planOnlyTools.has(name))
          ) {
            effects.activeTools = filterAvailable(
              withoutPlanOnlyTools(event.activeTools),
              event.availableTools,
            );
          }

          return createLifecycleResult(effects);
        }

        case "plan-written":
          state.lastPlanPath = event.absolutePath;
          return createLifecycleResult({ persist: snapshot() });
      }
    },
  };
}
