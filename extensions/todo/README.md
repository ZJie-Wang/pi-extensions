# todo

`todo` tracks complex, multi-phase work so the agent does not have to keep the whole plan in its head. The tracker lives in the session itself — it is reconstructed from past tool results — so it survives restarts and stays visible across the session tree. In the TUI a live widget shows the phases, the active one, and a progress bar.

The tool is deliberately dumb about when to be used: two guideline bullets tell the model to reach for it only when the work actually has phases, and nothing else.

## What it injects

**Guidance** — one snippet line plus two guideline bullets:

> Track multi-phase progress

> - Use todo for complex, multi-step work with at least three meaningfully coordinated phases. Skip it for simple tasks or when coordination adds no value.
> - Once a todo tracker is started, remember to update it promptly after each phase completes.

**Schema** — flat, with `additionalProperties: false` so the model cannot sneak extra fields into a call:

```jsonc
{
  "action": "new | update | list | clear",
  "items": ["string"],    // required for new
  "completedIds": [1, 2], // for update
  "activeId": 3           // optional, for update
}
```

## Actions

- `new` — start a tracker from ordered phase titles; the first phase becomes active.
- `update` — mark phases complete (`completedIds`), optionally jump to a phase (`activeId`); the next pending phase activates automatically.
- `list` — read the current tracker.
- `clear` — reset it.

There is also a `/todos` command to show or clear the tracker from the prompt line.

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
