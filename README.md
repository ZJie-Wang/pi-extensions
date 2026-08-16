# pi-extensions

Workflow extensions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): `ask_user`, plan mode, subagents, and a todo tracker.

They share one design goal: **keep the model's context clean.** A tool costs context twice — once when the model learns it exists (the guidance that lands in the system prompt), and once on every call (the parameter schema and payload). Most extensions pad both. These four keep them as small as they can be while staying precise, and each extension's README documents exactly what gets injected, so you can audit the cost before installing.

| Extension | Tools | What it is |
|---|---|---|
| [ask-user](extensions/ask-user/README.md) | `ask_user` | Interactive question dialog — options with descriptions, multi-select, free text. |
| [plan](extensions/plan/README.md) | `present_plan` | Plan mode: read-only exploration, then write and open a markdown plan. |
| [subagents](extensions/subagents/README.md) | `subagent_run`, `subagent_control` | Isolated child pi agents with profiles, named threads, and background runs. |
| [todo](extensions/todo/README.md) | `todo` | Multi-phase progress tracker with a live TUI widget. |

The four compose: plan mode narrows the toolset to `ask_user` plus the scout/researcher subagents, and subagents gives each child its own minimal tool surface.

## Install

```bash
pi install git:github.com/ZJie-Wang/pi-extensions
```

That loads all four. If you only want some, filter in `settings.json`:

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

or flip individual extensions on and off with `pi config`. See the [pi packages docs](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md#package-filtering) for the full filtering rules.

> **Security:** extensions run with your full system permissions. Read the source before installing — the whole codebase is in this repo.

## Development

The tests need Node ≥ 22.6 (native TypeScript, no build step):

```bash
npm test
```

## License

[MIT](LICENSE)
