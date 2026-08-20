import { readFileSync } from "node:fs";

export function loadToolAllowlist(path: URL): string[] {
  const filename = path.pathname.split("/").at(-1) ?? path.href;
  let value: unknown;

  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not load ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== "string" || !name.trim())
  ) {
    throw new Error(
      `${filename} must be a JSON array of non-empty tool names.`,
    );
  }

  return [...new Set(value)];
}
