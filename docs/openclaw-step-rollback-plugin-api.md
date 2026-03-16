# API 设计：OpenClaw Step Rollback Plugin

## 文档状态

- 状态：Draft v2
- 日期：2026-03-16
- 对应 PRD：[openclaw-step-rollback-plugin-prd.md](/Users/bin-mac/CodeX/docs/openclaw-step-rollback-plugin-prd.md)
- 对应架构：[openclaw-step-rollback-plugin-architecture.md](/Users/bin-mac/CodeX/docs/openclaw-step-rollback-plugin-architecture.md)
- 插件 id：`step-rollback`

## 1. 目标

本 API 设计严格对应当前 PRD 的两阶段范围。

### Phase 1 API 目标

提供 Gateway 模式下最小可用接口：

- 查询 checkpoint 列表
- 查询 rollback 状态
- 触发 rollback
- rollback 后进入可继续状态
- 用户显式触发 continue
- continue 时支持可选 prompt

### Phase 2 API 目标

新增 session checkout：

- 查看可 checkout 节点
- 基于节点 checkout 新 session
- 返回新 session 信息
- checkout 后如果继续执行，也支持可选 prompt

## 2. API 范围

本设计包含三类接口：

1. 插件配置 API
2. Gateway RPC / 前端消费 API
3. 插件内部运行接口

不在本版范围：

- 复杂 CLI 全家桶
- 通用外部系统补偿接口
- 一开始就支持所有 tool 的定制 restore adapter

## 3. 设计依据

本 API 假设当前 OpenClaw 支持：

- Native plugin manifest
- runtime hook 注册
- Gateway method 注册
- session 文件由 Gateway 管理

官方文档：

- Plugins: https://docs.openclaw.ai/tools/plugin
- Plugin Manifest: https://docs.openclaw.ai/plugins/manifest
- Sessions: https://docs.openclaw.ai/sessions

## 4. 插件配置 API

## 4.1 `openclaw.plugin.json`

```json
{
  "id": "step-rollback",
  "name": "Step Rollback",
  "version": "0.1.0",
  "description": "Gateway rollback and session checkout plugin for OpenClaw.",
  "runtime": {
    "entry": "./dist/index.js"
  },
  "configSchema": {
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "default": true },
      "workspaceRoots": {
        "type": "array",
        "items": { "type": "string" },
        "default": ["~/.openclaw/workspace"]
      },
      "checkpointDir": {
        "type": "string",
        "default": "~/.openclaw/plugins/step-rollback/checkpoints"
      },
      "registryDir": {
        "type": "string",
        "default": "~/.openclaw/plugins/step-rollback/registry"
      },
      "runtimeDir": {
        "type": "string",
        "default": "~/.openclaw/plugins/step-rollback/runtime"
      },
      "reportsDir": {
        "type": "string",
        "default": "~/.openclaw/plugins/step-rollback/reports"
      },
      "maxCheckpointsPerSession": { "type": "number", "default": 100 },
      "allowContinuePrompt": { "type": "boolean", "default": true },
      "stopRunBeforeRollback": { "type": "boolean", "default": true }
    },
    "additionalProperties": false
  }
}
```

## 4.2 运行时配置结构

```ts
interface StepRollbackConfig {
  enabled: boolean;
  workspaceRoots: string[];
  checkpointDir: string;
  registryDir: string;
  runtimeDir: string;
  reportsDir: string;
  maxCheckpointsPerSession: number;
  allowContinuePrompt: boolean;
  stopRunBeforeRollback: boolean;
}
```

## 5. 公共数据模型

## 5.1 CheckpointRecord

```ts
interface CheckpointRecord {
  checkpointId: string;
  agentId: string;
  sessionId: string;
  entryId: string;
  nodeIndex: number;
  toolName: string;
  createdAt: string;
  snapshotRef: string;
  status: "ready" | "restoring" | "restored" | "failed" | "expired";
  summary: string;
}
```

## 5.2 SessionRuntimeState

```ts
interface SessionRuntimeState {
  agentId: string;
  sessionId: string;
  activeHeadEntryId: string | null;
  currentRunId: string | null;
  rollbackInProgress: boolean;
  awaitingContinue: boolean;
  lastContinuePrompt?: string;
  lastRollbackCheckpointId?: string;
  updatedAt: string;
}
```

## 5.3 RollbackRecord

```ts
interface RollbackRecord {
  rollbackId: string;
  agentId: string;
  sessionId: string;
  checkpointId: string;
  targetEntryId: string;
  triggeredAt: string;
  result: "success" | "failed";
  message?: string;
}
```

## 5.4 SessionBranchRecord

仅用于 Phase 2：

```ts
interface SessionBranchRecord {
  branchId: string;
  sourceSessionId: string;
  sourceEntryId: string;
  newSessionId: string;
  createdAt: string;
}
```

## 6. Phase 1：Gateway API

Phase 1 的主接口全部围绕 checkpoint 与 rollback。

建议命名空间：

- `steprollback.*`

## 6.1 `steprollback.status`

### 作用

返回插件与当前运行状态。

### 请求

```json
{}
```

### 响应

```json
{
  "pluginId": "step-rollback",
  "enabled": true,
  "gatewayModeOnly": true,
  "allowContinuePrompt": true
}
```

## 6.2 `steprollback.checkpoints.list`

### 作用

返回某个 session 当前可见的 checkpoint 列表，供前端渲染和点击回退。

### 请求

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5"
}
```

### 响应

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "checkpoints": [
    {
      "checkpointId": "ckpt_0008",
      "entryId": "e6d43994",
      "nodeIndex": 8,
      "toolName": "write",
      "createdAt": "2026-03-16T10:22:11.000Z",
      "status": "ready",
      "summary": "before tool write"
    }
  ]
}
```

## 6.3 `steprollback.checkpoints.get`

### 作用

查询单个 checkpoint 详情。

### 请求

```json
{
  "checkpointId": "ckpt_0008"
}
```

### 响应

```json
{
  "checkpoint": {
    "checkpointId": "ckpt_0008",
    "agentId": "main",
    "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
    "entryId": "e6d43994",
    "nodeIndex": 8,
    "toolName": "write",
    "createdAt": "2026-03-16T10:22:11.000Z",
    "snapshotRef": "/Users/bin-mac/.openclaw/plugins/step-rollback/checkpoints/ckpt_0008",
    "status": "ready",
    "summary": "before tool write"
  }
}
```

## 6.4 `steprollback.rollback`

### 作用

用户点击某个 checkpoint 后触发 rollback。

这是第一阶段的核心 API。

### 请求

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "checkpointId": "ckpt_0008"
}
```

### 处理语义

服务端必须按以下顺序处理：

1. 校验 checkpoint 是否存在
2. 锁定当前 session
3. 停止或中止当前 run
4. 恢复 snapshot
5. 更新 `SessionRuntimeState.activeHeadEntryId`
6. 将 `SessionRuntimeState.awaitingContinue` 置为 `true`
7. 写入 rollback 记录

### 响应

```json
{
  "rollbackId": "rb_0003",
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "checkpointId": "ckpt_0008",
  "targetEntryId": "e6d43994",
  "result": "success",
  "awaitingContinue": true,
  "activeHeadEntryId": "e6d43994"
}
```

## 6.5 `steprollback.continue`

### 作用

在 rollback 完成后，由用户显式触发继续执行。

用户可以：

- 不提供 prompt，直接继续
- 提供一个 prompt，作为回退后的补充指令

### 请求

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "prompt": "回到这里之后，不要再写配置文件，先重新检查依赖。"
}
```

`prompt` 是可选字段。

### 处理语义

服务端必须：

1. 校验当前 session 是否处于 `awaitingContinue=true`
2. 读取当前 `activeHeadEntryId`
3. 如果带了 `prompt`，则把它作为回退后的补充输入
4. 重新启动执行
5. 成功后将 `awaitingContinue` 置回 `false`

### 响应

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "continued": true,
  "activeHeadEntryId": "e6d43994",
  "usedPrompt": true
}
```

## 6.6 `steprollback.rollback.status`

### 作用

查询某个 session 当前 rollback 运行状态。

### 请求

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5"
}
```

### 响应

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "rollbackInProgress": false,
  "awaitingContinue": true,
  "activeHeadEntryId": "e6d43994",
  "lastRollbackCheckpointId": "ckpt_0008"
}
```

## 6.7 `steprollback.reports.get`

### 作用

获取某次 rollback 的结果报告。

### 请求

```json
{
  "rollbackId": "rb_0003"
}
```

### 响应

```json
{
  "rollbackId": "rb_0003",
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "checkpointId": "ckpt_0008",
  "result": "success",
  "message": "rollback completed, waiting for continue"
}
```

## 7. Phase 1：前端消费契约

第一阶段前端最少需要两个能力：

1. 拉取 checkpoint 列表
2. 点击后触发 rollback

因此前端最小交互流是：

```text
页面加载
  -> steprollback.checkpoints.list
  -> 渲染 checkpoint 列表

用户点击某项
  -> steprollback.rollback
  -> 轮询 steprollback.rollback.status
  -> 如果 awaitingContinue=true，展示 continue 按钮和可选 prompt 输入框

用户点击 continue
  -> steprollback.continue
  -> 完成后刷新 checkpoint 列表
```

如果 Gateway 支持事件推送，后续可再补：

- `checkpoint_created`
- `rollback_started`
- `rollback_finished`

但第一阶段不是必需条件。

## 8. Phase 2：Session Checkout API

第二阶段新增 API，围绕节点 checkout 和新 session 创建。

## 8.1 `steprollback.session.nodes.list`

### 作用

返回某个 session 的可 checkout 节点列表。

### 请求

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5"
}
```

### 响应

```json
{
  "agentId": "main",
  "sessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "nodes": [
    {
      "entryId": "e6d43994",
      "nodeIndex": 8,
      "kind": "checkpoint",
      "toolName": "write",
      "createdAt": "2026-03-16T10:22:11.000Z",
      "checkoutAvailable": true
    }
  ]
}
```

## 8.2 `steprollback.session.checkout`

### 作用

基于某个节点创建新 session。

### 请求

```json
{
  "agentId": "main",
  "sourceSessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "sourceEntryId": "e6d43994",
  "continueAfterCheckout": true,
  "prompt": "从这里继续，但先检查为什么上一轮写错了。"
}
```

`prompt` 是可选字段。

### 处理语义

服务端必须：

1. 校验目标节点是否可 checkout
2. 找到该节点对应状态
3. 创建新 session
4. 建立 `SessionBranchRecord`
5. 将新 session 的运行起点设到目标节点
6. 如果 `continueAfterCheckout=true`，则在新 session 中继续执行
7. 如果带了 `prompt`，则把它作为 checkout 后继续执行的补充输入

### 响应

```json
{
  "branchId": "br_0001",
  "sourceSessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "sourceEntryId": "e6d43994",
  "newSessionId": "9b12e7f0-0a1a-4f6b-b9fc-123456789abc",
  "continued": true,
  "usedPrompt": true
}
```

## 8.3 `steprollback.session.branch.get`

### 作用

获取 checkout 生成的新旧 session 关联信息。

### 请求

```json
{
  "branchId": "br_0001"
}
```

### 响应

```json
{
  "branchId": "br_0001",
  "sourceSessionId": "140c0728-5d76-4362-be52-3d92aafc93f5",
  "sourceEntryId": "e6d43994",
  "newSessionId": "9b12e7f0-0a1a-4f6b-b9fc-123456789abc",
  "createdAt": "2026-03-16T11:05:00.000Z"
}
```

## 9. 内部运行接口

这部分不直接暴露给用户，但实现阶段必须稳定定义。

## 9.1 Hook 输入

### `before_tool_call`

```ts
interface BeforeToolCallContext {
  agentId: string;
  sessionId: string;
  entryId: string;
  nodeIndex: number;
  toolName: string;
}
```

用途：

- 触发 checkpoint 创建

### `after_tool_call`

```ts
interface AfterToolCallContext {
  agentId: string;
  sessionId: string;
  entryId: string;
  nodeIndex: number;
  toolName: string;
  success: boolean;
}
```

用途：

- 更新 checkpoint 状态

## 9.2 CheckpointManager 接口

```ts
interface CheckpointManager {
  create(ctx: BeforeToolCallContext): Promise<CheckpointRecord>;
  restore(checkpointId: string): Promise<void>;
  list(agentId: string, sessionId: string): Promise<CheckpointRecord[]>;
}
```

## 9.3 RuntimeCursorManager 接口

```ts
interface RuntimeCursorManager {
  get(agentId: string, sessionId: string): Promise<SessionRuntimeState | null>;
  setActiveHead(agentId: string, sessionId: string, entryId: string): Promise<void>;
  setRollbackState(agentId: string, sessionId: string, inProgress: boolean): Promise<void>;
  setAwaitingContinue(agentId: string, sessionId: string, awaiting: boolean): Promise<void>;
}
```

## 9.4 SessionCheckoutManager 接口

仅 Phase 2 实现：

```ts
interface SessionCheckoutManager {
  checkout(agentId: string, sourceSessionId: string, sourceEntryId: string): Promise<SessionBranchRecord>;
}
```

## 10. 错误模型

## 10.1 错误结构

```ts
interface StepRollbackError {
  code:
    | "CHECKPOINT_NOT_FOUND"
    | "SESSION_NOT_FOUND"
    | "ENTRY_NOT_FOUND"
    | "ROLLBACK_IN_PROGRESS"
    | "NOT_WAITING_CONTINUE"
    | "RUN_STOP_FAILED"
    | "SNAPSHOT_RESTORE_FAILED"
    | "CONTINUE_START_FAILED"
    | "CHECKOUT_NOT_SUPPORTED"
    | "BRANCH_CREATE_FAILED";
  message: string;
  details?: Record<string, unknown>;
}
```

## 10.2 主要错误码语义

- `CHECKPOINT_NOT_FOUND`
  - 目标 checkpoint 不存在
- `ROLLBACK_IN_PROGRESS`
  - 当前 session 正在回退中
- `NOT_WAITING_CONTINUE`
  - 当前 session 不处于可继续状态
- `RUN_STOP_FAILED`
  - 当前 run 无法被安全停止
- `SNAPSHOT_RESTORE_FAILED`
  - snapshot 恢复失败
- `CONTINUE_START_FAILED`
  - continue 重新启动执行失败
- `CHECKOUT_NOT_SUPPORTED`
  - 当前节点不允许 checkout

## 11. API 版本策略

建议第一阶段不做复杂版本体系，直接从 `v1` 开始。

规则：

1. Phase 1 先稳定 `status / checkpoints.list / rollback / continue / rollback.status`
2. Phase 2 再增量加入 `session.nodes.list / session.checkout / session.branch.get`
3. 尽量只做“加字段，不改语义”

## 12. 最终接口集

与当前 PRD 对齐后的最小 API 集如下。

### Phase 1

- `steprollback.status`
- `steprollback.checkpoints.list`
- `steprollback.checkpoints.get`
- `steprollback.rollback`
- `steprollback.continue`
- `steprollback.rollback.status`
- `steprollback.reports.get`

### Phase 2

- `steprollback.session.nodes.list`
- `steprollback.session.checkout`
- `steprollback.session.branch.get`

这一组接口已经足够支撑：

- 第一阶段的 checkpoint 列表 + 点击回退 + rollback 后 continue（可选 prompt）
- 第二阶段的节点 checkout + 新 session 续跑
