# Subagents

A light but useful subagent extension for Pi.

> Part of [pi-extensions](https://github.com/ZJie-Wang/pi-extensions). Install with `pi install git:github.com/ZJie-Wang/pi-extensions`, or load only this extension via package filtering (see the root README).

## Tools

The extension registers two parent-facing tools.

### `subagent_run`

Start a named thread by providing a profile:

```json
{"profile":"researcher","thread":"Dario","prompt":"Investigate why Anthropic banned my account"}
```

Continue the same child conversation by omitting `profile`:

```json
{"thread":"Dario","prompt":"Now tell me what is the latest Claude model"}
```

Run independent work in the background:

```json
{"profile":"reviewer","thread":"Sam","prompt":"Review the current changes for correctness.","background":true}
```

### `subagent_control`

```json
{"thread":"overengineering_hunter","action":"status"}
{"thread":"overengineering_hunter","action":"wait"}
{"thread":"overengineering_hunter","action":"steer","message":"Focus only on correctness."}
{"thread":"overengineering_hunter","action":"stop"}
```

- `status` returns immediately and includes the latest result when settled.
- `wait` joins the current run. Cancelling a wait does not stop background work.
- `steer` queues direction after the child’s current tool batch.
- `stop` removes queued work or aborts a running child.

## Profiles

Profiles are markdown files in [`agents/`](./agents):

```yaml
---
name: scout
description: Explore codebases without modifying files
tools: [read, grep, find, ls]
skills: []
model: inherit
thinking: low
preserveBaseInstruction: false
includeProjectContext: true
---

Profile instructions...
```

| Field | Meaning |
|---|---|
| `name` | Unique lowercase profile identifier |
| `description` | Purpose shown in the `subagent_run` schema |
| `tools` | Strict child tool allowlist |
| `skills` | Optional Pi skills; profiles using skills must include `read` |
| `model` | `inherit`, an exact model ID, or `provider/model` |
| `thinking` | `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `preserveBaseInstruction` | Append profile instructions to Pi’s base prompt when true; replace it when false |
| `includeProjectContext` | Load `AGENTS.md` and other project context files when true; exclude them when false |

Profiles are checked before parent turns and launches. Valid edits affect new threads without `/reload`; existing threads keep their snapshot. Child sessions load no extensions, cannot nest subagents, and receive both a strict SDK allowlist and a call-time tool guard.

## Child tool modules

Built-ins (`read`, `grep`, `find`, `ls`, `write`, `edit`, and `bash`) come from Pi. Extension-specific child tools live in [`tools/`](./tools).

Each `tools/<name>.ts` file default-exports a factory receiving the child working directory:

```ts
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export default function createTool(cwd: string): ToolDefinition {
  return {
    name: "example", // must match example.ts
    label: "Example",
    description: "Describe the capability and its safety boundary.",
    parameters: Type.Object({ input: Type.String() }),
    async execute(_id, params, signal, onUpdate) {
      return {
        content: [{ type: "text", text: `${cwd}: ${params.input}` }],
        details: {},
      };
    },
  };
}
```

Add `example` to a profile’s `tools` list to expose it to new threads using that profile. Modules are discovered by filename and imported only when requested by a new thread. The factory’s returned tool name must match its filename.

## Out-of-the-box agents

| Agent | Tools | Purpose |
|---|---|---|
| `scout` | `read`, `grep`, `find`, `ls` | Read-only code exploration |
| `reviewer` | `read`, `grep`, `find`, `ls` | Read-only review |
| `researcher` | `web` | System date and guarded Tavily/curl retrieval |
| `worker` | `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash` | Scoped implementation |

Read-only means the child is not given mutation tools. This is a Pi capability boundary, not an operating-system sandbox.
