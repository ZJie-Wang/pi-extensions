import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiChildSession, createChildSession, snapshotParent, type ParentSnapshot } from "../child.ts";
import { capOutput, emptyUsage, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "../core.ts";
import { ChildToolRegistry } from "../tool-loader.ts";
import { assistant, deferred, profile, response, testRuntime, tick } from "./helpers.ts";

function mockSession(prompt: (emit: (message: any) => void, entries: any[], options: any) => Promise<void>) {
  const listeners = new Set<(event: any) => void>();
  const entries: any[] = [];
  const session = {
    messages: Array.from({ length: 100 }, () => assistant()),
    sessionManager: { getEntryCount: () => entries.length, getEntries: () => [...entries] },
    subscribe: (listener: (event: any) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prompt: async (_text: string, options: any) => prompt((message) => {
      for (const listener of listeners) listener({ type: "message_end", message });
      entries.push({ type: "message", message });
      session.messages = [message];
    }, entries, options),
    abort: async () => {},
    steer: async () => "queued",
    dispose: () => {},
  };
  return { session: session as unknown as AgentSession, listeners };
}

test("final text survives transcript shortening and usage includes compaction", async () => {
  const usage = { ...emptyUsage(), input: 10, totalTokens: 10, turns: 1, cost: { ...emptyUsage().cost, input: 0.1, total: 0.1 } };
  const { session, listeners } = mockSession(async (emit, entries) => {
    entries.push({ type: "compaction", usage });
    emit({ ...assistant([{ type: "text", text: "final after compaction" }]), usage });
  });
  const child = new PiChildSession(session);
  const result = await child.run("task", () => {}, new AbortController().signal);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "final after compaction");
  assert.equal(result.usage.input, 20);
  assert.equal(result.usage.cost.total, 0.2);
  assert.equal(result.usage.turns, 1);
  assert.equal(listeners.size, 0);
});

test("cancellation during prompt preparation prevents starting the run", async () => {
  const ready = deferred<void>();
  const controller = new AbortController();
  let started = false;
  const { session } = mockSession(async (_emit, _entries, options) => {
    await ready.promise;
    options.preflightResult("started");
    started = true;
  });
  const child = new PiChildSession(session);
  const run = child.run("task", () => {}, controller.signal);
  await tick();
  controller.abort();
  ready.resolve();
  assert.equal((await run).status, "aborted");
  assert.equal(started, false);
});

test("already-cancelled work never calls prompt", async () => {
  let prompted = false;
  const { session } = mockSession(async () => { prompted = true; });
  const controller = new AbortController();
  controller.abort();
  const result = await new PiChildSession(session).run("task", () => {}, controller.signal);
  assert.equal(result.status, "aborted");
  assert.equal(prompted, false);
});

test("long child output has a private readable artifact", async () => {
  const fullText = "界".repeat(30_000);
  const { session } = mockSession(async (emit) => {
    emit(assistant([{ type: "text", text: fullText }]));
  });
  const result = await new PiChildSession(session).run("task", () => {}, new AbortController().signal);
  assert.equal(result.status, "completed");
  assert.ok(result.fullOutputPath);
  try {
    assert.equal(await readFile(result.fullOutputPath, "utf8"), fullText);
    assert.equal((await stat(result.fullOutputPath)).mode & 0o777, 0o600);
    assert.ok(Buffer.byteLength(result.output) <= MAX_OUTPUT_BYTES);
    assert.ok(result.output.includes(result.fullOutputPath));
    assert.ok(!result.output.includes("�"));
  } finally {
    await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
  }
});

test("output truncation includes its notice within both limits", () => {
  const text = capOutput(Array.from({ length: 3_000 }, () => "line").join("\n"));
  assert.ok(text.split("\n").length <= MAX_OUTPUT_LINES);
  assert.ok(Buffer.byteLength(text) <= MAX_OUTPUT_BYTES);
  assert.ok(text.includes("truncated"));
});

test("truncation preserves exact-limit output and bounds multibyte and newline-heavy output", () => {
  for (const text of ["", "x".repeat(MAX_OUTPUT_BYTES), "\n".repeat(MAX_OUTPUT_LINES - 1)]) {
    assert.equal(capOutput(text), text);
  }
  for (const text of ["界".repeat(MAX_OUTPUT_BYTES), "😀".repeat(MAX_OUTPUT_BYTES), "\n".repeat(1_000_000)]) {
    for (const artifact of [undefined, "/output.txt"]) {
      const output = capOutput(text, artifact);
      assert.ok(Buffer.byteLength(output) <= MAX_OUTPUT_BYTES);
      assert.ok(output.split("\n").length <= MAX_OUTPUT_LINES);
      assert.ok(!output.includes("�"));
      assert.ok(output.includes(artifact ?? "truncated"));
    }
  }
});

test("parent settings are snapshotted with the project trust decision", () => {
  const settings = { retry: { enabled: false } };
  const ctx = { cwd: "/tmp", scopedModels: [], isProjectTrusted: () => false };
  const snapshot = snapshotParent(ctx as any, settings);
  settings.retry.enabled = true;
  assert.equal(snapshot.settings.retry?.enabled, false);
  assert.equal(snapshot.projectTrusted, false);
});

test("SDK child respects declined trust and a strict read-only loadout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-child-trust-"));
  const contexts: any[] = [];
  const runtime = await testRuntime((context) => {
    contexts.push(context);
    return response();
  });
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "SYSTEM.md"), "UNTRUSTED_PROJECT_PREAMBLE");
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "UNTRUSTED_PREFIX" }));
    const parent: ParentSnapshot = {
      cwd,
      model: runtime.getModel("subagent-test", "test"),
      thinkingLevel: "off",
      modelRegistry: {
        runtime,
        find: (provider: string, id: string) => runtime.getModel(provider, id),
        getAll: () => runtime.getModels(),
      } as any,
      scopedModels: [],
      settings: { packages: [], skills: [], extensions: [], cacheWarming: "idle", retry: { enabled: false } },
      projectTrusted: false,
    };
    const child = await createChildSession({ ...profile, preserveBaseInstruction: true, tools: ["read"] }, parent, new ChildToolRegistry(join(cwd, "tools")));
    try {
      const session = (child as unknown as { session: AgentSession }).session;
      assert.deepEqual(session.getActiveToolNames(), ["read"]);
      assert.equal(session.settingsManager.isProjectTrusted(), false);
      assert.equal(session.settingsManager.getCacheWarmingMode(), "off");
      assert.equal(session.settingsManager.getRetrySettings().enabled, false);
      const result = await child.run("task", () => {}, new AbortController().signal);
      assert.equal(result.status, "completed");
      assert.ok(!JSON.stringify(contexts).includes("UNTRUSTED_PROJECT_PREAMBLE"));
      assert.ok(!session.systemPrompt.includes("subagent_run"));
    } finally {
      child.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancelling a continuation before compaction prevents a summarization request", async () => {
  let requests = 0;
  const runtime = await testRuntime(() => {
    requests++;
    const message = assistant();
    message.usage = { ...emptyUsage(), input: 95_000, totalTokens: 95_000, turns: 1 };
    return response(message);
  });
  const cwd = await mkdtemp(join(tmpdir(), "pi-child-compaction-"));
  try {
    const parent: ParentSnapshot = {
      cwd,
      model: runtime.getModel("subagent-test", "test"),
      modelRegistry: { runtime } as any,
      scopedModels: [],
      settings: { packages: [], skills: [], extensions: [], compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false } },
      projectTrusted: false,
    };
    const child = await createChildSession(profile, parent, new ChildToolRegistry(join(cwd, "tools")));
    try {
      const session = (child as unknown as { session: AgentSession }).session;
      assert.equal((await child.run("first", () => {}, new AbortController().signal)).status, "completed");
      session.setAutoCompactionEnabled(true);
      let compactionsStarted = 0;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "compaction_start") compactionsStarted++;
      });
      const controller = new AbortController();
      const continuing = child.run("second", () => {}, controller.signal);
      controller.abort();
      assert.equal((await continuing).status, "aborted");
      assert.equal(compactionsStarted, 1);
      assert.equal(requests, 1);
      unsubscribe();
    } finally {
      child.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an unavailable parent runtime fails explicitly instead of creating another", async () => {
  const parent = { cwd: tmpdir(), modelRegistry: {}, settings: {}, scopedModels: [], projectTrusted: false };
  await assert.rejects(createChildSession(profile, parent as any, new ChildToolRegistry("/nonexistent")), /parent model runtime/);
});

export default function () {}
