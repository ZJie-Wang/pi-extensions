# pi-extensions

Workflow extensions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent), built around one principle:

> **Lean context injection.** Every tool the model can call costs context. Each one advertises itself twice: as *tool guidance* (the `promptSnippet`/`promptGuidelines` that land in the system prompt) and as a *tool payload* (the parameter schema sent with each call). These extensions keep both deliberately small and precise — no padded guidance, no redundant schema fields, no injected payload examples.

A full transparency list of exactly what each tool injects is below, so you can audit the context cost before installing.

## Contents

| Extension | Tools | What it does |
|---|---|---|
| [ask-user](extensions/ask-user/README.md) | `ask_user` | Interactive question dialog with options, descriptions, multi-select, and free text. |
| [plan](extensions/plan/README.md) | `present_plan` | Plan mode: read-only exploration, then write/open a markdown plan. `/plan`, `--plan`, `Ctrl+Alt+P`. |
| [subagents](extensions/subagents/README.md) | `subagent_run`, `subagent_control` | Isolated child pi agents with profiles, threads, foreground/background runs, and live activity tracking. |
| [todo](extensions/todo/README.md) | `todo` | Persistent multi-phase progress tracker with a TUI widget. |

The four tools compose: `plan` restricts planning tools to `ask_user` + `subagent` (scout/researcher only), and `subagents` gives the child agents their own lean tool surface.

## Install

```bash
pi install git:github.com/ZJie-Wang/pi-extensions
```

This loads all four extensions. To load only a subset, filter with `pi config` (or see [Package Filtering](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md#package-filtering)):

```json
{
  "packages": [
    {
      "source": "git:github.com/ZJie-Wang/pi-extensions",
      "extensions": ["extensions/subagents/index.ts"]
    }
  ]
}
```

> **Security:** extensions run with your full system permissions. Review the source before installing — the whole codebase is in this repo.

## What each tool injects

The model sees each tool through two channels. Here is the complete picture for every tool in this repo.

### `ask_user`

**Guidance injected** (1 line):

```
Ask up to 4 concise blocking questions
```

Plus one guideline bullet:

```
Surface uncertainty or ambiguity. Whenever missing user input blocks progress, use ask_user to ask rather than guess.
```

**Payload schema injected:** a single `questions` array, 1–4 items, each with only the fields below. Bounds are enforced in the schema itself (question ≤ 1000 chars, header ≤ 16, label ≤ 60, description ≤ 300, 2–4 options) so the model cannot bloat the call.

```jsonc
{
  "questions": [
    {
      "question": "string",        // the prompt text
      "header": "string",          // short chip label, e.g. "Approach"
      "options": [                 // optional; omit for free-text
        { "label": "string", "description": "string" }
      ],
      "multiSelect": false         // optional
    }
  ]
}
```

### `present_plan` (plan mode)

No `promptSnippet` or guidelines are injected at all — plan mode teaches the model through one self-contained instruction block (`extensions/plan/plan-mode-instruction.md`) that is only active while plan mode is on. The tool itself is invisible outside plan mode.

**Payload schema injected:**

```jsonc
{ "plan": "string" }  // the full plan in markdown
```

### `subagent_run`

**Guidance injected** (1 line + 3 guidelines):

```
Start or continue substantial independent work in named subagent threads
```

```
- Use subagents for tasks that benefit from specialized focus, parallel execution, or keeping noisy exploration out of the main context. Avoid overuse; direct tools are enough for simple I/O and small tasks.
- Give each new subagent thread a short memorable name and a self-contained initial prompt; continue that thread when its prior context matters.
- Default to foreground subagent_run calls. Use background only to work in parallel with subagents; do not poll—wait while blocked on the result.
```

**Payload schema injected** — four fields, no nesting:

```jsonc
{
  "profile": "scout | researcher | reviewer | worker",  // enum of shipped profiles
  "thread": "string",                                   // 1–32 chars
  "prompt": "string",
  "background": false                                   // optional
}
```

The `profile` enum is generated from the markdown files in `extensions/subagents/agents/`, so it stays exactly in sync with the profiles that exist.

### `subagent_control`

**Guidance injected** (1 line, no guidelines):

```
Control existing subagent threads
```

**Payload schema injected:**

```jsonc
{
  "thread": "string",                 // 1–32 chars
  "action": "status | wait | steer | stop",
  "message": "string"                 // required only for steer
}
```

### `todo`

**Guidance injected** (1 line + 2 guidelines):

```
Track multi-phase progress
```

```
- Use todo for complex, multi-step work with at least three meaningfully coordinated phases. Skip it for simple tasks or when coordination adds no value.
- Once a todo tracker is started, remember to update it promptly after each phase completes.
```

**Payload schema injected** — a flat action + optional fields, with `additionalProperties: false` so the model cannot smuggle extra fields into the call:

```jsonc
{
  "action": "new | update | list | clear",
  "items": ["string"],        // required for new
  "completedIds": [1, 2],     // for update
  "activeId": 3               // optional, for update
}
```

## Design notes

- **No payload examples injected.** Several of these tools could advertise large JSON examples; none do. The schemas are small enough that the model does not need them.
- **Guidelines are behavioral, not descriptive.** They say *when* to use the tool, not *how* it works — the how lives in the schema.
- **Subagent output stays out of the main context until it matters.** Background threads complete silently; their full output enters context only when the parent calls `subagent_control` with `action: "wait"`. Child output is capped at 50 KB / 2,000 lines.
- **Strict schemas are enforced, not just suggested.** `todo` rejects unknown fields; `subagent_run` validates `thread` length in-schema; the `web` child tool validates its argument vector before execution.

## Development

Run the test suite (Node ≥ 22.6, native TypeScript — no build step):

```bash
npm test
```

The tests cover the pure logic of each extension: plan-mode bash policy, profile normalization, thread manager behavior, the web tool's argument allowlist, and the child tool loader. TUI rendering is exercised by the smoke test in `extensions/subagents/smoke/`, which requires pi's packages and is run manually.

## License

[MIT](LICENSE)
