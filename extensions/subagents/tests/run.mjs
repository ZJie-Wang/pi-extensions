import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
let host = process.env.PI_CODING_AGENT_PACKAGE;
if (!host) {
  try {
    host = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  } catch {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    host = join(globalRoot, "@earendil-works", "pi-coding-agent");
  }
}
const loader = join(resolve(host), "dist", "core", "extensions", "loader.js");
if (!existsSync(loader)) throw new Error("Set PI_CODING_AGENT_PACKAGE to the installed Pi package directory");
const { loadExtensions } = await import(pathToFileURL(loader).href);
const files = readdirSync(directory).filter((name) => name.endsWith(".test.ts")).sort();
for (const file of files) {
  const result = await loadExtensions([join(directory, file)], directory);
  if (result.errors.length) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  }
}
