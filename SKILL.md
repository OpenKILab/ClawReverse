---
name: clawreverse
description: Inspect, checkpoint, rollback, and branch OpenClaw sessions with the ClawReverse plugin. Use when a user wants to recover from bad tool or file changes, restore a known-good checkpoint, inspect session lineage, create a child branch from an earlier point, or avoid re-spending tokens after a long OpenClaw run. Do not use for plain git history operations or non-OpenClaw workspaces.
version: 0.1.0
homepage: https://github.com/OpenKILab/ClawReverse
metadata: {"openclaw":{"emoji":"⏪","homepage":"https://github.com/OpenKILab/ClawReverse","requires":{"bins":["openclaw"]}}}
---

# ClawReverse

Use this skill for OpenClaw session recovery and branching.

ClawReverse is a native OpenClaw plugin that adds the `openclaw reverse` command family for checkpoint listing, rollback, continue, checkout, and lineage inspection.

## Use this skill when

- a user wants to undo a bad OpenClaw tool call or recover from unwanted file changes
- a user wants to restore a known-good point without rerunning the whole task
- a user wants to branch from an earlier checkpoint and keep the parent session untouched
- a user wants to inspect checkpoint lineage, rollback status, rollback reports, or branch records
- a user wants to save tokens after a long analysis run by continuing from a checkpoint instead of starting over

## Do not use this skill when

- the task is a normal git revert, git checkout, or git branch workflow that should be handled directly with git
- the workspace is not managed by OpenClaw
- there are no OpenClaw sessions or checkpoints to operate on yet

## Key behavior you should know first

- ClawReverse creates checkpoints **before mutating tool calls**. Read-only tools and read-only shell commands do **not** create checkpoints.
- `rollback` rewinds the current session to a checkpoint. By default it does **not** restore the live workspace files unless `--restore-workspace` is used.
- `continue` requires a non-empty `--prompt` and creates a **new child agent, new workspace, and new session**, leaving the parent untouched.
- `checkout` creates a **new session in the same agent** from a checkpoint-backed entry. `--continue` can immediately start a run in that new session.
- `tree` is the fastest way to explain lineage and branch points to a user.
- Add `--json` whenever another tool needs machine-readable output.

## Prerequisites

- a working OpenClaw installation
- access to the machine that runs OpenClaw
- a valid `openclaw.json`
- the ClawReverse plugin files available in this skill bundle

## First step: verify or install the plugin

1. Check whether the plugin is already available:

```bash
openclaw reverse --help
```

2. If the command is missing, install the plugin from this skill bundle:

```bash
openclaw plugins install -l "{baseDir}"
```

3. Then initialize or repair config:

```bash
openclaw reverse setup
```

4. Restart the OpenClaw Gateway after install or config changes, then verify again:

```bash
openclaw reverse --help
```

If the OpenClaw state directory is not the default one, use:

```bash
openclaw reverse setup --base-dir /path/to/openclaw-state
```

## Default config created by `setup`

```json
{
  "plugins": {
    "allow": ["clawreverse"],
    "enabled": true,
    "entries": {
      "clawreverse": {
        "enabled": true,
        "config": {
          "workspaceRoots": ["~/.openclaw/workspace"],
          "checkpointDir": "~/.openclaw/plugins/clawreverse/checkpoints",
          "registryDir": "~/.openclaw/plugins/clawreverse/registry",
          "runtimeDir": "~/.openclaw/plugins/clawreverse/runtime",
          "reportsDir": "~/.openclaw/plugins/clawreverse/reports",
          "maxCheckpointsPerSession": 100,
          "allowContinuePrompt": true,
          "stopRunBeforeRollback": true
        }
      }
    }
  }
}
```

## Standard workflow

### 1) Identify the target agent and session

```bash
openclaw reverse agents
openclaw reverse sessions --agent <agent-id>
```

Use the value in the `Agent` column as the `agent id` and the value in the `Session` column as the `session id`. The row marked `latest` is the newest session.

### 2) List checkpoints

```bash
openclaw reverse checkpoints --agent <agent-id> --session <session-id>
```

If you need details for one checkpoint:

```bash
openclaw reverse checkpoint --checkpoint <checkpoint-id>
```

### 3) Choose the correct action

#### Roll back the current line

Use this when the user wants to rewind the **current session** to an earlier point.

```bash
openclaw reverse rollback \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id>
```

Only add `--restore-workspace` when the user explicitly wants the current on-disk workspace restored too:

```bash
openclaw reverse rollback \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --restore-workspace
```

#### Continue as a safe child branch

Use this when the parent session and workspace must stay untouched and the user wants a fresh attempt from a known-good checkpoint.

```bash
openclaw reverse continue \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "Continue from here with a different approach."
```

Optional advanced flags:

- `--new-agent <agent-id>` to force the child agent id
- `--clone-auth <auto|always|never>` for auth-copy behavior
- `--log` to capture child launch diagnostics and return `logFilePath`

#### Checkout into a new session in the same agent

Use this when the user wants a new session from a checkpoint-backed entry without creating a new agent.

```bash
openclaw reverse nodes --agent <agent-id> --session <session-id>
openclaw reverse checkout \
  --agent <agent-id> \
  --source-session <session-id> \
  --entry <entry-id>
```

To start running immediately after checkout:

```bash
openclaw reverse checkout \
  --agent <agent-id> \
  --source-session <session-id> \
  --entry <entry-id> \
  --continue \
  --prompt "Continue from this restored entry."
```

### 4) Inspect status, reports, and lineage

```bash
openclaw reverse rollback-status --agent <agent-id> --session <session-id>
openclaw reverse tree --agent <agent-id> --session <session-id>
openclaw reverse report --rollback <rollback-id>
openclaw reverse branch --branch <branch-id>
```

`tree` also supports automatic root selection and subtree inspection:

```bash
openclaw reverse tree
openclaw reverse tree --node <checkpoint-id>
```

## Command quick reference

| Command | Purpose |
|---|---|
| `openclaw reverse setup` | Patch `openclaw.json` and create plugin directories |
| `openclaw reverse status` | Show plugin runtime status |
| `openclaw reverse agents` | List configured agents |
| `openclaw reverse sessions --agent ...` | List sessions for one agent |
| `openclaw reverse checkpoints --agent ... --session ...` | List checkpoints for a session |
| `openclaw reverse checkpoint --checkpoint ...` | Inspect one checkpoint by id |
| `openclaw reverse rollback-status --agent ... --session ...` | Show rollback state for a session |
| `openclaw reverse rollback ...` | Rewind a session to a checkpoint |
| `openclaw reverse continue ... --prompt ...` | Create a child agent, workspace, and session from a checkpoint |
| `openclaw reverse nodes --agent ... --session ...` | List checkpoint-backed entries that support checkout |
| `openclaw reverse tree ...` | Display checkpoint lineage as a tree |
| `openclaw reverse checkout ...` | Create a new session from a checkpoint-backed entry |
| `openclaw reverse report --rollback ...` | Inspect a rollback report |
| `openclaw reverse branch --branch ...` | Inspect a saved branch record |

## Guardrails

- Prefer `continue` over `rollback` when the user wants to preserve the parent line untouched.
- Prefer `rollback` when the user wants the current line moved back to an earlier checkpoint.
- Ask before using `--restore-workspace` if the user has not clearly requested live file restoration.
- If no checkpoints appear, explain that ClawReverse only records checkpoints before mutating tools or mutating shell commands. Read-only operations such as `read`, `glob`, `ls`, `git status`, `find`, `cat`, `grep`, `diff`, `tree`, and similar commands are intentionally skipped.
- Use `--json` for programmatic parsing or when you want to feed results into another tool.
- From `{baseDir}`, `npm test` runs the repository test suite.

## Troubleshooting

### `openclaw reverse` is missing

- re-run `openclaw plugins install -l "{baseDir}"`
- run `openclaw reverse setup`
- restart the Gateway
- check that `clawreverse` is in `plugins.allow`
- check that `plugins.entries.clawreverse.enabled` is `true`

### `continue` fails

- make sure `--prompt` is non-empty
- if an agent id conflict occurs, retry with `--new-agent <fresh-id>`
- if you used `--log`, inspect the returned `logFilePath`

### `rollback` did not change files

That is expected unless `--restore-workspace` was used.

### `tree` or `checkpoints` shows nothing

- confirm the agent id and session id are correct
- confirm the session has mutating tool calls that could create checkpoints
