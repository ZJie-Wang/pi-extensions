import * as fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { addUsage, BUILTIN_TOOLS, capOutput, emptyUsage, type AgentProfile, preview, toolArgsPreview, type RunOutcome } from "./core.ts";
import type { ChildSession, ToolActivity } from "./manager.ts";
import type { ChildToolRegistry } from "./tool-loader.ts";

export interface ParentSnapshot {
  cwd: string;
  model: Model<any> | undefined;
  thinkingLevel?: ThinkingLevel;
  modelRegistry: ExtensionContext["modelRegistry"];
  scopedModels: ExtensionContext["scopedModels"];
  settings: ReturnType<ExtensionAPI["getSettings"]>;
  projectTrusted: boolean;
}

function parentModelRuntime(registry: ParentSnapshot["modelRegistry"]): ModelRuntime {
  // Pi exposes this runtime through ModelRegistry internally, but has no public getter yet.
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime || typeof runtime.streamSimple !== "function") {
    throw new Error("This Pi version does not expose the parent model runtime required by subagents");
  }
  return runtime;
}

function resolveModel(profile: AgentProfile, parent: ParentSnapshot): Model<any> | undefined {
  if (!profile.model) return parent.model;
  if (profile.model.includes("/")) {
    const slash = profile.model.indexOf("/");
    const model = parent.modelRegistry.find(profile.model.slice(0, slash), profile.model.slice(slash + 1));
    if (!model) throw new Error(`${profile.filePath}: model not found: ${profile.model}`);
    return model;
  }
  const matches = parent.modelRegistry.getAll().filter((model) => model.id === profile.model);
  if (matches.length !== 1) {
    throw new Error(`${profile.filePath}: model selector "${profile.model}" matched ${matches.length} models; use provider/model`);
  }
  return matches[0];
}

function assistantText(message: AssistantMessage | undefined): string {
  return message?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() ?? "";
}

function messagePreview(message: AssistantMessage): string {
  const text = assistantText(message);
  return preview(text.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("```")).slice(0, 3).join(" "), 300);
}

export class PiChildSession implements ChildSession {
  constructor(private readonly session: AgentSession) {}

  async run(prompt: string, onUpdate: Parameters<ChildSession["run"]>[1], signal: AbortSignal): Promise<RunOutcome> {
    const startedAt = Date.now();
    const startEntryCount = this.session.sessionManager.getEntryCount();
    let message: AssistantMessage | undefined;
    const checkCancelled = () => signal.throwIfAborted();
    const abort = () => { void this.session.abort().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    const tools: ToolActivity[] = [];
    let toolCount = 0;
    const emitTools = (activity?: string) => onUpdate({ activity, tools: tools.map((tool) => ({ ...tool })), toolCount });
    const unsubscribe = this.session.subscribe((event) => {
      // Preflight may create this controller after an earlier abort attempt.
      if (event.type === "compaction_start" && signal.aborted) this.session.abortCompaction();
      if (event.type === "tool_execution_start") {
        toolCount++;
        const args = toolArgsPreview(event.toolName, event.args);
        tools.push({
          toolCallId: event.toolCallId,
          tool: event.toolName,
          args,
          status: "running",
        });
        if (tools.length > 20) tools.shift();
        emitTools(`${event.toolName} · ${args}`);
      }
      if (event.type === "tool_execution_end") {
        const tool = tools.find((entry) => entry.toolCallId === event.toolCallId);
        if (tool) tool.status = event.isError ? "failed" : "done";
        emitTools(event.isError ? `${event.toolName} failed` : `${event.toolName} done`);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        message = event.message;
        onUpdate({ lastMessage: messagePreview(message) });
      }
    });

    let thrown: unknown;
    try {
      checkCancelled();
      await this.session.prompt(prompt, {
        expandPromptTemplates: false,
        source: "extension",
        preflightResult: checkCancelled,
      });
    } catch (error) {
      thrown = error;
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
    }

    // Raw entries remain append-only when compaction rebuilds the message array.
    const usage = emptyUsage();
    for (const entry of this.session.sessionManager.getEntries().slice(startEntryCount)) {
      if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
        if (entry.message.usage) addUsage(usage, entry.message.usage, entry.message.role === "assistant" ? 1 : 0);
      } else if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
        addUsage(usage, entry.usage, 0);
      }
    }
    const fullOutput = assistantText(message);
    let fullOutputPath: string | undefined;
    let output = capOutput(fullOutput);
    if (output !== fullOutput) {
      try {
        const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
        fullOutputPath = path.join(directory, "output.txt");
        await writeFile(fullOutputPath, fullOutput, { encoding: "utf8", mode: 0o600 });
        output = capOutput(fullOutput, fullOutputPath);
      } catch {
        fullOutputPath = undefined;
      }
    }
    const stopReason = message?.stopReason;
    const error = signal.aborted ? "Subagent stopped" : thrown instanceof Error ? thrown.message : thrown ? String(thrown) : message?.errorMessage;
    const status = signal.aborted || stopReason === "aborted"
      ? "aborted"
      : error || stopReason === "error" || stopReason === "length" || !output
        ? "failed"
        : "completed";
    return {
      status,
      output,
      fullOutputPath,
      error: error ?? (stopReason === "length" ? "Subagent reached the model output limit" : !output ? "Subagent returned no final text" : undefined),
      usage,
      startedAt,
      endedAt: Date.now(),
    };
  }

  async steer(message: string): Promise<void> {
    await this.session.steer(message, undefined, { source: "extension" });
  }

  dispose(): void {
    this.session.dispose();
  }
}

export function snapshotParent(ctx: ExtensionContext, settings: ParentSnapshot["settings"]): ParentSnapshot {
  return {
    cwd: ctx.cwd,
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel,
    modelRegistry: ctx.modelRegistry,
    scopedModels: ctx.scopedModels,
    settings: structuredClone(settings),
    projectTrusted: ctx.isProjectTrusted(),
  };
}

function resolveSkillPath(skill: string, profile: AgentProfile, cwd: string, agentDir: string): string | undefined {
  const candidates = path.isAbsolute(skill)
    ? [skill]
    : skill.startsWith(".") || skill.includes("/")
      ? [path.resolve(path.dirname(profile.filePath), skill), path.resolve(cwd, skill)]
      : [
          path.join(agentDir, "skills", skill, "SKILL.md"),
          path.join(agentDir, "skills", `${skill}.md`),
          path.join(os.homedir(), ".agents", "skills", skill, "SKILL.md"),
        ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export async function createChildSession(
  profile: AgentProfile,
  parent: ParentSnapshot,
  toolRegistry: ChildToolRegistry,
): Promise<ChildSession> {
  const agentDir = getAgentDir();
  const modelRuntime = parentModelRuntime(parent.modelRegistry);
  const settingsManager = SettingsManager.inMemory(
    { ...parent.settings, cacheWarming: "off" },
    { projectTrusted: parent.projectTrusted },
  );
  const selectedSkills = new Set(profile.skills);
  const explicitSkillPaths = new Map<string, string>();
  for (const skill of selectedSkills) {
    const resolved = resolveSkillPath(skill, profile, parent.cwd, agentDir);
    if (resolved) explicitSkillPaths.set(skill, resolved);
  }
  const skillPaths = new Set(explicitSkillPaths.values());
  const loader = new DefaultResourceLoader({
    cwd: parent.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !profile.includeProjectContext,
    noSkills: selectedSkills.size === 0,
    additionalSkillPaths: [...skillPaths],
    skillsOverride: selectedSkills.size
      ? (base) => ({
          skills: base.skills.filter((skill) => selectedSkills.has(skill.name) || skillPaths.has(skill.filePath)),
          diagnostics: base.diagnostics,
        })
      : undefined,
    systemPromptOverride: profile.preserveBaseInstruction ? undefined : () => profile.systemPrompt,
    appendSystemPromptOverride: profile.preserveBaseInstruction ? (base) => [...base, profile.systemPrompt] : () => [],
  });
  await loader.reload();
  if (selectedSkills.size) {
    const loaded = loader.getSkills().skills;
    for (const skill of selectedSkills) {
      const explicitPath = explicitSkillPaths.get(skill);
      if (!loaded.some((entry) => entry.name === skill || entry.filePath === explicitPath)) {
        throw new Error(`${profile.filePath}: skill not found: ${skill}`);
      }
    }
  }

  const model = resolveModel(profile, parent);
  if (!model) throw new Error("No model is selected for the subagent");
  const customToolNames = profile.tools.filter((name) => !BUILTIN_TOOLS.has(name));
  const customTools = await toolRegistry.create(customToolNames, parent.cwd);
  let session: AgentSession | undefined;
  try {
    const result = await createAgentSession({
      cwd: parent.cwd,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel: (profile.thinking as ThinkingLevel | undefined) ?? parent.thinkingLevel,
      scopedModels: parent.scopedModels.map((entry) => ({ ...entry })),
      tools: [...profile.tools],
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(parent.cwd),
      settingsManager,
    });
    session = result.session;
    const allowed = new Set(profile.tools);
    session.agent.beforeToolCall = async ({ toolCall }) => allowed.has(toolCall.name)
      ? undefined
      : { block: true, reason: `Tool "${toolCall.name}" is outside this subagent profile`, terminate: true };
    session.setSessionName(profile.name);
    await session.bindExtensions({});
    return new PiChildSession(session);
  } catch (error) {
    session?.dispose();
    throw error;
  }
}
