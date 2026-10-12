import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentProfile } from "../core.ts";
import { resolveProfileOverrides } from "../model-overrides.ts";

const profile: AgentProfile = {
  name: "worker",
  description: "Test worker",
  tools: ["read"],
  skills: ["test-skill"],
  model: "original/model",
  thinking: "medium",
  preserveBaseInstruction: true,
  includeProjectContext: true,
  systemPrompt: "Test instructions",
  filePath: "worker.md",
};
const parent = { provider: "provider", id: "parent-id" };

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "subagent-model-overrides-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "overrides.json");
  return {
    configPath,
    write: (config: unknown) => writeFileSync(configPath, JSON.stringify(config)),
    resolve: (model: typeof parent | undefined = parent) => resolveProfileOverrides(profile, model, configPath),
  };
}

function assertClone(result: AgentProfile) {
  assert.deepEqual(result, profile);
  assert.notEqual(result, profile);
  assert.notEqual(result.tools, profile.tools);
  assert.notEqual(result.skills, profile.skills);
}

function assertConfigError(run: () => unknown, configPath: string, message: RegExp) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(configPath));
    assert.match(error.message, /Cannot launch subagent/);
    assert.match(error.message, message);
    return true;
  });
}

test("missing override file returns a deep clone", (t) => {
  const f = fixture(t);
  const result = f.resolve();
  assertClone(result);
  result.tools.push("bash");
  assert.deepEqual(profile.tools, ["read"]);
});

test("read errors and malformed JSON prevent launch", (t) => {
  const f = fixture(t);
  mkdirSync(f.configPath);
  assertConfigError(() => f.resolve(), f.configPath, /cannot read model overrides/);
  rmSync(f.configPath, { recursive: true });
  writeFileSync(f.configPath, "{bad JSON");
  assertConfigError(() => f.resolve(), f.configPath, /invalid JSON/);
});

const invalidConfigs: [string, unknown, RegExp][] = [
  ["null root", null, /root: expected an object/],
  ["array root", [], /root: expected an object/],
  ["primitive root", "config", /root: expected an object/],
  ["missing parentModels", {}, /parentModels: expected an object/],
  ["unknown root field", { parentModels: {}, extra: true }, /unknown field "extra"/],
  ["null parentModels", { parentModels: null }, /parentModels: expected an object/],
  ["array parentModels", { parentModels: [] }, /parentModels: expected an object/],
  ["empty selector", { parentModels: { "": {} } }, /selector must be non-empty and trimmed/],
  ["whitespace selector", { parentModels: { " ": {} } }, /selector must be non-empty and trimmed/],
  ["untrimmed selector", { parentModels: { " parent-id": {} } }, /selector must be non-empty and trimmed/],
  ["null rule", { parentModels: { other: null } }, /expected an object/],
  ["array rule", { parentModels: { other: [] } }, /expected an object/],
  ["invalid profile name", { parentModels: { other: { Worker: { model: "child" } } } }, /invalid profile name/],
  ["long profile name", { parentModels: { other: { ["a".repeat(65)]: { model: "child" } } } }, /invalid profile name/],
  ["null override", { parentModels: { other: { scout: null } } }, /expected an object/],
  ["array override", { parentModels: { other: { scout: [] } } }, /expected an object/],
  ["empty override", { parentModels: { other: { scout: {} } } }, /expected model or thinking/],
  ["unknown override field", { parentModels: { other: { scout: { model: "child", tools: [] } } } }, /unknown field "tools"/],
  ["empty model", { parentModels: { other: { scout: { model: "" } } } }, /model: expected a non-empty string/],
  ["blank model", { parentModels: { other: { scout: { model: "  " } } } }, /model: expected a non-empty string/],
  ["null model", { parentModels: { other: { scout: { model: null } } } }, /model: expected a non-empty string/],
  ["numeric model", { parentModels: { other: { scout: { model: 1 } } } }, /model: expected a non-empty string/],
  ["null thinking", { parentModels: { other: { scout: { thinking: null } } } }, /thinking: expected a non-empty string/],
  ["blank thinking", { parentModels: { other: { scout: { thinking: " " } } } }, /thinking: expected a non-empty string/],
  ["invalid thinking", { parentModels: { other: { scout: { thinking: "ultra" } } } }, /invalid thinking level/],
];
for (const [name, config, message] of invalidConfigs) {
  test(`eager validation rejects ${name}`, (t) => {
    const f = fixture(t);
    f.write(config);
    assertConfigError(() => f.resolve(), f.configPath, message);
    assertConfigError(() => resolveProfileOverrides(profile, undefined, f.configPath), f.configPath, message);
  });
}

test("qualified selectors take precedence for the entire rule", (t) => {
  const f = fixture(t);
  f.write({ parentModels: {
    "provider/parent-id": { worker: { model: "provider/child-id" } },
    "parent-id": { worker: { model: "bare/child", thinking: "high" } },
  } });
  assert.deepEqual(f.resolve(), { ...profile, model: "provider/child-id" });
  f.write({ parentModels: {
    "provider/parent-id": { scout: { thinking: "low" } },
    "parent-id": { worker: { model: "bare/child" } },
  } });
  assertClone(f.resolve());
  assert.equal(f.resolve({ provider: "other", id: parent.id }).model, "bare/child");
});

test("unmatched selectors, profiles, and missing parents return clones", (t) => {
  const f = fixture(t);
  f.write({ parentModels: {} });
  assertClone(f.resolve());
  f.write({ parentModels: { "*": { worker: { model: "wildcard/child" } } } });
  assertClone(f.resolve());
  f.write({ parentModels: { "parent-id": { scout: { thinking: "low" } } } });
  assertClone(f.resolve());
  f.write({ parentModels: { "parent-id": { worker: { model: "child" } } } });
  assertClone(resolveProfileOverrides(profile, undefined, f.configPath));
});

test("partial overrides preserve omitted fields and trim strings", (t) => {
  const f = fixture(t);
  f.write({ parentModels: { "parent-id": { worker: { model: " provider/child-id " } } } });
  assert.deepEqual(f.resolve(), { ...profile, model: "provider/child-id" });
  f.write({ parentModels: { "parent-id": { worker: { thinking: " low " } } } });
  const result = f.resolve();
  assert.deepEqual(result, { ...profile, thinking: "low" });
  result.skills.push("another-skill");
  assert.deepEqual(profile.skills, ["test-skill"]);
  assert.equal(profile.model, "original/model");
  assert.equal(profile.thinking, "medium");
});

test("inherit clears only explicitly overridden fields", (t) => {
  const f = fixture(t);
  for (const override of [{ model: "inherit" }, { thinking: "inherit" }, { model: "inherit", thinking: "inherit" }]) {
    f.write({ parentModels: { "parent-id": { worker: override } } });
    const expected = { ...profile };
    for (const field of Object.keys(override) as ("model" | "thinking")[]) expected[field] = undefined;
    assert.deepEqual(f.resolve(), expected);
  }
});

test("all core thinking levels are accepted", (t) => {
  const f = fixture(t);
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    f.write({ parentModels: { "parent-id": { worker: { thinking } } } });
    assert.equal(f.resolve().thinking, thinking);
  }
});

test("each call reads edits and deletion without retaining a last valid config", (t) => {
  const f = fixture(t);
  f.write({ parentModels: { "parent-id": { worker: { model: "first" } } } });
  assert.equal(f.resolve().model, "first");
  f.write({ parentModels: { "parent-id": { worker: { model: "second" } } } });
  assert.equal(f.resolve().model, "second");
  f.write({ parentModels: { unused: { worker: { thinking: "invalid" } } } });
  assertConfigError(() => f.resolve(), f.configPath, /invalid thinking level/);
  writeFileSync(f.configPath, "broken");
  assertConfigError(() => f.resolve(), f.configPath, /invalid JSON/);
  rmSync(f.configPath);
  assertClone(f.resolve());
});

export default function () {}
