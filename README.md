# pi-extensions

Sharing extensions I built for my [pi agent harness](https://github.com/earendil-works/pi-coding-agent).

## What's included

| Extension | Tools | What it is |
|---|---|---|
| [ask-user](extensions/ask-user/README.md) | `ask_user` | Interactive question dialog — options with descriptions, multi-select, free text. |
| [plan](extensions/plan/README.md) | `present_plan` | Plan mode: read-only exploration, then write and open a markdown plan. |
| [subagents](extensions/subagents/README.md) | `subagent_run`, `subagent_control` | Isolated child pi agents with profiles, named threads, and background runs. |
| [todo](extensions/todo/README.md) | `todo` | Multi-phase progress tracker with a live TUI widget. |

## Install

Install the extensions you want from npm:

```bash
pi install npm:@zjie-wang/pi-ask-user
pi install npm:@zjie-wang/pi-plan
pi install npm:@zjie-wang/pi-subagents
pi install npm:@zjie-wang/pi-todo
```

To load all four directly from GitHub instead:

```bash
pi install git:github.com/ZJie-Wang/pi-extensions
```

After installing the packages, you should be able to find them at `~/.pi/agent/npm/node_modules/@zjie-wang`. You can also install them by just copying the extension folders into your `~/.pi/agent/extensions` and maintain them yourself.

## Some notes

These extensions are definitely not the most powerful ones you can find, and that's not what I'm trying to achieve either. I just want something light and controllable while being as useful as possible. I personally don't have a super heavy, fully automatic workflow to run in my pi harness (I also don't think pi is meant to run things like that). Instead, I just want an agent I can collaborate with without needing to "have a fight first".

The main reason I built these rather than installing the popular community extensions is that, although there are many powerful extensions out there, I think most of them inject too much tool guidance/schema into the model's context which actually violates the principle of clean context proposed by pi. What I'm looking for is just something light, controllable and useful, or why am I using pi instead of claude code or codex? Why would someone think they can build a better harness themselves than the big labs can?

Also, I have handwritten many of the instructions and guidelines these extensions come with to make sure they work the way I expect. I test them with `deepseek-v4-flash`, and the experience is quite smooth. So I would assume it should work well with most models out of the box.

## License

[MIT](LICENSE)
