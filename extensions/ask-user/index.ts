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
const RESERVED_LABELS = new Set([
  "other",
  "type something.",
  "✎ type something.",
]);

const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: 60,
    description: "Short option label (1-5 words).",
  }),
  description: Type.Optional(
    Type.String({
      maxLength: 300,
      description:
        "What this option means or implies: trade-offs, consequences, etc.",
    }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({
    maxLength: 1000,
    description:
      "The complete question. Clear, specific, ends with a question mark.",
  }),
  options: Type.Optional(
    Type.Array(OptionSchema, {
      minItems: 2,
      maxItems: 4,
      description: "2-4 distinct options, with the recommended one first. Omit options for a free-text question.",
    }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Allow selecting multiple options. Use when options are not mutually exclusive.",
    }),
  ),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "Question(s) to ask.",
  }),
});

type AskUserParamsInput = Static<typeof AskUserParams>;

interface NormalOption {
  label: string;
  description: string;
}

interface NormalQuestion {
  question: string;
  options: NormalOption[];
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
      Type.Literal("reserved_label"),
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

function normalizeForExecute(input: AskUserParamsInput): NormalQuestion[] {
  return input.questions.map((q) => ({
    question: normalizeText(q.question),
    options: (q.options ?? []).map((option) => ({
      label: normalizeText(option.label),
      description: normalizeText(option.description),
    })),
    multiSelect: q.multiSelect === true,
  }));
}

function validateQuestions(
  questions: NormalQuestion[],
): AskUserError | undefined {
  const seenQuestions = new Set<string>();
  for (const q of questions) {
    if (!q.question) return "empty_question";
    const qKey = q.question.toLowerCase();
    if (seenQuestions.has(qKey)) return "duplicate_question";
    seenQuestions.add(qKey);
    const seenOptions = new Set<string>();
    for (const option of q.options) {
      if (!option.label) return "invalid_options";
      const key = option.label.toLowerCase();
      if (RESERVED_LABELS.has(key)) return "reserved_label";
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

function buildResult(details: AskUserResult) {
  let text: string;
  if (details.error) text = `error: ${details.error}`;
  else if (details.cancelled) text = "cancelled";
  else if (details.answers.length === 1)
    text = `answer: ${answerText(details.answers[0])}`;
  else text = `answers: ${details.answers.map(compactAnswer).join("; ")}`;
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

function stateSummary(s: DialogState): string | null {
  const parts: string[] = [];
  if (s.picked != null) parts.push(s.q.options[s.picked].label);
  if (s.q.multiSelect)
    for (const i of [...s.selected].sort((a, b) => a - b))
      parts.push(s.q.options[i].label);
  if (s.customText) parts.push(s.customText);
  return parts.length > 0 ? parts.join(", ") : null;
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
      const SUBMIT_TAB = questions.length;
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
            const values = [...s.selected]
              .sort((a, b) => a - b)
              .map((x) => s.q.options[x].label);
            if (s.customText) values.push(s.customText);
            answer = values;
            source = "multi";
          } else if (s.picked != null) {
            answer = s.q.options[s.picked].label;
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
        const prev = states[tab];
        if (prev && isTextQuestion(prev)) prev.draft = editor.getText();
        tab = next;
        const target = states[tab];
        editor.setText(
          target && isTextQuestion(target)
            ? target.draft
            : "",
        );
      }

      function advance() {
        for (let i = tab + 1; i < states.length; i++)
          if (!isAnswered(states[i])) {
            setTab(i);
            return;
          }
        for (let i = 0; i < states.length; i++)
          if (!isAnswered(states[i])) {
            setTab(i);
            return;
          }
        setTab(SUBMIT_TAB);
      }

      function commitCustom(s: DialogState, text: string): boolean {
        if (!text) return false;
        if (!s.q.multiSelect) s.picked = null;
        s.customText = text;
        if (single) {
          done(buildAnswers());
          return true;
        }
        advance();
        return false;
      }

      function pick(s: DialogState, index: number): boolean {
        s.picked = index;
        s.customText = null;
        if (single) {
          done(buildAnswers());
          return true;
        }
        advance();
        return false;
      }

      function toggle(s: DialogState, index: number) {
        if (s.selected.has(index)) s.selected.delete(index);
        else s.selected.add(index);
      }

      editor.onSubmit = (value) => {
        const s = tab < states.length ? states[tab] : undefined;
        if (!s) {
          editMode = null;
          editor.setText("");
          refresh();
          return;
        }
        const text = normalizeText(value);
        const mode = editMode;
        editMode = null;
        editor.setText(isTextQuestion(s) ? text : "");
        if (mode === "note") {
          s.note = text || null;
          refresh();
          return;
        }
        if (text && commitCustom(s, text)) return;
        refresh();
      };

      function handleInput(data: string) {
        const onSubmitTab = !single && tab === SUBMIT_TAB;
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

        if (!single && matchesKey(data, Key.tab)) {
          setTab((tab + 1) % (SUBMIT_TAB + 1));
          refresh();
          return;
        }
        if (!single && matchesKey(data, Key.shift("tab"))) {
          setTab((tab + SUBMIT_TAB) % (SUBMIT_TAB + 1));
          refresh();
          return;
        }
        if (s && isTextQuestion(s)) {
          editor.handleInput(data);
          refresh();
          return;
        }

        if (!single && (matchesKey(data, Key.right) || data === "l")) {
          setTab((tab + 1) % (SUBMIT_TAB + 1));
          refresh();
          return;
        }
        if (!single && (matchesKey(data, Key.left) || data === "h")) {
          setTab((tab + SUBMIT_TAB) % (SUBMIT_TAB + 1));
          refresh();
          return;
        }

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
          if (states.every(isAnswered)) {
            done(buildAnswers());
            return;
          }
          const first = states.findIndex((st) => !isAnswered(st));
          if (first !== -1) setTab(first);
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
          if (s.selected.size > 0 || s.customText) {
            if (single) {
              done(buildAnswers());
              return;
            }
            advance();
          }
          refresh();
          return;
        }
        if (s.q.multiSelect) {
          toggle(s, s.cursor);
          refresh();
          return;
        }
        if (pick(s, s.cursor)) return;
        refresh();
      }

      function helpText(): string {
        if (editMode === "note") return "Enter save note • Esc back";
        if (editMode === "custom") return "Enter submit • Esc back";
        const move = "↑↓/jk";
        const switchTab = "←→/hl/Tab switch";
        if (!single && tab === SUBMIT_TAB)
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
            tab === SUBMIT_TAB
              ? theme.bold(theme.fg("accent", " Submit "))
              : theme.fg("dim", " Submit "),
          );
          add(chips.join(theme.fg("borderMuted", "│")));
          lines.push("");
        }

        if (!single && tab === SUBMIT_TAB) {
          add(theme.bold(theme.fg("text", " Review your answers")));
          lines.push("");
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
          lines.push("");
          const allDone = states.every(isAnswered);
          const rows: { label: string; color: "success" | "dim" }[] = [
            { label: SUBMIT_LABEL, color: allDone ? "success" : "dim" },
            { label: CANCEL_LABEL, color: "dim" },
          ];
          rows.forEach((row, i) => {
            const focused = submitCursor === i;
            const prefix = focused ? theme.fg("accent", "> ") : "  ";
            const styled = theme.fg(row.color, row.label);
            add(prefix + (focused ? theme.bold(styled) : styled));
          });
        } else {
          const s = states[tab];
          for (const line of wrapTextWithAnsi(s.q.question, contentWidth))
            add(theme.bold(theme.fg("text", ` ${line}`)));
          if (s.note)
            add(theme.fg("warning", " note: ") + theme.fg("muted", s.note));
          lines.push("");

          if (isTextQuestion(s)) {
            renderEditorLines(add, width);
          } else {
            for (let i = 0; i < s.q.options.length; i++) {
              const option = s.q.options[i];
              const focused = s.cursor === i;
              const chosen = s.q.multiSelect
                ? s.selected.has(i)
                : s.picked === i;
              const prefix = focused ? theme.fg("accent", "> ") : "  ";
              const num = theme.fg(focused ? "accent" : "muted", `${i + 1}. `);
              let row: string;
              if (s.q.multiSelect) {
                const mark = chosen
                  ? theme.fg("success", "[x] ")
                  : theme.fg("dim", "[ ] ");
                row =
                  mark +
                  num +
                  theme.fg(focused ? "accent" : "text", option.label);
              } else {
                row =
                  num +
                  theme.fg(focused ? "accent" : "text", option.label) +
                  (chosen ? theme.fg("success", " ✓") : "");
              }
              add(prefix + (focused ? theme.bold(row) : row));
              if (option.description)
                for (const dl of wrapTextWithAnsi(
                  option.description,
                  Math.max(1, contentWidth - 5),
                ))
                  add(`     ${theme.fg("muted", dl)}`);
            }

            lines.push("");
            const customFocused = s.cursor === s.q.options.length;
            const customPrefix = customFocused
              ? theme.fg("accent", "> ")
              : "  ";
            let customRow: string;
            if (customFocused)
              customRow = theme.fg(
                "accent",
                s.customText ? `✎ ${s.customText}` : CUSTOM_LABEL,
              );
            else if (s.customText)
              customRow =
                theme.fg("warning", "✎ ") + theme.fg("text", s.customText);
            else customRow = theme.fg("muted", CUSTOM_LABEL);
            add(
              customPrefix +
                (customFocused ? theme.bold(customRow) : customRow),
            );

            if (s.q.multiSelect) {
              const commitFocused = s.cursor === s.q.options.length + 1;
              const commitPrefix = commitFocused
                ? theme.fg("accent", "> ")
                : "  ";
              const ready = s.selected.size > 0 || !!s.customText;
              const commitStyled = theme.fg(
                ready ? "success" : "dim",
                MULTI_COMMIT_LABEL,
              );
              add(
                commitPrefix +
                  (commitFocused ? theme.bold(commitStyled) : commitStyled),
              );
            }

            if (editMode === "custom") {
              lines.push("");
              add(theme.fg("muted", " Your answer:"));
              renderEditorLines(add, width);
            }
            if (editMode === "note") {
              lines.push("");
              add(theme.fg("muted", " Note:"));
              renderEditorLines(add, width);
            }
          }
        }

        lines.push("");
        add(theme.fg("dim", ` ${helpText()}`));
        rule();
        cachedLines = lines;
        cacheWidth = width;
        return lines;
      }

      return {
        render,
        handleInput,
        get focused() { return editor.focused; },
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
  const labelsByLower = new Map(
    question.options.map((option) => [
      option.label.toLowerCase(),
      option.label,
    ]),
  );
  const answers: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(/[,;]+/).map(normalizeText).filter(Boolean)) {
    const numeric = Number(part);
    const label = Number.isInteger(numeric)
      ? question.options[numeric - 1]?.label
      : labelsByLower.get(part.toLowerCase()) || part;
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    answers.push(label);
  }

  return answers;
}

async function askOptionsQuestionBasic(
  ctx: ExtensionContext,
  question: NormalQuestion,
  signal: AbortSignal | undefined,
): Promise<{ answer: string | string[]; source: AnswerSource } | null> {
  if (!question.multiSelect) {
    const options = question.options.map((option) => option.label);
    options.push(CUSTOM_LABEL);
    const choice = await ctx.ui.select(question.question, options, { signal });
    if (!choice || signal?.aborted) return null;
    if (choice === CUSTOM_LABEL) return askTextQuestionBasic(ctx, question, signal);
    return { answer: choice, source: "choice" };
  }

  const options = question.options
    .map(
      (option, index) =>
        `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
    )
    .join("\n");
  const prompt = `${question.question}\n\n${options}\n\nEnter numbers or labels separated by commas; add custom text if needed.`;
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
      "Ask one or more user questions. Supports options with descriptions, multi-select, and free text. Returns compact answers.",
    promptSnippet: "Ask up to 4 concise blocking questions",
    promptGuidelines: [
      "Surface uncertainty or ambiguity. Whenever missing user input blocks progress, use ask_user to ask rather than guess.",
    ],
    parameters: AskUserParams,
    outputSchema: AskUserResultSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const answers: QuestionAnswer[] = [];
      const questions = normalizeForExecute(params);
      const error = validateQuestions(questions);

      if (signal?.aborted)
        return buildResult({ answers, cancelled: true, error: "aborted" });
      if (!ctx.hasUI)
        return buildResult({
          answers,
          cancelled: true,
          error: "ui_unavailable",
        });
      if (error) return buildResult({ answers, cancelled: true, error });

      if (ctx.mode === "tui") {
        const result = await runQuestionnaire(ctx, questions, signal);
        if (signal?.aborted)
          return buildResult({ answers, cancelled: true, error: "aborted" });
        if (!result) return buildResult({ answers, cancelled: true });
        return buildResult({ answers: result, cancelled: false });
      }

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (signal?.aborted)
          return buildResult({ answers, cancelled: true, error: "aborted" });

        const response =
          q.options.length === 0
            ? await askTextQuestionBasic(ctx, q, signal)
            : await askOptionsQuestionBasic(ctx, q, signal);

        if (signal?.aborted)
          return buildResult({ answers, cancelled: true, error: "aborted" });
        if (!response) return buildResult({ answers, cancelled: true });
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

    renderResult(result, _options, theme) {
      const details = result.details as AskUserResult | undefined;
      if (!details) return new Text("", 0, 0);
      if (details.error)
        return new Text(theme.fg("error", details.error), 0, 0);
      if (details.cancelled)
        return new Text(theme.fg("warning", "cancelled"), 0, 0);
      const summary =
        details.answers.length === 1
          ? answerText(details.answers[0])
          : details.answers.map((a) => compactAnswer(a)).join("; ");
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("text", truncateToWidth(summary, 140)),
        0,
        0,
      );
    },
  });
}
