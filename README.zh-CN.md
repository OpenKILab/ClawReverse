<p align="center">
  <img src="./clawreverse_logo.jpg" alt="ClawReverse logo" width="220" />
</p>

<p align="center">
  <a href="mailto:wangxuhong@pjlab.org.cn">wangxuhong@pjlab.org.cn</a>
  <br />
  <a href="mailto:huangbin@pjlab.org.cn">huangbin@pjlab.org.cn</a>
</p>

# ClawReverse

[English](README.md) | 简体中文

为 OpenClaw 会话提供检查点暂存、回退与安全分支能力，而不必丢掉已经取得的进展。

ClawReverse 是一个 OpenClaw 原生插件，提供 `openclaw reverse` 命令，用于管理 checkpoint、恢复干净的 workspace 状态，并从一个已知可用的历史点继续任务，而不是每次都从头开始。

## 为什么使用 ClawReverse？

在实际使用 OpenClaw 时，ClawReverse 能帮你解决以下痛点：

- **AI 改乱了代码，任务卡死：** 当 OpenClaw 反复调用工具、生成一堆无用文件或错误修改导致无法继续时，你可以一键回退到干净状态，而不用删掉项目重头再来。
- **复用长程任务进度，节省 Token：** 如果 AI 花了大量时间完美分析了整个代码库，但在写代码时出错，你可以直接从“分析完成”的节点继续，避免让它重新阅读代码浪费 Token。

它能帮助你：

- 快速把 workspace回溯到可控状态
- 保留已经有价值的中间成果
- 以子分支方式安全试错
- 减少重复执行和 token 消耗

## 核心概念

可以把 ClawReverse 理解为三件事：

- `checkpoint`：会话的一个历史状态边界，记录 workspace snapshot、闭合的 transcript prefix 和 lineage 元数据。
- `rollback`：把当前执行线回退到某个 checkpoint。它不会创建新的 workspace、agent 或 session。默认不会改写 parent workspace，只有在你显式要求时才会做原地恢复。
- `continue`：从某个 checkpoint 分叉继续。它必须带 `--prompt`，并会创建新的 child agent、新的 workspace 和新的 session，而不会污染 parent。


## 前置条件

- Node.js 24+
- 一个可正常使用且 `openclaw.json` 能通过校验的 OpenClaw 环境
- 对运行 OpenClaw 的机器有访问权限

## 安装

软链接安装：

```bash
openclaw plugins install -l <path-to-repo>
```


插件在 `openclaw.json` 中的配置键是 `clawreverse`，CLI 基础命令是 `openclaw reverse`。

## 配置

最快方式：

```bash
openclaw reverse setup
```

或者手动编辑 `openclaw.json`：

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

其他插件路径默认位于 `~/.openclaw/plugins/clawreverse/`。

## 验证安装

安装完成或修改配置后，请先重启 Gateway，再确认命令已可用：

```bash
openclaw reverse --help
```

如果命令没有出现，请检查：

- `openclaw.json` 是否仍能通过校验
- `clawreverse` 是否已加入 `plugins.allow`
- 插件条目是否处于启用状态

## 常见工作流

### 1) 查看可用 checkpoint

```bash
openclaw reverse checkpoints --agent <agent-id> --session <session-id>
```

先查看当前会话有哪些可用的恢复点或分叉点。

### 2) 用 `continue` 安全分叉

```bash
openclaw reverse continue \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id> \
  --prompt "从这个历史点继续，并尝试另一种方案。"
```

当你希望保留 parent session、不污染原执行线时，用 `continue`。

### 3) 用 `rollback` 回退当前执行线

```bash
openclaw reverse rollback \
  --agent <agent-id> \
  --session <session-id> \
  --checkpoint <checkpoint-id>
```

当你想把当前执行线直接拉回某个更早的干净状态，而不是创建子分支时，用 `rollback`。

### 4) 用 `tree` 查看分支关系

```bash
openclaw reverse tree --agent <agent-id> --session <session-id> [--node <checkpoint>]
```

它适合回答这些问题：

- 当前视图的根 checkpoint 是哪个
- 哪些位置产生了 child branch
- 一共涉及多少 nodes、sessions 和 branches




## 排查问题

### 找不到 `openclaw reverse` 命令

- 安装插件或修改 `openclaw.json` 之后，先重启 Gateway
- 检查 `clawreverse` 是否在 `plugins.allow` 中
- 检查插件条目是否启用，配置是否仍能通过校验


## 验证 / 测试

在仓库根目录运行：

```bash
npm test
```

## Roadmap

- ✅ checkpoint snapshot 的 PoC
- ✅ 基于新创建的 agent 继续任务
- [ ] 集成 sandbox 支持
