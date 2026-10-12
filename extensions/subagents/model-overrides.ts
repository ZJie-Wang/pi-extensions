import { readFileSync } from "node:fs";
import { type AgentProfile, THINKING_LEVELS } from "./core.ts";

const PROFILE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
type Override = { model?: string; thinking?: string };
type ParentModels = Record<string, Record<string, Override>>;

function validateConfig(input: unknown, configPath: string): ParentModels {
  const fail = (message: string): never => {
    throw new Error(`Cannot launch subagent: ${configPath}: ${message}`);
  };
  const object = (value: unknown, location: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`${location}: expected an object`);
    }
    return value as Record<string, unknown>;
  };
  const root = object(input, "root");
  for (const key of Object.keys(root)) {
    if (key !== "parentModels") fail(`root: unknown field ${JSON.stringify(key)}`);
  }
  const parentModels = object(root.parentModels, "parentModels");
  for (const [selector, value] of Object.entries(parentModels)) {
    const location = `parentModels[${JSON.stringify(selector)}]`;
    if (!selector.trim() || selector !== selector.trim()) {
      fail(`${location}: selector must be non-empty and trimmed`);
    }
    const profiles = object(value, location);
    for (const [name, value] of Object.entries(profiles)) {
      const profileLocation = `${location}[${JSON.stringify(name)}]`;
      if (!PROFILE_NAME.test(name)) fail(`${profileLocation}: invalid profile name`);
      const override = object(value, profileLocation);
      if (!Object.keys(override).length) fail(`${profileLocation}: expected model or thinking`);
      for (const [field, value] of Object.entries(override)) {
        if (field !== "model" && field !== "thinking") {
          fail(`${profileLocation}: unknown field ${JSON.stringify(field)}`);
        }
        if (typeof value !== "string" || !value.trim()) {
          fail(`${profileLocation}.${field}: expected a non-empty string`);
        }
        if (field === "thinking" && (value as string).trim() !== "inherit" && !THINKING_LEVELS.has((value as string).trim())) {
          fail(`${profileLocation}.thinking: invalid thinking level ${JSON.stringify(value)}`);
        }
      }
    }
  }
  return parentModels as ParentModels;
}

export function resolveProfileOverrides(
  profile: AgentProfile,
  parent: { provider: string; id: string } | undefined,
  configPath: string,
): AgentProfile {
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(profile);
    throw new Error(`Cannot launch subagent: ${configPath}: cannot read model overrides: ${error instanceof Error ? error.message : String(error)}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch (error) {
    throw new Error(`Cannot launch subagent: ${configPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parentModels = validateConfig(input, configPath);
  const resolved = structuredClone(profile);
  if (!parent) return resolved;
  const qualified = `${parent.provider}/${parent.id}`;
  const selector = Object.hasOwn(parentModels, qualified) ? qualified : parent.id;
  if (!Object.hasOwn(parentModels, selector)) return resolved;
  const rules = parentModels[selector];
  if (!Object.hasOwn(rules, profile.name)) return resolved;
  const override = rules[profile.name];
  for (const field of ["model", "thinking"] as const) {
    if (Object.hasOwn(override, field)) {
      const value = override[field]!.trim();
      resolved[field] = value === "inherit" ? undefined : value;
    }
  }
  return resolved;
}
