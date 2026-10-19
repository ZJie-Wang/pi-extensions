import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const TOOL_NAME = "ask_user";
const CUSTOM_LABEL = "✎ Type something.";
const MULTI_COMMIT_LABEL = "✓ Submit selections";
const SUBMIT_LABEL = "✓ Submit answers";
const CANCEL_LABEL = "✕ Cancel";
const MAX_QUESTIONS = 8;
const RESERVED_OPTIONS = new Set([
  CUSTOM_LABEL.toLowerCase(),
  CUSTOM_LABEL.replace("✎ ", "").toLowerCase(),
]);

const OptionSchema = Type.String({ maxLength: 150 });

const QuestionSchema = Type.Object({
  question: Type.String({ maxLength: 300 }),
  options: Type.Optional(Type.Array(OptionSchema, { maxItems: 4 })),
  multiSelect: Type.Optional(Type.Boolean({ default: false })),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema),
});

type AskUserParamsInput = Static<typeof AskUserParams>;

interface NormalQuestion {
  question: string;
  options: string[];
  multiSelect: boolean;
}

const QuestionAnswerSchema = Type.Object({
  questionIndex: Type.Integer({ minimum: 0 }),
  question: Type.String(),
  answer: Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()]),
  source: Type.Optional(
    Type.Union([
      Type.Literal("choice"),
      Type.Literal("text"),
      Type.Literal("multi"),
    ]),
  ),
  note: Type.Optional(Type.String()),
}, { additionalProperties: false });

const AskUserResultSchema = Type.Object({
  answers: Type.Array(QuestionAnswerSchema),
  cancelled: Type.Boolean(),
  error: Type.Optional(
    Type.Union([
      Type.Literal("ui_unavailable"),
      Type.Literal("aborted"),
      Type.Literal("no_questions"),
      Type.Literal("too_many_questions"),
      Type.Literal("empty_question"),
      Type.Literal("invalid_options"),
      Type.Literal("duplicate_question"),
      Type.Literal("duplicate_option"),
      Type.Literal("reserved_option"),
    ]),
  ),
}, { additionalProperties: false });

type QuestionAnswer = Static<typeof QuestionAnswerSchema>;
type AnswerSource = NonNullable<QuestionAnswer["source"]>;
type AskUserResult = Static<typeof AskUserResultSchema>;
type AskUserError = NonNullable<AskUserResult["error"]>;

function normalizeText(value = ""): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeQuestions(input: AskUserParamsInput): NormalQuestion[] {
  return input.questions.map((q) => ({
    question: normalizeText(q.question),
    options: (q.options ?? []).map((option) => normalizeText(option)),
    multiSelect: q.multiSelect === true,
  }));
}

function validateQuestions(
  questions: NormalQuestion[],
): AskUserError | undefined {
  if (questions.length === 0) return "no_questions";
  if (questions.length > MAX_QUESTIONS) return "too_many_questions";
  const seenQuestions = new Set<string>();
  for (const q of questions) {
    if (!q.question) return "empty_question";
    if (q.options.length === 1) return "invalid_options";
    const qKey = q.question.toLowerCase();
    if (seenQuestions.has(qKey)) return "duplicate_question";
    seenQuestions.add(qKey);
    const seenOptions = new Set<string>();
    for (const option of q.options) {
      if (!option) return "invalid_options";
      const key = option.toLowerCase();
      if (RESERVED_OPTIONS.has(key)) return "reserved_option";
      if (seenOptions.has(key)) return "duplicate_option";
      seenOptions.add(key);
    }
  }
  return undefined;
}

function answerText(answer: QuestionAnswer): string {
  const base = Array.isArray(answer.answer)
    ? answer.answer.join(", ")
    : (answer.answer ?? "");
  return answer.note ? `${base} (note: ${answer.note})` : base;
}

function compactAnswer(answer: QuestionAnswer): string {
  return `Q${answer.questionIndex + 1}: ${answerText(answer)}`;
}

function summaryText(answers: QuestionAnswer[]): string {
  return answers.length === 1
    ? answerText(answers[0])
    : answers.map(compactAnswer).join("; ");
}

function buildResult(details: AskUserResult) {
  let text: string;
  if (details.error) text = `error: ${details.error}`;
  else if (details.cancelled) text = "cancelled";
  else {
    const label = details.answers.length === 1 ? "answer" : "answers";
    text = `${label}: ${summaryText(details.answers)}`;
  }
  return {
    content: [{ type: "text" as const, text }],
    details,
    structuredContent: details,
    ...(details.error ? { isError: true } : {}),
  };
}

interface DialogState {
  q: NormalQuestion;
  cursor: number;
  selected: Set<number>;
  picked: number | null;
  customText: string | null;
  note: string | null;
  draft: string;
}

type EditMode = "custom" | "note" | null;

function isAnswered(s: DialogState): boolean {
  return s.customText != null || s.picked != null || s.selected.size > 0;
}

function selectedValues(s: DialogState): string[] {
  return [...s.selected].sort((a, b) => a - b).map((i) => s.q.options[i]);
}

function stateSummary(s: DialogState): string | null {
  const parts: string[] = [];
  if (s.picked != null) parts.push(s.q.options[s.picked]);
  if (s.q.multiSelect) parts.push(...selectedValues(s));
  if (s.customText) parts.push(s.customText);
  return parts.join(", ") || null;
}

function runQuestionnaire(
  ctx: ExtensionContext,
  questions: NormalQuestion[],
  signal: AbortSignal | undefined,
): Promise<QuestionAnswer[] | null> {
  let cancel: (() => void) | undefined;
  return ctx.ui.custom<QuestionAnswer[] | null>(
    (tui, theme, _keybindings, done) => {
      cancel = () => done(null);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const single = questions.length === 1;
      const submitTab = questions.length;
      const states: DialogState[] = questions.map((q) => ({
        q,
        cursor: 0,
        selected: new Set<number>(),
        picked: null,
        customText: null,
        note: null,
        draft: "",
      }));
      let tab = 0;
      let submitCursor = 0;
      let editMode: EditMode = null;
      let cachedLines: string[] | undefined;
      let cacheWidth = -1;
      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg("borderMuted", s),
        selectList: {
          selectedPrefix: (s) => theme.fg("muted", s),
          selectedText: (s) => theme.bold(theme.fg("text", s)),
          description: (s) => theme.fg("muted", s),
          scrollInfo: (s) => theme.fg("dim", s),
          noMatch: (s) => theme.fg("warning", s),
        },
      };
      const editor = new Editor(tui, editorTheme);

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function isTextQuestion(s: DialogState): boolean {
        return s.q.options.length === 0;
      }

      function rowCount(s: DialogState): number {
        return s.q.options.length + 1 + (s.q.multiSelect ? 1 : 0);
      }

      function buildAnswers(): QuestionAnswer[] {
        return states.map((s, i) => {
          let answer: string | string[] | null = null;
          let source: AnswerSource | undefined;
          if (s.q.multiSelect) {
            const values = selectedValues(s);
            if (s.customText) values.push(s.customText);
            answer = values;
            source = "multi";
          } else if (s.picked != null) {
            answer = s.q.options[s.picked];
            source = "choice";
          } else if (s.customText != null) {
            answer = s.customText;
            source = "text";
          }
          return {
            questionIndex: i,
            question: s.q.question,
            answer,
            ...(source ? { source } : {}),
            ...(s.note ? { note: s.note } : {}),
          };
        });
      }

      function setTab(next: number) {
        const current = states[tab];
        if (current && isTextQuestion(current)) current.draft = editor.getText();
        tab = next;
        const target = states[tab];
        editor.setText(target && isTextQuestion(target) ? target.draft : "");
      }

      function advance() {
        for (let offset = 1; offset <= states.length; offset++) {
          const index = (tab + offset) % states.length;
          if (!isAnswered(states[index])) {
            setTab(index);
            return;
          }
        }
        setTab(submitTab);
      }

      function cycleTab(step: -1 | 1) {
        const tabCount = submitTab + 1;
        setTab((tab + step + tabCount) % tabCount);
        refresh();
      }

      function finishOrAdvance() {
        if (single) {
          done(buildAnswers());
          return;
        }
        advance();
        refresh();
      }

      function commitCustom(s: DialogState, text: string) {
        if (!s.q.multiSelect) s.picked = null;
        s.customText = text;
        finishOrAdvance();
      }

      function pick(s: DialogState, index: number) {
        s.picked = index;
        s.customText = null;
        finishOrAdvance();
      }

      function toggle(s: DialogState, index: number) {
        if (s.selected.has(index)) s.selected.delete(index);
        else s.selected.add(index);
      }

      editor.onSubmit = (value) => {
        const s = states[tab];
        const text = normalizeText(value);
        const mode = editMode;
        editMode = null;
        editor.setText(isTextQuestion(s) ? text : "");
        if (mode === "note") {
          s.note = text || null;
          refresh();
          return;
        }
        if (text) commitCustom(s, text);
        else refresh();
      };

      function handleInput(data: string) {
        const onSubmitTab = !single && tab === submitTab;
        const s = tab < states.length ? states[tab] : undefined;

        if (editMode) {
          if (matchesKey(data, Key.escape)) {
            editMode = null;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }

        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }

        if (!single && matchesKey(data, Key.tab)) return cycleTab(1);
        if (!single && matchesKey(data, Key.shift("tab"))) return cycleTab(-1);
        if (s && isTextQuestion(s)) {
          editor.handleInput(data);
          refresh();
          return;
        }

        if (!single && (matchesKey(data, Key.right) || data === "l"))
          return cycleTab(1);
        if (!single && (matchesKey(data, Key.left) || data === "h"))
          return cycleTab(-1);

        if (onSubmitTab) {
          if (matchesKey(data, Key.up) || data === "k") {
            submitCursor = Math.max(0, submitCursor - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            submitCursor = Math.min(1, submitCursor + 1);
            refresh();
            return;
          }
          if (!matchesKey(data, Key.enter)) return;
          if (submitCursor === 1) {
            done(null);
            return;
          }
          const firstUnanswered = states.findIndex((st) => !isAnswered(st));
          if (firstUnanswered === -1) {
            done(buildAnswers());
            return;
          }
          setTab(firstUnanswered);
          refresh();
          return;
        }

        if (!s) return;
        const rows = rowCount(s);
        if (matchesKey(data, Key.up) || data === "k") {
          s.cursor = Math.max(0, s.cursor - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          s.cursor = Math.min(rows - 1, s.cursor + 1);
          refresh();
          return;
        }
        if (data === "n") {
          editMode = "note";
          editor.setText(s.note ?? "");
          refresh();
          return;
        }
        if (
          s.q.multiSelect &&
          matchesKey(data, Key.space) &&
          s.cursor < s.q.options.length
        ) {
          toggle(s, s.cursor);
          refresh();
          return;
        }
        if (!matchesKey(data, Key.enter)) return;

        if (s.cursor === s.q.options.length) {
          editMode = "custom";
          editor.setText(s.customText ?? "");
          refresh();
          return;
        }
        if (s.q.multiSelect && s.cursor === s.q.options.length + 1) {
          if (isAnswered(s)) finishOrAdvance();
          else refresh();
          return;
        }
        if (s.q.multiSelect) {
          toggle(s, s.cursor);
          refresh();
          return;
        }
        pick(s, s.cursor);
      }

      function helpText(): string {
        if (editMode === "note") return "Enter save note • Esc back";
        if (editMode === "custom") return "Enter submit • Esc back";
        const move = "↑↓/jk";
        const switchTab = "←→/hl/Tab switch";
        if (!single && tab === submitTab)
          return `${move} move • Enter confirm • ${switchTab} • Esc cancel`;
        const s = states[tab];
        if (isTextQuestion(s))
          return single
            ? "Enter submit • Esc cancel"
            : "Enter submit • Tab switch • Esc cancel";
        const base = s.q.multiSelect
          ? `${move} move • Space/Enter toggle`
          : `${move} move • Enter select`;
        return single
          ? `${base} • n note • Esc cancel`
          : `${base} • n note • ${switchTab} • Esc cancel`;
      }

      function renderEditorLines(add: (line?: string) => void, width: number) {
        for (const line of editor.render(Math.max(1, width - 2)))
          add(` ${line}`);
      }

      function render(width: number): string[] {
        if (cachedLines && cacheWidth === width) return cachedLines;
        const lines: string[] = [];
        const add = (line = "") => lines.push(truncateToWidth(line, width));
        const contentWidth = Math.max(1, width - 1);
        const rule = () => add(theme.fg("borderMuted", "─".repeat(width)));
        const addRow = (label: string, focused: boolean) =>
          add(
            (focused ? theme.fg("accent", "> ") : "  ") +
              (focused ? theme.bold(label) : label),
          );

        rule();

        if (!single) {
          const chips: string[] = [];
          states.forEach((st, i) => {
            const label = `Q${i + 1}`;
            const answered = isAnswered(st);
            const body =
              i === tab
                ? theme.bold(theme.fg("accent", ` ${label} `))
                : theme.fg(answered ? "text" : "dim", ` ${label} `);
            chips.push(body + (answered ? theme.fg("success", "✓ ") : ""));
          });
          chips.push(
            tab === submitTab
              ? theme.bold(theme.fg("accent", " Submit "))
              : theme.fg("dim", " Submit "),
          );
          add(chips.join(theme.fg("borderMuted", "│")));
          add();
        }

        if (!single && tab === submitTab) {
          add(theme.bold(theme.fg("text", " Review your answers")));
          add();
          states.forEach((st, i) => {
            const head = `Q${i + 1}`;
            const summary = stateSummary(st);
            add(
              ` ${theme.fg("muted", head)}  ${
                summary
                  ? theme.fg("text", summary)
                  : theme.fg("warning", "— not answered")
              }`,
            );
          });
          add();
          const submitColor = states.every(isAnswered) ? "success" : "dim";
          addRow(theme.fg(submitColor, SUBMIT_LABEL), submitCursor === 0);
          addRow(theme.fg("dim", CANCEL_LABEL), submitCursor === 1);
        } else {
          const s = states[tab];
          for (const line of wrapTextWithAnsi(s.q.question, contentWidth))
            add(theme.bold(theme.fg("text", ` ${line}`)));
          if (s.note)
            add(theme.fg("warning", " note: ") + theme.fg("muted", s.note));
          add();

          if (isTextQuestion(s)) {
            renderEditorLines(add, width);
          } else {
            for (let i = 0; i < s.q.options.length; i++) {
              const option = s.q.options[i];
              const focused = s.cursor === i;
              const focusColor = focused ? "accent" : "text";
              const num = theme.fg(focused ? "accent" : "muted", `${i + 1}. `);
              let row = num + theme.fg(focusColor, option);
              if (s.q.multiSelect) {
                const mark = s.selected.has(i)
                  ? theme.fg("success", "[x] ")
                  : theme.fg("dim", "[ ] ");
                row = mark + row;
              } else if (s.picked === i) {
                row += theme.fg("success", " ✓");
              }
              addRow(row, focused);
            }

            add();
            const customFocused = s.cursor === s.q.options.length;
            const customLabel = s.customText
              ? `✎ ${s.customText}`
              : CUSTOM_LABEL;
            const customRow = customFocused
              ? theme.fg("accent", customLabel)
              : s.customText
                ? theme.fg("warning", "✎ ") + theme.fg("text", s.customText)
                : theme.fg("muted", CUSTOM_LABEL);
            addRow(customRow, customFocused);

            if (s.q.multiSelect) {
              const commitFocused = s.cursor === s.q.options.length + 1;
              addRow(
                theme.fg(isAnswered(s) ? "success" : "dim", MULTI_COMMIT_LABEL),
                commitFocused,
              );
            }

            if (editMode === "custom") {
              add();
              add(theme.fg("muted", " Your answer:"));
              renderEditorLines(add, width);
            }
            if (editMode === "note") {
              add();
              add(theme.fg("muted", " Note:"));
              renderEditorLines(add, width);
            }
          }
        }

        add();
        add(theme.fg("dim", ` ${helpText()}`));
        rule();
        cachedLines = lines;
        cacheWidth = width;
        return lines;
      }

      return {
        render,
        handleInput,
        get focused() {
          return editor.focused;
        },
        set focused(value: boolean) {
          editor.focused = value;
          cachedLines = undefined;
        },
        invalidate: () => {
          cachedLines = undefined;
          editor.invalidate();
        },
      };
    },
  ).finally(() => {
    if (cancel) signal?.removeEventListener("abort", cancel);
  });
}

async function askTextQuestionBasic(
  ctx: ExtensionContext,
  question: NormalQuestion,
  signal: AbortSignal | undefined,
): Promise<{ answer: string; source: "text" } | null> {
  const value = await ctx.ui.input(question.question, "", { signal });
  const text = normalizeText(value);
  return text ? { answer: text, source: "text" } : null;
}

function parseMultiChoiceAnswer(
  raw: string,
  question: NormalQuestion,
): string[] {
  const optionsByLower = new Map(
    question.options.map((option) => [option.toLowerCase(), option]),
  );
  const answers: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(/[,;]+/).map(normalizeText).filter(Boolean)) {
    const numeric = Number(part);
    const option = Number.isInteger(numeric)
      ? question.options[numeric - 1]
      : optionsByLower.get(part.toLowerCase()) || part;
    if (!option) continue;
    const key = option.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    answers.push(option);
  }

  return answers;
}

async function askOptionsQuestionBasic(
  ctx: ExtensionContext,
  question: NormalQuestion,
  signal: AbortSignal | undefined,
): Promise<{ answer: string | string[]; source: AnswerSource } | null> {
  if (!question.multiSelect) {
    const options = [...question.options, CUSTOM_LABEL];
    const choice = await ctx.ui.select(question.question, options, { signal });
    if (!choice || signal?.aborted) return null;
    if (choice === CUSTOM_LABEL)
      return askTextQuestionBasic(ctx, question, signal);
    return { answer: choice, source: "choice" };
  }

  const options = question.options
    .map((option, index) => `${index + 1}. ${option}`)
    .join("\n");
  const prompt =
    `${question.question}\n\n${options}\n\n` +
    "Enter numbers or option text separated by commas; add custom text if needed.";
  const value = await ctx.ui.input(prompt, "1, 2", { signal });
  const answers = parseMultiChoiceAnswer(normalizeText(value), question);
  return answers.length > 0 ? { answer: answers, source: "multi" } : null;
}

export default function askUser(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) return;
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME))
      pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Ask User",
    description:
      "Ask user questions. Provide distinct options, with the recommended one first; set multiSelect when options are not mutually exclusive. Omit options for a free-text question.",
    promptSnippet: "Ask the user questions",
    promptGuidelines: [
      "Surface uncertainty or ambiguity. Whenever missing user input blocks progress, use ask_user to ask rather than guess.",
    ],
    parameters: AskUserParams,
    outputSchema: AskUserResultSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const answers: QuestionAnswer[] = [];
      const questions = normalizeQuestions(params);
      const validationError = validateQuestions(questions);
      const abortedResult = () =>
        buildResult({ answers, cancelled: true, error: "aborted" });
      const cancelledResult = (reason?: AskUserError) =>
        buildResult({
          answers,
          cancelled: true,
          ...(reason ? { error: reason } : {}),
        });

      if (signal?.aborted) return abortedResult();
      if (!ctx.hasUI) return cancelledResult("ui_unavailable");
      if (validationError) return cancelledResult(validationError);

      if (ctx.mode === "tui") {
        const result = await runQuestionnaire(ctx, questions, signal);
        if (signal?.aborted) return abortedResult();
        return buildResult({
          answers: result ?? [],
          cancelled: result === null,
        });
      }

      for (let i = 0; i < questions.length; i++) {
        if (signal?.aborted) return abortedResult();

        const q = questions[i];
        const response =
          q.options.length === 0
            ? await askTextQuestionBasic(ctx, q, signal)
            : await askOptionsQuestionBasic(ctx, q, signal);

        if (signal?.aborted) return abortedResult();
        if (!response) return cancelledResult();
        answers.push({
          questionIndex: i,
          question: q.question,
          answer: response.answer,
          source: response.source,
        });
      }

      return buildResult({ answers, cancelled: false });
    },

    renderCall(args, theme) {
      const question = normalizeText(args.questions?.[0]?.question);
      const count = args.questions?.length ?? 0;
      const suffix = count > 1 ? ` (${count} questions)` : "";
      const text =
        theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) +
        theme.fg("muted", truncateToWidth(question, 90)) +
        theme.fg("dim", suffix);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as AskUserResult | undefined;
      if (!details) return new Text("", 0, 0);
      if (details.error)
        return new Text(`\n${theme.fg("error", details.error)}`, 0, 0);
      if (details.cancelled)
        return new Text(`\n${theme.fg("warning", "cancelled")}`, 0, 0);

      if (expanded) {
        const pairs = details.answers.map((answer) => {
          const index = answer.questionIndex + 1;
          return theme.fg(
            "muted",
            `Q${index}: ${answer.question}\nA${index}: ${answerText(answer) || "—"}`,
          );
        });
        return new Text(`\n${pairs.join("\n\n")}`, 0, 0);
      }

      const summary = summaryText(details.answers);
      return new Text(
        "\n" +
          theme.fg("success", "✓ ") +
          theme.fg("muted", truncateToWidth(summary, 140)),
        0,
        0,
      );
    },
  });
}
