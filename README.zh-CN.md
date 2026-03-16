# SecureStepClaw

英文版文档：[`README.md`](./README.md)

`SecureStepClaw` 是基于 [`docs/`](./docs) 中设计文档实现的一个 OpenClaw Native Plugin 版本的 `step-rollback` 插件。它已经包含了原生运行时入口、回退引擎、存储结构、插件清单以及测试代码，对应项目文档里定义的 Phase 1 和 Phase 2 API 形态。

## 当前状态

这个仓库现在已经从 [`dist/index.js`](./dist/index.js) 导出了 OpenClaw Native Plugin 运行时入口，原生注册逻辑位于 [`dist/native-plugin.js`](./dist/native-plugin.js)。

目前已经具备的内容：

- 插件清单文件：[`openclaw.plugin.json`](./openclaw.plugin.json)
- 原生插件运行时入口 `register(api)`：[`dist/native-plugin.js`](./dist/native-plugin.js)
- 通过 `api.registerGatewayMethod(...)` 注册 Gateway RPC 方法
- 优先通过官方 `api.on(...)` 注册生命周期 hook，并保留 `api.registerHook(...)` 兼容回退
- 插件 service 和 CLI 注册
- 回退引擎和 API 实现：[`dist/plugin.js`](./dist/plugin.js)
- 对外导出入口：[`dist/index.js`](./dist/index.js)
- 本地测试：[`tests/plugin.test.js`](./tests/plugin.test.js)

当前需要注意的点：

- 我没有在这个工作区里连接真实的 OpenClaw Gateway 进程做联调验证，所以原生桥接层目前是通过 mock OpenClaw API 测试的。
- 官方文档对 Native Plugin 注册面描述得比较清楚，但并没有给出一个专门的“从同一个 session 的历史 entry 精确恢复继续执行”的公开运行时 helper。
- 因此，插件在 [`dist/native-plugin.js`](./dist/native-plugin.js) 中采用了“官方原生接口 + best-effort runtime bridge”的实现方式。
- 如果你本地使用的 OpenClaw 版本在 `api.runtime` 下暴露的方法名不同，可能需要对 [`dist/native-plugin.js`](./dist/native-plugin.js) 做一小段兼容调整。
- 当 `steprollback.continue` 没有传入 prompt 时，插件会自动补一条 `Continue from the restored checkpoint.`，因为 OpenClaw 的 `agent` 入口需要消息文本。

## 已实现内容

### Phase 1

- 每次 tool 调用前自动创建 checkpoint
- checkpoint 注册与查询
- 基于 Git 的工作区快照恢复，目录级快照仓库存放在 `checkpointDir/_git`
- rollback 状态跟踪
- 支持带可选 prompt 的 continue
- rollback 报告记录

### Phase 2 脚手架

- session 节点列表
- checkout 元数据与 branch record
- 新 session 的运行态初始化

## 仓库结构

- [`docs/`](./docs)：PRD、架构设计、API 设计
- [`openclaw.plugin.json`](./openclaw.plugin.json)：插件 manifest 与配置 schema
- [`package.json`](./package.json)：包信息与测试脚本
- [`dist/index.js`](./dist/index.js)：公共导出入口
- [`dist/native-plugin.js`](./dist/native-plugin.js)：OpenClaw 原生运行时入口与注册逻辑
- [`dist/plugin.js`](./dist/plugin.js)：核心插件引擎
- [`dist/services/`](./dist/services)：checkpoint、registry、runtime、lock、report 等服务
- [`tests/plugin.test.js`](./tests/plugin.test.js)：Node 测试套件

## 前置条件

在使用或集成这个项目之前，请先确认：

1. 已安装 Node.js 24 或更高版本
2. 已安装并启用 Gateway 模式的 OpenClaw
3. 你可以访问真正运行 OpenClaw Gateway 的那台机器

同时需要注意以下 OpenClaw 运行特点：

- Native Plugin 是在 Gateway 进程内运行的
- 插件配置位于 `plugins.entries.<id>.config`
- 修改插件配置后通常需要重启 Gateway
- 本地开发时，可以通过目录安装或软链接安装插件，例如 `openclaw plugins install -l <path>`

## 本地开发使用流程

如果你想在不启动真实 OpenClaw Gateway 的情况下，直接在代码里调试 rollback 引擎，可以按下面的方式使用。

### 1. 进入项目目录

```bash
cd /Users/bin-mac/CodeX/SecureStepClaw
```

### 2. 运行测试

```bash
npm test
```

预期结果：全部测试通过。

### 3. 在代码中创建 rollback 引擎实例

除了原生 OpenClaw 运行时入口之外，这个仓库也同时暴露了一个普通 JavaScript API，便于本地直接测试回退引擎。

```js
import crypto from "node:crypto";
import { createStepRollbackPlugin } from "./dist/index.js";

const plugin = createStepRollbackPlugin({
  config: {
    workspaceRoots: ["/absolute/path/to/workspace"],
    checkpointDir: "/absolute/path/to/plugin-data/checkpoints",
    registryDir: "/absolute/path/to/plugin-data/registry",
    runtimeDir: "/absolute/path/to/plugin-data/runtime",
    reportsDir: "/absolute/path/to/plugin-data/reports"
  },
  host: {
    async stopRun({ agentId, sessionId, runId }) {
      return { stopped: true, agentId, sessionId, runId };
    },
    async startContinueRun({ agentId, sessionId, entryId, prompt }) {
      return { runId: `run:${agentId}:${sessionId}:${entryId}:${prompt ?? ""}` };
    },
    async createSession() {
      return { sessionId: crypto.randomUUID() };
    }
  }
});
```

### 4. 把 session 和 tool 生命周期事件喂给插件

```js
await plugin.hooks.sessionStart({
  agentId: "main",
  sessionId: "session-1",
  runId: "run-1"
});

await plugin.hooks.beforeToolCall({
  agentId: "main",
  sessionId: "session-1",
  entryId: "entry-1",
  nodeIndex: 1,
  toolName: "write",
  runId: "run-1"
});

await plugin.hooks.afterToolCall({
  agentId: "main",
  sessionId: "session-1",
  entryId: "entry-1",
  nodeIndex: 1,
  toolName: "write",
  runId: "run-1",
  success: true
});
```

### 5. 调用 rollback API

```js
const list = await plugin.methods["steprollback.checkpoints.list"]({
  agentId: "main",
  sessionId: "session-1"
});

const rollback = await plugin.methods["steprollback.rollback"]({
  agentId: "main",
  sessionId: "session-1",
  checkpointId: list.checkpoints[0].checkpointId
});

const resumed = await plugin.methods["steprollback.continue"]({
  agentId: "main",
  sessionId: "session-1",
  prompt: "Continue from here, but do not rewrite the config file yet."
});

console.log(resumed.branchId, resumed.newSessionId, resumed.newSessionKey);
```

## 配置说明

[`openclaw.plugin.json`](./openclaw.plugin.json) 中定义的配置项包括：

- `enabled`
- `workspaceRoots`
- `checkpointDir`
- `registryDir`
- `runtimeDir`
- `reportsDir`
- `maxCheckpointsPerSession`
- `allowContinuePrompt`
- `stopRunBeforeRollback`

示例配置如下：

```json
{
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
```

## 如何把它安装到 OpenClaw

### 1. 把仓库放在 Gateway 所在机器上

这个插件会运行在 OpenClaw Gateway 进程内，所以请把仓库放在真正运行 Gateway 的机器上。

### 2. 先验证本地包

```bash
cd /Users/bin-mac/CodeX/SecureStepClaw
npm test
```

### 3. 安装插件

开发阶段建议使用软链接安装：

```bash
openclaw plugins install -l /Users/bin-mac/CodeX/SecureStepClaw
```

如果你希望复制安装：

```bash
openclaw plugins install /Users/bin-mac/CodeX/SecureStepClaw
```

这个仓库通过以下两个位置声明了原生插件入口：

- [`openclaw.plugin.json`](./openclaw.plugin.json)
- [`package.json`](./package.json) 中的 `openclaw.extensions`

### 4. 验证是否安装成功

```bash
openclaw plugins list
openclaw plugins info step-rollback
openclaw plugins doctor
```

### 5. 配置插件

在 OpenClaw 配置中启用 `step-rollback`，并填写真实的工作区与插件状态目录：

```json
{
  "plugins": {
    "allow": [
      "step-rollback"
    ],
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

加上 `plugins.allow: ["step-rollback"]` 之后，可以去掉启动时这类 warning：

```text
plugins.allow is empty; discovered non-bundled plugins may auto-load ...
```

### 6. 重启 Gateway

如果 Gateway 以服务方式运行：

```bash
openclaw gateway restart
```

如果 Gateway 在前台运行：

```bash
openclaw gateway run
```

重要：checkpoint 只会为“当前这个插件版本已经加载之后”发生的 tool 调用创建。更新插件代码后，请先重启 Gateway，再启动一个新的 session 进行回退测试。

### 7. 验证原生 RPC 接口

插件现在已经提供了更友好的 CLI 命令，正常使用时不需要再手写 JSON 参数。

列出 agents：

```bash
openclaw steprollback agents
```

如果你的 OpenClaw 配置只有 `agents.defaults`，Step Rollback 会把真正可用的运行时 agent 显示成 `main`。CLI 同时也接受 `--agent default` 和 `--agent defaults` 作为这个默认运行时 agent 的别名。

按 agent 列出 sessions：

```bash
openclaw steprollback sessions --agent main
```

session 列表会按最近更新时间倒序排列，时间会显示为可读格式，并且最新的一条会标记为 `latest`。

如果你仍然希望拿到机器可读的原始输出，可以在任意插件命令后加上 `--json`。

当然，如果你确实想直接调用原始 Gateway RPC，也仍然可以：

```bash
openclaw gateway call steprollback.status
openclaw gateway call steprollback.checkpoints.list --params '{"agentId":"main","sessionId":"<session-id>"}'
openclaw gateway call steprollback.rollback.status --params '{"agentId":"main","sessionId":"<session-id>"}'
```

像 `openclaw steprollback rollback-status`、`openclaw steprollback checkpoint`、`openclaw steprollback report` 这类读状态/管理类命令，如果当前 CLI 进程没有暴露直接可用的 Gateway caller，仍然会自动转成 `openclaw gateway call ...`。

修改状态的命令现在在 CLI 中都会优先走本地逻辑：
- `openclaw steprollback rollback` 会直接在插件进程里运行 rollback engine。
- `openclaw steprollback continue` 不会再从 CLI 里绕一圈插件 Gateway RPC。它会先在本地恢复 checkpoint，然后调用官方的 `openclaw agent --agent ... --message ... --json` 来启动新的 branch turn。

### 8. 使用 rollback 流程

1. 正常启动 OpenClaw 任务。
2. 让 agent 执行工具调用。
3. 如果你需要先确认有哪些 agent，可以先执行：

```bash
openclaw steprollback agents
```

4. 查看某个 agent 下的 sessions：

```bash
openclaw steprollback sessions --agent main
```

5. 查询 checkpoint 列表：

```bash
openclaw steprollback checkpoints --agent main --session <session-id>
```

如果这里仍然显示 `No checkpoints were found`，请优先检查：

1. 这个 session 是否是在最近一次插件重启之后新建的。
2. 这个 session 是否真的执行过一个或多个 tool 调用。
3. `plugins.allow` 是否包含 `step-rollback`。
4. 修改代码后是否已经重启 Gateway。
5. 你检查的是不是“Git 快照版本插件加载之后”新产生并真正执行过 tool 的 session。
6. 如果你是在终端里执行 `rollback`、`continue`、`checkout` 这类会修改 session 状态的命令，请确认 Gateway 仍在运行。

当 checkpoint 正常创建时，插件会把内容放在：

- `~/.openclaw/plugins/step-rollback/checkpoints/`：checkpoint 清单和运行时状态
- `~/.openclaw/plugins/step-rollback/checkpoints/_git/`：每个 workspace root 对应的 Git 快照仓库

最近的版本会只打印真正有用的 checkpoint 调试日志：

- 是否收到了 `before_tool_call` / `after_tool_call` hook
- 是否把 `toolCallId` 成功解析成了 `entryId/nodeIndex`
- 是否初始化了 Git 快照仓库
- 每次 checkpoint 提交前当前 workspace 的 Git 脏状态摘要
- checkpoint 的创建与 reconcile 结果

如果你的 OpenClaw 配置里仍然写着 `/Users/you/...`，插件会自动改写到当前用户的 home 目录，并打印 warning。

6. 执行回退：

```bash
openclaw steprollback rollback --agent main --session <session-id> --checkpoint <checkpoint-id>
```

7. 确认 session 正在等待 continue：

```bash
openclaw steprollback rollback-status --agent main --session <session-id>
```

8. 继续执行。

重要：`continue` 现在不会再原地修改旧 session，而是先恢复 checkpoint 对应的 workspace，再创建一个新的 branch session，并通过 `openclaw agent` 启动新的 branch turn。命令输出会带上 `branchId`、`newSessionId`、`newSessionKey`。

不带 prompt：

```bash
openclaw steprollback continue --agent main --session <session-id>
```

典型返回字段：

```json
{
  "continued": true,
  "branchId": "br_0001",
  "newSessionId": "....",
  "newSessionKey": "agent:main:direct:step-rollback-br_0001"
}
```

带 prompt：

```bash
openclaw steprollback continue --agent main --session <session-id> --prompt "Continue from here, but inspect dependencies first."
```

### 9. 使用 checkout 流程

列出可 checkout 的节点：

```bash
openclaw steprollback nodes --agent main --session <session-id>
```

基于节点创建新 session：

```bash
openclaw steprollback checkout --agent main --source-session <session-id> --entry <entry-id> --continue --prompt "Continue on a new branch from here."
```

查询 branch record：

```bash
openclaw steprollback branch --branch <branch-id>
```

## 剩余注意事项

目前主要有以下几点需要注意：

1. 原生注册路径已经实现并通过 mock OpenClaw API 测试，但还没有在这个仓库里连接真实 Gateway 二进制做联调。
2. 官方插件文档没有明确给出一个“从历史 entry 精确恢复同一 session 执行”的专门 runtime helper。
3. 因此，插件在 [`dist/native-plugin.js`](./dist/native-plugin.js) 中采用了“原生注册 + best-effort runtime bridge”的做法，必要时会调用 Gateway 的 `agent` 入口。
4. 如果你本地的 OpenClaw 版本暴露的 runtime helper 名称不同，请调整 [`dist/native-plugin.js`](./dist/native-plugin.js) 中的 helper lookup。

## 验证方式

在仓库根目录运行：

```bash
npm test
```

当前测试覆盖了以下能力：

- checkpoint 创建
- rollback 与 continue
- checkpoint 数量裁剪
- checkout 分支元数据

## OpenClaw 官方参考

下面这些官方文档是本文安装和运行说明的参考依据：

- Plugins: https://docs.openclaw.ai/tools/plugin
- Plugin manifest: https://docs.openclaw.ai/plugins/manifest
- Plugin CLI: https://docs.openclaw.ai/cli/plugins
- Gateway CLI: https://docs.openclaw.ai/cli/gateway
- Agent loop and plugin lifecycle hooks: https://docs.openclaw.ai/agent-loop
