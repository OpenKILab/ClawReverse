# SecureStepClaw

Safe checkpointing, rollback, and clean branching for OpenClaw sessions.

## Pain Points

When an agent has already made several state-changing tool calls, going back safely or trying a different path can get messy fast. SecureStepClaw gives you a clean way to inspect history, recover a known-good point, and branch without contaminating the parent run.

- An agent has already changed the workspace through multiple tool calls and it is hard to safely go back.
- A user wants to branch from a historical point without polluting the parent agent, workspace, or session.
- Historical file state and transcript lineage are hard to inspect and reproduce.
- First-time users need a fast path, not a long document.

## What SecureStepClaw Does

SecureStepClaw is an OpenClaw `step-rollback` plugin that:

- automatically creates checkpoints before state-changing tool calls
- lets you inspect checkpoint history for an agent/session
- lets you rollback a source session to a chosen checkpoint
- lets you continue from a checkpoint into a new child agent, workspace, and session

Read-only calls are skipped, so checkpoint history stays focused on meaningful state changes.

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

### Minimal config

Fastest path:

```bash
openclaw steprollback setup
```

If you prefer to edit `openclaw.json` yourself, this is the minimum useful plugin entry:

```json
{
  "plugins": {
    "allow": ["step-rollback"],
    "enabled": true,
    "entries": {
      "step-rollback": {
        "enabled": true,
        "config": {
          "workspaceRoots": ["~/.openclaw/workspace"]
        }
      }
    }
  }
}
```

Other plugin paths default under `~/.openclaw/plugins/step-rollback/`.

### Verify installation

Restart Gateway after install or config changes, then verify that the plugin is visible:

```bash
openclaw steprollback --help
```

If the command is missing, make sure `openclaw.json` still passes validation and `step-rollback` is allowed.

### One minimal happy-path example

1. Run your agent normally and let it make state-changing tool calls.
2. Inspect checkpoints for the session.
3. Continue from a checkpoint into a clean child branch.

```bash
openclaw steprollback checkpoints --agent <agent-id> --session <session-id>

openclaw steprollback continue \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "Continue from this point with a different approach."
```

If you want to rewind the parent session instead of creating a child branch, use `rollback` with the same `--agent`, `--session`, and `--checkpoint` values.

## Where to Learn More

- `openclaw steprollback --help` for the current CLI surface and flags
- [PRD](./docs/PRD.md)
- [PRD.zh-CN](./docs/PRD.zh-CN.md)

## Verification / Tests

From the repo root:

```bash
npm test
```
