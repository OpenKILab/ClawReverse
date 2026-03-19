# ClawReverse

Checkpoint, roll back, and branch OpenClaw sessions safely with `openclaw reverse`.

ClawReverse is an OpenClaw native plugin that adds the `openclaw reverse` command for saving checkpoints, restoring a clean workspace state, and continuing from useful progress instead of starting over.

## User Scenarios

ClawReverse is designed for two common task execution scenarios, helping you manage work efficiently and avoid unnecessary repetition:

1. During task execution, files in the workspace are accidentally deleted or modified, which leaves the environment messy and hard to control. You need a fast way to restore it to a clean, manageable starting state.
2. You do not need to rerun the entire task. Some useful results already exist, and you want to continue directly from that progress, cutting down repeated steps and saving token cost.

## What ClawReverse Does

ClawReverse helps you recover control of the workspace without throwing away useful progress.

- Save checkpoints as the task moves forward.
- Roll back to an earlier clean state after unwanted file changes.
- Continue from existing partial results instead of restarting from scratch.
- Reduce repeated work and token usage by reusing what is already correct.

## Core Concepts

### `checkpoint`

A checkpoint is a saved historical boundary: workspace snapshot, closed transcript prefix, and lineage metadata. It captures state; it does not create a branch.

### `rollback`

`rollback` rewinds the source side to a checkpoint. It does not create a new workspace, agent, or session. By default it leaves the parent workspace untouched unless you explicitly request an in-place restore.

### `continue`

`continue` is the fork operation. It requires `--prompt` and creates a new child agent, a new workspace, and a new session from the selected checkpoint, without polluting the parent.

## Quick Start

### Prerequisites

- Node.js 24+
- A working OpenClaw installation with a valid `openclaw.json`
- Access to the machine that runs OpenClaw

### Install

```bash
openclaw plugins install -l <path-to-repo>
```

Use `openclaw plugins install <path-to-repo>` if you want a copied install instead of a linked one.

The plugin key in `openclaw.json` is `clawreverse`, and its CLI base command is `openclaw reverse`.

### Minimal config

Fastest path:

```bash
openclaw reverse setup
```

If you prefer to edit `openclaw.json` yourself, this is the minimum useful plugin entry:

```json
{
  "plugins": {
    "allow": ["clawreverse"],
    "enabled": true,
    "entries": {
      "clawreverse": {
        "enabled": true,
        "config": {
          "workspaceRoots": ["~/.openclaw/workspace"]
        }
      }
    }
  }
}
```

Other plugin paths default under `~/.openclaw/plugins/clawreverse/`.

### Verify installation

Restart Gateway after install or config changes, then verify that the plugin is visible:

```bash
openclaw reverse --help
```

If the command is missing, make sure `openclaw.json` still passes validation and `clawreverse` is allowed.

### One minimal happy-path example

1. Run your agent normally and let it make state-changing tool calls.
2. Inspect checkpoints for the session.
3. Continue from a checkpoint into a clean child branch.

```bash
openclaw reverse checkpoints --agent <agent-id> --session <session-id>

openclaw reverse continue \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "Continue from this point with a different approach."
```

If you want to rewind the parent session instead of creating a child branch, use `rollback` with the same `--agent`, `--session`, and `--checkpoint` values.

### Inspect the checkpoint tree

Use `openclaw reverse tree` to see checkpoint lineage across the parent session and any child branches created with `continue`.

```bash
openclaw reverse tree --agent <agent-id> --session <session-id>
```

This is useful when you want to answer questions like:

- which checkpoint is the root of this view
- where the session continued into a child branch
- how many nodes, sessions, and branches are involved

If you want to focus on one checkpoint as the tree root, pass `--node` (or `--checkpoint` as an alias):

```bash
openclaw reverse tree \
  --agent <agent-id> \
  --session <session-id> \
  --node <checkpoint-id>
```

Add `--json` if you want raw structured output.

## Verification / Tests

From the repo root:

```bash
npm test
```

## Contact

For questions or collaboration, please contact:

- [wangxuhong@pjlab.org.cn](mailto:wangxuhong@pjlab.org.cn)
- [huangbin@pjlab.org.cn](mailto:huangbin@pjlab.org.cn)
