# PRD：SecureStepClaw / Step Rollback

## 1. 文档信息

- 文档名：`SecureStepClaw Product Requirements Document`
- 版本：`v1.1`
- 文档语言：`简体中文`
- 插件 ID：`step-rollback`
- CLI 命名空间：`openclaw steprollback ...`
- 目标形态：`OpenClaw Native Plugin`

## 2. 背景与问题

OpenClaw 已经具备 agent、workspace、session 等运行基础能力，但当前仍缺少一套清晰、稳定、可恢复、可分叉的“历史执行状态管理”机制。

用户在以下场景里会遇到明显问题：

- agent 已执行多轮 tool call，workspace 已经发生变化，但用户无法方便地回到某个稳定历史点。
- 用户希望从某个历史状态继续探索另一条思路，但不想污染当前 agent。
- 用户希望把“历史文件状态 + 对应 session 历史”固化成可复现、可继续演化的新分支。

本插件的目标，是补上这一层能力：

- 只在会改变状态的 tool 调用时做 checkpoint 快照。
- 当用户明确决定继续演化某个历史点时，再基于 checkpoint 创建全新的 workspace、全新的 agent、全新的 session。
- 保持 parent agent 与 child agent 之间清晰的 lineage 关系。

## 3. 核心语义

### 3.1 Checkpoint 只负责快照

checkpoint 的职责只有一个：记录某个历史点的可恢复状态。

checkpoint 至少包含：

- workspace snapshot
- transcript prefix
- lineage metadata

checkpoint 的创建不应：

- 创建新 workspace
- 创建新 agent
- 创建新 session
- 修改 parent agent 的逻辑身份

### 3.2 Tool 调用时自动创建 checkpoint

当 agent 发生会改变状态的 tool call 时，插件应自动创建 checkpoint。

只读工具需要被过滤掉。例如：

- `read` 不应创建 checkpoint
- 明确只读的 shell 命令，例如 `ls`、`find`、`git status`，也不应创建 checkpoint

这个自动流程是主路径，目的是让用户不必在每次工具调用前手动记快照。

### 3.3 Rollback 只负责原地恢复

`rollback` 的职责是把 source session / source workspace 恢复到指定 checkpoint 的状态，以便用户：

- 检查历史状态
- 回看某个失败点
- 暂停在某个历史点进行分析

`rollback` 不负责：

- 创建新 agent
- 创建新 workspace
- 创建新 session

### 3.4 Continue 才负责创建新分支

只有 `continue` 才负责真正的“继续演化”动作。

`continue` 必须满足以下语义：

- 必须显式指定 checkpoint
- 必须显式提供 `--prompt`
- 必须创建新的 workspace
- 必须创建新的 agent
- 必须创建新的 session

新的分支对象来源如下：

- 新 workspace：来自 checkpoint 对应的文件快照
- 新 agent：复制 parent agent 的必要配置，不复用 parent agentDir
- 新 session：使用 checkpoint 对应的 transcript prefix 重建，并使用新的 session 名称 / id
- 新 prompt：作为新 session 的下一条用户输入
- child 执行：child session 建好之后，通过标准 `openclaw agent --agent <child-agent> --session-id <child-session> --message "..."` 路径继续

`continue` 的 agent 配置白名单必须符合当前 schema：

- 允许复制：`model`、`params`、`identity`、`groupChat`、`sandbox`、`runtime`、`tools`、`heartbeat`、`subagents.allowAgents`
- 禁止复制：`models`、`compaction`、`maxConcurrent`、`workspaceRoot`、`cwd`、`root` 以及不受支持的 `subagents.*` 字段

### 3.5 Continue 不能污染 parent agent

`continue` 不应修改 parent agent 的以下内容：

- parent workspace
- parent session store
- parent agentDir
- parent bindings
- parent runtime locks / cursor / counters

continue 的本质是 fork，而不是“在原 agent 上继续跑”。

## 4. 产品目标

### 4.1 P0 目标

P0 提供以下核心能力：

- 会改变状态的 tool call 自动 checkpoint
- checkpoint 列表与详情查询
- rollback 到指定 checkpoint
- rollback 状态查询
- continue 基于 checkpoint fork 新 workspace / 新 agent / 新 session
- agent / session 查询
- checkpoint-backed node / checkout / report / branch 命令
- 提供根级 `openclaw steprollback --help` 总览，以及对声明了 `--json` 的命令提供 JSON 输出

### 4.2 P1 目标

- retention / prune 策略增强
- 更完整的 lineage 展示
- group / topic / custom session 支持增强
- sandbox workspace 支持增强
- 更完整的诊断与统计

## 5. 非目标

P0 不包含以下内容：

- 跨机器 checkpoint 同步
- 捕获数据库、远端 API、外部系统副作用
- 修改用户真实项目 Git 历史
- 默认复制 bindings
- 复用 source agentDir
- 在没有 prompt 的情况下执行 continue

## 6. CLI 总览

### 6.1 核心命令

| 命令 | 类型 | 语义 |
| --- | --- | --- |
| `openclaw steprollback --help` | 读 | 查看全部已注册命令与 flags 总览 |
| `openclaw steprollback setup` | 写 | 初始化插件目录与配置 |
| `openclaw steprollback status` | 读 | 查看插件状态与运行时标记 |
| `openclaw steprollback agents` | 读 | 查看 agent 摘要 |
| `openclaw steprollback sessions --agent <agentId>` | 读 | 查看某个 agent 下的 session |
| `openclaw steprollback checkpoints --agent <agentId> --session <sessionId>` | 读 | 查看某个 session 的 checkpoint 列表 |
| `openclaw steprollback checkpoint --checkpoint <checkpointId>` | 读 | 查看单个 checkpoint 详情 |
| `openclaw steprollback rollback --agent <agentId> --session <sessionId> --checkpoint <checkpointId>` | 写 | 将 source session / workspace 原地恢复到某个 checkpoint |
| `openclaw steprollback rollback-status --agent <agentId> --session <sessionId>` | 读 | 查看 rollback 状态 |
| `openclaw steprollback continue --agent <agentId> --session <sessionId> --checkpoint <checkpointId> --prompt \"...\" [--new-agent <agentId>] [--clone-auth <mode>] [--log]` | 写 | 基于 checkpoint fork 新 workspace / 新 agent / 新 session |
| `openclaw steprollback nodes --agent <agentId> --session <sessionId>` | 读 | 列出可 checkout 的 checkpoint-backed node |
| `openclaw steprollback checkout --agent <agentId> --source-session <sessionId> --entry <entryId> [--continue] [--prompt \"...\"]` | 写 | 基于 checkpoint-backed entry 创建新 session |
| `openclaw steprollback report --rollback <rollbackId>` | 读 | 查看 rollback report |
| `openclaw steprollback branch --branch <branchId>` | 读 | 查看 checkout branch 记录 |

### 6.2 辅助命令

以下命令属于主流程 checkpoint -> continue 之外的辅助能力，不应改变主语义：

- `nodes`
- `checkout`
- `branch`
- `report`

这些命令不能替代主路径：

- 会改变状态的 tool call -> 自动 checkpoint
- continue -> 带 prompt fork 新 agent

## 7. 用户流程

### 7.1 主流程：checkpoint -> continue

1. 用户正常运行 agent。
2. 每次会改变状态的 tool call 前插件自动创建 checkpoint。
3. 用户通过 `checkpoints` 选择一个历史 checkpoint。
4. 用户执行：

```bash
openclaw steprollback continue \
  --agent <parent-agent> \
  --session <parent-session> \
  --checkpoint <checkpoint-id> \
  --prompt "..."
```

5. 插件创建：
   - 新 workspace
   - 新 agent
   - 新 session
6. 插件先重建 child transcript prefix，再通过标准 `openclaw agent` message 路径继续 child。

### 7.2 辅助流程：rollback

1. 用户选择某个 checkpoint。
2. 用户执行 `rollback`。
3. source session / source workspace 被恢复到对应状态。
4. 用户可以检查、对比、分析。

rollback 不是 fork 行为。

## 8. CLI 详细需求

### 8.1 通用规则

所有命令统一遵循：

```bash
openclaw steprollback <command> [flags]
```

通用要求：

- `openclaw steprollback --help` 必须输出全部已注册子命令与 flags 总览
- `openclaw steprollback <command> --help` 继续作为单个命令的帮助入口
- 大多数命令默认输出人类可读的表格或字段视图
- `status` 当前直接输出格式化 JSON，不单独提供 `--json` flag
- 只有声明了 `--json` 的命令才要求支持 `--json`
- 写命令必须返回稳定错误码
- 写命令必须具备原子性或可清理的失败策略
- 只有当 `openclaw.json` 通过当前 schema 校验后，插件命令才会出现
- 所有路径必须尊重：
  - `OPENCLAW_HOME`
  - `OPENCLAW_STATE_DIR`
  - `OPENCLAW_CONFIG_PATH`

### 8.2 `status`

用途：

- 查看插件是否启用
- 查看运行时是否仅支持 gateway mode
- 查看是否允许 continue prompt

命令：

```bash
openclaw steprollback status
```

建议输出字段：

- `pluginId`
- `enabled`
- `gatewayModeOnly`
- `allowContinuePrompt`

### 8.3 `setup`

用途：

- 初始化插件状态目录
- 补齐 `openclaw.json` 中的插件条目

命令：

```bash
openclaw steprollback setup [--base-dir <path>] [--dry-run] [--json]
```

行为：

- 创建默认目录
- 写入 `plugins.entries.step-rollback`
- 返回 `restartRequired`

### 8.5 `agents`

命令：

```bash
openclaw steprollback agents [--json]
```

用途：

- 列出可管理 agent
- 展示 parent / child 关系摘要

建议输出字段：

- `agentId`
- `workspacePath`
- `agentDir`
- `sessionCount`
- `checkpointCount`
- `derivedFrom`

### 8.6 `sessions`

命令：

```bash
openclaw steprollback sessions --agent <agentId> [--json]
```

用途：

- 查看指定 agent 下的 session

建议输出字段：

- `sessionId`
- `sessionKey`
- `updatedAt`
- `checkpointCount`
- `latestCheckpointId`

### 8.7 `checkpoints`

命令：

```bash
openclaw steprollback checkpoints --agent <agentId> --session <sessionId> [--json]
```

用途：

- 查看 checkpoint 列表

建议输出字段：

- `checkpointId`
- `entryId`
- `turnIndex`
- `gitCommit`
- `createdAt`
- `workspaceDigest`
- `summary`

### 8.8 `checkpoint`

命令：

```bash
openclaw steprollback checkpoint --checkpoint <checkpointId> [--json]
```

用途：

- 查看单个 checkpoint 详情

建议输出字段：

- `checkpointId`
- `sourceAgentId`
- `sourceSessionId`
- `entryId`
- `turnIndex`
- `gitCommit`
- `workspaceDigest`
- `lineage`

### 8.9 `rollback`

命令：

```bash
openclaw steprollback rollback \
  --agent <agentId> \
  --session <sessionId> \
  --checkpoint <checkpointId> \
  [--json]
```

用途：

- 将 source workspace / source session 原地恢复到指定 checkpoint

明确约束：

- 不创建新 workspace
- 不创建新 agent
- 不创建新 session

建议输出字段：

- `ok`
- `agentId`
- `sessionId`
- `checkpointId`
- `rollbackId`

### 8.10 `rollback-status`

命令：

```bash
openclaw steprollback rollback-status --agent <agentId> --session <sessionId> [--json]
```

用途：

- 查看当前 source session 是否处于 rollback 后状态

建议输出字段：

- `rollbackInProgress`
- `awaitingContinue`
- `lastRollbackCheckpointId`

### 8.11 `continue`

命令：

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

用途：

- 基于 checkpoint 创建新的 child agent 分支

强约束：

- `--prompt` 必填
- 不允许无 prompt continue
- continue 不修改 parent agent

核心行为：

1. 解析 checkpoint。
2. 生成新的 `agentId`。
3. 创建新的 workspace：
   - 从 checkpoint 对应快照 materialize
   - 不复用 parent workspace
4. 创建新的 agentDir：
   - 白名单复制 parent agent 的必要配置
   - 不复用 parent agentDir
   - 不复制 bindings
   - 写回配置时必须保持在当前 OpenClaw schema 允许的字段集合内
5. 创建新的 session：
   - 使用新的 `sessionId` / `sessionKey`
   - transcript 内容 = checkpoint 对应的历史前缀
   - 新 prompt 作为下一条输入
6. 使用新的 `agentId` 和 `sessionId`，通过标准 `openclaw agent` message 流程继续 child。
7. 返回 child agent / workspace / session 信息。

建议输出字段：

- `ok`
- `parentAgentId`
- `newAgentId`
- `newWorkspacePath`
- `newSessionId`
- `newSessionKey`
- `checkpointId`

失败场景至少包括：

- `ERR_CHECKPOINT_NOT_FOUND`
- `ERR_PROMPT_REQUIRED`
- `ERR_AGENT_ALREADY_EXISTS`
- `ERR_WORKSPACE_MATERIALIZE_FAILED`
- `ERR_AGENTDIR_CLONE_FAILED`
- `ERR_SESSION_REBUILD_FAILED`
- `ERR_CONFIG_WRITE_FAILED`

### 8.12 `nodes`

命令：

```bash
openclaw steprollback nodes --agent <agentId> --session <sessionId> [--json]
```

用途：

- 列出可用于 `checkout` 的 checkpoint-backed node

建议输出字段：

- `entryId`
- `nodeIndex`
- `toolName`
- `checkoutAvailable`
- `createdAt`

### 8.13 `checkout`

命令：

```bash
openclaw steprollback checkout \
  --agent <agentId> \
  --source-session <sessionId> \
  --entry <entryId> \
  [--continue] \
  [--prompt "..."] \
  [--json]
```

用途：

- 基于 checkpoint-backed entry 创建一个新的 session
- 在传入 `--continue` 时可以立即继续执行

建议输出字段：

- `branchId`
- `newSessionId`
- `newSessionKey`
- `continued`
- `usedPrompt`

### 8.14 `report`

命令：

```bash
openclaw steprollback report --rollback <rollbackId> [--json]
```

用途：

- 按 id 查看单个 rollback report

建议输出字段：

- `rollbackId`
- `result`
- `message`
- `checkpointId`
- `createdAt`

### 8.15 `branch`

命令：

```bash
openclaw steprollback branch --branch <branchId> [--json]
```

用途：

- 按 id 查看单个 checkout branch 记录

建议输出字段：

- `branchId`
- `sourceAgentId`
- `sourceSessionId`
- `sourceEntryId`
- `newSessionId`
- `createdAt`

## 9. 数据模型

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

## 10. 存储布局

推荐默认目录：

```text
${OPENCLAW_STATE_DIR:-~/.openclaw}/plugins/step-rollback/
```

目录结构：

```text
step-rollback/
  checkpoints/
  registry/
  runtime/
  reports/
  _git/
```

要求：

- checkpoint 数据和 fork 记录必须可检索
- Git shadow snapshots 必须与用户真实仓库隔离

## 11. 状态机

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

## 12. 一致性规则

- checkpoint 是历史快照，不是分支实体
- continue 才是分支动作
- rollback 不能偷偷创建新 agent
- continue 不能偷偷修改 parent agent
- 新 agent 不能复用 parent agentDir
- 新 session 必须使用新的 session 名称 / id
- checkpoint 的 transcript 只能是闭合前缀，不能是任意截断文本

## 13. 安全与隐私

- 插件属于高信任代码，只能安装可信来源
- 默认目录权限应为最小必要权限
- 不输出 token、secret、auth profile 内容
- `clone-auth` 必须采用最小复制策略
- 默认不复制 bindings

## 14. 成功指标

- 会改变状态的 tool call 自动 checkpoint 成功率稳定在高位
- checkpoint 查询保持秒级返回
- continue 创建 child agent 成功率稳定在高位
- continue 后 parent agent 零破坏
- 新 workspace / 新 agent / 新 session 的 lineage 可追踪

## 15. 验收标准

- 会改变状态的 tool call 发生时自动创建 checkpoint；只读调用既不创建 checkpoint，也不创建新 agent
- `openclaw steprollback --help` 可以看到已注册命令与 flags 总览
- 执行 `checkpoints` 可以看到自动创建的 checkpoint
- 执行 `rollback` 时只恢复 source，不创建 fork
- 执行 `continue` 时若没有 `--prompt` 必须失败
- 执行 `continue --prompt "..."` 时会创建：
  - 新 workspace
  - 新 agent
  - 新 session
- child agent 继承 parent agent 的必要配置，但不复用 `agentDir`
- child session 只包含 checkpoint 对应的历史前缀，再追加新 prompt
- parent agent / parent workspace / parent session 不被 continue 污染
- 所有写命令支持 `--json`
- 所有失败场景返回稳定错误码
