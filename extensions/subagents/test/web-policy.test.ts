import assert from "node:assert/strict";
import test from "node:test";
import createWebTool, { validateWebInvocation } from "../tools/web.ts";

const allowed: Array<[string, string[]]> = [
  ["date", []],
  ["tvly", ["search", "pi coding agent", "--depth", "fast", "--json"]],
  ["tvly", ["extract", "https://example.com", "--json"]],
  ["tvly", ["map", "https://example.com", "--json"]],
  ["tvly", ["research", "run", "question", "--json"]],
  ["tvly", ["--status", "--json"]],
  ["curl", ["-sSL", "--fail", "https://example.com"]],
  ["curl", ["--head", "--max-time", "10", "--url=https://example.com"]],
  ["curl", ["-H", "Accept: application/json", "https://example.com"]],
];

for (const [program, args] of allowed) {
  test(`allows ${program} ${args.join(" ")}`, () => assert.doesNotThrow(() => validateWebInvocation(program, args)));
}

test("executes date and returns its output", async () => {
  const result = await createWebTool(process.cwd()).execute(
    "test",
    { program: "date", args: [] },
    undefined,
    undefined,
    {} as never,
  );
  assert.ok(result.content[0]?.type === "text" && result.content[0].text.trim());
  assert.equal(result.details?.program, "date");
  assert.equal(result.details?.exitCode, 0);
});

const blocked: Array<[string, string[]]> = [
  ["date", ["-r", "/etc/passwd"]],
  ["tvly", ["login", "--api-key", "secret"]],
  ["tvly", ["search", "q", "--output", "/tmp/result"]],
  ["curl", ["-o", "/tmp/x", "https://example.com"]],
  ["curl", ["--data", "x", "https://example.com"]],
  ["curl", ["-X", "POST", "https://example.com"]],
  ["curl", ["--upload-file", "x", "https://example.com"]],
  ["curl", ["--config", "/tmp/curlrc", "https://example.com"]],
  ["curl", ["-H", "@/tmp/headers", "https://example.com"]],
  ["curl", ["file:///etc/passwd"]],
  ["bash", ["-lc", "curl https://example.com"]],
];

for (const [program, args] of blocked) {
  test(`blocks ${program} ${args.join(" ")}`, () => assert.throws(() => validateWebInvocation(program, args)));
}
