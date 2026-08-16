# pi-extensions

Sharing extensions I built for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

The main reason I built these rather than just installing community extensions is that most of them inject a lot of tool guidance and parameter schemas into the model's context. Every tool costs context twice — once when the model learns it exists, and once on every call — so I made my own versions that keep both minimal while staying precise. Each extension's README documents exactly what gets injected, so you can audit the cost before installing.

| Extension | Tools | What it is |
|---|---|---|
| [ask-user](extensions/ask-user/README.md) | `ask_user` | Interactive question dialog — options with descriptions, multi-select, free text. |
| [plan](extensions/plan/README.md) | `present_plan` | Plan mode: read-only exploration, then write and open a markdown plan. |
| [subagents](extensions/subagents/README.md) | `subagent_run`, `subagent_control` | Isolated child pi agents with profiles, named threads, and background runs. |
| [todo](extensions/todo/README.md) | `todo` | Multi-phase progress tracker with a live TUI widget. |

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

Alternatively, you can copy the extension folders straight into `~/.pi/agent/extensions/`. Either way, I'd encourage you to adapt them to your needs — let your agent edit the code and build your own version. That's what pi is designed for.

## License

[MIT](LICENSE)
