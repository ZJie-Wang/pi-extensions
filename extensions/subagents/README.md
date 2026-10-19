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
{"action":"new","profile":"searcher","thread":"Dario","prompt":"Investigate why Anthropic banned my account"}
```

Continue the same child conversation once it is idle, using `action: "continue"` and omitting `profile`:

```json
{"action":"continue","thread":"Dario","prompt":"?"}
```

### `subagent_control`

```json
{"thread":"overengineering_hunter","action":"status"}
{"thread":"overengineering_hunter","action":"wait"}
{"thread":"overengineering_hunter","action":"steer","message":"Scan one more dir"}
{"thread":"overengineering_hunter","action":"stop"}
```

- `status` returns immediately with the thread's state and activity.
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
---

Profile instructions...
```

| Field | Meaning |
|---|---|
| `name` | Unique lowercase profile identifier |
| `description` | Purpose shown in the `subagent_run` schema |
| `tools` | Strict allowlist of tools available |
| `skills` | Optional Pi skills; profiles using skills must also have `read` |
| `model` | `inherit`, an exact model ID, or `provider/model` |
| `thinking` | `inherit`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

- Every child uses its profile instructions in place of Pi's base prompt.
- All children load context files such as `AGENTS.md` through Pi's normal discovery.
- The tool allowlist rejects  `subagent_run` and `subagent_control` to prevent recursive orchestration.
- Profile instructions support `{{date}}` and `{{cwd}}`. They are resolved when the child session starts.

### Parent-model overrides

Use `~/.pi/agent/subagents.json` to override a profile's model or thinking level for a matching parent model. You need to use the complete id for the model, for example:

```json
{
  "parentModels": {
    "openai-codex/gpt-6-astra": {
      "scout": { "model": "openai-codex/gpt-6-luna", "thinking": "low" }
    },
    "zai-coding-cn/glm-5.3-flash": {
      "reviewer": { "model": "zai-coding-cn/glm-5.3", "thinking": "max" }
    }
  }
}
```

## Out-of-the-box agents

| Agent | Tools |
|---|---|
| `scout` | `read`, `grep`, `find`, `ls` |
| `searcher` | `web_search`, `web_fetch` |
| `reviewer` | `read`, `grep`, `find`, `ls` |
| `worker` | `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash` |

## What the (main) agent sees

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
        "enum": ["new", "continue"]
      },
      "profile": {
        "type": "string",
        "enum": ["${profiles.names()}"],
        "description": "Required for new; omit for continue. Available:\n${profiles.describe()}"
      },
      "thread": {
        "type": "string",
        "description": "Unique and human-readable name, like Tom, Jerry, slop_hunter, etc."
      },
      "prompt": {
        "type": "string",
        "description": "Natural-language message for the child."
      },
      "inheritContext": {
        "type": "boolean",
        "description": "Inherit the parent's active conversation when creating new threads.",
        "default": false
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
- Give the child a clear task. Set inheritContext to true when the child needs the earlier parent conversation as context; otherwise include the necessary context in the prompt. Continue an existing thread when its history matters.
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
        "description": "Existing thread name."
      },
      "action": {
        "type": "string",
        "enum": ["status", "wait", "steer", "stop"],
        "description": "status returns state; wait joins the child; steer injects message; stop aborts the thread"
      },
      "message": {
        "type": "string",
        "description": "Required only for steer"
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
