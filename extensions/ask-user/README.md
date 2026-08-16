# ask-user

An `ask_user` tool for the pi coding agent: ask one or more user questions with options, descriptions, multi-select, and free text.

The main agent uses it to surface uncertainty, ambiguity, and blocked decisions instead of guessing.

## Features

- Up to **4 questions per call**, each with an optional chip label (`header`).
- Each question supports 2–4 options with trade-off descriptions, multi-select, or a plain free-text answer (a free-text row is always available).
- In TUI mode, a full dialog renders the questionnaire with keyboard navigation, an inline editor, per-question notes, and a final review/submit screen.
- In RPC mode, it falls back to sequential `select`/`input` prompts.
- Returns a compact result (`answer: ...` or `answers: Q1: ...; Q2: ...`) plus structured `details` for rendering.

## Context footprint

One-line `promptSnippet`, a single guideline bullet, and a flat schema with strict bounds — see the [root README](../README.md) for the exact injected text.

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
