import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, ModelRuntime, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { addUsage, capOutputWithArtifact, emptyUsage, SUBAGENT_TOOLS, type AgentProfile, preview, toolArgsPreview, type RunOutcome, type UsageSummary } from "./core.ts";
import type { ChildRunUpdate, ChildSession, ToolActivity } from "./manager.ts";

const PI_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit", "bash", "powershell"]);

export interface ParentSnapshot {
  cwd: string;
  model: Model<any> | undefined;
  thinkingLevel?: ThinkingLevel;
  modelRegistry: ExtensionContext["modelRegistry"];
  scopedModels: ExtensionContext["scopedModels"];
  settings: ReturnType<ExtensionAPI["getSettings"]>;
  projectTrusted: boolean;
  inheritedMessages?: Message[];
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
  const slash = profile.model.indexOf("/");
  if (slash >= 0) {
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

function collectUsage(session: AgentSession, startEntryCount: number): UsageSummary {
  const usage = emptyUsage();
  for (const entry of session.sessionManager.getEntries().slice(startEntryCount)) {
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
      if (entry.message.usage) addUsage(usage, entry.message.usage, entry.message.role === "assistant" ? 1 : 0);
    } else if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      addUsage(usage, entry.usage, 0);
    }
  }
  return usage;
}

class PiChildSession implements ChildSession {
  constructor(private readonly session: AgentSession, private needsHandoff = false) {}

  async run(prompt: string, onUpdate: (update: ChildRunUpdate) => void, signal: AbortSignal): Promise<RunOutcome> {
    const startedAt = Date.now();
    const startEntryCount = this.session.sessionManager.getEntryCount();
    let message: AssistantMessage | undefined;
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
        const args = toolArgsPreview(event.args);
        tools.push({
          toolCallId: event.toolCallId,
          tool: event.toolName,
          args,
          status: "running",
        });
        if (tools.length > 20) tools.shift();
        emitTools(args ? `${event.toolName} · ${args}` : event.toolName);
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
      signal.throwIfAborted();
      const task = this.needsHandoff
        ? `The preceding conversation is from your parent agent. Use it as background for the following task:\n\n${prompt}`
        : prompt;
      await this.session.prompt(task, {
        expandPromptTemplates: false,
        source: "extension",
        preflightResult: (result) => {
          signal.throwIfAborted();
          if (result === "started") this.needsHandoff = false;
        },
      });
    } catch (error) {
      thrown = error;
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
    }

    // Raw entries remain append-only when compaction rebuilds the message array.
    const usage = collectUsage(this.session, startEntryCount);
    const fullOutput = assistantText(message);
    const { output, fullOutputPath } = capOutputWithArtifact(fullOutput);
    const stopReason = message?.stopReason;
    let error = message?.errorMessage;
    if (signal.aborted) error = "Subagent stopped";
    else if (thrown instanceof Error) error = thrown.message;
    else if (thrown) error = String(thrown);

    let status: RunOutcome["status"] = "completed";
    if (signal.aborted || stopReason === "aborted") {
      status = "aborted";
    } else if (error || stopReason === "error" || stopReason === "length" || !output) {
      status = "failed";
    }
    return {
      status,
      output,
      fullOutputPath,
      error: error ?? (
        stopReason === "length" ? "Subagent reached the model output limit"
          : !output ? "Subagent returned no final text" : undefined
      ),
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

export function snapshotParent(
  ctx: ExtensionContext,
  settings: ParentSnapshot["settings"],
  launchToolCallId?: string,
): ParentSnapshot {
  let inheritedMessages: Message[] | undefined;
  if (launchToolCallId !== undefined) {
    const { messages } = ctx.sessionManager.buildSessionProjection();
    const launchIndex = messages.findIndex((message) => message.role === "assistant" &&
      message.content.some((part) => part.type === "toolCall" && part.id === launchToolCallId));
    if (launchIndex < 0) throw new Error("Cannot inherit context: launch tool call is missing from the parent transcript");
    // Exclude the whole launching batch, including any sibling results already recorded.
    inheritedMessages = structuredClone(convertToLlm(messages.slice(0, launchIndex).filter((message) => message.role !== "system")));
    // Parent usage and recovery state must not trigger compaction or retries in the child.
    for (const message of inheritedMessages) {
      if (message.role !== "assistant") continue;
      message.usage = emptyUsage();
      delete message.errorMessage;
      if (message.stopReason === "length") {
        message.stopReason = message.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
      }
    }
  }
  return {
    cwd: ctx.cwd,
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel,
    modelRegistry: ctx.modelRegistry,
    scopedModels: ctx.scopedModels,
    settings: structuredClone(settings),
    projectTrusted: ctx.isProjectTrusted(),
    inheritedMessages,
  };
}

function resolveSkillPath(skill: string, profile: AgentProfile, cwd: string, agentDir: string): string | undefined {
  if (path.isAbsolute(skill)) return fs.existsSync(skill) ? skill : undefined;
  const candidates = skill.startsWith(".") || skill.includes("/")
    ? [path.resolve(path.dirname(profile.filePath), skill), path.resolve(cwd, skill)]
    : [
        path.join(agentDir, "skills", skill, "SKILL.md"),
        path.join(agentDir, "skills", `${skill}.md`),
        path.join(os.homedir(), ".agents", "skills", skill, "SKILL.md"),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function resolveToolExtensionPaths(
  profile: AgentProfile,
  tools: readonly ToolInfo[],
): string[] {
  const available = tools.filter(
    (tool) => tool.exposure !== "hidden" && !SUBAGENT_TOOLS.has(tool.name),
  );
  const names = new Set(available.map((tool) => tool.name));
  const missing = profile.tools.filter((name) => !names.has(name));
  if (missing.length) {
    throw new Error(`${profile.filePath}: unavailable tool(s): ${missing.join(", ")}`);
  }

  const selected = new Set(profile.tools);
  const extensionPaths = new Set<string>();
  for (const tool of available) {
    if (!selected.has(tool.name) || PI_BUILTIN_TOOLS.has(tool.name)) continue;
    const source = tool.sourceInfo.path;
    if (source.startsWith("<")) {
      throw new Error(`${profile.filePath}: tool ${tool.name} is not provided by a loadable extension`);
    }
    extensionPaths.add(source);
  }
  return [...extensionPaths];
}

function resolvePromptVariables(prompt: string, cwd: string): string {
  return prompt
    .replaceAll("{{date}}", new Date().toISOString())
    .replaceAll("{{cwd}}", cwd);
}

export async function createChildSession(
  profile: AgentProfile,
  parent: ParentSnapshot,
  extensionPaths: string[],
): Promise<ChildSession> {
  const agentDir = getAgentDir();
  const modelRuntime = parentModelRuntime(parent.modelRegistry);
  const systemPrompt = resolvePromptVariables(profile.systemPrompt, parent.cwd);
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
    additionalExtensionPaths: extensionPaths,
    noPromptTemplates: true,
    noThemes: true,
    noSkills: selectedSkills.size === 0,
    additionalSkillPaths: [...skillPaths],
    skillsOverride: selectedSkills.size
      ? (base) => ({
          skills: base.skills.filter((skill) => selectedSkills.has(skill.name) || skillPaths.has(skill.filePath)),
          diagnostics: base.diagnostics,
        })
      : undefined,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
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
  let session: AgentSession | undefined;
  try {
    const sessionManager = SessionManager.inMemory(parent.cwd);
    for (const message of parent.inheritedMessages ?? []) sessionManager.appendMessage(message);
    const result = await createAgentSession({
      cwd: parent.cwd,
      agentDir,
      model,
      modelRuntime,
      thinkingLevel: (profile.thinking as ThinkingLevel | undefined) ?? parent.thinkingLevel,
      scopedModels: parent.scopedModels.map((entry) => ({ ...entry })),
      tools: [...profile.tools],
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    session = result.session;
    session.setSessionName(profile.name);
    await session.bindExtensions({});
    return new PiChildSession(session, parent.inheritedMessages !== undefined);
  } catch (error) {
    session?.dispose();
    throw error;
  }
}
