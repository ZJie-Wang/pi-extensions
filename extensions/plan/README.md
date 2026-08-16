# Plan Mode Extension

Plan mode for Pi: read-only exploration, then write/open a markdown plan/spec file.

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

## Customize instruction

Edit `plan-mode-instruction.md` and run `/reload`.
