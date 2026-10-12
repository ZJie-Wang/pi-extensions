# pi-extensions

Sharing extensions I built for my [pi agent harness](https://github.com/earendil-works/pi-coding-agent).

## What's included

| Extension | Tools | What it is |
|---|---|---|
| [ask-user](extensions/ask-user/README.md) | `ask_user` | Interactive question dialog — options with descriptions, multi-select, free text. |
| [lazygit](extensions/lazygit/index.ts) | - | Hands the terminal to lazygit in the current directory, then returns to pi. |
| [subagents](extensions/subagents/README.md) | `subagent_run`, `subagent_control` | Isolated child pi agents with profiles, named threads, and background runs. |
| [todo](extensions/todo/README.md) | `todo` | Multi-phase progress tracker with a live TUI widget. |

## Install

Install the extensions you want from npm:

```bash
pi install npm:@zjie-wang/pi-ask-user
pi install npm:@zjie-wang/pi-subagents
pi install npm:@zjie-wang/pi-todo
```

To load all four directly from GitHub instead (lazygit has no npm package yet):

```bash
pi install git:github.com/ZJie-Wang/pi-extensions
```

After installing the packages, you should be able to find them at `~/.pi/agent/npm/node_modules/@zjie-wang`. You can also install them by just copying the extension folders into your `~/.pi/agent/extensions` and maintain them yourself (I still recommend this way).

## Some notes

These extensions are definitely not the most powerful ones you can find, and that's not what I'm trying to achieve either. I think most of the popular community extensions inject too much context, whereas I'm just looking for something light, controllable and useful, or why am I using pi instead of claude code or codex?

Also, I have handwritten many of the instructions and guidelines these extensions come with to make sure they work the way I expect. I test them with `deepseek-v4-flash`, and the experience is quite smooth. So I would assume it should work well with most models out of the box.

## License

[MIT](LICENSE)
