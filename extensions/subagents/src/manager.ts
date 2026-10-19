import { addUsage, type AgentProfile, emptyUsage, type RunOutcome, type UsageSummary } from "./core.ts";

export interface ToolActivity {
  toolCallId: string;
  tool: string;
  args: string;
  status: "running" | "done" | "failed";
}

export interface ChildRunUpdate {
  activity?: string;
  tools?: ToolActivity[];
  toolCount?: number;
  lastMessage?: string;
}

export interface ChildSession {
  run(prompt: string, onUpdate: (update: ChildRunUpdate) => void, signal: AbortSignal): Promise<RunOutcome>;
  steer(message: string): Promise<void>;
  dispose(): void;
}

export type SessionFactory = () => Promise<ChildSession>;
export type ThreadState = "queued" | "running" | "idle";

interface RunRecord {
  prompt: string;
  queuedAt: number;
  startedAt?: number;
  controller: AbortController;
  promise: Promise<RunOutcome>;
  resolve: (outcome: RunOutcome) => void;
  updateListeners: Set<(thread: SubagentThread) => void>;
}

export interface SubagentThread {
  /** Caller-assigned thread name. */
  id: string;
  profile: AgentProfile;
  state: ThreadState;
  session?: ChildSession;
  createSession: SessionFactory;
  current?: RunRecord;
  lastOutcome?: RunOutcome;
  activity: string;
  tools: ToolActivity[];
  toolCount: number;
  lastMessage: string;
  lastPrompt: string;
}

export interface ManagerCallbacks {
  onThreadChange?: (thread: SubagentThread) => void;
  onComplete?: (thread: SubagentThread, outcome: RunOutcome) => void;
}

const THREAD_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/;

function abortedOutcome(message: string, startedAt = Date.now()): RunOutcome {
  return { status: "aborted", output: "", error: message, usage: emptyUsage(), startedAt, endedAt: Date.now() };
}

function failedOutcome(error: unknown, startedAt: number): RunOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", output: "", error: message, usage: emptyUsage(), startedAt, endedAt: Date.now() };
}

function observe(callback: () => void): void {
  try {
    void Promise.resolve(callback()).catch(() => {});
  } catch {
    // Observers must not affect run execution.
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export class ThreadManager {
  private readonly threads = new Map<string, SubagentThread>();
  private readonly queue: SubagentThread[] = [];
  private active = 0;
  private shutdownPromise?: Promise<void>;
  private pendingUsage?: UsageSummary;

  constructor(private readonly maxConcurrency: number, private readonly callbacks: ManagerCallbacks = {}) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("Max concurrency must be a positive integer");
    }
  }

  create(
    profile: AgentProfile,
    prompt: string,
    createSession: SessionFactory,
    requestedName: string,
  ): SubagentThread {
    if (this.shutdownPromise) throw new Error("Subagent manager is shutting down");
    const id = this.makeId(requestedName);
    const thread: SubagentThread = {
      id,
      profile: structuredClone(profile),
      state: "idle",
      createSession,
      activity: "",
      tools: [],
      toolCount: 0,
      lastMessage: "",
      lastPrompt: prompt,
    };
    this.enqueue(thread, prompt);
    return thread;
  }

  continue(threadId: string, prompt: string): SubagentThread {
    if (this.shutdownPromise) throw new Error("Subagent manager is shutting down");
    const thread = this.status(threadId);
    if (thread.current) throw new Error(`Thread ${thread.id} is ${thread.state}; wait, steer, or stop it first`);
    if (!thread.session) throw new Error(`Thread ${thread.id} has no usable session; create a new thread`);
    this.enqueue(thread, prompt);
    return thread;
  }

  list(): SubagentThread[] {
    return [...this.threads.values()].reverse();
  }

  takeUsage(): UsageSummary | undefined {
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  async wait(
    threadId: string,
    signal?: AbortSignal,
    onUpdate?: (thread: SubagentThread) => void,
  ): Promise<RunOutcome> {
    if (signal?.aborted) throw new DOMException("Wait cancelled", "AbortError");
    const thread = this.status(threadId);
    const run = thread.current;
    if (!run) {
      if (!thread.lastOutcome) throw new Error(`Thread ${thread.id} has not produced a result`);
      return thread.lastOutcome;
    }
    return new Promise((resolve, reject) => {
      const listener = (updated: SubagentThread) => onUpdate?.(updated);
      const release = () => {
        run.updateListeners.delete(listener);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        release();
        reject(new DOMException("Wait cancelled", "AbortError"));
      };
      run.updateListeners.add(listener);
      signal?.addEventListener("abort", abort, { once: true });
      observe(() => listener(thread));
      run.promise.then((outcome) => { release(); resolve(outcome); });
    });
  }

  status(threadId: string): SubagentThread {
    const thread = this.threads.get(this.key(threadId));
    if (!thread) throw new Error(`Unknown subagent thread: ${threadId}`);
    return thread;
  }

  async steer(threadId: string, message: string): Promise<void> {
    const thread = this.status(threadId);
    if (thread.state !== "running" || !thread.session) throw new Error(`Thread ${thread.id} is not running`);
    await thread.session.steer(message);
    thread.activity = "steered";
    observe(() => this.callbacks.onThreadChange?.(thread));
  }

  async stop(threadId: string): Promise<RunOutcome> {
    const thread = this.status(threadId);
    const run = thread.current;
    if (!run) return thread.lastOutcome ?? abortedOutcome("Thread was already idle");
    const result = this.wait(threadId);
    run.controller.abort();
    if (thread.state === "queued") {
      const index = this.queue.indexOf(thread);
      if (index >= 0) this.queue.splice(index, 1);
      const outcome = abortedOutcome("Subagent stopped while queued", run.queuedAt);
      this.settle(thread, run, outcome);
      this.drain();
    }
    return result;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = Promise.resolve().then(() => this.finishShutdown());
    for (const thread of this.threads.values()) thread.current?.controller.abort();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    const completions = this.list().flatMap((thread) => thread.current ? [thread.current.promise] : []);
    const queued = this.queue.splice(0);
    for (const thread of queued) {
      const run = thread.current;
      if (run) this.settle(thread, run, abortedOutcome("Parent session ended", run.queuedAt));
    }
    await Promise.all(completions);
    for (const thread of this.threads.values()) {
      try {
        thread.session?.dispose();
      } catch {
        // Dispose the remaining sessions even if one fails.
      }
    }
    this.threads.clear();
  }

  private enqueue(thread: SubagentThread, prompt: string): void {
    let resolve!: (outcome: RunOutcome) => void;
    const promise = new Promise<RunOutcome>((done) => { resolve = done; });
    const run: RunRecord = {
      prompt,
      queuedAt: Date.now(),
      controller: new AbortController(),
      promise,
      resolve,
      updateListeners: new Set(),
    };
    thread.current = run;
    thread.lastOutcome = undefined;
    thread.state = "queued";
    thread.activity = "queued";
    thread.tools = [];
    thread.toolCount = 0;
    thread.lastMessage = "";
    thread.lastPrompt = prompt;
    // Map insertion order tracks the latest create/continue request.
    const key = this.key(thread.id);
    this.threads.delete(key);
    this.threads.set(key, thread);
    this.queue.push(thread);
    this.emitUpdate(thread, run);
    this.drain();
  }

  private drain(): void {
    while (!this.shutdownPromise && this.active < this.maxConcurrency && this.queue.length) {
      const thread = this.queue.shift()!;
      const run = thread.current!;
      this.active++;
      thread.state = "running";
      thread.activity = "starting";
      run.startedAt = Date.now();
      this.emitUpdate(thread, run);
      void this.execute(thread, run);
    }
  }

  private async execute(thread: SubagentThread, run: RunRecord): Promise<void> {
    const startedAt = run.startedAt!;
    const { signal } = run.controller;
    let outcome: RunOutcome;
    try {
      if (!signal.aborted) thread.session ??= await thread.createSession();
      if (signal.aborted) {
        outcome = abortedOutcome("Subagent stopped", startedAt);
      } else {
        outcome = await thread.session!.run(run.prompt, (update) => {
          if (thread.current !== run) return;
          if (update.activity !== undefined) thread.activity = update.activity;
          if (update.tools !== undefined) thread.tools = update.tools;
          if (update.toolCount !== undefined) thread.toolCount = update.toolCount;
          if (update.lastMessage !== undefined) thread.lastMessage = update.lastMessage;
          this.emitUpdate(thread, run);
        }, signal);
        if (signal.aborted && outcome.status === "completed") {
          outcome = { ...outcome, status: "aborted", error: "Subagent stopped" };
        }
      }
    } catch (error) {
      outcome = signal.aborted ? abortedOutcome("Subagent stopped", startedAt) : failedOutcome(error, startedAt);
    } finally {
      this.active--;
    }
    this.settle(thread, run, outcome);
    this.drain();
  }

  private emitUpdate(thread: SubagentThread, run: RunRecord): void {
    for (const listener of [...run.updateListeners]) observe(() => listener(thread));
    observe(() => this.callbacks.onThreadChange?.(thread));
  }

  private settle(thread: SubagentThread, run: RunRecord, outcome: RunOutcome): void {
    if (thread.current !== run) return;
    const notifyParent = run.updateListeners.size === 0 && !this.shutdownPromise;
    thread.current = undefined;
    thread.state = "idle";
    thread.lastOutcome = outcome;
    thread.activity = outcome.status;
    this.pendingUsage ??= emptyUsage();
    addUsage(this.pendingUsage, outcome.usage);
    run.resolve(outcome);
    this.emitUpdate(thread, run);
    if (notifyParent) observe(() => this.callbacks.onComplete?.(thread, outcome));
  }

  private makeId(requestedName: string): string {
    const name = normalizeName(requestedName);
    if (!THREAD_NAME.test(name)) {
      throw new Error("Thread name must start with a letter and use at most 32 letters, numbers, spaces, _ or -");
    }
    if (this.threads.has(this.key(name))) throw new Error(`Subagent thread name is already in use: ${name}`);
    return name;
  }

  private key(id: string): string {
    return normalizeName(id).toLowerCase();
  }
}

export interface ThreadStatus {
  id: string;
  status: ThreadState | RunOutcome["status"];
}

export function getThreadStatus(threads: readonly SubagentThread[]): ThreadStatus[] | undefined {
  if (!threads.length) return undefined;
  return threads.map((thread) => ({
    id: thread.id,
    status: thread.state === "idle" ? thread.lastOutcome?.status ?? "idle" : thread.state,
  }));
}
