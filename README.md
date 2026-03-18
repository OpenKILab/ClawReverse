# SecureStepClaw

Chinese version: [`README.zh-CN.md`](./README.zh-CN.md)

`SecureStepClaw` is an OpenClaw `step-rollback` Native Plugin project. Its intended command semantics are:

- only state-changing tool calls should create checkpoints; read-only calls should be skipped
- `rollback` keeps the parent workspace untouched by default and only restores it in place when explicitly requested
- `continue` must require `--prompt` and must create a new session from a checkpoint, reusing the latest child agent by default or creating a fresh child agent/workspace when requested

## Current note

This repository already includes:

- the plugin manifest: [openclaw.plugin.json](./openclaw.plugin.json)
- the native entry: [dist/index.js](./dist/index.js)
- native registration: [dist/native-plugin.js](./dist/native-plugin.js)
- the core engine: [dist/plugin.js](./dist/plugin.js)
- service modules: [dist/services/](./dist/services)
- tests: [tests/plugin.test.js](./tests/plugin.test.js)

Important note:

- This README now documents the intended product contract.
- The repository already contains working checkpoint, rollback, and continue foundations, but some runtime details may still be in the process of being aligned to this contract.
- So the documentation is deliberately describing the target semantics, not claiming that every current implementation detail is already perfectly aligned.

## Core semantics

### Checkpoint

A checkpoint only captures state. It does not create a branch.

Each checkpoint should correspond to at least:

- a workspace snapshot
- a closed transcript prefix
- lineage metadata

When a state-changing tool call happens, the plugin should create a checkpoint automatically, but it should not create a new workspace, a new agent, or a new session.

Read-only tools such as `read`, and read-only shell commands such as `ls`, `find`, or `git status`, should not create checkpoints.

### Rollback

`rollback` rewinds the source session to a chosen checkpoint.

By default it must not rewrite the parent workspace.

If the caller explicitly requests an in-place restore, `rollback` may also restore the source workspace to the chosen checkpoint.

`rollback` must not:

- create a new workspace
- create a new agent
- create a new session

### Continue

`continue` is the only fork operation.

Its semantics are fixed:

- `--prompt` is required
- a checkpoint must be selected
- a new child agent and workspace must be created every time
- a new session must be created

The continued branch is built from:

- target workspace: materialized from checkpoint file snapshots
- target agent: a newly created child copied from the necessary parent agent configuration
- new session: rebuilt from the checkpoint session history prefix with a new session name / id
- new prompt: appended as the next input in the child session
- child execution: resumed through the standard `openclaw agent --agent <child-agent> --session-id <child-session> --message "..."` flow once the checkpoint prefix is restored

Continue must not pollute the parent agent.

## Installation

### 1. Prerequisites

You need:

1. Node.js 24+
2. an OpenClaw installation whose `openclaw.json` passes current schema validation
3. access to the machine that actually runs OpenClaw

### 2. Install the plugin

For development, prefer a linked install:

```bash
openclaw plugins install -l /Users/bin-mac/CodeX/SecureStepClaw
```

For a copied install:

```bash
openclaw plugins install /Users/bin-mac/CodeX/SecureStepClaw
```

### 3. Verify the installation

```bash
openclaw plugins list
openclaw plugins info step-rollback
openclaw plugins doctor
```

### 4. Configure the plugin

Example:

```json
{
  "plugins": {
    "allow": ["step-rollback"],
    "enabled": true,
    "entries": {
      "step-rollback": {
        "enabled": true,
        "config": {
          "enabled": true,
          "workspaceRoots": [
            "~/.openclaw/workspace"
          ],
          "checkpointDir": "~/.openclaw/plugins/step-rollback/checkpoints",
          "registryDir": "~/.openclaw/plugins/step-rollback/registry",
          "runtimeDir": "~/.openclaw/plugins/step-rollback/runtime",
          "reportsDir": "~/.openclaw/plugins/step-rollback/reports",
          "maxCheckpointsPerSession": 100,
          "allowContinuePrompt": true,
          "stopRunBeforeRollback": true
        }
      }
    }
  }
}
```

Restart Gateway after config changes.

Important config note:

- OpenClaw will hide plugin commands such as `openclaw steprollback ...` until `openclaw.json` validates successfully.
- If validation reports stale forked-agent keys such as `models`, `compaction`, `maxConcurrent`, `workspaceRoot`, `cwd`, `root`, or `subagents.maxConcurrent` under `agents.list[]`, repair them before retrying.
- Keep only current per-agent fields under `agents.list[]`: `model`, `params`, `identity`, `groupChat`, `sandbox`, `runtime`, `tools`, `heartbeat`, and `subagents.allowAgents`.
- Move defaults-only fields such as `models`, `compaction`, and `maxConcurrent` back under `agents.defaults`.
- Normalize old workspace aliases such as `workspaceRoot`, `cwd`, and `root` to `workspace`.

## Primary commands

Print the full Step Rollback CLI overview:

```bash
openclaw steprollback --help
```

### Read commands

```bash
openclaw steprollback status
openclaw steprollback agents
openclaw steprollback sessions --agent <agentId>
openclaw steprollback checkpoints --agent <agentId> --session <sessionId>
openclaw steprollback checkpoint --checkpoint <checkpointId>
openclaw steprollback rollback-status --agent <agentId> --session <sessionId>
openclaw steprollback nodes --agent <agentId> --session <sessionId>
openclaw steprollback report --rollback <rollbackId>
openclaw steprollback branch --branch <branchId>
```

### Write commands

```bash
openclaw steprollback setup
openclaw steprollback rollback --agent <agentId> --session <sessionId> --checkpoint <checkpointId> [--restore-workspace]
openclaw steprollback continue --agent <agentId> --session <sessionId> --checkpoint <checkpointId> --prompt "..." [--new-agent <agentId>] [--clone-auth <mode>] [--log]
openclaw steprollback checkout --agent <agentId> --source-session <sessionId> --entry <entryId> [--continue] [--prompt "..."]
```

## Main workflow

### 1. Run the parent agent normally

Let the agent execute tool calls. The plugin should automatically create a checkpoint before each state-changing tool call.

### 2. Inspect agents and sessions

```bash
openclaw steprollback agents
openclaw steprollback sessions --agent main
```

### 3. Inspect checkpoints

```bash
openclaw steprollback checkpoints --agent main --session <session-id>
openclaw steprollback checkpoint --checkpoint <checkpoint-id>
```

If you do not see checkpoints yet, check these first:

- the session was created after the latest Gateway / plugin restart
- the session actually executed tool calls
- `plugins.allow` includes `step-rollback`

### 4. Optional: rollback for in-place restore

By default, `rollback` only moves the plugin/runtime cursor back to the checkpoint. It does not rewrite the parent workspace unless you ask for that explicitly.

Rollback without touching the parent workspace:

```bash
openclaw steprollback rollback \
  --agent main \
  --session <session-id> \
  --checkpoint <checkpoint-id>
```

Rollback and also restore the parent workspace in place:

```bash
openclaw steprollback rollback \
  --agent main \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --restore-workspace
```

Then inspect status:

```bash
openclaw steprollback rollback-status --agent main --session <session-id>
```

Important: rollback only restores the source side. It does not create a child agent.

### 5. Continue to fork a new agent

`continue` always creates a new child agent, a new workspace, and a new session from the checkpoint.

Agent selection works like this:

- a fresh child agent/workspace is always created
- `--new-agent <agentId>` lets you name the fresh child agent when creating one

Continue using the default child naming:

```bash
openclaw steprollback continue \
  --agent main \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "Continue from this historical point, but try a different approach."
```

Continue and explicitly name the new child agent:

```bash
openclaw steprollback continue \
  --agent main \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "Continue from this historical point in a brand new child." \
  --new-agent main-cp-0004
```

If a child launch looks suspicious or appears to stall, rerun with `--log`. The plugin will print extra launch diagnostics and return a `logFilePath` pointing at the captured child process log under the runtime directory.

This command should always create:

- a new session
- a new workspace
- a new agent

and return fields such as:

```json
{
  "ok": true,
  "parentAgentId": "main",
  "newAgentId": "main-cp-a1b2",
  "newWorkspacePath": "...",
  "newSessionId": "...",
  "newSessionKey": "...",
  "checkpointId": "cp_000123"
}
```

Important:

- `--prompt` is required for continue
- continue is a fork operation, not an in-place resume of the parent agent
- after the child workspace and child session are rebuilt, the plugin should resume the child through the standard `openclaw agent` message path

## Other inspection and checkout commands

These commands are useful around the main checkpoint -> rollback / continue workflow:

```bash
openclaw steprollback nodes --agent main --session <session-id>
openclaw steprollback checkout --agent main --source-session <session-id> --entry <entry-id>
openclaw steprollback checkout --agent main --source-session <session-id> --entry <entry-id> --continue --prompt "Continue from this entry."
openclaw steprollback report --rollback <rollback-id>
openclaw steprollback branch --branch <branch-id>
```

## What continue copies

When continue creates a child agent, it should copy only the necessary parent configuration, for example:

- `model`
- `params`
- `identity`
- `groupChat`
- `sandbox`
- `runtime`
- `tools`
- `heartbeat`
- `subagents.allowAgents`

It should not copy:

- the parent `agentDir`
- the parent session store
- the parent bindings
- parent runtime locks / cursor / counters
- defaults-only fields such as `models`, `compaction`, and `maxConcurrent`
- legacy workspace aliases such as `workspaceRoot`, `cwd`, and `root`
- unsupported subagent fields outside `subagents.allowAgents`

## Storage

By default, plugin state lives under:

- `~/.openclaw/plugins/step-rollback/checkpoints`
- `~/.openclaw/plugins/step-rollback/registry`
- `~/.openclaw/plugins/step-rollback/runtime`
- `~/.openclaw/plugins/step-rollback/reports`

Git shadow snapshots must remain isolated from the user's real project repository.

## Current code status

The repository currently provides:

- automatic checkpoints on state-changing tool calls
- checkpoint queries
- rollback for source-side restore
- continue / branching through fresh child agents and sessions
- checkpoint-backed node listing, checkout, rollback reports, and branch inspection

The native bridge now prefers the documented `openclaw agent --message` continuation path and treats lower-level runtime or Gateway helpers as fallback compatibility paths.

## Verification

Run from the repo root:

```bash
npm test
```
