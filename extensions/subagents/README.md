# Subagents

A light but useful subagent extension for Pi.

## Tools

The extension registers two tools for the parent agent.

### `subagent_run`

Start a named thread by providing a profile:

```json
{"profile":"researcher","thread":"Dario","prompt":"Investigate why Anthropic banned my account"}
```

Continue the same child conversation by omitting `profile`:

```json
{"thread":"Dario","prompt":"What is the ToS? Explain more about the reasons you mentioned."}
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

## What the model sees

### `subagent_run`

**Tool definition** (request payload):

```json
{
  "name": "subagent_run",
  "description": "Start or continue a named thread with an isolated child pi agent.",
  "parameters": {
    "type": "object",
    "required": ["thread", "prompt"],
    "properties": {
      "profile": {
        "type": "string",
        "enum": ["researcher", "reviewer", "scout", "worker"],
        "description": "Profile for the named child. Include a profile to start a new thread; omit it when continuing an existing one. Available: ${profiles.describe()}"
      },
      "thread": {
        "type": "string",
        "description": "Human-readable thread name, like Tom, Jerry, overengineering_hunter, etc.",
        "minLength": 1,
        "maxLength": 32
      },
      "prompt": {
        "type": "string",
        "description": "Natural-language message for the child.",
        "minLength": 1
      },
      "background": {
        "type": "boolean",
        "description": "Run independently and notify the parent on completion. Default: false.",
        "default": false
      }
    }
  }
}
```

**System prompt guidance** — this extension's contribution, alongside the other tools in the session:

```
Available tools:
- subagent_run: Start or continue substantial independent work in named subagent threads

Guidelines:
- Use subagents for tasks that benefit from specialized focus, parallel execution, or keeping noisy exploration out of the main context. Avoid overuse; direct tools are enough for simple I/O and small tasks.
- Give each new subagent thread a short memorable name and a self-contained initial prompt; continue that thread when its prior context matters.
- Default to foreground subagent_run calls. Use background only to work in parallel with subagents; do not poll—wait while blocked on the result.
```

The `profile` enum is generated from the markdown files in [`agents/`](./agents), so it always matches the profiles that actually exist. And a child's own context is lean too: each profile gets exactly the tools it lists — `scout` only `read`/`grep`/`find`/`ls`, for instance — so nothing is injected that a child cannot use.

### `subagent_control`

**Tool definition** (request payload):

```json
{
  "name": "subagent_control",
  "description": "Inspect, join, redirect, or stop an existing named subagent thread.",
  "parameters": {
    "type": "object",
    "required": ["thread", "action"],
    "properties": {
      "thread": {
        "type": "string",
        "description": "Human-readable thread name used by subagent_run",
        "minLength": 1,
        "maxLength": 32
      },
      "action": {
        "type": "string",
        "enum": ["status", "wait", "steer", "stop"],
        "description": "status is non-blocking; wait joins; steer redirects; stop aborts"
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
- subagent_control: Control existing subagent threads
```

No guidelines for this one — the schema's `action` enum is the whole story.

## Note

This subagent extension is definitely not the most powerful one compared with what you can find from the community. However, all design decisions are made deliberately to keep it lean and light, while being as useful as possible.

Also, I have to say that, although subagents have become one of the "standards" for agent harnesses, it's worth reflecting on whether they actually live up to the hype they got — do they really improve how our agents work in terms of quality and efficiency? I believe for many users, a working experience **without** any subagents or similar features actually feels much smoother, especially regarding that many "frontier" models nowadays, like `gpt-5.6-sol`, really overuse subagents so much when not necessary.

I'm not trying to doubt the value subagents add to our workflow - they are indeed powerful, and can be very helpful when used properly. The question worth asking is: how we can ensure they are used deliberately and intentionally, and how we can ensure everything is still in control when a number of child agents are running wild on our machines.

I cannot say this extension solves the problems, but at least it was built with these considerations in mind.
