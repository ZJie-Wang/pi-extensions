import assert from "node:assert/strict";
import test from "node:test";
import { capOutput, MAX_OUTPUT_BYTES, normalizeProfile } from "../core.ts";

const base = {
  name: "scout",
  description: "Explore",
  tools: ["read", "grep"],
  skills: [],
  model: "inherit",
  thinking: "low",
  preserveBaseInstruction: false,
};

test("normalizes a profile and inheritance", () => {
  const profile = normalizeProfile(base, "Be useful", "/agents/scout.md");
  assert.equal(profile.model, undefined);
  assert.equal(profile.thinking, "low");
  assert.equal(profile.preserveBaseInstruction, false);
  assert.equal(profile.includeProjectContext, true);
  assert.deepEqual(profile.tools, ["read", "grep"]);
});

test("supports excluding project context and validates the boolean", () => {
  assert.equal(normalizeProfile({ ...base, includeProjectContext: false }, "x", "/a.md").includeProjectContext, false);
  assert.throws(() => normalizeProfile({ ...base, includeProjectContext: "sometimes" }, "x", "/a.md"), /includeProjectContext: expected true or false/);
});

test("rejects unknown and orchestration tools", () => {
  assert.throws(() => normalizeProfile({ ...base, tools: ["mystery"] }, "x", "/a.md"), /unknown tool/);
  assert.throws(() => normalizeProfile({ ...base, tools: ["subagent_run"] }, "x", "/a.md"), /orchestration/);
});

test("caps output by lines and UTF-8 bytes", () => {
  const result = capOutput("界".repeat(MAX_OUTPUT_BYTES));
  assert.ok(Buffer.byteLength(result, "utf8") <= MAX_OUTPUT_BYTES);
  assert.match(result, /Output truncated/);
  assert.doesNotMatch(result, /�/);
  assert.match(capOutput(Array.from({ length: 2_100 }, (_, i) => String(i)).join("\n")), /Output truncated/);
});
