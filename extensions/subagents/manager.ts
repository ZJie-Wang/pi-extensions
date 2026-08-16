import { type AgentProfile, emptyUsage, preview, type RunOutcome, type UsageSummary } from "./core.ts";

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
  usage?: UsageSummary;
}

export interface ChildSession {
  run(prompt: string, onUpdate: (update: ChildRunUpdate) => void): Promise<RunOutcome>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export type SessionFactory = () => Promise<ChildSession>;
export type ThreadState = "queued" | "running" | "idle";

export interface RunRecord {
  prompt: string;
  background: boolean;
  queuedAt: number;
  startedAt?: number;
  stopRequested: boolean;
  promise: Promise<RunOutcome>;
  resolve: (outcome: RunOutcome) => void;
  updateListeners: Set<(thread: SubagentThread) => void>;
}

export interface SubagentThread {
  /** Human-facing thread name assigned by the caller. */
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
  promptPreview: string;
  createdAt: number;
}

export interface ManagerCallbacks {
  onThreadChange?: (thread: SubagentThread) => void;
  onBackgroundComplete?: (thread: SubagentThread) => void;
  onResultConsumed?: (threadId: string) => void;
}

const THREAD_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/;

function abortedOutcome(message: string, startedAt = Date.now()): RunOutcome {
  return { status: "aborted", output: "", error: message, usage: emptyUsage(), startedAt, endedAt: Date.now() };
}

function failedOutcome(error: unknown, startedAt: number): RunOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "failed", output: "", error: message, usage: emptyUsage(), startedAt, endedAt: Date.now() };
}

export class ThreadManager {
  private readonly threads = new Map<string, SubagentThread>();
  private readonly queue: SubagentThread[] = [];
  private active = 0;
  private shuttingDown = false;
  private readonly maxConcurrency: number;
  private readonly callbacks: ManagerCallbacks;

  constructor(maxConcurrency: number, callbacks: ManagerCallbacks = {}) {
    this.maxConcurrency = maxConcurrency;
    this.callbacks = callbacks;
  }

  create(
    profile: AgentProfile,
    prompt: string,
    background: boolean,
    createSession: SessionFactory,
    onUpdate: ((thread: SubagentThread) => void) | undefined,
    requestedName: string,
  ): SubagentThread {
    if (this.shuttingDown) throw new Error("Subagent manager is shutting down");
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
      promptPreview: prompt,
      createdAt: Date.now(),
    };
    this.threads.set(this.key(id), thread);
    this.enqueue(thread, prompt, background, onUpdate);
    return thread;
  }

  continue(
    threadId: string,
    prompt: string,
    background: boolean,
    onUpdate?: (thread: SubagentThread) => void,
  ): SubagentThread {
    const thread = this.require(threadId);
    if (thread.current) throw new Error(`Thread ${thread.id} is ${thread.state}; wait, steer, or stop it first`);
    if (!thread.session) throw new Error(`Thread ${thread.id} has no usable session; create a new thread`);
    this.enqueue(thread, prompt, background, onUpdate);
    return thread;
  }

  get(threadId: string): SubagentThread | undefined {
    return this.threads.get(this.key(threadId));
  }

  list(): SubagentThread[] {
    return [...this.threads.values()];
  }

  async wait(
    threadId: string,
    signal?: AbortSignal,
    onUpdate?: (thread: SubagentThread) => void,
  ): Promise<RunOutcome> {
    const thread = this.require(threadId);
    const run = thread.current;
    if (!run) {
      if (!thread.lastOutcome) throw new Error(`Thread ${thread.id} has not produced a result`);
      this.callbacks.onResultConsumed?.(thread.id);
      return thread.lastOutcome;
    }
    if (onUpdate) {
      run.updateListeners.add(onUpdate);
      onUpdate(thread);
    }
    try {
      const outcome = await waitWithoutCancelling(run.promise, signal);
      this.callbacks.onResultConsumed?.(thread.id);
      return outcome;
    } finally {
      if (onUpdate) run.updateListeners.delete(onUpdate);
    }
  }

  status(threadId: string): SubagentThread {
    return this.require(threadId);
  }

  async steer(threadId: string, message: string): Promise<void> {
    const thread = this.require(threadId);
    if (thread.state !== "running" || !thread.session) throw new Error(`Thread ${thread.id} is not running`);
    await thread.session.steer(message);
    thread.activity = "steered";
    this.callbacks.onThreadChange?.(thread);
  }

  async stop(threadId: string): Promise<RunOutcome> {
    const thread = this.require(threadId);
    const run = thread.current;
    if (!run) return thread.lastOutcome ?? abortedOutcome("Thread was already idle");
    run.stopRequested = true;
    if (thread.state === "queued") {
      const index = this.queue.indexOf(thread);
      if (index >= 0) this.queue.splice(index, 1);
      const outcome = abortedOutcome("Subagent stopped while queued", run.queuedAt);
      this.settle(thread, run, outcome);
      return outcome;
    }
    await thread.session?.abort();
    return run.promise;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const thread of [...this.queue]) {
      const run = thread.current;
      if (run) this.settle(thread, run, abortedOutcome("Parent session ended", run.queuedAt));
    }
    this.queue.length = 0;
    const running = this.list().filter((thread) => thread.state === "running" && thread.current);
    const completions = running.map((thread) => thread.current!.promise);
    await Promise.allSettled(running.map((thread) => thread.session?.abort()));
    await Promise.allSettled(completions);
    for (const thread of this.threads.values()) thread.session?.dispose();
    this.threads.clear();
  }

  private enqueue(
    thread: SubagentThread,
    prompt: string,
    background: boolean,
    onUpdate?: (thread: SubagentThread) => void,
  ): void {
    let resolve!: (outcome: RunOutcome) => void;
    const promise = new Promise<RunOutcome>((done) => { resolve = done; });
    thread.current = {
      prompt,
      background,
      queuedAt: Date.now(),
      stopRequested: false,
      promise,
      resolve,
      updateListeners: new Set(onUpdate ? [onUpdate] : []),
    };
    thread.state = "queued";
    thread.activity = "queued";
    thread.promptPreview = prompt;
    this.queue.push(thread);
    this.emitUpdate(thread, thread.current);
    this.callbacks.onThreadChange?.(thread);
    this.drain();
  }

  private drain(): void {
    while (!this.shuttingDown && this.active < this.maxConcurrency && this.queue.length) {
      const thread = this.queue.shift()!;
      const run = thread.current;
      if (!run || run.stopRequested) continue;
      this.active++;
      thread.state = "running";
      thread.activity = "starting";
      run.startedAt = Date.now();
      this.emitUpdate(thread, run);
      this.callbacks.onThreadChange?.(thread);
      void this.execute(thread, run);
    }
  }

  private async execute(thread: SubagentThread, run: RunRecord): Promise<void> {
    const startedAt = run.startedAt ?? Date.now();
    let outcome: RunOutcome;
    try {
      thread.session ??= await thread.createSession();
      if (run.stopRequested) {
        outcome = abortedOutcome("Subagent stopped", startedAt);
      } else {
        outcome = await thread.session.run(run.prompt, (update) => {
          if (update.activity !== undefined) thread.activity = update.activity;
          if (update.tools !== undefined) thread.tools = update.tools;
          if (update.toolCount !== undefined) thread.toolCount = update.toolCount;
          if (update.lastMessage !== undefined) thread.lastMessage = update.lastMessage;
          this.emitUpdate(thread, run);
        });
        if (run.stopRequested && outcome.status === "completed") outcome = abortedOutcome("Subagent stopped", startedAt);
      }
    } catch (error) {
      outcome = run.stopRequested ? abortedOutcome("Subagent stopped", startedAt) : failedOutcome(error, startedAt);
    } finally {
      this.active--;
    }
    this.settle(thread, run, outcome!);
    this.drain();
  }

  private emitUpdate(thread: SubagentThread, run: RunRecord): void {
    for (const listener of run.updateListeners) listener(thread);
  }

  private settle(thread: SubagentThread, run: RunRecord, outcome: RunOutcome): void {
    if (thread.current !== run) return;
    thread.current = undefined;
    thread.state = "idle";
    thread.lastOutcome = outcome;
    thread.activity = outcome.status;
    run.resolve(outcome);
    this.callbacks.onThreadChange?.(thread);
    if (run.background && !this.shuttingDown) this.callbacks.onBackgroundComplete?.(thread);
  }

  private require(id: string): SubagentThread {
    const thread = this.get(id);
    if (!thread) throw new Error(`Unknown subagent thread: ${id}`);
    return thread;
  }

  private makeId(requestedName: string): string {
    const name = requestedName.trim().replace(/\s+/g, " ");
    if (!THREAD_NAME.test(name)) {
      throw new Error("Thread name must start with a letter and use at most 32 letters, numbers, spaces, _ or -");
    }
    if (this.threads.has(this.key(name))) throw new Error(`Subagent thread name is already in use: ${name}`);
    return name;
  }

  private key(id: string): string {
    return id.trim().toLocaleLowerCase();
  }
}

export interface BackgroundStatus {
  count: number;
  names: string[];
}

export function getBackgroundStatus(threads: readonly SubagentThread[]): BackgroundStatus | undefined {
  const active = threads.filter((thread) => thread.current?.background);
  if (!active.length) return undefined;
  return {
    count: active.length,
    names: active.map((thread) => preview(thread.id, 20)),
  };
}

export function formatBackgroundStatus(threads: readonly SubagentThread[]): string | undefined {
  const status = getBackgroundStatus(threads);
  if (!status) return undefined;
  return `${status.count} subagent${status.count === 1 ? "" : "s"}: ${status.names.join(", ")}`;
}

export function waitWithoutCancelling<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Wait cancelled", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Wait cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
