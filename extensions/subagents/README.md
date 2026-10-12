# Subagents

A light but useful subagent extension for Pi.

## Install

```bash
pi install npm:@zjie-wang/pi-subagents
```

## Tools

The extension registers two tools for the parent agent.

### `subagent_run`

Start a named thread with `action: "new"` and a profile:

```json
{"action":"new","profile":"researcher","thread":"Dario","prompt":"Investigate why Anthropic banned my account"}
```

Continue the same child conversation once it is idle, using `action: "continue"` and omitting `profile`:

```json
{"action":"continue","thread":"Dario","prompt":"What is the ToS? Explain more about the reasons you mentioned."}
```

### `subagent_control`

```json
{"thread":"overengineering_hunter","action":"status"}
{"thread":"overengineering_hunter","action":"wait"}
{"thread":"overengineering_hunter","action":"steer","message":"Focus only on correctness."}
{"thread":"overengineering_hunter","action":"stop"}
```

- `status` returns immediately and includes the latest result when settled.
- `wait` joins the current run. Cancelling a wait leaves the child running.
- `steer` queues direction after the child’s current tool batch.
- `stop` removes queued work or aborts a running child, keeping the thread.

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

Profiles are checked before parent turns and launches. Valid edits affect new threads without `/reload`; existing threads keep their snapshot.

### Parent-model overrides

Use `~/.pi/agent/subagents.json` to override a profile's model or thinking level for a matching parent model.

```json
{
  "parentModels": {
    "provider/model-a": {
      "worker": { "model": "provider/model-b", "thinking": "high" }
    },
    "provider/model-c": {
      "worker": { "model": "provider/model-d" }
    }
  }
}
```

Parent selectors match exact `provider/model` or model IDs; a qualified selector takes precedence for the whole rule. Unmatched parents or profiles use the profile frontmatter. Omitted fields keep their profile values; `"inherit"` uses the parent's value.

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

Add `example` to a profile’s `tools` list to expose it to new threads using that profile. Modules are discovered by filename and imported when requested by a new thread.

## Out-of-the-box agents

| Agent | Tools | Purpose |
|---|---|---|
| `scout` | `read`, `grep`, `find`, `ls` | Read-only code exploration |
| `reviewer` | `read`, `grep`, `find`, `ls` | Read-only review |
| `researcher` | `web` | System date and guarded Tavily/curl retrieval |
| `worker` | `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash` | Scoped implementation |

Read-only means the child is not given mutation tools. This is a capability boundary, not an operating-system sandbox.

## What the model sees

### `subagent_run`

**Tool definition** (request payload):

```json
{
  "name": "subagent_run",
  "description": "Start or continue a named thread with an isolated child pi agent.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["action", "thread", "prompt"],
    "properties": {
      "action": {
        "type": "string",
        "enum": ["new", "continue"],
        "description": "Create a new thread or send another task to an idle thread."
      },
      "profile": {
        "type": "string",
        "enum": ["researcher", "reviewer", "scout", "worker"],
        "description": "Required for new; omit for continue. Available:\n${profiles.describe()}"
      },
      "thread": {
        "type": "string",
        "description": "Unique and human-readable name, like Tom, Jerry, slop_hunter, etc.",
        "minLength": 1,
        "maxLength": 32,
        "pattern": "^[A-Za-z][A-Za-z0-9 _-]{0,31}$"
      },
      "prompt": {
        "type": "string",
        "description": "Natural-language message for the child.",
        "minLength": 1
      }
    }
  }
}
```

**System prompt guidance** — this extension's contribution, alongside the other tools in the session:

```
Available tools:
- subagent_run: Schedule substantial independent work in named subagent threads

Guidelines:
- Use subagents for tasks that benefit from specialized focus, parallel execution, or keeping noisy exploration out of the main context. Skip them for simple I/O or small tasks.
- New subagent threads start without the parent's transcript. Provide a self-contained initial prompt with the context the child needs. Continue an existing thread when its prior context matters. Keep work in the parent when passing the necessary context would be cumbersome.
```

### `subagent_control`

**Tool definition** (request payload):

```json
{
  "name": "subagent_control",
  "description": "Inspect, join, redirect, or stop an existing named subagent thread.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["thread", "action"],
    "properties": {
      "thread": {
        "type": "string",
        "description": "Existing thread name; case-insensitive.",
        "minLength": 1,
        "maxLength": 32,
        "pattern": "^[A-Za-z][A-Za-z0-9 _-]{0,31}$"
      },
      "action": {
        "type": "string",
        "enum": ["status", "wait", "steer", "stop"],
        "description": "status returns state; wait joins the child; steer injects message; stop aborts the thread"
      },
      "message": {
        "type": "string",
        "description": "Required only for steer",
        "minLength": 1
      }
    }
  }
}
```

**System prompt guidance:**

```
Available tools:
- subagent_control: Interact with existing subagent threads
```

No guidelines for this one — the schema's `action` enum is the whole story.

## Note

This subagent extension is definitely not the most powerful one compared with what you can find from the community. However, all design decisions are made deliberately to keep it lean and light (relatively), while being as useful as possible.
