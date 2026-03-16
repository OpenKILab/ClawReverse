# 架构设计：OpenClaw Step Rollback Plugin

## 文档状态

- 状态：Draft v2
- 日期：2026-03-16
- 对应 PRD：[openclaw-step-rollback-plugin-prd.md](/Users/bin-mac/CodeX/docs/openclaw-step-rollback-plugin-prd.md)
- 插件形态：OpenClaw Native Plugin
- 插件 id：`step-rollback`

## 1. 目标

本设计文档只服务于当前 PRD 的两阶段目标，不再提前做过度泛化。

### Phase 1

只解决 Gateway 模式下的基础回退：

- 每次 tool 调用前自动保存 checkpoint
- 执行中可以展示 checkpoint 列表
- 用户点击某个 checkpoint 后 rollback
- rollback 后进入可继续状态
- 用户如果选择 continue，可以从该 checkpoint 继续执行
- continue 时允许用户附加一个 prompt，也可以不附加

### Phase 2

在某个节点上 checkout，创建新 session 续跑：

- 保留原 session
- 新 session 从目标节点开始继续执行
- 如果用户需要继续，也可以带一个可选 prompt

## 2. 设计原则

### 2.1 只做 Gateway

第一阶段只接入 OpenClaw Gateway，不覆盖 `openclaw agent` 直连模式。

### 2.2 session 负责定位，snapshot 负责恢复

`session.jsonl` 回答“回到哪里”。

snapshot 回答“怎么回去”。

### 2.3 checkpoint 粒度固定为 tool 前

第一阶段不保存每一步推理状态，只在 **每次 tool 调用前** 保存 checkpoint。

这是因为：

- 真正明确的状态变更几乎都发生在 tool 调用边界
- 这样最简单，也最适合在 Gateway 生命周期中接入

### 2.4 Phase 1 不新建 session

第一阶段 rollback 后，不新建 session，而是先进入“等待 continue”的状态。

这不是 checkout，不生成新 session id。

### 2.5 Phase 2 才做 checkout / branch

第二阶段才引入真正的 session 分支：

- checkout 某个节点
- 新建 session
- 从该节点状态继续执行

## 3. 设计依据

该设计依赖于当前 OpenClaw 的几个能力：

- Native plugin 由 Gateway 加载并在进程内运行
- 插件可以注册 runtime hook、command、CLI、Gateway 方法、service
- session 由 Gateway 管理，并持久化为：
  - `sessions.json`
  - `<sessionId>.jsonl`
- transcript 是 append-only JSONL，且具备 `id` / `parentId` 结构

这些能力来自 OpenClaw 官方文档：

- Plugins: https://docs.openclaw.ai/tools/plugin
- Plugin Manifest: https://docs.openclaw.ai/plugins/manifest
- Sessions: https://docs.openclaw.ai/sessions
- Session Management Deep Dive: https://docs.openclaw.ai/reference/session-management-compaction

## 4. 总体架构

```text
                 +-----------------------------+
                 |       OpenClaw Gateway      |
                 |   session / run / tool loop |
                 +--------------+--------------+
                                |
                                v
                 +------------------------------+
                 |    Step Rollback Plugin      |
                 +------------------------------+
                 |  1. Hook Adapter             |
                 |  2. Checkpoint Manager       |
                 |  3. Checkpoint Registry      |
                 |  4. Rollback Controller      |
                 |  5. Continue Controller      |
                 |  6. Runtime Cursor Manager   |
                 |  7. Gateway API Adapter      |
                 |  8. Session Checkout Manager |
                 +------------------------------+
                                |
                                v
                 +------------------------------+
                 |           Storage            |
                 | - OpenClaw session files     |
                 | - plugin checkpoints         |
                 | - plugin runtime state       |
                 | - plugin reports             |
                 +------------------------------+
```

## 5. Phase 1 架构

## 5.1 核心组件

### 5.1.1 Hook Adapter

负责接入 Gateway 生命周期。

最关键的接入点是：

- `before_tool_call`
- `after_tool_call`
- `session_start`
- `session_end`

其中第一阶段最重要的是 `before_tool_call`。

作用：

- 在每次 tool 调用前触发 checkpoint
- 捕获当前 session、entry、tool 元数据

### 5.1.2 Checkpoint Manager

负责 checkpoint 的创建和恢复。

职责：

- 在 tool 调用前创建 snapshot
- 写入 checkpoint 元数据
- 执行 rollback 时恢复 snapshot

第一阶段恢复范围只包括：

- 当前工作区
- 插件自有运行状态
- 与当前任务恢复相关的本地元数据

### 5.1.3 Checkpoint Registry

负责维护 checkpoint 列表。

职责：

- 为 UI / Gateway API 提供 checkpoint 列表
- 维护 checkpoint 和 session / 节点 / tool 的映射
- 标记 checkpoint 是否可用、是否已失效

### 5.1.4 Rollback Controller

负责处理用户点击 checkpoint 后的回退流程。

职责：

1. 校验当前 run 状态
2. 暂停或停止当前继续执行
3. 恢复目标 checkpoint
4. 重置执行位置
5. 将 session 置为“等待 continue”状态

### 5.1.5 Continue Controller

负责处理 rollback 之后的继续执行。

职责：

1. 接收用户的 continue 请求
2. 接收可选 prompt
3. 基于当前 `activeHeadEntryId` 重新发起执行
4. 如果带了 prompt，则把 prompt 作为回退后的补充输入
5. 继续在当前 session 链路中执行

### 5.1.6 Runtime Cursor Manager

这是第一阶段最关键的额外控制层。

原因是：

- session transcript 是 append-only
- 第一阶段又不想创建新 session

因此需要一个插件自有的“运行游标”来记录：

- 当前 session 的有效继续点
- 当前 rollback 选中的目标 entry
- 当前是否处于等待 continue 状态
- 当前继续执行应该从哪个节点恢复

这个组件使第一阶段可以做到：

- 不改写历史 transcript
- 不创建新 session
- rollback 后先停在旧节点
- 用户确认 continue 后再从旧节点继续执行

### 5.1.7 Gateway API Adapter

负责把能力暴露给前端和调用方。

第一阶段最少需要：

- checkpoint 列表查询接口
- rollback 接口
- rollback 状态接口
- continue 接口

### 5.1.8 Report Writer

负责记录：

- checkpoint 创建日志
- rollback 成功 / 失败记录
- 当前 session 的 rollback 状态

## 5.2 存储结构

### 5.2.1 OpenClaw 自有存储

插件只读或有限配合使用：

```text
~/.openclaw/agents/<agentId>/sessions/sessions.json
~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
```

### 5.2.2 插件自有存储

建议目录：

```text
~/.openclaw/plugins/step-rollback/
  checkpoints/
  registry/
  runtime/
  reports/
```

建议含义：

- `checkpoints/`：snapshot 实体
- `registry/`：checkpoint 索引
- `runtime/`：当前 session 的运行游标、锁、状态
- `reports/`：rollback 报告

## 5.3 Phase 1 数据模型

### 5.3.1 CheckpointRecord

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

### 5.3.2 SessionRuntimeState

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

### 5.3.3 RollbackRecord

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

## 5.4 Phase 1 执行链路

## 5.4.1 正常执行时

```text
session_start
  -> 初始化 SessionRuntimeState

before_tool_call
  -> 解析当前 session / entry / tool
  -> 创建 snapshot
  -> 写入 CheckpointRecord
  -> 更新 checkpoint 列表

after_tool_call
  -> 更新 checkpoint 的执行后元数据
```

## 5.4.2 用户触发 rollback 时

```text
用户点击 checkpoint
  -> Rollback Controller 校验目标 checkpoint
  -> 对当前 session 加锁
  -> 停止或中断当前 run
  -> 恢复 snapshot
  -> Runtime Cursor Manager 更新 activeHeadEntryId
  -> Runtime Cursor Manager 设置 awaitingContinue=true
  -> 写入 rollback 记录
  -> 返回“已恢复，等待 continue”
```

## 5.5 Phase 1 “继续执行”设计

这一段需要单独说明。

第一阶段要求：

- rollback 后仍在当前 session 内继续执行
- continue 必须由用户显式触发
- 用户触发 continue 时可以额外给一段 prompt，也可以不给

但 session 又是 append-only。

因此第一阶段采用“软回退”机制：

1. 原 session 历史不删除
2. 插件在自己的 runtime state 中记录 `activeHeadEntryId`
3. rollback 完成后，把 session 标记为 `awaitingContinue=true`
4. 用户如果选择 continue，则：
   - 可以不给 prompt，直接从 `activeHeadEntryId` 继续
   - 也可以给一段 prompt，作为回退后的补充输入
5. 后续恢复执行时，不再以 transcript 最后一个 entry 作为继续点，而是以 `activeHeadEntryId` 作为继续点
6. 新的执行结果继续写入当前 session，但逻辑上从目标节点续接

这等价于：

- 第一阶段不显式创建新 session
- rollback 后先进入等待 continue 状态
- 用户确认 continue 后，运行上具备“从旧节点恢复”的能力

## 5.6 Phase 1 UI 视图要求

前端至少需要一个 checkpoint 列表面板。

每项展示：

- 序号
- 时间
- tool 名称
- 摘要
- 状态
- 回退按钮

在用户执行 rollback 成功后，前端还需要展示 continue 区域：

- continue 按钮
- 一个可选 prompt 输入框

前端不需要在第一阶段实现完整 session 树，只要能完成：

- 列表查看
- 点击 rollback

## 5.7 Phase 1 锁与并发

对同一 session 需要至少一把 restore lock。

原因：

- 避免 rollback 和当前执行并发修改工作区
- 避免同一个 session 被多次同时回退

第一阶段建议策略：

- rollback 前必须先进入 session lock
- 如果 session 仍在执行，先停止 run，再恢复 snapshot

## 5.8 Phase 1 失败处理

### 失败类型

1. checkpoint 不存在
2. snapshot 恢复失败
3. 当前 run 无法停止
4. runtime cursor 更新失败
5. continue 重新启动失败

### 处理原则

- 失败时不继续执行
- 写入失败报告
- 保留当前现场供人工处理

## 6. Phase 2 架构

## 6.1 新增目标

第二阶段不再只是“当前 session 内软回退”，而是支持：

- checkout 某个节点
- 新建 session
- 新 session 从该节点继续执行

## 6.2 新增组件

### 6.2.1 Session Checkout Manager

负责 checkout 的整体流程。

职责：

1. 接收目标节点
2. 校验节点可 checkout
3. 基于目标节点状态创建新 session
4. 复制或生成新 session 的运行起点
5. 如果用户选择继续执行，则接收一个可选 prompt
6. 启动新 session 的继续执行

### 6.2.2 Session Branch Registry

负责记录 session 之间的派生关系。

建议记录：

- sourceSessionId
- sourceEntryId
- newSessionId
- createdAt

## 6.3 Phase 2 执行链路

```text
用户点击 checkout
  -> Session Checkout Manager 校验目标节点
  -> 找到对应 checkpoint / 目标状态
  -> 创建新 session
  -> 将新 session 的 activeHeadEntryId 指向目标节点
  -> 如果用户需要继续，则在新 session 中继续执行
  -> 继续时允许附加一个可选 prompt
  -> 原 session 保持不变
```

## 6.4 Phase 2 与 OpenClaw session 模型的关系

第二阶段必须尽量与 OpenClaw 当前 session 文件组织保持兼容。

兼容点包括：

- `sessions.json`
- `<sessionId>.jsonl`
- `id` / `parentId` 结构

另外需要参考：

- `pinchbench/skill` 对 OpenClaw session 文件的消费方式

设计原则是：

- 不发明完全独立的一套 session 系统
- 尽量在现有 OpenClaw session 模型上增加 checkout / branch 能力

## 7. 快照策略

## 7.1 第一阶段

默认策略：

- 每次 tool 调用前做一次 snapshot

优先级：

1. 简单可用
2. 恢复正确
3. 性能后续优化

## 7.2 后续可优化方向

后续可以再考虑：

- 只对 mutating tool 保存
- 差量 snapshot
- 按路径粒度保存

但这些都不应阻塞第一阶段实现。

## 8. 最终设计决策

这版架构只保留三条主线：

### 主线 1：Phase 1

- Gateway only
- tool 调用前 checkpoint
- checkpoint 列表
- rollback
- rollback 后等待 continue
- continue 时支持可选 prompt

### 主线 2：Phase 1 的运行控制

- 通过插件自有 runtime cursor 做“当前 session 内软回退”
- 不修改历史 transcript
- 不创建新 session

### 主线 3：Phase 2

- checkout 某个节点
- 新建 session
- 新 session 继续执行
- checkout 后 continue 时支持可选 prompt

这个拆分与 PRD 完全一致，也能给后续真正实现留出稳定的演进路径。
