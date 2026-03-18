# PRD: SecureStepClaw / Step Rollback

## 1. Document Info

- Document name: `SecureStepClaw Product Requirements Document`
- Version: `v1.1`
- Language: `English`
- Plugin ID: `step-rollback`
- CLI namespace: `openclaw steprollback ...`
- Target form: `OpenClaw Native Plugin`

## 2. Background and Problem

OpenClaw already has the basic runtime building blocks for agents, workspaces, and sessions. What it still lacks is a clear, stable, recoverable, and forkable history management model.

Users run into several common problems:

- An agent has already executed multiple tool calls and changed the workspace, but the user cannot easily return to a stable historical point.
- A user wants to explore a different direction from a historical state without polluting the current agent.
- A user wants to freeze "historical file state + corresponding session history" into a reproducible branch that can keep evolving independently.

This plugin is meant to fill that gap:

- Only create checkpoint snapshots during state-changing tool calls.
- Only create a brand-new workspace, brand-new agent, and brand-new session when the user explicitly decides to continue from a checkpoint.
- Keep lineage between the parent agent and the child agent explicit and queryable.

## 3. Core Semantics

### 3.1 A checkpoint only captures state

A checkpoint has exactly one job: record a recoverable historical state.

At minimum, a checkpoint contains:

- a workspace snapshot
- a transcript prefix
- lineage metadata

Creating a checkpoint must not:

- create a new workspace
- create a new agent
- create a new session
- change the logical identity of the parent agent

### 3.2 Tool calls create checkpoints automatically

Whenever the agent executes a state-changing tool call, the plugin should create a checkpoint automatically.

Read-only tools should be filtered out. For example:

- `read` should not create a checkpoint
- clearly read-only shell commands such as `ls`, `find`, or `git status` should not create checkpoints

This automatic path is the primary path, so users do not need to create manual snapshots before every tool invocation.

### 3.3 Rollback only restores in place

`rollback` is responsible for restoring the source session / source workspace to the chosen checkpoint so the user can:

- inspect a historical state
- review a failure point
- pause at a previous state for analysis

`rollback` does not:

- create a new agent
- create a new workspace
- create a new session

### 3.4 Continue is the only fork operation

Only `continue` performs the real "keep evolving from here" operation.

`continue` must obey all of the following:

- it must explicitly target a checkpoint
- it must explicitly require `--prompt`
- it must create a new workspace
- it must create a new agent
- it must create a new session

The new branch is built as follows:

- new workspace: materialized from the checkpoint file snapshot
- new agent: copied from a whitelist of parent agent configuration, without reusing the parent agentDir
- new session: rebuilt from the checkpoint transcript prefix, using a new session name / id
- new prompt: appended as the next user input in the new session
- child execution: resumed through the standard `openclaw agent --agent <child-agent> --session-id <child-session> --message "..."` flow once the child session exists

The agent-config whitelist for `continue` must stay schema-safe:

- allow: `model`, `params`, `identity`, `groupChat`, `sandbox`, `runtime`, `tools`, `heartbeat`, and `subagents.allowAgents`
- do not copy: `models`, `compaction`, `maxConcurrent`, `workspaceRoot`, `cwd`, `root`, or unsupported `subagents.*` keys

### 3.5 Continue must not pollute the parent agent

`continue` must not modify any of the following on the parent side:

- parent workspace
- parent session store
- parent agentDir
- parent bindings
- parent runtime locks / cursor / counters

Continue is a fork, not an in-place resume of the parent agent.

## 4. Product Goals

### 4.1 P0 Goals

P0 must provide:

- automatic checkpoints on state-changing tool calls
- checkpoint list and detail queries
- rollback to a chosen checkpoint
- rollback status queries
- continue that forks a new workspace / new agent / new session from a checkpoint
- agent / session inspection commands
- checkpoint-backed node / checkout / report / branch commands
- a root `openclaw steprollback --help` overview plus `--json` on commands that declare it

### 4.2 P1 Goals

- stronger retention / prune policies
- better lineage visualization
- better support for group / topic / custom sessions
- better support for sandbox workspaces
- richer diagnostics and metrics

## 5. Non-Goals

P0 does not include:

- cross-machine checkpoint synchronization
- capturing database, remote API, or external side effects
- modifying the user's real project Git history
- copying bindings by default
- reusing the source agentDir
- running continue without a prompt

## 6. CLI Overview

### 6.1 Core Commands

| Command | Type | Semantics |
| --- | --- | --- |
| `openclaw steprollback --help` | Read | Show an overview of all registered commands and flags |
| `openclaw steprollback setup` | Write | Initialize plugin directories and config |
| `openclaw steprollback status` | Read | Show plugin state and runtime flags |
| `openclaw steprollback agents` | Read | Show agent summaries |
| `openclaw steprollback sessions --agent <agentId>` | Read | Show sessions for an agent |
| `openclaw steprollback checkpoints --agent <agentId> --session <sessionId>` | Read | Show checkpoint list for a session |
| `openclaw steprollback checkpoint --checkpoint <checkpointId>` | Read | Show one checkpoint in detail |
| `openclaw steprollback rollback --agent <agentId> --session <sessionId> --checkpoint <checkpointId>` | Write | Restore the source session / workspace in place |
| `openclaw steprollback rollback-status --agent <agentId> --session <sessionId>` | Read | Show rollback state |
| `openclaw steprollback continue --agent <agentId> --session <sessionId> --checkpoint <checkpointId> --prompt \"...\" [--new-agent <agentId>] [--clone-auth <mode>] [--log]` | Write | Fork a new workspace / new agent / new session from a checkpoint |
| `openclaw steprollback nodes --agent <agentId> --session <sessionId>` | Read | List checkpoint-backed nodes that can be checked out |
| `openclaw steprollback checkout --agent <agentId> --source-session <sessionId> --entry <entryId> [--continue] [--prompt \"...\"]` | Write | Create a new session from a checkpoint-backed entry |
| `openclaw steprollback report --rollback <rollbackId>` | Read | Show a rollback report |
| `openclaw steprollback branch --branch <branchId>` | Read | Show a checkout branch record |

### 6.2 Auxiliary Commands

The following commands are auxiliary to the main checkpoint -> continue flow and must not redefine the main product semantics:

- `nodes`
- `checkout`
- `branch`
- `report`

They must not replace the primary path:

- state-changing tool call -> automatic checkpoint
- continue -> prompt-required fork into a new agent

## 7. User Flows

### 7.1 Main flow: checkpoint -> continue

1. The user runs the parent agent normally.
2. The plugin automatically creates a checkpoint before each state-changing tool call.
3. The user selects a historical checkpoint from `checkpoints`.
4. The user runs:

```bash
openclaw steprollback continue \
  --agent <parent-agent> \
  --session <parent-session> \
  --checkpoint <checkpoint-id> \
  --prompt "..."
```

5. The plugin creates:
   - a new workspace
   - a new agent
   - a new session
6. The plugin rebuilds the child transcript prefix and then resumes the child through the standard `openclaw agent` message path.

### 7.2 Auxiliary flow: rollback

1. The user chooses a checkpoint.
2. The user runs `rollback`.
3. The source session / source workspace is restored in place.
4. The user inspects, compares, or analyzes the historical state.

Rollback is not a fork operation.

## 8. Detailed CLI Requirements

### 8.1 Common Rules

All commands follow:

```bash
openclaw steprollback <command> [flags]
```

Common requirements:

- `openclaw steprollback --help` must show an overview of all registered subcommands and flags
- `openclaw steprollback <command> --help` remains the command-specific help path
- most commands default to human-readable tables or field/value output
- `status` currently returns pretty-printed JSON directly without a separate `--json` flag
- commands that declare `--json` must support it
- stable error codes for all write commands
- atomic or cleanable failure behavior for all write commands
- plugin commands only appear after `openclaw.json` passes current schema validation
- all path resolution must respect:
  - `OPENCLAW_HOME`
  - `OPENCLAW_STATE_DIR`
  - `OPENCLAW_CONFIG_PATH`

### 8.2 `status`

Purpose:

- show whether the plugin is enabled
- show whether the runtime is gateway-mode-only
- show whether continue prompts are allowed

Command:

```bash
openclaw steprollback status
```

Suggested output fields:

- `pluginId`
- `enabled`
- `gatewayModeOnly`
- `allowContinuePrompt`

### 8.3 `setup`

Purpose:

- initialize plugin state directories
- patch the plugin entry into `openclaw.json`

Command:

```bash
openclaw steprollback setup [--base-dir <path>] [--dry-run] [--json]
```

Behavior:

- create default directories
- write `plugins.entries.step-rollback`
- return `restartRequired`

### 8.5 `agents`

Command:

```bash
openclaw steprollback agents [--json]
```

Purpose:

- list manageable agents
- show summary lineage information for parent / child relationships

Suggested output fields:

- `agentId`
- `workspacePath`
- `agentDir`
- `sessionCount`
- `checkpointCount`
- `derivedFrom`

### 8.6 `sessions`

Command:

```bash
openclaw steprollback sessions --agent <agentId> [--json]
```

Purpose:

- show sessions under the target agent

Suggested output fields:

- `sessionId`
- `sessionKey`
- `updatedAt`
- `checkpointCount`
- `latestCheckpointId`

### 8.7 `checkpoints`

Command:

```bash
openclaw steprollback checkpoints --agent <agentId> --session <sessionId> [--json]
```

Purpose:

- list checkpoints for a session

Suggested output fields:

- `checkpointId`
- `entryId`
- `turnIndex`
- `gitCommit`
- `createdAt`
- `workspaceDigest`
- `summary`

### 8.8 `checkpoint`

Command:

```bash
openclaw steprollback checkpoint --checkpoint <checkpointId> [--json]
```

Purpose:

- show one checkpoint in detail

Suggested output fields:

- `checkpointId`
- `sourceAgentId`
- `sourceSessionId`
- `entryId`
- `turnIndex`
- `gitCommit`
- `workspaceDigest`
- `lineage`

### 8.9 `rollback`

Command:

```bash
openclaw steprollback rollback \
  --agent <agentId> \
  --session <sessionId> \
  --checkpoint <checkpointId> \
  [--json]
```

Purpose:

- restore the source workspace / source session in place

Strict constraints:

- no new workspace is created
- no new agent is created
- no new session is created

Suggested output fields:

- `ok`
- `agentId`
- `sessionId`
- `checkpointId`
- `rollbackId`

### 8.10 `rollback-status`

Command:

```bash
openclaw steprollback rollback-status --agent <agentId> --session <sessionId> [--json]
```

Purpose:

- show whether the source session is currently in a post-rollback state

Suggested output fields:

- `rollbackInProgress`
- `awaitingContinue`
- `lastRollbackCheckpointId`

### 8.11 `continue`

Command:

```bash
openclaw steprollback continue \
  --agent <parent-agent> \
  --session <parent-session> \
  --checkpoint <checkpointId|latest> \
  --prompt "..." \
  [--new-agent <new-agent-id>] \
  [--clone-auth auto|always|never] \
  [--log] \
  [--json]
```

Purpose:

- fork a new child agent from a checkpoint

Hard constraints:

- `--prompt` is required
- continue without a prompt is not allowed
- continue must not mutate the parent agent

Core behavior:

1. Resolve the checkpoint.
2. Generate a new `agentId`.
3. Create a new workspace:
   - materialize from the checkpoint snapshot
   - do not reuse the parent workspace
4. Create a new agentDir:
   - copy a whitelist of required parent configuration
   - do not reuse the parent agentDir
   - do not copy bindings
   - keep the copied agent entry within the current OpenClaw schema
5. Create a new session:
   - assign a new `sessionId` / `sessionKey`
   - rebuild the transcript from the checkpoint prefix
   - append the new prompt as the next input
6. Resume the child through the standard `openclaw agent` message flow using the new `agentId` and `sessionId`.
7. Return child agent / workspace / session information.

Suggested output fields:

- `ok`
- `parentAgentId`
- `newAgentId`
- `newWorkspacePath`
- `newSessionId`
- `newSessionKey`
- `checkpointId`

Failure cases must include at least:

- `ERR_CHECKPOINT_NOT_FOUND`
- `ERR_PROMPT_REQUIRED`
- `ERR_AGENT_ALREADY_EXISTS`
- `ERR_WORKSPACE_MATERIALIZE_FAILED`
- `ERR_AGENTDIR_CLONE_FAILED`
- `ERR_SESSION_REBUILD_FAILED`
- `ERR_CONFIG_WRITE_FAILED`

### 8.12 `nodes`

Command:

```bash
openclaw steprollback nodes --agent <agentId> --session <sessionId> [--json]
```

Purpose:

- list checkpoint-backed nodes that can be used with `checkout`

Suggested output fields:

- `entryId`
- `nodeIndex`
- `toolName`
- `checkoutAvailable`
- `createdAt`

### 8.13 `checkout`

Command:

```bash
openclaw steprollback checkout \
  --agent <agentId> \
  --source-session <sessionId> \
  --entry <entryId> \
  [--continue] \
  [--prompt "..."] \
  [--json]
```

Purpose:

- create a new session from a checkpoint-backed entry
- optionally continue immediately when `--continue` is provided

Suggested output fields:

- `branchId`
- `newSessionId`
- `newSessionKey`
- `continued`
- `usedPrompt`

### 8.14 `report`

Command:

```bash
openclaw steprollback report --rollback <rollbackId> [--json]
```

Purpose:

- show one rollback report by id

Suggested output fields:

- `rollbackId`
- `result`
- `message`
- `checkpointId`
- `createdAt`

### 8.15 `branch`

Command:

```bash
openclaw steprollback branch --branch <branchId> [--json]
```

Purpose:

- show one checkout branch record by id

Suggested output fields:

- `branchId`
- `sourceAgentId`
- `sourceSessionId`
- `sourceEntryId`
- `newSessionId`
- `createdAt`

## 9. Data Models

### 9.1 CheckpointRecord

```json
{
  "checkpointId": "cp_000123",
  "sourceAgentId": "main",
  "sourceSessionId": "sess_abc",
  "sourceSessionKey": "agent:main:main",
  "entryId": "entry_42_assistant",
  "turnIndex": 42,
  "gitCommit": "7f9d1c2",
  "workspaceDigest": "sha256:...",
  "createdAt": "2026-03-17T09:30:00Z",
  "lineage": {
    "parentCheckpointId": "cp_000122"
  }
}
```

### 9.2 AgentForkRecord

```json
{
  "parentAgentId": "main",
  "parentSessionId": "sess_abc",
  "checkpointId": "cp_000123",
  "newAgentId": "main-cp-a1b2",
  "newWorkspacePath": "...",
  "newSessionId": "sess_new",
  "newSessionKey": "agent:main-cp-a1b2:main",
  "createdAt": "2026-03-17T09:31:00Z"
}
```

### 9.3 RollbackStatus

```json
{
  "agentId": "main",
  "sessionId": "sess_abc",
  "rollbackInProgress": false,
  "awaitingContinue": false,
  "lastRollbackCheckpointId": "cp_000123"
}
```

## 10. Storage Layout

Recommended default root:

```text
${OPENCLAW_STATE_DIR:-~/.openclaw}/plugins/step-rollback/
```

Directory layout:

```text
step-rollback/
  checkpoints/
  registry/
  runtime/
  reports/
  _git/
```

Requirements:

- checkpoint data and fork records must be searchable
- Git shadow snapshots must remain isolated from the user's real repository

## 11. State Machines

### 11.1 Checkpoint

```text
tool call detected
  -> create snapshot
  -> persist metadata
  -> ready
```

### 11.2 Rollback

```text
checkpoint selected
  -> restore source workspace
  -> restore source runtime state
  -> rollback ready
```

### 11.3 Continue

```text
checkpoint selected
  -> validate prompt
  -> create new workspace
  -> create new agent
  -> create new session
  -> append prompt
  -> child agent ready
```

## 12. Consistency Rules

- a checkpoint is a historical snapshot, not a branch entity
- continue is the branch operation
- rollback must not secretly create a new agent
- continue must not secretly mutate the parent agent
- a new agent must never reuse the parent agentDir
- a new session must always use a new session name / id
- checkpoint transcript data must be a closed prefix, never an arbitrary text truncation

## 13. Security and Privacy

- the plugin is high-trust code and should only be installed from trusted sources
- default directories should use minimum necessary permissions
- tokens, secrets, and auth profile contents must not appear in logs or CLI output
- `clone-auth` must follow a minimum-copy strategy
- bindings are not copied by default

## 14. Success Metrics

- automatic checkpoints on state-changing tool calls succeed at a high stable rate
- checkpoint queries remain fast
- continue succeeds at creating child agents at a high stable rate
- continue causes zero damage to the parent agent
- lineage across new workspace / new agent / new session is traceable

## 15. Acceptance Criteria

- state-changing tool calls automatically create checkpoints, while read-only calls do not create checkpoints or new agents
- `openclaw steprollback --help` shows the registered command and flag overview
- `checkpoints` shows automatically created checkpoints
- `rollback` only restores the source side and does not create forks
- `continue` without `--prompt` must fail
- `continue --prompt "..."` creates:
  - a new workspace
  - a new agent
  - a new session
- the child agent inherits only the necessary parent configuration and does not reuse `agentDir`
- the child session contains only the checkpoint transcript prefix plus the new prompt
- the parent agent / parent workspace / parent session are not polluted by continue
- all write commands support `--json`
- all failure cases return stable error codes
