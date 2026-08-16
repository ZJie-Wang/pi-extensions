# pi-extensions

Sharing extensions I built for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

| Extension | Tools | What it is |
|---|---|---|
| [ask-user](extensions/ask-user/README.md) | `ask_user` | Interactive question dialog — options with descriptions, multi-select, free text. |
| [plan](extensions/plan/README.md) | `present_plan` | Plan mode: read-only exploration, then write and open a markdown plan. |
| [subagents](extensions/subagents/README.md) | `subagent_run`, `subagent_control` | Isolated child pi agents with profiles, named threads, and background runs. |
| [todo](extensions/todo/README.md) | `todo` | Multi-phase progress tracker with a live TUI widget. |

The main reason I built these rather than just installing community extensions is that I think most of them inject too much tool guidance/schema into the model's context which actually violates the principle of clean context proposed by pi. What I'm looking for is just something light, smooth and useful, or why am I using pi instead of claude code or codex?

Also, these extensions are specifically tuned based on my taste, and I have hand-written many of the instructions and guidelines that come with them. All extensions are tested in my own pi harness with `deepseek-v4-flash`, and the experience is quite smooth. So I would assume it should work well with most models out of the box.

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
