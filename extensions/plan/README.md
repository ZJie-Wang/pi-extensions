# Plan Mode Extension

Plan mode for Pi: read-only exploration, then write/open a markdown plan/spec file.

## Install

```bash
pi install npm:@zjie-wang/pi-plan
```

## Entry points

- `/plan` — toggle plan mode
- `/plan on|off|status|open|clear` — explicit controls
- `--plan` — start Pi in plan mode
- `Ctrl+Alt+P` — toggle plan mode

## Behavior

While planning, usable tools are restricted to:

- `read`, `grep`, `find`, `ls`
- `bash` with a conservative read-only policy.
- `ask_user`
- `subagent`, but only `scout` and `researcher`
- `present_plan`

`present_plan` writes the plan to `PLAN.md` in the current repo. The extension opens that file immediately with the system default markdown app unless `PI_PLAN_NO_OPEN=1` is set.

After saving the plan, the extension asks the user what to do next, options include:

- Implement plan
- I revised the plan — re-read & implement
- Revise plan
- Stay in plan mode

For either implementation action, a second prompt asks whether to start in current context, or compact first before starting.

## Adapt to your harness

- Edit `config/tool-allowlist` to configure your own custom tools (if any).
- Edit `plan-mode-instruction.md` if you have preferences about how the plan-mode agent should behave or what the plan should look like.
- Run `/reload` or start a new pi session to apply the changes.

## Note

Plan mode is a workflow guard, not a security sandbox. It restricts tools and blocks common mutating shell commands, but allowed commands such as tests and external tools such as subagents can still have side effects. Review `config/tool-allowlist.json` and adjust it for your environment.

## Source

Part of the [pi-extensions](https://github.com/ZJie-Wang/pi-extensions) collection. This extension works individually; the collection README also covers the design notes, the other extensions, and how to customize the installed files — e.g. copying them from `~/.pi/agent/npm/node_modules/@zjie-wang` to maintain them yourself.
