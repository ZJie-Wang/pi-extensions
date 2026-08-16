import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { addUsage, BUILTIN_TOOLS, type AgentProfile, capOutput, emptyUsage, preview, toolArgsPreview, type RunOutcome } from "./core.ts";
import type { ChildSession, ToolActivity } from "./manager.ts";
import type { ChildToolRegistry } from "./tool-loader.ts";

export interface ParentSnapshot {
  cwd: string;
  model: Model<any> | undefined;
  thinkingLevel?: ThinkingLevel;
  modelRegistry: ExtensionContext["modelRegistry"];
  scopedModels: ExtensionContext["scopedModels"];
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

function assistantText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim();
}

function finalAssistant(messages: readonly any[], startIndex: number): any | undefined {
  for (let index = messages.length - 1; index >= startIndex; index--) {
    if (messages[index]?.role === "assistant") return messages[index];
  }
  return undefined;
}

function messagePreview(message: any): string {
  const text = assistantText(message);
  return preview(text.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("```")).slice(0, 3).join(" "), 300);
}

class PiChildSession implements ChildSession {
  private readonly session: AgentSession;

  constructor(session: AgentSession) {
    this.session = session;
  }

  async run(prompt: string, onUpdate: Parameters<ChildSession["run"]>[1]): Promise<RunOutcome> {
    const startedAt = Date.now();
    const startIndex = this.session.messages.length;
    const usage = emptyUsage();
    const tools: ToolActivity[] = [];
    let toolCount = 0;
    const emitTools = (activity?: string) => onUpdate({ activity, tools: tools.map((tool) => ({ ...tool })), toolCount });
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        toolCount++;
        tools.push({
          toolCallId: event.toolCallId,
          tool: event.toolName,
          args: toolArgsPreview(event.toolName, event.args),
          status: "running",
        });
        while (tools.length > 20) tools.shift();
        emitTools(`${event.toolName} · ${toolArgsPreview(event.toolName, event.args)}`);
      }
      if (event.type === "tool_execution_end") {
        const tool = tools.find((entry) => entry.toolCallId === event.toolCallId);
        if (tool) tool.status = event.isError ? "failed" : "done";
        emitTools(event.isError ? `${event.toolName} failed` : `${event.toolName} done`);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        addUsage(usage, (event.message as any).usage);
        onUpdate({ usage, lastMessage: messagePreview(event.message) });
      }
    });

    let thrown: unknown;
    try {
      await this.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
    } catch (error) {
      thrown = error;
    } finally {
      unsubscribe();
    }

    const message = finalAssistant(this.session.messages, startIndex);
    const output = capOutput(assistantText(message));
    const stopReason = message?.stopReason;
    const error = thrown instanceof Error ? thrown.message : thrown ? String(thrown) : message?.errorMessage;
    const status = stopReason === "aborted"
      ? "aborted"
      : error || stopReason === "error" || stopReason === "length" || !output
        ? "failed"
        : "completed";
    return {
      status,
      output,
      error: error ?? (stopReason === "length" ? "Subagent reached the model output limit" : !output ? "Subagent returned no final text" : undefined),
      usage,
      startedAt,
      endedAt: Date.now(),
    };
  }

  steer(message: string): Promise<void> {
    return this.session.steer(message);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  dispose(): void {
    this.session.dispose();
  }
}

export function snapshotParent(ctx: ExtensionContext): ParentSnapshot {
  return {
    cwd: ctx.cwd,
    model: ctx.model,
    thinkingLevel: ctx.thinkingLevel,
    modelRegistry: ctx.modelRegistry,
    scopedModels: ctx.scopedModels,
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
  const selectedSkills = new Set(profile.skills);
  const explicitSkillPaths = new Map<string, string>();
  for (const skill of selectedSkills) {
    const resolved = resolveSkillPath(skill, profile, parent.cwd, agentDir);
    if (resolved) explicitSkillPaths.set(skill, resolved);
  }
  const loader = new DefaultResourceLoader({
    cwd: parent.cwd,
    agentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !profile.includeProjectContext,
    noSkills: selectedSkills.size === 0,
    additionalSkillPaths: [...explicitSkillPaths.values()],
    skillsOverride: selectedSkills.size
      ? (base) => ({
          skills: base.skills.filter((skill) => selectedSkills.has(skill.name) || [...explicitSkillPaths.values()].includes(skill.filePath)),
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
  const modelRuntime = (parent.modelRegistry as unknown as { runtime?: any }).runtime;
  const settingsManager = SettingsManager.create(parent.cwd, agentDir);
  const customToolNames = profile.tools.filter((name) => !BUILTIN_TOOLS.has(name));
  const customTools: any[] = await toolRegistry.create(customToolNames, parent.cwd);
  let session: AgentSession | undefined;
  try {
    const result = await createAgentSession({
      cwd: parent.cwd,
      agentDir,
      model,
      ...(modelRuntime ? { modelRuntime } : {}),
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
