import assert from "node:assert/strict";
import test from "node:test";
import { ThreadManager, getThreadStatus, type ChildSession } from "../manager.ts";
import { emptyUsage, type RunOutcome } from "../core.ts";
import { deferred, outcome, profile, tick } from "./helpers.ts";

function child(run: ChildSession["run"]): ChildSession {
  return { run, steer: async () => {}, dispose: () => {} };
}

test("schedules immediately, bounds concurrency, and drains queued work", async () => {
  const first = deferred<RunOutcome>();
  const second = deferred<RunOutcome>();
  const started: string[] = [];
  const manager = new ThreadManager(1);
  manager.create(profile, "first", async () => child(async () => {
    started.push("first");
    return first.promise;
  }), "First");
  manager.create(profile, "second", async () => child(async () => {
    started.push("second");
    return second.promise;
  }), "Second");
  await tick();
  assert.deepEqual(started, ["first"]);
  assert.equal(manager.status("Second").state, "queued");
  assert.deepEqual(getThreadStatus(manager.list()), { running: ["First"], queued: ["Second"] });
  first.resolve(outcome("first"));
  await manager.wait("First");
  await tick();
  assert.deepEqual(started, ["first", "second"]);
  second.resolve(outcome("second"));
  await manager.wait("Second");
  assert.equal(getThreadStatus(manager.list()), undefined);
  await manager.shutdown();
});

test("cancelling a waiter leaves work running and restores completion delivery", async () => {
  const result = deferred<RunOutcome>();
  const completions: string[] = [];
  const manager = new ThreadManager(1, { onComplete: (thread) => completions.push(thread.id) });
  let runSignal: AbortSignal | undefined;
  manager.create(profile, "task", async () => child(async (_prompt, _update, signal) => {
    runSignal = signal;
    return result.promise;
  }), "A");
  const signal = new AbortController();
  const wait = manager.wait("A", signal.signal);
  signal.abort();
  await assert.rejects(wait, { name: "AbortError" });
  assert.equal(runSignal?.aborted, false);
  assert.equal(manager.status("A").state, "running");
  result.resolve(outcome());
  await tick();
  assert.deepEqual(completions, ["A"]);
  await manager.shutdown();
});

test("an active waiter receives completion without a duplicate notification", async () => {
  const result = deferred<RunOutcome>();
  let notifications = 0;
  const manager = new ThreadManager(1, { onComplete: () => { notifications++; } });
  manager.create(profile, "task", async () => child(async () => result.promise), "A");
  const wait = manager.wait("A");
  result.resolve(outcome());
  assert.equal((await wait).output, "result");
  assert.equal(notifications, 0);
  await manager.shutdown();
});

test("continuation resets progress and retains only the latest outcome", async () => {
  const next = deferred<RunOutcome>();
  let count = 0;
  const manager = new ThreadManager(1);
  manager.create(profile, "first", async () => child(async (_prompt, update) => {
    if (++count > 1) return next.promise;
    update({ toolCount: 3, tools: [], lastMessage: "old message" });
    return outcome("old result");
  }), "Map  One");
  await manager.wait("map one");
  manager.continue("MAP   ONE", "second");
  assert.equal(manager.status("Map One").lastOutcome, undefined);
  assert.equal(manager.status("Map One").lastMessage, "");
  assert.equal(manager.status("Map One").toolCount, 0);
  assert.throws(() => manager.continue("Map One", "third"), /wait, steer, or stop/);
  next.resolve(outcome("new result"));
  assert.equal((await manager.wait("Map One")).output, "new result");
  await manager.shutdown();
});

test("shutdown during creation prevents a child run and is awaitably idempotent", async () => {
  const creation = deferred<ChildSession>();
  let runs = 0;
  let disposals = 0;
  const manager = new ThreadManager(1);
  manager.create(profile, "task", () => creation.promise, "A");
  const ending = manager.shutdown();
  assert.equal(manager.shutdown(), ending);
  creation.resolve({
    ...child(async () => { runs++; return outcome(); }),
    dispose: () => { disposals++; },
  });
  await ending;
  assert.equal(runs, 0);
  assert.equal(disposals, 1);
  assert.equal(manager.list().length, 0);
});

test("stop cancels queued work and cancellation preserves billed usage", async () => {
  const finishing = deferred<RunOutcome>();
  const usage = { ...emptyUsage(), input: 10, totalTokens: 10, turns: 1 };
  let signal: AbortSignal | undefined;
  let notifications = 0;
  const manager = new ThreadManager(1, { onComplete: () => { notifications++; } });
  manager.create(profile, "first", async () => child(async (_prompt, _update, runSignal) => {
    signal = runSignal;
    return finishing.promise;
  }), "A");
  manager.create(profile, "second", async () => { throw new Error("must not create queued child"); }, "B");
  await tick();
  assert.equal((await manager.stop("B")).status, "aborted");
  const stopped = manager.stop("A");
  assert.equal(signal?.aborted, true);
  finishing.resolve(outcome("partial work", usage));
  const result = await stopped;
  assert.equal(result.status, "aborted");
  assert.equal(result.output, "partial work");
  assert.equal(result.usage.input, 10);
  assert.equal(notifications, 0);
  assert.equal(manager.takeUsage()?.input, 10);
  assert.equal(manager.takeUsage(), undefined);
  await manager.wait("A");
  assert.equal(manager.takeUsage(), undefined);
  await manager.shutdown();
});

test("usage survives supersession and is drained independently of result reads", async () => {
  const usage = { ...emptyUsage(), output: 2, totalTokens: 2, turns: 1 };
  const manager = new ThreadManager(1);
  manager.create(profile, "first", async () => child(async () => outcome("answer", usage)), "A");
  await manager.wait("A");
  manager.continue("A", "second");
  await manager.wait("A");
  await manager.wait("A");
  assert.equal(manager.takeUsage()?.output, 4);
  assert.equal(manager.takeUsage(), undefined);
  await manager.shutdown();
});

test("shutdown cancels the run signal before yielding", async () => {
  let signal: AbortSignal | undefined;
  const manager = new ThreadManager(1);
  manager.create(profile, "task", async () => child(async (_prompt, _update, runSignal) => {
    signal = runSignal;
    return new Promise((resolve) => runSignal.addEventListener("abort", () => resolve(outcome()), { once: true }));
  }), "A");
  await tick();
  const ending = manager.shutdown();
  assert.equal(signal?.aborted, true);
  await ending;
});

test("observer failures do not strand a concurrency slot", async () => {
  const manager = new ThreadManager(1, {
    onThreadChange: () => { throw new Error("observer failed"); },
    onComplete: () => { throw new Error("observer failed"); },
  });
  manager.create(profile, "task", async () => child(async () => outcome()), "A");
  assert.equal((await manager.wait("A")).status, "completed");
  manager.create(profile, "next", async () => child(async () => outcome()), "B");
  assert.equal((await manager.wait("B")).status, "completed");
  await manager.shutdown();
});

test("thread names and concurrency are validated", async () => {
  assert.throws(() => new ThreadManager(0), /concurrency/i);
  const manager = new ThreadManager(1);
  assert.throws(() => manager.create(profile, "task", async () => child(async () => outcome()), "123"), /letter/);
  manager.create(profile, "task", async () => child(async () => outcome()), "Map");
  assert.throws(() => manager.create(profile, "task", async () => child(async () => outcome()), "map"), /already in use/);
  await manager.wait("Map");
  await manager.shutdown();
  assert.throws(() => manager.continue("Map", "task"), /shutting down/);
});

test("independent waiters detach on cancellation and completion", async () => {
  const result = deferred<RunOutcome>();
  let notifications = 0;
  let updates = 0;
  const manager = new ThreadManager(1, { onComplete: () => { notifications++; } });
  const thread = manager.create(profile, "task", async () => child(async () => result.promise), "A");
  const controller = new AbortController();
  const listener = () => { updates++; };
  const cancelled = manager.wait("A", controller.signal, listener);
  const joined = manager.wait("A", undefined, listener);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  result.resolve(outcome());
  assert.equal((await joined).status, "completed");
  assert.equal(updates, 3);
  assert.equal(notifications, 0);
  assert.equal(thread.current, undefined);
  await manager.shutdown();
});

test("stop during creation cancels only that run and retains the session for continuation", async () => {
  const creation = deferred<ChildSession>();
  const prompts: string[] = [];
  const manager = new ThreadManager(1);
  manager.create(profile, "cancelled", () => creation.promise, "A");
  const stopped = manager.stop("A");
  creation.resolve(child(async (prompt) => { prompts.push(prompt); return outcome(); }));
  assert.equal((await stopped).status, "aborted");
  assert.deepEqual(prompts, []);
  manager.continue("A", "next");
  assert.equal((await manager.wait("A")).status, "completed");
  assert.deepEqual(prompts, ["next"]);
  await manager.shutdown();
});

test("shutdown settles queued work and disposes every session despite cleanup errors", async () => {
  let disposed = 0;
  const manager = new ThreadManager(2);
  for (const name of ["A", "B", "Queued"]) manager.create(profile, "task", async () => ({
    ...child(async (_prompt, _update, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(outcome()), { once: true });
    })),
    dispose: () => { disposed++; throw new Error("cleanup failed"); },
  }), name);
  await tick();
  const results = manager.list().map((thread) => manager.wait(thread.id));
  await manager.shutdown();
  assert.deepEqual((await Promise.all(results)).map((result) => result.status), ["aborted", "aborted", "aborted"]);
  assert.equal(disposed, 2);
  assert.deepEqual(manager.list(), []);
});

export default function () {}
