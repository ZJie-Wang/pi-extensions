export const BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit", "bash"]);
export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2_000;

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface AgentProfile {
  name: string;
  description: string;
  tools: string[];
  skills: string[];
  model?: string;
  thinking?: string;
  preserveBaseInstruction: boolean;
  includeProjectContext: boolean;
  systemPrompt: string;
  filePath: string;
}

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  turns: number;
}

export interface RunOutcome {
  status: "completed" | "failed" | "aborted";
  output: string;
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

export function addUsage(target: UsageSummary, usage: any): void {
  target.input += usage?.input ?? 0;
  target.output += usage?.output ?? 0;
  target.cacheRead += usage?.cacheRead ?? 0;
  target.cacheWrite += usage?.cacheWrite ?? 0;
  target.totalTokens += usage?.totalTokens ?? 0;
  target.cost.input += usage?.cost?.input ?? 0;
  target.cost.output += usage?.cost?.output ?? 0;
  target.cost.cacheRead += usage?.cost?.cacheRead ?? 0;
  target.cost.cacheWrite += usage?.cost?.cacheWrite ?? 0;
  target.cost.total += usage?.cost?.total ?? 0;
  target.turns += 1;
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

function booleanValue(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${field}: expected true or false`);
}

export function normalizeProfile(
  input: Record<string, unknown>,
  body: string,
  filePath: string,
  knownTools: ReadonlySet<string> = BUILTIN_TOOLS,
): AgentProfile {
  const fail = (message: string): never => { throw new Error(`${filePath}: ${message}`); };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) fail("name is required");
  if (!AGENT_NAME.test(name)) fail("name must start with a lowercase letter and contain only lowercase letters, numbers, _ or -");
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description) fail("description is required");

  const tools = parseStringList(input.tools, "tools");
  const nested = tools.filter((tool) => tool === "subagent_run" || tool === "subagent_control");
  if (nested.length) fail("child agents cannot receive subagent orchestration tools");
  const unknown = tools.filter((tool) => !knownTools.has(tool));
  if (unknown.length) fail(`unknown tool(s): ${unknown.join(", ")}`);

  const skills = parseStringList(input.skills, "skills");
  if (skills.length && !tools.includes("read")) fail("profiles with skills must include read");
  const model = inheritedString(input.model, "model");
  const thinking = inheritedString(input.thinking, "thinking");
  if (thinking && !THINKING_LEVELS.has(thinking)) fail(`invalid thinking level: ${thinking}`);
  if (!body.trim()) fail("profile instructions are empty");

  return {
    name,
    description,
    tools,
    skills,
    model,
    thinking,
    preserveBaseInstruction: booleanValue(input.preserveBaseInstruction, "preserveBaseInstruction", true),
    includeProjectContext: booleanValue(input.includeProjectContext, "includeProjectContext", true),
    systemPrompt: body.trim(),
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

export function capOutput(text: string): string {
  const lines = text.split("\n");
  const lineLimited = lines.length > MAX_OUTPUT_LINES ? lines.slice(0, MAX_OUTPUT_LINES).join("\n") : text;
  const notice = "\n\n[Output truncated to 50 KB / 2,000 lines. Continue the thread for details.]";
  if (lineLimited === text && Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  return utf8Prefix(lineLimited, MAX_OUTPUT_BYTES - Buffer.byteLength(notice, "utf8")) + notice;
}

export function preview(text: string, width = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(1, width - 1))}…`;
}

export function toolArgsPreview(toolName: string, args: any): string {
  if (toolName === "web" && args?.program) {
    const argv = Array.isArray(args.args) ? args.args.map(String).join(" ") : "";
    return preview([args.program, argv].filter(Boolean).join(" "), 140);
  }
  const value = args?.command ?? args?.path ?? args?.query ?? args?.pattern ?? args?.url;
  if (value !== undefined) return preview(String(value), 140);
  if (args?.program) return preview(String(args.program), 140);
  return preview(JSON.stringify(args ?? {}), 140);
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
