import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const host = process.env.PI_CODING_AGENT_DIR;
if (!host) throw new Error("Set PI_CODING_AGENT_DIR to the installed Pi package directory.");
const require = createRequire(join(host, "package.json"));
const { Check } = await import(pathToFileURL(require.resolve("typebox/value")).href);
const { visibleWidth, CURSOR_MARKER } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const { loadExtensions } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")).href);
const entry = join(dirname(fileURLToPath(import.meta.url)), "../index.ts");
const loaded = await loadExtensions([entry], process.cwd());
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get("ask_user").definition;

function prepare(args) {
  assert.equal(Check(tool.parameters, args), true, "input matches the advertised schema");
  return args;
}

function checkResult(result) {
  assert.equal(Check(tool.outputSchema, result.structuredContent), true);
  assert.deepEqual(result.structuredContent, result.details);
  assert.deepEqual(JSON.parse(JSON.stringify(result.structuredContent)), result.structuredContent);
}

async function execute(args, ui, signal) {
  const result = await tool.execute("test", prepare(args), signal, undefined, {
    mode: "rpc",
    hasUI: true,
    ui,
  });
  checkResult(result);
  return result;
}

const choices = [{ label: "First" }, { label: "Second" }];

function dialog(questions, signal) {
  let component;
  const result = tool.execute("test", prepare({ questions }), signal, undefined, {
    mode: "tui", hasUI: true,
    ui: {
      custom: factory => new Promise(resolve => {
        component = factory({ terminal: { rows: 40 }, requestRender() {} }, {
          fg: (_color, text) => text, bold: text => text,
        }, {}, resolve);
      }),
    },
  });
  return { component, result };
}

test("TUI rendering follows width, focus and invalidation", async () => {
  const { component, result } = dialog([{ question: "Where should we save 文件 👩‍💻?" }]);
  component.focused = true;
  const wide = component.render(80);
  assert.ok(wide.some(line => line.includes(CURSOR_MARKER)));
  for (const width of [24, 8, 1, 80]) {
    const lines = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.equal(visibleWidth(lines[0]), width);
  }
  component.focused = false;
  assert.ok(component.render(80).every(line => !line.includes(CURSOR_MARKER)));
  component.invalidate();
  component.handleInput("\u001b");
  assert.equal((await result).details.cancelled, true);
});

test("free-text drafts survive tab switches, including an intentionally emptied draft", async () => {
  const { component, result } = dialog([
    { question: "Where?" }, { question: "Which?", options: choices },
  ]);
  component.handleInput("hello");
  component.handleInput("\r");
  component.handleInput("\u001b[Z");
  assert.match(component.render(80).join("\n"), /hello/);
  for (let i = 0; i < 5; i++) component.handleInput("\u007f");
  component.handleInput("\t");
  component.handleInput("\u001b[Z");
  assert.doesNotMatch(component.render(80).join("\n"), /hello/);
  component.handleInput("replacement");
  component.handleInput("\r");
  component.handleInput("\r");
  component.handleInput("\r");
  const response = await result;
  checkResult(response);
  assert.equal(response.details.answers[0].answer, "replacement");
});

test("TUI multi-selection keeps option order, custom answers and notes", async () => {
  const { component, result } = dialog([{ question: "Which?", options: choices, multiSelect: true }]);
  for (const key of ["j", " ", "k", " ", "n", "a note", "\r", "j", "j", "\r", "Third", "\r"]) {
    component.handleInput(key);
  }
  const response = await result;
  checkResult(response);
  assert.deepEqual(response.details.answers[0], {
    questionIndex: 0, question: "Which?", answer: ["First", "Second", "Third"],
    source: "multi", note: "a note",
  });
});

test("TUI abort closes a pending dialog and removes its listener", async () => {
  const controller = new AbortController();
  const { result } = dialog([{ question: "Where?" }], controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  const response = await result;
  checkResult(response);
  assert.equal(response.details.error, "aborted");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("TUI normal completion also removes its abort listener", async () => {
  const controller = new AbortController();
  const { component, result } = dialog([{ question: "Which?", options: choices }], controller.signal);
  component.handleInput("\r");
  await result;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("RPC input and selection receive the tool abort signal", async () => {
  for (const question of [
    { question: "Where?" },
    { question: "Which?", options: choices },
    { question: "Which?", options: choices, multiSelect: true },
  ]) {
    const controller = new AbortController();
    const wait = (_title, _choices, { signal }) => {
      assert.equal(signal, controller.signal);
      return new Promise(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    };
    const pending = execute({ questions: [question] }, { input: wait, select: wait }, controller.signal);
    controller.abort();
    assert.equal((await pending).details.error, "aborted");
  }
});

test("normalization rejects blank and duplicate content rather than silently dropping options", async () => {
  for (const [questions, error] of [
    [[{ question: "   " }], "empty_question"],
    [[{ question: "Same?" }, { question: "  same? " }], "duplicate_question"],
    [[{ question: "Which?", options: [{ label: " " }, { label: "Second" }] }], "invalid_options"],
    [[{ question: "Which?", options: [{ label: "Same" }, { label: " same " }] }], "duplicate_option"],
    [[{ question: "Which?", options: [{ label: "Other" }, { label: "Second" }] }], "reserved_label"],
  ]) assert.equal((await execute({ questions }, {})).details.error, error);
});

test("option descriptions are optional without changing question or option shapes", () => {
  const args = {
    questions: [
      { question: "Where is the repository?" },
      { question: "Which package?", options: choices },
    ],
  };
  assert.deepEqual(prepare(args), args);
  assert.deepEqual(tool.parameters.properties.questions.items.required, ["question"]);
  assert.deepEqual(tool.parameters.properties.questions.items.properties.options.items.required, ["label"]);
  assert.equal(tool.parameters.properties.questions.items.properties.multiSelect.default, false);
});

test("only the advertised question and option shapes are accepted", () => {
  assert.equal(Object.hasOwn(tool.parameters.properties.questions.items.properties, "header"), false);
  for (const args of [
    { question: "Which package?", options: choices },
    { questions: [{ prompt: "Which package?" }] },
    { questions: [{ question: "Which package?", options: ["First", "Second"] }] },
  ]) assert.equal(Check(tool.parameters, args), false);
});

test("option descriptions and multiselect inputs remain supported", () => {
  const args = {
    questions: [{
      question: "Which packages?",
      options: [
        { label: "First", description: "Start with the first package." },
        { label: "Second", description: "Start with the second package." },
      ],
      multiSelect: true,
    }],
  };
  assert.deepEqual(prepare(args), args);
});

test("question and option count and length constraints remain enforced", () => {
  for (const args of [
    { questions: [] },
    { questions: Array.from({ length: 5 }, () => ({ question: "Question?" })) },
    { questions: [{ question: "x".repeat(1001) }] },
    { questions: [{ question: "Question?", options: [{ label: "Only" }] }] },
    { questions: [{ question: "Question?", options: Array.from({ length: 5 }, () => ({ label: "Option" })) }] },
    { questions: [{ question: "Question?", options: [{ label: "x".repeat(61) }, { label: "Second" }] }] },
    { questions: [{ question: "Question?", options: [{ label: "First", description: "x".repeat(301) }, { label: "Second" }] }] },
  ]) assert.equal(Check(tool.parameters, args), false);
});

test("free-text input keeps its compact result and provides structured answers", async () => {
  const result = await execute({ questions: [{ question: "Where is the repository?" }] }, {
    input: async () => "/work/project",
  });
  assert.equal(result.content[0].text, "answer: /work/project");
  assert.deepEqual(result.structuredContent, {
    answers: [{ questionIndex: 0, question: "Where is the repository?", answer: "/work/project", source: "text" }],
    cancelled: false,
  });
  assert.notEqual(result.isError, true);
});

test("choice input still offers automatic custom input", async () => {
  let offered;
  const result = await execute({ questions: [{ question: "Which package?", options: choices }] }, {
    select: async (_question, options) => {
      offered = options;
      return options.at(-1);
    },
    input: async () => "Another package",
  });
  assert.deepEqual(offered.slice(0, 2), ["First", "Second"]);
  assert.equal(offered.length, 3);
  assert.equal(result.content[0].text, "answer: Another package");
  assert.equal(result.structuredContent.answers[0].source, "text");
});

test("multiselect without descriptions returns an array", async () => {
  const result = await execute({ questions: [{ question: "Which packages?", options: choices, multiSelect: true }] }, {
    input: async () => "1, 2",
  });
  assert.equal(result.content[0].text, "answer: First, Second");
  assert.deepEqual(result.structuredContent.answers[0].answer, ["First", "Second"]);
});

test("multiple questions keep their compact numbered answer format", async () => {
  const result = await execute({ questions: [
    { question: "Which package?", options: choices },
    { question: "Where is the repository?" },
  ] }, {
    select: async () => "First",
    input: async () => "/work/project",
  });
  assert.equal(result.content[0].text, "answers: Q1: First; Q2: /work/project");
  assert.deepEqual(result.structuredContent.answers.map(answer => answer.questionIndex), [0, 1]);
});

test("TUI questions use numbered tabs and render label-only options", async () => {
  let rendered;
  const theme = { fg: (_color, text) => text, bold: text => text };
  const result = await tool.execute("test", prepare({ questions: [
    { question: "Which package first?", options: choices },
    { question: "Which package second?", options: choices },
  ] }), undefined, undefined, {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: factory => new Promise(resolve => {
        const component = factory({ requestRender() {} }, theme, {}, resolve);
        rendered = component.render(80).join("\n");
        component.handleInput("\r");
        component.handleInput("\r");
        component.handleInput("\r");
      }),
    },
  });
  checkResult(result);
  assert.match(rendered, /Q1.*Q2/);
  assert.match(rendered, /First/);
  assert.match(rendered, /Second/);
  assert.equal(result.content[0].text, "answers: Q1: First; Q2: First");
});

test("user cancellation is structured and is not a tool failure", async () => {
  const result = await execute({ questions: [{ question: "Where is the repository?" }] }, {
    input: async () => undefined,
  });
  assert.equal(result.content[0].text, "cancelled");
  assert.deepEqual(result.structuredContent, { answers: [], cancelled: true });
  assert.notEqual(result.isError, true);
});

test("partial answers remain available after cancellation", async () => {
  const result = await execute({ questions: [
    { question: "Which package?", options: choices },
    { question: "Where is the repository?" },
  ] }, {
    select: async () => "First",
    input: async () => undefined,
  });
  assert.equal(result.structuredContent.cancelled, true);
  assert.equal(result.structuredContent.answers.length, 1);
  assert.equal(result.structuredContent.answers[0].answer, "First");
});

test("semantic validation failures report errors with matching structured data", async () => {
  const result = await execute({ questions: [{ question: "Which package?", options: [{ label: "Same" }, { label: "Same" }] }] }, {});
  assert.equal(result.content[0].text, "error: duplicate_option");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "duplicate_option");
});

test("missing UI and pre-aborted calls keep their structured failure details", async () => {
  const params = prepare({ questions: [{ question: "Which package?" }] });
  const unavailable = await tool.execute("test", params, undefined, undefined, { hasUI: false });
  checkResult(unavailable);
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.structuredContent.error, "ui_unavailable");
  const controller = new AbortController();
  controller.abort();
  const aborted = await tool.execute("test", params, controller.signal, undefined, { hasUI: true });
  checkResult(aborted);
  assert.equal(aborted.isError, true);
  assert.equal(aborted.structuredContent.error, "aborted");
});
