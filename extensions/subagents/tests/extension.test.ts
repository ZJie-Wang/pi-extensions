import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import subagents from "../index.ts";
import { emptyUsage, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../core.ts";
import { assistant, deferred, response, testRuntime, tick } from "./helpers.ts";

async function extension(handler?: Parameters<typeof testRuntime>[0], mode = "print") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extension-test-"));
  const runtime = await testRuntime(handler);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const messages: any[] = [];
  const widgets = new Map<string, any>();
  const widgetCalls: any[] = [];
  const statuses: any[] = [];
  let renderRequests = 0;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const pi = {
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
    on: (event: string, handler: Function) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    sendMessage: (message: any, options: any) => { messages.push({ message, options }); },
    getSettings: () => ({ packages: [], skills: [], extensions: [], retry: { enabled: false }, compaction: { enabled: false } }),
  };
  const ctx = {
    cwd,
    mode,
    model: runtime.getModel("subagent-test", "test"),
    thinkingLevel: "off",
    scopedModels: [],
    modelRegistry: {
      runtime,
      find: (provider: string, id: string) => runtime.getModel(provider, id),
      getAll: () => runtime.getModels(),
    },
    isProjectTrusted: () => false,
    ui: {
      theme,
      setStatus: (...args: any[]) => { statuses.push(args); },
      setWidget: (key: string, content: any, options: any) => {
        widgets.get(key)?.dispose?.();
        widgets.delete(key);
        widgetCalls.push({ key, content, options });
        if (content) widgets.set(key, content({ requestRender: () => { renderRequests++; } }, theme));
      },
      notify: () => {},
    },
  };
  subagents(pi as unknown as ExtensionAPI);
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
    return result;
  };
  await emit("session_start");
  return {
    tools, handlers, messages, ctx, emit, widgets, widgetCalls, statuses,
    renderRequests: () => renderRequests,
    async dispose() {
      try {
        await emit("session_shutdown");
        await rm(cwd, { recursive: true, force: true });
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    },
  };
}

test("schema uses explicit flat actions and rejects obsolete background arguments", async () => {
  const fixture = await extension();
  try {
    const run = fixture.tools.get("subagent_run");
    assert.equal(run.exposure, "model-only");
    assert.equal(fixture.tools.get("subagent_control").exposure, "model-only");
    assert.ok(Check(run.parameters, { action: "new", profile: "scout", thread: "Map", prompt: "task" }));
    assert.ok(Check(run.parameters, { action: "continue", thread: "Map", prompt: "task" }));
    assert.ok(!Check(run.parameters, { profile: "scout", thread: "Map", prompt: "task" }));
    assert.ok(!Check(run.parameters, { action: "new", profile: "scout", thread: "Map", prompt: "task", background: true }));
    assert.ok(!Check(run.parameters, { action: "new", profile: "scout", thread: "123", prompt: "task" }));
    await assert.rejects(run.execute("id", { action: "new", thread: "Map", prompt: "task" }, undefined, undefined, fixture.ctx), /profile is required/);
    await assert.rejects(run.execute("id", { action: "continue", profile: "scout", thread: "Map", prompt: "task" }, undefined, undefined, fixture.ctx), /omit profile/);
    assert.ok(!fixture.handlers.has("session_before_switch"));
  } finally {
    await fixture.dispose();
  }
});

test("launch renderer omits new and keeps continue visible", async () => {
  const fixture = await extension();
  try {
    const run = fixture.tools.get("subagent_run");
    const render = (action: string) => run.renderCall(
      { action, thread: "Map", profile: "scout", prompt: "task" }, fixture.ctx.ui.theme,
    ).render(100).join("\n").trim();
    assert.equal(render("new"), "subagent_run Map (scout) task");
    assert.equal(render("continue"), "subagent_run continue Map (scout) task");
  } finally {
    await fixture.dispose();
  }
});

test("README tool payloads match the registered definitions", async () => {
  const fixture = await extension();
  try {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const payloads = [...readme.matchAll(/\*\*Tool definition\*\* \(request payload\):\n\n```json\n([\s\S]*?)\n```/g)];
    assert.equal(payloads.length, 2);
    for (const [, json] of payloads) {
      const documented = JSON.parse(json);
      const tool = fixture.tools.get(documented.name);
      assert.ok(tool);
      if (documented.name === "subagent_run") {
        documented.parameters.properties.profile.description = tool.parameters.properties.profile.description;
      }
      assert.equal(documented.description, tool.description);
      assert.deepEqual(documented.parameters, JSON.parse(JSON.stringify(tool.parameters)));
      assert.ok(readme.includes(`- ${tool.name}: ${tool.promptSnippet}`));
      for (const guideline of tool.promptGuidelines ?? []) assert.ok(readme.includes(`- ${guideline}`));
    }
  } finally {
    await fixture.dispose();
  }
});

test("launch returns before work finishes and sends a non-waking completion", async () => {
  const completed = deferred<void>();
  const fixture = await extension(() => {
    const stream = response();
    // Hold the SDK prompt open independently of the launch call.
    const original = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      await completed.promise;
      const iterator = original();
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value;
    };
    return stream;
  });
  try {
    const result = await fixture.tools.get("subagent_run").execute("id", {
      action: "new", profile: "scout", thread: "Map", prompt: "task",
    }, undefined, undefined, fixture.ctx);
    assert.ok(result.content[0].text.includes("Scheduled Map"));
    assert.equal(fixture.messages.length, 0);
    completed.resolve();
    for (let i = 0; i < 100 && fixture.messages.length === 0; i++) await tick();
    assert.equal(fixture.messages.length, 1);
    assert.equal(fixture.messages[0].options.triggerTurn, false);
    assert.ok(fixture.messages[0].message.content.includes("Thread Map"));
    const resultAgain = await fixture.tools.get("subagent_control").execute("id", {
      action: "wait", thread: "Map",
    }, undefined, undefined, fixture.ctx);
    assert.equal(resultAgain.isError, false);
    assert.equal(fixture.messages.length, 1);
  } finally {
    completed.resolve();
    await fixture.dispose();
  }
});

test("completion content survives continuation and usage is attached once", async () => {
  let count = 0;
  const fixture = await extension(() => {
    const message = assistant([{ type: "text", text: `answer ${++count}` }]);
    message.usage = { ...emptyUsage(), input: 7, totalTokens: 7, turns: 1 };
    return response(message);
  });
  try {
    const run = fixture.tools.get("subagent_run");
    const control = fixture.tools.get("subagent_control");
    await run.execute("id", { action: "new", profile: "scout", thread: "Map", prompt: "first" }, undefined, undefined, fixture.ctx);
    for (let i = 0; i < 100 && fixture.messages.length < 1; i++) await tick();
    await run.execute("id", { action: "continue", thread: "Map", prompt: "second" }, undefined, undefined, fixture.ctx);
    await control.execute("id", { action: "wait", thread: "Map" }, undefined, undefined, fixture.ctx);
    assert.ok(fixture.messages[0].message.content.includes("answer 1"));
    const billed = await fixture.emit("tool_result", { toolName: "subagent_control" });
    assert.equal(billed.usage.input, 14);
    await control.execute("id", { action: "wait", thread: "Map" }, undefined, undefined, fixture.ctx);
    assert.equal(await fixture.emit("tool_result", { toolName: "subagent_control" }), undefined);
  } finally {
    await fixture.dispose();
  }
});

test("wrapper-induced truncation preserves full output for wait and completion delivery", async () => {
  const outputs = [
    Array.from({ length: MAX_OUTPUT_LINES }, () => "line").join("\n"),
    "x".repeat(MAX_OUTPUT_BYTES),
  ];
  for (const fullText of outputs) {
    const fixture = await extension(() => response(assistant([{ type: "text", text: fullText }])));
    let artifact: string | undefined;
    try {
      await fixture.tools.get("subagent_run").execute("id", {
        action: "new", profile: "scout", thread: "Map", prompt: "task",
      }, undefined, undefined, fixture.ctx);
      for (let i = 0; i < 100 && fixture.messages.length === 0; i++) await tick();
      assert.equal(fixture.messages.length, 1);
      const result = await fixture.tools.get("subagent_control").execute("id", {
        action: "wait", thread: "Map",
      }, undefined, undefined, fixture.ctx);
      artifact = result.details.outcome.fullOutputPath;
      assert.ok(artifact);
      assert.equal(await readFile(artifact, "utf8"), `Thread Map (scout) · completed\n\n${fullText}`);
      assert.equal((await stat(artifact)).mode & 0o777, 0o600);
      for (const text of [fixture.messages[0].message.content, result.content[0].text]) {
        assert.ok(Buffer.byteLength(text) <= MAX_OUTPUT_BYTES);
        assert.ok(text.split("\n").length <= MAX_OUTPUT_LINES);
        assert.ok(text.includes(artifact));
      }
    } finally {
      await fixture.dispose();
      if (artifact) await rm(dirname(artifact), { recursive: true, force: true });
    }
  }
});

test("an active waiter creates the artifact without a completion notification", async () => {
  const fullText = "x".repeat(MAX_OUTPUT_BYTES);
  const fixture = await extension(() => response(assistant([{ type: "text", text: fullText }])));
  let artifact: string | undefined;
  try {
    await fixture.tools.get("subagent_run").execute("id", {
      action: "new", profile: "scout", thread: "Map", prompt: "task",
    }, undefined, undefined, fixture.ctx);
    assert.equal(fixture.messages.length, 0);
    const result = await fixture.tools.get("subagent_control").execute("id", {
      action: "wait", thread: "Map",
    }, undefined, undefined, fixture.ctx);
    assert.equal(fixture.messages.length, 0);
    artifact = result.details.outcome.fullOutputPath;
    assert.ok(artifact);
    assert.equal(await readFile(artifact, "utf8"), `Thread Map (scout) · completed\n\n${fullText}`);
    assert.ok(result.content[0].text.includes(artifact));
    assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_OUTPUT_BYTES);
  } finally {
    await fixture.dispose();
    if (artifact) await rm(dirname(artifact), { recursive: true, force: true });
  }
});

test("failed children remain failed tool results with retained details", async () => {
  const fixture = await extension(() => {
    const message = assistant([]);
    return response(message);
  });
  try {
    await fixture.tools.get("subagent_run").execute("id", { action: "new", profile: "scout", thread: "Map", prompt: "task" }, undefined, undefined, fixture.ctx);
    const result = await fixture.tools.get("subagent_control").execute("id", { action: "wait", thread: "Map" }, undefined, undefined, fixture.ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details.outcome.status, "failed");
  } finally {
    await fixture.dispose();
  }
});

test("Pi inserts context-only completions before the next request and does not wake idle sessions", async () => {
  const contexts: any[] = [];
  const runtime = await testRuntime();
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Local test",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  const { session: created } = await createAgentSession({
    cwd: tmpdir(),
    modelRuntime: runtime,
    model: runtime.getModel("subagent-test", "test"),
    resourceLoader,
    sessionManager: SessionManager.inMemory(tmpdir()),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" }),
    tools: ["boundary_probe"],
    customTools: [{
      name: "boundary_probe", label: "Probe", description: "Local test", parameters: { type: "object", properties: {} } as any,
      execute: async () => {
        await session.sendCustomMessage({ customType: "subagents-complete", content: "COMPLETION_AT_BOUNDARY", display: false }, { triggerTurn: false });
        return { content: [{ type: "text", text: "tool result" }], details: undefined };
      },
    }],
  });
  session = created;
  session.agent.streamFunction = (_model, context) => {
    contexts.push(structuredClone(context));
    return contexts.length === 1
      ? response(assistant([{ type: "toolCall", id: "probe", name: "boundary_probe", arguments: {} }]))
      : response();
  };
  try {
    await session.prompt("task");
    assert.equal(contexts.length, 2);
    assert.ok(JSON.stringify(contexts[1]).includes("COMPLETION_AT_BOUNDARY"));
    const persisted = session.sessionManager.getEntries().filter((entry) => entry.type === "message" || entry.type === "custom_message");
    const resultIndex = persisted.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult");
    const completionIndex = persisted.findIndex((entry) => entry.type === "custom_message");
    assert.ok(completionIndex > resultIndex);
    await session.sendCustomMessage({ customType: "subagents-complete", content: "IDLE_COMPLETION", display: false }, { triggerTurn: false });
    await tick();
    assert.equal(contexts.length, 2);
    assert.ok(JSON.stringify(session.messages).includes("IDLE_COMPLETION"));
  } finally {
    session.dispose();
  }
});

test("parent-model overrides reach the SDK and existing threads keep their snapshot", async () => {
  const fixture = await extension();
  const requests: { model: string; thinking: string | undefined }[] = [];
  const runtime = fixture.ctx.modelRegistry.runtime;
  runtime.registerProvider("override-test", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "local-test-only",
    models: ["child-b", "child-c"].map((id) => ({
      id, name: id, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000, maxTokens: 1_000,
    })),
  });
  runtime.streamSimple = (model, _context, options) => {
    requests.push({ model: model.id, thinking: options?.reasoning });
    return response();
  };
  const configPath = join(fixture.ctx.cwd, "subagents.json");
  const config = { parentModels: {
    "subagent-test/test": { scout: { model: "override-test/child-b", thinking: "high" } },
    "override-test/child-b": { scout: { model: "override-test/child-c", thinking: "medium" } },
  } };
  const run = fixture.tools.get("subagent_run");
  const control = fixture.tools.get("subagent_control");
  const launch = async (thread: string) => {
    await run.execute("id", { action: "new", profile: "scout", thread, prompt: "task" }, undefined, undefined, fixture.ctx);
    const result = await control.execute("id", { action: "wait", thread }, undefined, undefined, fixture.ctx);
    assert.equal(result.isError, false);
  };
  try {
    await writeFile(configPath, JSON.stringify(config));
    await launch("First");
    assert.deepEqual(requests.at(-1), { model: "child-b", thinking: "high" });
    fixture.ctx.model = runtime.getModel("override-test", "child-b");
    await launch("Second");
    assert.deepEqual(requests.at(-1), { model: "child-c", thinking: "medium" });
    await writeFile(configPath, "invalid json");
    await run.execute("id", { action: "continue", thread: "First", prompt: "again" }, undefined, undefined, fixture.ctx);
    await control.execute("id", { action: "wait", thread: "First" }, undefined, undefined, fixture.ctx);
    assert.deepEqual(requests.at(-1), { model: "child-b", thinking: "high" });
    await assert.rejects(launch("Invalid"), /subagents\.json/);
    await writeFile(configPath, JSON.stringify(config));
    fixture.ctx.model = runtime.getModel("override-test", "child-c");
    await launch("Unmatched");
    assert.deepEqual(requests.at(-1), { model: "child-c", thinking: "low" });
    config.parentModels["subagent-test/test"].scout.model = "override-test/child-c";
    await writeFile(configPath, JSON.stringify(config));
    fixture.ctx.model = runtime.getModel("subagent-test", "test");
    await launch("Edited");
    assert.deepEqual(requests.at(-1), { model: "child-c", thinking: "high" });
    await rm(configPath);
    await launch("Deleted");
    assert.equal(requests.at(-1)?.model, "test");
    assert.equal(fixture.widgetCalls.length, 0);
  } finally {
    await fixture.dispose();
  }
});

test("TUI widget keeps its slot across launches and hides when idle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const completed = deferred<void>();
  const fixture = await extension(() => {
    const stream = response();
    const original = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      await completed.promise;
      yield* { [Symbol.asyncIterator]: original };
    };
    return stream;
  }, "tui");
  try {
    const widget = fixture.widgets.get("subagents");
    assert.ok(widget);
    assert.deepEqual(widget.render(80), []);
    fixture.ctx.ui.setWidget("todo", () => ({ render: () => ["Todos"], invalidate: () => {} }), { placement: "aboveEditor" });
    assert.deepEqual([...fixture.widgets.keys()], ["subagents", "todo"]);
    const run = fixture.tools.get("subagent_run");
    await run.execute("id", { action: "new", profile: "scout", thread: "Map", prompt: "task" }, undefined, undefined, fixture.ctx);
    for (let i = 0; i < 10; i++) await tick();
    t.mock.timers.tick(120);
    assert.deepEqual(widget.render(80), [" ● Subagents running Map"]);
    assert.equal(fixture.widgetCalls[0].options.placement, "aboveEditor");
    const renders = fixture.renderRequests();
    t.mock.timers.tick(1_000);
    assert.equal(fixture.renderRequests(), renders);
    await fixture.tools.get("subagent_control").execute("id", {
      action: "steer", thread: "Map", message: "Focus on correctness.",
    }, undefined, undefined, fixture.ctx);
    t.mock.timers.tick(120);
    assert.equal(fixture.renderRequests(), renders);
    await run.execute("id", { action: "new", profile: "scout", thread: "Review", prompt: "task" }, undefined, undefined, fixture.ctx);
    t.mock.timers.tick(120);
    assert.deepEqual(widget.render(80), [" ● Subagents running Map, Review"]);
    assert.ok(fixture.renderRequests() > renders);
    assert.equal(fixture.widgetCalls.length, 2);
    assert.deepEqual([...fixture.widgets.keys()], ["subagents", "todo"]);
    completed.resolve();
    await fixture.tools.get("subagent_control").execute("id", { action: "wait", thread: "Map" }, undefined, undefined, fixture.ctx);
    await fixture.tools.get("subagent_control").execute("id", { action: "wait", thread: "Review" }, undefined, undefined, fixture.ctx);
    t.mock.timers.tick(120);
    assert.deepEqual(widget.render(80), []);
    assert.equal(fixture.widgets.get("subagents"), widget);
    assert.deepEqual([...fixture.widgets.keys()], ["subagents", "todo"]);
    const afterCompletion = fixture.renderRequests();
    t.mock.timers.tick(2_000);
    assert.equal(fixture.renderRequests(), afterCompletion);
    await run.execute("id", { action: "new", profile: "scout", thread: "Again", prompt: "task" }, undefined, undefined, fixture.ctx);
    await fixture.tools.get("subagent_control").execute("id", { action: "wait", thread: "Again" }, undefined, undefined, fixture.ctx);
    t.mock.timers.tick(120);
    assert.equal(fixture.widgets.get("subagents"), widget);
    assert.equal(fixture.widgetCalls.length, 2);
    assert.deepEqual([...fixture.widgets.keys()], ["subagents", "todo"]);
    assert.equal(fixture.statuses.length, 0);
  } finally {
    completed.resolve();
    await fixture.dispose();
    t.mock.timers.reset();
  }
});

test("widget repaints when the running identity changes with the same counts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gates = [deferred<void>(), deferred<void>()];
  let requests = 0;
  const fixture = await extension(() => {
    const gate = gates[requests++];
    const stream = response();
    const original = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      await gate.promise;
      yield* { [Symbol.asyncIterator]: original };
    };
    return stream;
  }, "tui");
  try {
    const run = fixture.tools.get("subagent_run");
    const control = fixture.tools.get("subagent_control");
    const widget = fixture.widgets.get("subagents");
    await run.execute("id", { action: "new", profile: "scout", thread: "First", prompt: "task" }, undefined, undefined, fixture.ctx);
    for (let i = 0; i < 10; i++) await tick();
    t.mock.timers.tick(120);
    assert.deepEqual(widget.render(80), [" ● Subagents running First"]);
    const renders = fixture.renderRequests();
    gates[0].resolve();
    await control.execute("id", { action: "wait", thread: "First" }, undefined, undefined, fixture.ctx);
    await run.execute("id", { action: "new", profile: "scout", thread: "Second", prompt: "task" }, undefined, undefined, fixture.ctx);
    for (let i = 0; i < 10; i++) await tick();
    t.mock.timers.tick(120);
    assert.deepEqual(widget.render(80), [" ● Subagents running Second"]);
    assert.ok(fixture.renderRequests() > renders);
    assert.equal(fixture.widgetCalls.length, 1);
    gates[1].resolve();
    await control.execute("id", { action: "wait", thread: "Second" }, undefined, undefined, fixture.ctx);
  } finally {
    for (const gate of gates) gate.resolve();
    await fixture.dispose();
    t.mock.timers.reset();
  }
});

test("shutdown removes the active widget and its pending timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const fixture = await extension(undefined, "tui");
  const completed = deferred<void>();
  const runtime = fixture.ctx.modelRegistry.runtime;
  runtime.streamSimple = (_model, _context, options) => {
    const stream = response();
    const original = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      await Promise.race([
        completed.promise,
        new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true })),
      ]);
      yield* { [Symbol.asyncIterator]: original };
    };
    return stream;
  };
  try {
    await fixture.tools.get("subagent_run").execute("id", { action: "new", profile: "scout", thread: "Map", prompt: "task" }, undefined, undefined, fixture.ctx);
    for (let i = 0; i < 10; i++) await tick();
    t.mock.timers.tick(120);
    assert.ok(fixture.widgets.get("subagents"));
    await fixture.dispose();
    assert.equal(fixture.widgets.size, 0);
    const renders = fixture.renderRequests();
    t.mock.timers.tick(2_000);
    assert.equal(fixture.renderRequests(), renders);
  } finally {
    completed.resolve();
    t.mock.timers.reset();
  }
});

export default function () {}
