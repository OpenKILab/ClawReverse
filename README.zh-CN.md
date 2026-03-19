# ClawReverse

通过 `openclaw reverse` 为 OpenClaw 会话提供安全的 checkpoint、rollback 和干净的分支继续能力。

ClawReverse 是一个 OpenClaw 原生插件，提供 `openclaw reverse` 命令，用来保存 checkpoint、恢复干净的 workspace 状态，并基于已有进度继续推进，而不是每次从头开始。

## 使用场景

ClawReverse 专为两类任务执行场景设计，帮你高效管理任务，解决重复执行问题：

1. 任务运行中，workspace 内文件被误删、篡改，导致环境混乱，需要快速恢复至整洁、可控的初始状态。
2. 无需完整重新运行任务，已有部分可用结果，可直接基于现有成果继续推进，大幅减少重复步骤，节省 token 消耗。

## ClawReverse 能做什么

ClawReverse 帮你在不丢掉已有成果的前提下，把 workspace 拉回可控状态并继续推进任务。

- 在任务推进过程中保存 checkpoint。
- 在文件误删或改乱后，回到更早的干净状态。
- 基于已有的部分结果继续任务，而不是从头重跑。
- 复用已经正确的结果，减少重复推演和 token 消耗。

## 核心概念

### `checkpoint`

checkpoint 是一个历史状态边界，包含 workspace snapshot、闭合的 transcript prefix，以及 lineage 元数据。它只负责保存状态，不代表分支。

### `rollback`

`rollback` 会把 source 侧回退到某个 checkpoint。它不会创建新的 workspace、agent 或 session。默认情况下它不会改写 parent workspace，只有你显式要求时才会原地恢复。

### `continue`

`continue` 是 fork 行为。它必须带 `--prompt`，并且会基于所选 checkpoint 创建新的 child agent、新的 workspace 和新的 session，同时不污染 parent。

## 快速开始

### 前置条件

- Node.js 24+
- 一个可正常使用、且 `openclaw.json` 能通过校验的 OpenClaw 环境
- 对运行 OpenClaw 的机器有访问权限

### 安装

```bash
openclaw plugins install -l <path-to-repo>
```

如果你想用复制安装而不是软链接安装，可以使用 `openclaw plugins install <path-to-repo>`。

插件在 `openclaw.json` 里的配置键仍然是 `step-rollback`，但 CLI 基础命令已经改为 `openclaw reverse`。

### 最小配置

最快的方式：

```bash
openclaw reverse setup
```

如果你更想手动编辑 `openclaw.json`，下面是最小可用配置：

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

其余插件路径默认会落在 `~/.openclaw/plugins/step-rollback/` 下。

### 验证安装

安装或修改配置后，重启 Gateway，然后确认插件命令已经可见：

```bash
openclaw reverse --help
```

如果命令没有出现，先确认 `openclaw.json` 仍然能通过校验，并且 `step-rollback` 已经加入 `plugins.allow`。

### 一个最小 happy path

1. 正常运行 agent，让它执行会改动状态的 tool call。
2. 查看这个 session 的 checkpoint。
3. 从某个 checkpoint continue 出一个新的 child 分支。

```bash
openclaw reverse checkpoints --agent <agent-id> --session <session-id>

openclaw reverse continue \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "从这个历史点继续，但尝试另一种方案。"
```

如果你想回退 parent session，而不是创建 child 分支，就使用同一组 `--agent`、`--session`、`--checkpoint` 参数执行 `rollback`。

### 查看 checkpoint tree

如果你想看 parent session 和通过 `continue` 创建出来的 child branch 是怎么连接起来的，可以使用 `openclaw reverse tree`：

```bash
openclaw reverse tree --agent <agent-id> --session <session-id>
```

它适合回答这些问题：

- 这次视图的 root checkpoint 是哪个
- 哪些地方发生了继续分支
- 一共涉及多少 nodes、sessions 和 branches

如果你想把某个 checkpoint 当作树根来聚焦查看，可以使用 `--node`，也可以用它的别名 `--checkpoint`：

```bash
openclaw reverse tree \
  --agent <agent-id> \
  --session <session-id> \
  --node <checkpoint-id>
```

如果你想拿到原始结构化输出，可以加 `--json`。

## 验证 / 测试

在仓库根目录运行：

```bash
npm test
```

## 联系方式

如有问题，可通过以下邮箱联系：

- [wangxuhong@pjlab.org.cn](mailto:wangxuhong@pjlab.org.cn)
- [huangbin@pjlab.org.cn](mailto:huangbin@pjlab.org.cn)
