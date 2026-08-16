# ask-user

`ask_user` lets the agent ask you questions instead of guessing. One call can carry up to four questions, each with optional multiple-choice options (including trade-off descriptions), multi-select, or plain free text. In the TUI it renders a full dialog — keyboard navigation, an inline editor for custom answers, per-question notes, and a review screen before anything is submitted. In RPC mode it falls back to simple `select`/`input` prompts.

It is designed to stay out of the way: the model sees one line of guidance and a small, strictly bounded schema.

## What it injects

**Guidance** — one snippet line plus a single guideline bullet:

> Ask up to 4 concise blocking questions

> Surface uncertainty or ambiguity. Whenever missing user input blocks progress, use ask_user to ask rather than guess.

**Schema** — a single `questions` array, 1–4 items:

```jsonc
{
  "questions": [
    {
      "question": "string",      // the prompt text
      "header": "string",        // short chip label, e.g. "Approach"
      "options": [               // optional; omit for a free-text question
        { "label": "string", "description": "string" }
      ],
      "multiSelect": false       // optional
    }
  ]
}
```

The bounds live in the schema itself (question ≤ 1000 chars, header ≤ 16, label ≤ 60, description ≤ 300, 2–4 options), so the model cannot bloat the call.

## Install

```bash
pi install git:github.com/ZJie-Wang/pi-extensions
```

Load only this extension:

```json
{
  "packages": [
    {
      "source": "git:github.com/ZJie-Wang/pi-extensions",
      "extensions": ["extensions/ask-user/index.ts"]
    }
  ]
}
```
