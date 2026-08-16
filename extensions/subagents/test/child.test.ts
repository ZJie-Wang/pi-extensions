import assert from "node:assert/strict";
import test from "node:test";
import { toolArgsPreview } from "../core.ts";

test("web activity preview includes program and useful argv", () => {
  assert.equal(
    toolArgsPreview("web", { program: "curl", args: ["-L", "https://example.com/article"] }),
    "curl -L https://example.com/article",
  );
  assert.equal(
    toolArgsPreview("web", { program: "tvly", args: ["search", "interesting fact", "--json"] }),
    "tvly search interesting fact --json",
  );
});

test("built-in activity preview keeps focused paths and commands", () => {
  assert.equal(toolArgsPreview("read", { path: "/tmp/example.ts" }), "/tmp/example.ts");
  assert.equal(toolArgsPreview("bash", { command: "npm test" }), "npm test");
});
