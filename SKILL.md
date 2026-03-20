---
name: clawreverse
description: "Checkpoint, restore, and branch OpenClaw sessions without throwing away useful progress."
---

# ClawReverse Skill Instructions

You are equipped with the **ClawReverse** skill. ClawReverse is an OpenClaw native plugin that adds the `openclaw reverse` CLI command. It allows you to manage session checkpoints, recover a clean workspace state, branch safely for experiments, and undo mistakes without rerunning everything from scratch.

## 🎯 When to Use This Skill
Use this skill when the user asks you to:
- "Undo" a mistake, revert the workspace, or roll back to a previous state.
- "Branch", "fork", or "continue" from an earlier step to try a different approach.
- View the history, checkpoints, or lineage tree of the current session or agent.

## 🛠️ Required Workflow (CRITICAL)
To perform a rollback, continue, or view a tree, you MUST know the `agent-id`, `session-id`, and `checkpoint-id`. You cannot guess these IDs. Always follow this 3-step lookup process if the IDs are not already known:

### Step 1: Find the Agent ID
**Command:** `openclaw reverse agents --json`
**Action:** Identify the target `<agent-id>` from the JSON output.

### Step 2: Find the Session ID
**Command:** `openclaw reverse sessions --agent <agent-id> --json`
**Action:** Identify the target `<session-id>`. Usually, the row marked `latest` is the most recent session for that agent.

### Step 3: Find the Checkpoint ID
**Command:** `openclaw reverse checkpoints --agent <agent-id> --session <session-id>`
**Action:** Find the specific `<checkpoint-id>` (e.g., `ckpt_0001`) that represents the exact state you need to return to or branch from.

---

## 🚀 Core Actions & Commands
Once you have the required IDs, execute ONE of the following commands based on the user's request:

### 1. Rollback (Rewind the current line)
Use this to rewind the current timeline back to an earlier clean point. It does NOT create a new workspace or branch.
**Command:** 
`openclaw reverse rollback --agent <agent-id> --session <session-id> --checkpoint <checkpoint-id>`

### 2. Continue (Branch safely)
Use this to fork from a checkpoint. It creates a new child agent, a new workspace, and a new session, leaving the parent untouched.
**Command:** 
`openclaw reverse continue --agent <agent-id> --session <session-id> --checkpoint <checkpoint-id> --prompt "<user_instructions_for_the_new_branch>"`

### 3. Inspect Branch Lineage (Tree)
Use this to see which checkpoint is the root, where a child branch was created, and how many nodes/sessions are involved.
**Command:** 
`openclaw reverse tree --agent <agent-id> --session <session-id>`
*(Optional: Append `--node <checkpoint-id>` to only inspect a specific subtree).*

### 4. Setup / Initialization
If the user asks to configure the plugin, or if a command fails because the workspace roots are not configured, run:
**Command:** `openclaw reverse setup`

## 🧠 Rules & Guardrails
- **Never Hallucinate IDs:** Always look up the exact `agent-id`, `session-id`, and `checkpoint-id` before executing a rollback or continue command.
- **Rollback vs. Continue:** Understand the difference based on the user's prompt. `rollback` modifies the current session's timeline (undo). `continue` forks the state into a brand new child session for an experiment (branch). 
- **JSON Output:** Always use the `--json` flag when running the `agents` and `sessions` commands to make it easier for you to parse the IDs accurately.