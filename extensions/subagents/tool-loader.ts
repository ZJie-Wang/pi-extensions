import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";


export type ChildToolFactory = (cwd: string) => ToolDefinition<any, any>;

/**
 * Child tool modules live in tools/<tool-name>.ts and default-export a factory.
 * Filenames form the profile allowlist catalogue; modules are imported only when
 * a new thread actually requests them.
 */
export class ChildToolRegistry {
  private files = new Map<string, string>();
  private signature = "";

  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    this.refresh();
  }

  refresh(): boolean {
    const next = new Map<string, string>();
    if (fs.existsSync(this.directory)) {
      const files = fs.readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.(?:ts|js|mjs)$/.test(entry.name))
        .map((entry) => path.join(this.directory, entry.name))
        .sort((a, b) => a.localeCompare(b));
      for (const filePath of files) {
        const name = path.basename(filePath).replace(/\.(?:ts|js|mjs)$/, "");
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`${filePath}: invalid child tool filename`);
        if (name === "subagent_run" || name === "subagent_control") throw new Error(`${filePath}: reserved orchestration tool name`);
        if (next.has(name)) throw new Error(`${filePath}: duplicate child tool name: ${name}`);
        next.set(name, filePath);
      }
    }
    const signature = JSON.stringify([...next.entries()].map(([name, filePath]) => [name, filePath, fs.statSync(filePath).mtimeMs]));
    const changed = signature !== this.signature;
    this.files = next;
    this.signature = signature;
    return changed;
  }

  names(): string[] {
    return [...this.files.keys()];
  }

  async create(names: readonly string[], cwd: string): Promise<ToolDefinition<any, any>[]> {
    const tools: ToolDefinition<any, any>[] = [];
    for (const name of names) {
      const filePath = this.files.get(name);
      if (!filePath) throw new Error(`Unknown child tool: ${name}`);
      const stats = fs.statSync(filePath);
      const module = await import(`${pathToFileURL(filePath).href}?v=${stats.mtimeMs}`);
      if (typeof module.default !== "function") throw new Error(`${filePath}: expected a default tool factory function`);
      const tool = (module.default as ChildToolFactory)(cwd);
      if (tool?.name !== name) throw new Error(`${filePath}: factory must return tool named "${name}"`);
      tools.push(tool);
    }
    return tools;
  }
}
