import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai/compat";
import { emptyUsage, type AgentProfile, type RunOutcome } from "../core.ts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export const profile: AgentProfile = {
  name: "test",
  description: "Local test child",
  tools: [],
  skills: [],
  preserveBaseInstruction: false,
  includeProjectContext: false,
  systemPrompt: "Local test instructions",
  filePath: "test.md",
};

export function outcome(output = "result", usage = emptyUsage()): RunOutcome {
  return { status: "completed", output, usage, startedAt: 1, endedAt: 2 };
}

export function assistant(content: any[] = [{ type: "text", text: "result" }]) {
  return {
    role: "assistant" as const,
    api: "openai-completions" as const,
    provider: "subagent-test",
    model: "test",
    content,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" as const : "stop" as const,
    usage: emptyUsage(),
    timestamp: Date.now(),
  };
}

export function response(message = assistant()) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
  });
  return stream;
}

export async function testRuntime(handler: (context: any, options: any) => ReturnType<typeof response> = () => response()) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("subagent-test", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "local-test-only",
    models: [{
      id: "test",
      name: "Local test model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1_000,
    }],
  });
  runtime.streamSimple = (_model, context, options) => handler(context, options);
  return runtime;
}
