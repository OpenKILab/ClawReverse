<p align="center">
  <img src="./clawreverse_logo.jpg" alt="ClawReverse logo" width="320" />
</p>

# ClawReverse

English | [简体中文](README.zh-CN.md)

Checkpoint, restore, and branch OpenClaw sessions without throwing away useful progress.

ClawReverse is an OpenClaw native plugin that adds the `openclaw reverse` command. It helps you work with checkpoints, recover a clean workspace state, and continue from a known-good point instead of rerunning everything from scratch.

## Why use ClawReverse?

ClawReverse is designed to solve real-world friction when working with OpenClaw:

- **The AI made a mess and got stuck:** If OpenClaw generates too many unwanted files or bad code changes and can no longer proceed, you can instantly rewind the workspace to a clean state instead of starting from scratch.
- **Save tokens on long-running tasks:** If OpenClaw perfectly analyzes a massive codebase but fails during the coding step, you don't have to pay it to read everything again. Just branch from the exact moment the analysis finished.

In practice, it helps you:

- recover control of the workspace quickly
- preserve useful progress
- branch safely for experiments
- reduce repeated work and token usage

## Core concepts

Think of the plugin like this:

- `checkpoint`: a saved historical boundary for a session. It records the workspace snapshot, the closed transcript prefix, and lineage metadata.
- `rollback`: rewinds the current line to an earlier checkpoint. It does not create a new workspace, agent, or session. By default, the parent workspace is left untouched unless you explicitly request an in-place restore.
- `continue`: forks from a checkpoint. It requires `--prompt` and creates a new child agent, a new workspace, and a new session, leaving the parent untouched.


## Requirements

- Node.js 24+
- A working OpenClaw installation with a valid `openclaw.json` with the read and write perssion granted

## Install

If you're starting from GitHub, clone the repo first:

```bash
git clone https://github.com/OpenKILab/ClawReverse.git
cd ClawReverse
```

Then install it as a linked plugin:

```bash
openclaw plugins install -l "$(pwd)"
```


The plugin key in `openclaw.json` is `clawreverse`, and its CLI base command is `openclaw reverse`.

## Configure

Fastest path:

```bash
openclaw reverse setup
```

Or edit `openclaw.json` manually:

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

Other plugin paths default to `~/.openclaw/plugins/clawreverse/`.

## Verify

After installation or config changes, restart Gateway and verify that the command is available:

```bash
openclaw reverse --help
```

If the command is missing, make sure:

- `openclaw.json` still passes validation
- `clawreverse` is in `plugins.allow`
- the plugin entry is enabled

## Find `agent id` and `session id`

Before running `checkpoints`, `continue`, or `rollback`, first look up the agent and session you want to operate on.

### 1) List available agents

```bash
openclaw reverse agents
```

Use the value in the `Agent` column as your `agent id`.

### 2) List sessions for one agent

```bash
openclaw reverse sessions --agent <agent-id>
```

Use the value in the `Session` column as your `session id`. The row marked `latest` is the most recent session for that agent.

Add `--json` to either command if you want machine-readable output.

## Common workflows

### 1) List available checkpoints

```bash
openclaw reverse checkpoints --agent <agent-id> --session <session-id>
```

Use this to find the checkpoint you want to restore or branch from.

### 2) Branch safely with `continue`

```bash
openclaw reverse continue \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "Continue from this point with a different approach."
```

Use `continue` when you want a clean child branch without changing the parent session.

### 3) Rewind the current line with `rollback`

```bash
openclaw reverse rollback \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id>
```

Use `rollback` when you want to move the current line back to an earlier clean point instead of creating a child branch.

### 4) Inspect branch lineage with `tree`

```bash
openclaw reverse tree --agent <agent-id> --session <session-id> [--node <checkpoint>]
```

This helps answer questions such as:

- which checkpoint is the root of the current view
- where a child branch was created
- how many nodes, sessions, and branches are involved

For example, suppose the main session created two checkpoints, then you used `continue` from `ckpt_0002` to try a different fix:

```text
Root: ckpt_0001 [main / 5f29223a-6e53-49f9-9200-63766baa7c2f / node 7]
Resolved by: default
Nodes: 5  Sessions: 2  Branches: 1

ckpt_0001 [main / 5f29223a-6e53-49f9-9200-63766baa7c2f / node 7] write - before tool write summary.txt
\- ckpt_0002 [main / 5f29223a-6e53-49f9-9200-63766baa7c2f / node 8] write - before tool write spark.txt
   |- ckpt_0003 [main / 5f29223a-6e53-49f9-9200-63766baa7c2f / node 9] exec - before tool exec delete summary.txt
   \- ckpt_0004 [main-branch / 91c5d557-f94c-4d27-8d7d-0e0d9b4f7d6b / node 1] write - before tool write alternative_summary.txt via continue
      \- ckpt_0005 [main-branch / 91c5d557-f94c-4d27-8d7d-0e0d9b4f7d6b / node 2] exec - before tool exec move alternative_summary.txt archive/alternative_summary.txt
```

You can read this tree like this:

- `ckpt_0001` is the root selected for the current view
- `ckpt_0002 -> ckpt_0003` is the original main line
- `ckpt_0004` starts a child branch from `ckpt_0002`, and `via continue` shows why that edge exists
- the child branch has its own session id, so you can quickly tell the parent and child lines apart

If you only want to inspect one subtree, pass the branch point explicitly:

```bash
openclaw reverse tree --node ckpt_0002
```


## Troubleshooting

### `openclaw reverse` is not available

- Restart Gateway after installing the plugin or editing `openclaw.json`.
- Check that `clawreverse` is listed in `plugins.allow`.
- Check that the plugin entry is enabled and the config still passes validation.


## Test

From the repository root:

```bash
npm test
```

## Roadmap

- [x] PoC of checkpoint snapshots
- [x] Continue tasks with a newly created agent
- [x] Package it as an OpenClaw skill
- [ ] Integrate sandbox support

## Citation

```bibtex
@software{clawreverse2026,
  author       = {Bin Huang, Xuhong Wang, Yingchun Wang, Chaochao Lu, Xia Hu},
  title        = {ClawReverse},
  year         = {2026},
  version      = {0.1.0},
  organization = {Shanghai AI Laboratory},
  url          = {https://github.com/OpenKILab/ClawReverse}
}
```

## Contact

If you have questions or would like to collaborate, please contact us at:

- Bin Huang，Shanghai AI Laboratory，<a href="mailto:huangbin@pjlab.org.cn">huangbin@pjlab.org.cn</a>
- Xuhong Wang ，Shanghai AI Laboratory，<a href="mailto:wangxuhong@pjlab.org.cn">wangxuhong@pjlab.org.cn</a>
