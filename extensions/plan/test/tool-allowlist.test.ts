import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { loadToolAllowlist } from "../lib/tool-allowlist.ts";

function withConfig(t: TestContext, content: string): URL {
  const directory = mkdtempSync(join(tmpdir(), "plan-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "tool-allowlist.json");
  writeFileSync(path, content);
  return pathToFileURL(path);
}

test("loads and deduplicates tool names in configured order", (t) => {
  const path = withConfig(t, '["read", "subagent_run", "read"]');
  assert.deepEqual(loadToolAllowlist(path), ["read", "subagent_run"]);
});

test("rejects malformed JSON", (t) => {
  const path = withConfig(t, "[");
  assert.throws(
    () => loadToolAllowlist(path),
    /Could not load tool-allowlist\.json/,
  );
});

test("rejects values other than non-empty string arrays", (t) => {
  for (const content of ['{"tools":["read"]}', '["read", ""]', '["read", 1]']) {
    const path = withConfig(t, content);
    assert.throws(
      () => loadToolAllowlist(path),
      /must be a JSON array of non-empty tool names/,
    );
  }
});
