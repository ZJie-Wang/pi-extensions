import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type AgentProfile, type RunOutcome } from "../core.ts";
import { type ChildSession, formatBackgroundStatus, getBackgroundStatus, ThreadManager } from "../manager.ts";

const profile: AgentProfile = {
  name: "scout",
  description: "Scout",
  tools: ["read"],
  skills: [],
  preserveBaseInstruction: false,
  includeProjectContext: true,
  systemPrompt: "Scout",
  filePath: "/scout.md",
};

function outcome(status: RunOutcome["status"] = "completed", output = "done"): RunOutcome {
  return { status, output, usage: emptyUsage(), startedAt: Date.now(), endedAt: Date.now() };
}

class ControlledSession implements ChildSession {
  prompts: string[] = [];
  steering: string[] = [];
  disposed = false;
  private pending?: (value: RunOutcome) => void;
  private onUpdate?: Parameters<ChildSession["run"]>[1];

  run(prompt: string, onUpdate: Parameters<ChildSession["run"]>[1]): Promise<RunOutcome> {
    this.prompts.push(prompt);
    this.onUpdate = onUpdate;
    return new Promise((resolve) => { this.pending = resolve; });
  }
  report(update: Parameters<Parameters<ChildSession["run"]>[1]>[0]): void { this.onUpdate?.(update); }
  finish(value = outcome()): void { this.pending?.(value); this.pending = undefined; }
  async steer(message: string): Promise<void> { this.steering.push(message); }
  async abort(): Promise<void> { this.finish(outcome("aborted", "")); }
  dispose(): void { this.disposed = true; }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("enforces cross-thread concurrency and preserves a profile snapshot", async () => {
  const manager = new ThreadManager(1);
  const firstSession = new ControlledSession();
  const secondSession = new ControlledSession();
  const first = manager.create(profile, "one", false, async () => firstSession, undefined, "Ada");
  profile.description = "changed later";
  const second = manager.create(profile, "two", false, async () => secondSession, undefined, "Fox");
  await tick();
  assert.deepEqual(firstSession.prompts, ["one"]);
  assert.deepEqual(secondSession.prompts, []);
  assert.equal(first.id, "Ada");
  assert.equal(second.id, "Fox");
  assert.equal(first.profile.description, "Scout");

  firstSession.finish();
  await manager.wait(first.id);
  await tick();
  assert.deepEqual(secondSession.prompts, ["two"]);
  secondSession.finish();
  await manager.wait(second.id);
  await manager.shutdown();
});

test("continues the same child session and rejects overlap", async () => {
  const manager = new ThreadManager(2);
  const session = new ControlledSession();
  const thread = manager.create(profile, "first", false, async () => session, undefined, "Ada");
  await tick();
  assert.equal(thread.id, "Ada");
  assert.throws(() => manager.continue("ada", "overlap", false), /wait, steer, or stop/);
  session.finish(outcome("completed", "first result"));
  await manager.wait(thread.id);
  manager.continue("ADA", "second", false);
  await tick();
  assert.deepEqual(session.prompts, ["first", "second"]);
  session.finish(outcome("completed", "second result"));
  assert.equal((await manager.wait(thread.id)).output, "second result");
  await manager.shutdown();
});

test("validates and deduplicates caller-assigned thread names", async () => {
  const manager = new ThreadManager(2);
  const firstSession = new ControlledSession();
  const first = manager.create(profile, "one", false, async () => firstSession, undefined, "Auth Review");
  assert.equal(first.id, "Auth Review");
  assert.throws(() => manager.create(profile, "two", false, async () => new ControlledSession(), undefined, "auth review"), /already in use/);
  assert.throws(() => manager.create(profile, "two", false, async () => new ControlledSession(), undefined, "#bad"), /must start with a letter/);
  await tick();
  firstSession.finish();
  await manager.wait(first.id);
  await manager.shutdown();
});

test("stops queued work without creating its session", async () => {
  const manager = new ThreadManager(1);
  const running = new ControlledSession();
  const queued = new ControlledSession();
  const first = manager.create(profile, "first", false, async () => running, undefined, "Runner");
  const second = manager.create(profile, "second", true, async () => queued, undefined, "Queued");
  await tick();
  const stopped = await manager.stop(second.id);
  assert.equal(stopped.status, "aborted");
  assert.deepEqual(queued.prompts, []);
  running.finish();
  await manager.wait(first.id);
  await manager.shutdown();
});

test("cancelling wait does not abort background work", async () => {
  const manager = new ThreadManager(1);
  const session = new ControlledSession();
  const thread = manager.create(profile, "background", true, async () => session, undefined, "Background");
  await tick();
  const controller = new AbortController();
  const waiting = manager.wait(thread.id, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /Wait cancelled/);
  assert.equal(thread.state, "running");
  session.finish();
  assert.equal((await manager.wait(thread.id)).status, "completed");
  await manager.shutdown();
});

test("waiting on background work receives live progress updates", async () => {
  const manager = new ThreadManager(1);
  const session = new ControlledSession();
  const thread = manager.create(profile, "background", true, async () => session, undefined, "Background");
  await tick();

  const updates: Array<{ state: string; activity: string; toolCount: number; lastMessage: string }> = [];
  const waiting = manager.wait(thread.id, undefined, (current) => {
    updates.push({
      state: current.state,
      activity: current.activity,
      toolCount: current.toolCount,
      lastMessage: current.lastMessage,
    });
  });
  assert.equal(updates.at(-1)?.state, "running");

  session.report({ activity: "read · /tmp/example.ts", toolCount: 1, lastMessage: "Inspecting the file" });
  assert.deepEqual(updates.at(-1), {
    state: "running",
    activity: "read · /tmp/example.ts",
    toolCount: 1,
    lastMessage: "Inspecting the file",
  });

  session.finish();
  assert.equal((await waiting).status, "completed");
  await manager.shutdown();
});

test("formats a quiet footer status only for active background work", async () => {
  const manager = new ThreadManager(2);
  const background = new ControlledSession();
  const foreground = new ControlledSession();
  const backThread = manager.create(profile, "background", true, async () => background, undefined, "Ada");
  const frontThread = manager.create(profile, "foreground", false, async () => foreground, undefined, "Fox");
  await tick();
  backThread.activity = `web · curl https://example.com/${"a".repeat(80)}`;
  assert.deepEqual(getBackgroundStatus(manager.list()), {
    count: 1,
    names: ["Ada"],
  });
  assert.equal(formatBackgroundStatus(manager.list()), "1 subagent: Ada");
  background.finish();
  await manager.wait(backThread.id);
  assert.equal(formatBackgroundStatus(manager.list()), undefined);
  foreground.finish();
  await manager.wait(frontThread.id);
  await manager.shutdown();
});

test("background completion is announced and a successful wait consumes it", async () => {
  const announced: string[] = [];
  const consumed: string[] = [];
  const manager = new ThreadManager(1, {
    onBackgroundComplete: (thread) => announced.push(thread.id),
    onResultConsumed: (threadId) => consumed.push(threadId),
  });
  const session = new ControlledSession();
  const thread = manager.create(profile, "background", true, async () => session, undefined, "Announce");
  await tick();
  session.finish();
  await tick();
  assert.deepEqual(announced, [thread.id]);
  await manager.wait(thread.id);
  assert.deepEqual(consumed, [thread.id]);
  await manager.shutdown();
});
