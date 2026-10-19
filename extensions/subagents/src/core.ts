import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai/compat";

export const SUBAGENT_TOOLS = new Set(["subagent_run", "subagent_control"]);
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

export const RESOURCE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface AgentProfile {
  name: string;
  description: string;
  tools: string[];
  skills: string[];
  model?: string;
  thinking?: string;
  systemPrompt: string;
  filePath: string;
}

export interface UsageSummary extends Usage {
  turns: number;
}

export interface RunOutcome {
  status: "completed" | "failed" | "aborted";
  output: string;
  fullOutputPath?: string;
  error?: string;
  usage: UsageSummary;
  startedAt: number;
  endedAt: number;
}

export function emptyUsage(): UsageSummary {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 0,
  };
}

export function addUsage(target: UsageSummary, usage: Usage & { turns?: number }, turns = usage.turns ?? 1): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost.input += usage.cost.input;
  target.cost.output += usage.cost.output;
  target.cost.cacheRead += usage.cost.cacheRead;
  target.cost.cacheWrite += usage.cost.cacheWrite;
  target.cost.total += usage.cost.total;
  target.turns += turns;
}

export function parseStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!raw) throw new Error(`${field}: expected an array or comma-separated string`);
  const values = raw.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${field}: every entry must be a string`);
    return entry.trim();
  }).filter(Boolean);
  return [...new Set(values)];
}

function inheritedString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "" || value === "inherit") return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field}: expected "inherit" or a non-empty string`);
  return value.trim();
}

export function normalizeProfile(
  input: Record<string, unknown>,
  body: string,
  filePath: string,
): AgentProfile {
  const fail = (message: string): never => { throw new Error(`${filePath}: ${message}`); };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) fail("name is required");
  if (!RESOURCE_NAME_PATTERN.test(name)) fail("name must start with a lowercase letter and contain only lowercase letters, numbers, _ or -");
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description) fail("description is required");

  const tools = parseStringList(input.tools, "tools");
  const subagentTools = tools.filter((tool) => SUBAGENT_TOOLS.has(tool));
  if (subagentTools.length) fail(`child agents cannot receive subagent orchestration tools: ${subagentTools.join(", ")}`);

  const skills = parseStringList(input.skills, "skills");
  if (skills.length && !tools.includes("read")) fail("profiles with skills must include read");
  const model = inheritedString(input.model, "model");
  const thinking = inheritedString(input.thinking, "thinking");
  if (thinking && !THINKING_LEVELS.has(thinking)) fail(`invalid thinking level: ${thinking}`);
  const systemPrompt = body.trim();
  if (!systemPrompt) fail("profile instructions are empty");

  return {
    name,
    description,
    tools,
    skills,
    model,
    thinking,
    systemPrompt,
    filePath,
  };
}

function utf8Prefix(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export function capOutput(text: string, fullOutputPath?: string): string {
  const lines = text.split("\n", MAX_OUTPUT_LINES + 1);
  if (lines.length <= MAX_OUTPUT_LINES && Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  const notice = fullOutputPath
    ? `\n\n[Output truncated. Full output: ${fullOutputPath}]`
    : "\n\n[Output truncated to 50 KB / 2,000 lines.]";
  const lineLimited = lines.slice(0, MAX_OUTPUT_LINES - 2).join("\n");
  return utf8Prefix(lineLimited, MAX_OUTPUT_BYTES - Buffer.byteLength(notice, "utf8")) + notice;
}

function writeOutputArtifact(text: string): string | undefined {
  try {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    const outputPath = path.join(directory, "output.txt");
    writeFileSync(outputPath, text, { encoding: "utf8", mode: 0o600 });
    return outputPath;
  } catch {
    return undefined;
  }
}

export function capOutputWithArtifact(text: string): { output: string; fullOutputPath?: string } {
  const output = capOutput(text);
  if (output === text) return { output };
  const fullOutputPath = writeOutputArtifact(text);
  return { output: capOutput(text, fullOutputPath), fullOutputPath };
}

export function preview(text: string, width = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1))}…`;
}

function primaryArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const values = Object.values(args as Record<string, unknown>);
  const list = values.find((value): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string"));
  if (list) return list.join(", ");
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}

export function toolArgsPreview(args: unknown): string {
  const value = primaryArg(args);
  if (value !== undefined) return preview(value, 140);
  const json = JSON.stringify(args ?? {});
  return json === "{}" ? "" : preview(json, 140);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export function formatUsage(usage: UsageSummary): string {
  const tokens = usage.input + usage.output;
  const formatted = tokens < 1_000 ? `${tokens}` : `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${usage.turns} turn${usage.turns === 1 ? "" : "s"} · ${formatted} tokens${usage.cost.total ? ` · $${usage.cost.total.toFixed(4)}` : ""}`;
}
