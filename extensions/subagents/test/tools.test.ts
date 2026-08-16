import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ChildToolRegistry } from "../tool-loader.ts";

test("discovers tool names from modules and loads only requested factories", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tools-"));
  try {
    fs.writeFileSync(path.join(directory, "echo.ts"), `
      export default function (cwd: string) {
        return {
          name: "echo",
          label: "Echo",
          description: "test",
          parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          async execute(_id: string, params: { text: string }) {
            return { content: [{ type: "text", text: cwd + ":" + params.text }], details: {} };
          },
        };
      }
    `);
    const registry = new ChildToolRegistry(directory);
    assert.deepEqual(registry.names(), ["echo"]);
    const tools = await registry.create(["echo"], "/work");
    assert.equal(tools[0].name, "echo");
    await assert.rejects(registry.create(["missing"], "/work"), /Unknown child tool/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("requires module filename and returned tool name to agree", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tools-"));
  try {
    fs.writeFileSync(path.join(directory, "expected.ts"), `
      export default function () { return { name: "wrong" }; }
    `);
    const registry = new ChildToolRegistry(directory);
    await assert.rejects(registry.create(["expected"], "/work"), /must return tool named/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
