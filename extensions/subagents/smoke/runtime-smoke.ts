import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

export default async function runtimeSmoke(pi: ExtensionAPI): Promise<void> {
  const tools = new Map<string, any>();
  const proxy = new Proxy(pi, {
    get(target, property, receiver) {
      if (property !== "registerTool") return Reflect.get(target, property, receiver);
      return (tool: { name: string }) => {
        tools.set(tool.name, tool);
        return target.registerTool(tool as any);
      };
    },
  });
  extension(proxy);

  const actual = [...tools.keys()].sort();
  const expected = ["subagent_control", "subagent_run"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected parent tools ${expected.join(", ")}; got ${actual.join(", ")}`);
  }
  for (const name of expected) {
    if (!tools.get(name)?.promptSnippet) {
      throw new Error(`Expected ${name} in the system prompt's available tool list`);
    }
  }

  const properties = tools.get("subagent_run")?.parameters?.properties ?? {};
  const fields = Object.keys(properties).sort();
  const expectedFields = ["background", "profile", "prompt", "thread"];
  if (JSON.stringify(fields) !== JSON.stringify(expectedFields)) {
    throw new Error(`Expected subagent_run fields ${expectedFields.join(", ")}; got ${fields.join(", ")}`);
  }
  const runTool = tools.get("subagent_run");
  const required = [...(runTool?.parameters?.required ?? [])].sort();
  if (JSON.stringify(required) !== JSON.stringify(["prompt", "thread"])) {
    throw new Error(`Expected prompt and thread to be required; got ${required.join(", ")}`);
  }

  const theme = {
    bold: (text: string) => text,
    italic: (text: string) => text,
    fg: (_color: string, text: string) => text,
  };
  const details = {
    threadId: "Ada",
    profile: "scout",
    state: "running",
    activity: "working",
    tools: [],
    toolCount: 0,
    lastMessage: "",
    prompt: `${"Inspect every renderer detail carefully. ".repeat(8)}PROMPT_TAIL_SENTINEL`,
    startedAt: Date.now(),
  };
  let resolveFirstTick!: () => void;
  const firstTick = new Promise<void>((resolve) => {
    resolveFirstTick = resolve;
  });
  const context: any = {
    args: { profile: "scout" },
    invalidate: resolveFirstTick,
    lastComponent: undefined,
    state: {},
  };
  const running = runTool.renderResult(
    { content: [], details },
    { expanded: true, isPartial: true },
    theme,
    context,
  );
  const rendered = running.render(120).join("\n");
  if (
    !rendered.includes("Inspect every renderer detail") ||
    !rendered.includes("PROMPT_TAIL_SENTINEL\n┄") ||
    !rendered.includes("┄\n\n")
  ) {
    throw new Error(
      "Expanded foreground renderer did not include the full child prompt",
    );
  }
  if (
    !rendered.includes("⠋") ||
    rendered.includes("●") ||
    !(running as any).timer
  ) {
    throw new Error("Running foreground renderer did not use the animated working indicator");
  }

  context.lastComponent = running;
  let tickTimeout: NodeJS.Timeout | undefined;
  await Promise.race([
    firstTick,
    new Promise<never>((_resolve, reject) => {
      tickTimeout = setTimeout(
        () => reject(new Error("Working indicator did not advance")),
        500,
      );
    }),
  ]).finally(() => {
    if (tickTimeout) clearTimeout(tickTimeout);
  });
  const advanced = runTool.renderResult(
    { content: [], details },
    { expanded: true, isPartial: true },
    theme,
    context,
  );
  if (!advanced.render(120).join("\n").includes("⠙")) {
    throw new Error("Working indicator timer did not render the next frame");
  }

  const settledDetails = {
    ...details,
    state: "idle",
    outcome: {
      status: "completed",
      output: "Done",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
        turns: 0,
      },
      startedAt: Date.now(),
      endedAt: Date.now(),
    },
  };
  runTool.renderResult(
    { content: [], details: settledDetails },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  if ((running as any).timer) {
    throw new Error("Foreground renderer did not stop its animation after completion");
  }

  const backgroundContext: any = {
    args: { profile: "scout", background: true },
    invalidate() {},
    lastComponent: undefined,
    state: {},
  };
  const background = runTool.renderResult(
    { content: [], details: { ...details, detached: true } },
    { expanded: true, isPartial: false },
    theme,
    backgroundContext,
  );
  const backgroundText = background.render(120).join("\n");
  if (!backgroundText.includes("PROMPT_TAIL_SENTINEL")) {
    throw new Error("Expanded background renderer did not include the prompt");
  }

  const waitContext: any = {
    args: { action: "wait" },
    invalidate() {},
    lastComponent: undefined,
    state: {},
  };
  const waited = tools.get("subagent_control").renderResult(
    { content: [], details: settledDetails },
    { expanded: true, isPartial: false },
    theme,
    waitContext,
  );
  const waitedText = waited.render(120).join("\n");
  if (!waitedText.includes("PROMPT_TAIL_SENTINEL")) {
    throw new Error("Expanded wait renderer did not include the prompt");
  }

  const statusContext: any = {
    args: { action: "status" },
    invalidate() {},
    lastComponent: undefined,
    state: {},
  };
  const status = tools.get("subagent_control").renderResult(
    { content: [], details },
    { expanded: false, isPartial: false },
    theme,
    statusContext,
  );
  const statusText = status.render(120).join("\n");
  if ((status as any).timer) {
    throw new Error("One-shot status renderer left a working animation running");
  }
  if (!statusText.includes("▸") || statusText.includes("⠋")) {
    throw new Error("One-shot running status did not use the static activity icon");
  }
}
