# pi-extensions

Sharing extensions I built for my [pi agent harness](https://github.com/earendil-works/pi-coding-agent).

## What's included

| Extension | Tools | What it does |
|---|---|---|
| [ask-user](extensions/ask-user/README.md) | `ask_user` | Ask questions mid-run. |
| [deepseek-web](extensions/deepseek-web/README.md) | `web_search`, `web_fetch` | Web search and page fetch through DeepSeek's tools API. |
| [lazygit](extensions/lazygit/README.md) | - | Open lazygit in the same terminal tab. |
| [subagents](extensions/subagents/README.md) | `subagent_run`, `subagent_control` | A relatively light subagent extension. |
| [todo](extensions/todo/README.md) | `todo` | Track task progress. |

## Install

Install the extensions you want from npm:

```bash
pi install npm:@zjie-wang/pi-ask-user
pi install npm:@zjie-wang/pi-deepseek-web
pi install npm:@zjie-wang/pi-lazygit
pi install npm:@zjie-wang/pi-subagents
pi install npm:@zjie-wang/pi-todo
```

To load all extensions directly from GitHub instead:

```bash
pi install git:github.com/ZJie-Wang/pi-extensions
```

After installing the packages, you should be able to find them at `~/.pi/agent/npm/node_modules/@zjie-wang`. You can also install them by just copying the extension folders into your `~/.pi/agent/extensions` and maintain them yourself (I still recommend this way).

## Some notes

These extensions are definitely not the most powerful ones you can find, and that's not what I'm trying to achieve either. I made these extensions just because I think most popular community extensions inject too much context. Installing just a few of them, my pi is more bloated than codex. However, I'm just looking for something light and controllable; or why am I not using codex directly.

Also, I have handwritten many of the instructions and guidelines these extensions come with to make sure they work the way I expect. I test them with `deepseek-v4-flash`, and the experience is quite smooth. So I would assume it should work well with most models out of the box.

## License

[MIT](LICENSE)
