# todo

A `todo` tool for the pi coding agent: track complex, multi-phase work.

## Features

- `new` — start a tracker from ordered phase titles; the first phase becomes active.
- `update` — mark phases complete (`completedIds`), optionally jump to a phase (`activeId`); the next pending phase activates automatically.
- `list` — read the current tracker.
- `clear` — reset the tracker.
- State is reconstructed from the session's tool results, so it survives restarts and is visible across the session tree.
- In TUI mode, a live widget shows progress (`✓/○/●`), a progress bar, and the active phase.

## Context footprint

One-line `promptSnippet`, two guideline bullets, and a flat `additionalProperties: false` schema — see the [root README](../README.md) for the exact injected text.

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
      "extensions": ["extensions/todo/index.ts"]
    }
  ]
}
```
