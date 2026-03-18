# SecureStepClaw

英文版文档：[`README.md`](./README.md)

`SecureStepClaw` 是一个面向 OpenClaw 的 `step-rollback` Native Plugin 项目。它的目标语义是：

- 只有会改变状态的 tool call 才应创建 checkpoint；只读调用应跳过
- `rollback` 默认不改写 parent workspace，只有显式要求时才原地恢复 workspace
- `continue` 必须带 `--prompt`，并且基于 checkpoint 创建新的 session；默认优先复用最新 child agent，必要时或显式要求时再创建新的 child agent / workspace

## 当前说明

这个仓库已经包含：

- 插件清单：[openclaw.plugin.json](./openclaw.plugin.json)
- Native Plugin 入口：[dist/index.js](./dist/index.js)
- 原生注册逻辑：[dist/native-plugin.js](./dist/native-plugin.js)
- 核心引擎：[dist/plugin.js](./dist/plugin.js)
- 服务层：[dist/services/](./dist/services)
- 测试：[tests/plugin.test.js](./tests/plugin.test.js)

重要说明：

- 本 README 现在统一描述“目标命令语义”。
- 仓库里已经具备 checkpoint、rollback、continue 等运行时基础能力，但部分运行细节仍可能处于向这套语义持续对齐的过程中。
- 因此，文档优先表达产品 contract，而不是承诺每一个当前实现细节都已经完全一致。

## 核心语义

### Checkpoint

checkpoint 只负责快照，不负责分支。

每个 checkpoint 至少对应：

- 一个 workspace snapshot
- 一段闭合 transcript prefix
- 一份 lineage 元数据

会改变状态的 tool call 时自动创建 checkpoint，但不会创建新的 workspace、agent 或 session。

像 `read` 这样的只读工具，以及 `ls`、`find`、`git status` 这类只读 shell 命令，都不应创建 checkpoint。

### Rollback

`rollback` 的职责是把 source session 回退到指定 checkpoint。

默认情况下，它不应改写 parent workspace。

只有调用方显式要求时，`rollback` 才可以把 source workspace 原地恢复到指定 checkpoint。

`rollback` 不会：

- 创建新 workspace
- 创建新 agent
- 创建新 session

### Continue

`continue` 才是 fork 行为。

`continue` 的语义固定为：

- 必须带 `--prompt`
- 必须指定 checkpoint
- 每次都必须创建新的 child agent 和 workspace
- 必须创建新 session

continue 创建的 child 分支来源如下：

- target workspace：来自 checkpoint 对应文件快照
- target agent：总是新建，并复制必要的 parent agent 配置
- 新 session：基于 checkpoint 对应的 session 历史前缀重建，并使用新的 session 名称 / id
- 新 prompt：作为 child session 的下一条输入
- child 执行：在还原好 checkpoint prefix 之后，通过标准的 `openclaw agent --agent <child-agent> --session-id <child-session> --message "..."` 路径继续

continue 不应污染 parent agent。

## 安装

### 1. 准备环境

需要：

1. Node.js 24+
2. 一个 `openclaw.json` 能通过当前 schema 校验的 OpenClaw 环境
3. 在真正运行 OpenClaw 的机器上安装本插件

### 2. 安装插件

开发阶段建议使用软链接安装：

```bash
openclaw plugins install -l /Users/bin-mac/CodeX/SecureStepClaw
```

复制安装：

```bash
openclaw plugins install /Users/bin-mac/CodeX/SecureStepClaw
```

### 3. 验证安装

```bash
openclaw plugins list
openclaw plugins info step-rollback
openclaw plugins doctor
```

### 4. 配置插件

示例：

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

修改配置后需要重启 Gateway。

重要配置说明：

- 只有当 `openclaw.json` 通过校验后，`openclaw steprollback ...` 这类插件命令才会出现。
- 如果校验报出 `agents.list[]` 下面仍有旧的 fork agent 字段，例如 `models`、`compaction`、`maxConcurrent`、`workspaceRoot`、`cwd`、`root` 或 `subagents.maxConcurrent`，需要先修复再重试。
- `agents.list[]` 中只保留当前允许的 per-agent 字段：`model`、`params`、`identity`、`groupChat`、`sandbox`、`runtime`、`tools`、`heartbeat` 和 `subagents.allowAgents`。
- `models`、`compaction`、`maxConcurrent` 这类 defaults 级字段应回到 `agents.defaults`。
- `workspaceRoot`、`cwd`、`root` 这类旧别名应统一收敛成 `workspace`。

## 主要命令

先用下面这个命令查看完整的 Step Rollback CLI 总览：

```bash
openclaw steprollback --help
```

### 读命令

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

### 写命令

```bash
openclaw steprollback setup
openclaw steprollback rollback --agent <agentId> --session <sessionId> --checkpoint <checkpointId> [--restore-workspace]
openclaw steprollback continue --agent <agentId> --session <sessionId> --checkpoint <checkpointId> --prompt "..." [--new-agent <agentId>] [--clone-auth <mode>] [--log]
openclaw steprollback checkout --agent <agentId> --source-session <sessionId> --entry <entryId> [--continue] [--prompt "..."]
```

## 主流程

### 1. 正常运行 agent

让 agent 正常执行 tool call。插件会在每次会改变状态的 tool call 前自动创建 checkpoint。

### 2. 查看 agent 和 session

```bash
openclaw steprollback agents
openclaw steprollback sessions --agent main
```

### 3. 查看 checkpoint

```bash
openclaw steprollback checkpoints --agent main --session <session-id>
openclaw steprollback checkpoint --checkpoint <checkpoint-id>
```

如果没有看到 checkpoint，优先检查：

- 该 session 是否在最近一次 Gateway / 插件重启之后新建
- 该 session 是否真的执行过 tool call
- `plugins.allow` 是否包含 `step-rollback`

### 4. 可选：rollback 做原地恢复

默认情况下，`rollback` 只会把插件 / 运行时游标回退到指定 checkpoint，不会直接改写 parent workspace。只有显式传入 `--restore-workspace` 时，才会原地恢复 parent workspace。

只回退状态，不改动 parent workspace：

```bash
openclaw steprollback rollback \
  --agent main \
  --session <session-id> \
  --checkpoint <checkpoint-id>
```

回退状态，并原地恢复 parent workspace：

```bash
openclaw steprollback rollback \
  --agent main \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --restore-workspace
```

然后查看状态：

```bash
openclaw steprollback rollback-status --agent main --session <session-id>
```

注意：rollback 只是恢复 source，不会创建 child agent。

### 5. continue fork 新 agent

`continue` 会基于 checkpoint 总是创建一个新的 agent、workspace 和 session。

agent 创建规则如下：

- 总是创建新的 child agent / workspace
- `--new-agent <agentId>` 可以在新建时指定 child agent 名称

按默认命名继续：

```bash
openclaw steprollback continue \
  --agent main \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "继续这个历史点，但尝试不同方案"
```

继续并显式命名新的 child agent：

```bash
openclaw steprollback continue \
  --agent main \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "继续这个历史点，但放到一个全新的 child 里。" \
  --new-agent main-cp-0004
```

如果 child 启动看起来异常或像是卡住了，可以加上 `--log` 重试。插件会打印额外诊断信息，并返回 `logFilePath` 指向 runtime 目录下的 child 进程日志。

这个命令一定会创建：

- 新 session
- 新 workspace
- 新 agent

并返回类似字段：

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

重要：

- `--prompt` 是 continue 的必填参数
- continue 的目的是 fork，不是原地续跑 parent agent
- child workspace 和 child session 准备好之后，应通过标准 `openclaw agent` message 路径继续执行

## 其他查看与 checkout 命令

这些命令适合和主流程 checkpoint -> rollback / continue 搭配使用：

```bash
openclaw steprollback nodes --agent main --session <session-id>
openclaw steprollback checkout --agent main --source-session <session-id> --entry <entry-id>
openclaw steprollback checkout --agent main --source-session <session-id> --entry <entry-id> --continue --prompt "从这个 entry 继续。"
openclaw steprollback report --rollback <rollback-id>
openclaw steprollback branch --branch <branch-id>
```

## continue 复制什么

continue 创建 child agent 时，应只复制 parent agent 的必要配置，例如：

- `model`
- `params`
- `identity`
- `groupChat`
- `sandbox`
- `runtime`
- `tools`
- `heartbeat`
- `subagents.allowAgents`

不应复制：

- parent `agentDir`
- parent session store
- parent bindings
- parent runtime lock / cursor / counters
- `models`、`compaction`、`maxConcurrent` 这类 defaults 级字段
- `workspaceRoot`、`cwd`、`root` 这类旧 workspace 别名
- `subagents.allowAgents` 之外的 subagent 扩展字段

## 存储

默认配置下，插件状态目录位于：

- `~/.openclaw/plugins/step-rollback/checkpoints`
- `~/.openclaw/plugins/step-rollback/registry`
- `~/.openclaw/plugins/step-rollback/runtime`
- `~/.openclaw/plugins/step-rollback/reports`

Git shadow snapshots 应与用户真实项目仓库隔离。

## 当前代码状态说明

这个仓库当前已经提供：

- 会改变状态的 tool call 自动 checkpoint
- checkpoint 查询
- source 侧 rollback 恢复能力
- 基于全新 child agent / session 的 continue 与分支能力
- checkpoint-backed node 列表、checkout、rollback report、branch 查看能力

当前 native bridge 会优先使用官方文档里标准的 `openclaw agent --message` 续跑路径，runtime helper 或 Gateway helper 只作为兼容性回退方案。

## 验证

仓库根目录运行：

```bash
npm test
```
