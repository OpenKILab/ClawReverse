# SecureStepClaw

为 OpenClaw 会话提供安全的 checkpoint、rollback 和干净的分支继续能力。

## 痛点

当 agent 已经连续执行了多个会改动状态的 tool call 时，想安全地回到历史点，或者从旧状态试另一条路线，往往会变得很麻烦。SecureStepClaw 的目标就是把这件事变简单：你可以查看历史、恢复到已知良好的状态，并且在不污染父级运行的前提下继续分支。

- agent 已经通过多次 tool call 修改了 workspace，很难安全地回退。
- 用户想从某个历史点分叉，但不希望污染 parent agent、workspace 或 session。
- 历史文件状态和 transcript lineage 不容易检查，也不容易复现。
- 第一次使用的人需要的是一条最快可走通的路径，而不是一份很长的说明书。

## SecureStepClaw 能做什么

SecureStepClaw 是一个 OpenClaw `step-rollback` 插件，主要能力包括：

- 在状态变更型 tool call 之前自动创建 checkpoint
- 查看某个 agent / session 的 checkpoint 历史
- 将 source session rollback 到指定 checkpoint
- 从指定 checkpoint continue，创建新的 child agent、workspace 和 session

只读调用会被跳过，因此 checkpoint 历史会更聚焦于真正的状态变化。

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

### 最小配置

最快的方式：

```bash
openclaw steprollback setup
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
openclaw steprollback --help
```

如果命令没有出现，先确认 `openclaw.json` 仍然能通过校验，并且 `step-rollback` 已经加入 `plugins.allow`。

### 一个最小 happy path

1. 正常运行 agent，让它执行会改动状态的 tool call。
2. 查看这个 session 的 checkpoint。
3. 从某个 checkpoint continue 出一个新的 child 分支。

```bash
openclaw steprollback checkpoints --agent <agent-id> --session <session-id>

openclaw steprollback continue \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "从这个历史点继续，但尝试另一种方案。"
```

如果你想回退 parent session，而不是创建 child 分支，就使用同一组 `--agent`、`--session`、`--checkpoint` 参数执行 `rollback`。

## 延伸阅读

- `openclaw steprollback --help`：查看当前 CLI 命令和参数
- [PRD](./docs/PRD.md)
- [PRD.zh-CN](./docs/PRD.zh-CN.md)

## 验证 / 测试

在仓库根目录运行：

```bash
npm test
```
