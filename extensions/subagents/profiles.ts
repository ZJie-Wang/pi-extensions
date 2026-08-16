import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AgentProfile, normalizeProfile } from "./core.ts";

export interface ProfileRefresh {
  changed: boolean;
  warning?: string;
}

function profileSignature(profiles: AgentProfile[]): string {
  return JSON.stringify(profiles);
}

export function loadProfiles(directory: string, knownTools: ReadonlySet<string>): AgentProfile[] {
  if (!fs.existsSync(directory)) throw new Error(`Subagent profile directory does not exist: ${directory}`);
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new Error(`No subagent profiles found in ${directory}`);

  const seen = new Map<string, string>();
  return files.map((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const profile = normalizeProfile(frontmatter, body, filePath, knownTools);
    const previous = seen.get(profile.name);
    if (previous) throw new Error(`Duplicate subagent name "${profile.name}" in ${previous} and ${filePath}`);
    seen.set(profile.name, filePath);
    return profile;
  });
}

export class ProfileStore {
  private profiles: AgentProfile[];
  private signature: string;
  private lastWarning?: string;
  private readonly directory: string;
  private knownTools: ReadonlySet<string>;

  constructor(directory: string, knownTools: ReadonlySet<string>) {
    this.directory = directory;
    this.knownTools = knownTools;
    this.profiles = loadProfiles(directory, knownTools);
    this.signature = profileSignature(this.profiles);
  }

  setKnownTools(knownTools: ReadonlySet<string>): void {
    this.knownTools = knownTools;
  }

  refresh(): ProfileRefresh {
    try {
      const next = loadProfiles(this.directory, this.knownTools);
      const signature = profileSignature(next);
      const changed = signature !== this.signature;
      if (changed) {
        this.profiles = next;
        this.signature = signature;
      }
      this.lastWarning = undefined;
      return { changed };
    } catch (error) {
      const warning = `Subagent profiles were not refreshed; using the last valid set. ${error instanceof Error ? error.message : String(error)}`;
      const isNew = warning !== this.lastWarning;
      this.lastWarning = warning;
      return { changed: false, warning: isNew ? warning : undefined };
    }
  }

  list(): readonly AgentProfile[] {
    return this.profiles;
  }

  get(name: string): AgentProfile | undefined {
    return this.profiles.find((profile) => profile.name === name);
  }

  describe(): string {
    return this.profiles
      .map((profile) => `- ${profile.name}: ${profile.description}`)
      .join("\n");
  }
}
