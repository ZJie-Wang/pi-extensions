import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentThread } from "../manager.ts";
import { SubagentStatusWidget } from "../status-widget.ts";
import { profile } from "./helpers.ts";

function theme(color = 36): Theme {
  return {
    fg: (_token: string, text: string) => `\x1b[${color}m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as Theme;
}

function thread(id: string, state: SubagentThread["state"] = "running"): SubagentThread {
  return {
    id, state, profile, createSession: async () => { throw new Error("Unused session"); },
    activity: "thinking", tools: [], toolCount: 0, lastMessage: "", promptPreview: "",
  };
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("hides the summary for empty or idle snapshots", () => {
  let threads: SubagentThread[] = [];
  const widget = new SubagentStatusWidget(() => threads, () => theme());
  assert.deepEqual(widget.render(100), []);
  threads = [thread("Finished", "idle")];
  assert.deepEqual(widget.render(100), []);
});

test("shows running and queued names without tool details", () => {
  const running = thread("Research");
  running.tools = [{ toolCallId: "1", tool: "bash", args: "npm test", status: "running" }];
  running.toolCount = 2;
  running.lastMessage = "Partial result";
  const widget = new SubagentStatusWidget(
    () => [running, thread("Worker"), thread("Review", "queued"), thread("Finished", "idle")],
    () => theme(),
  );
  assert.deepEqual(widget.render(100).map(plain), [" ● Subagents running Research, Worker · queued Review"]);
  assert.doesNotMatch(plain(widget.render(100)[0]), /Finished|bash|npm test|tools|thinking|Partial result/);
});

test("matches todo's header styling using the Markdown link color", () => {
  const colors: string[] = [];
  const widgetTheme = {
    ...theme(),
    fg: (token: string, text: string) => { colors.push(token); return text; },
  } as Theme;
  const widget = new SubagentStatusWidget(() => [thread("Worker")], () => widgetTheme);
  const line = widget.render(100)[0];
  assert.equal(plain(line), " ● Subagents running Worker");
  assert.match(line, /\x1b\[1mSubagents\x1b\[22m/);
  assert.deepEqual(colors, ["mdLink", "mdLink", "muted"]);
});

test("omits empty groups and stays on one line with many threads", () => {
  let threads = Array.from({ length: 20 }, (_, index) => thread(`Worker ${index}`));
  const widget = new SubagentStatusWidget(() => threads, () => theme());
  assert.deepEqual(widget.render(500).map(plain), [` ● Subagents running ${threads.map((item) => item.id).join(", ")}`]);
  assert.equal(widget.render(100).length, 1);
  threads = [thread("Waiting", "queued")];
  assert.deepEqual(widget.render(100).map(plain), [" ● Subagents queued Waiting"]);
});

test("fits narrow terminals and keeps multiline names on one line", () => {
  const running = thread("界面\n👩‍💻\té");
  running.activity = "\x1b[31m检查\x1b[0m\nnext\r\nline\t👩‍💻";
  const widget = new SubagentStatusWidget(() => [running, thread("等待", "queued")], () => theme());
  for (const width of [0, 1, 5, 10, 20, 40, 100]) {
    const lines = widget.render(width);
    assert.equal(lines.length, width === 0 ? 0 : 1);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `Width ${width}: ${JSON.stringify(line)}`);
      assert.doesNotMatch(line, /[\r\n\t]/);
    }
  }
});

test("reads changed identities, states, and themes on every render", () => {
  const threads = [thread("Worker", "queued")];
  let currentTheme = theme(36);
  const widget = new SubagentStatusWidget(() => threads, () => currentTheme);
  const before = widget.render(100)[0];
  assert.equal(plain(before), " ● Subagents queued Worker");
  assert.match(before, /\x1b\[36m/);
  threads[0].state = "running";
  currentTheme = theme(35);
  widget.invalidate();
  const after = widget.render(100)[0];
  assert.equal(plain(after), " ● Subagents running Worker");
  assert.match(after, /\x1b\[35m/);
  assert.doesNotMatch(after, /\x1b\[36m/);
  threads[0].id = "Replacement";
  assert.equal(plain(widget.render(100)[0]), " ● Subagents running Replacement");
  threads[0].state = "idle";
  assert.deepEqual(widget.render(100), []);
});

export default function () {}
