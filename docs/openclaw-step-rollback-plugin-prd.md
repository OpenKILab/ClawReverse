# PRD：OpenClaw Step Rollback Plugin

## 文档状态

- 状态：Draft v2
- 日期：2026-03-16
- 产品形态：OpenClaw Native Plugin
- 工作名：`step-rollback`

## 1. 背景

我们希望为 OpenClaw 增加一个“按执行节点回退”的能力，核心目标不是做一个很重的通用恢复系统，而是先解决 Gateway 运行时最常见的两个问题：

1. Agent 在连续执行多个 tool 调用后改坏了本地工作区，用户需要快速回退。
2. 回退之后，Agent 不能只是“停在过去”，还要支持从回退点继续执行任务；继续执行时，用户可以补充一段 prompt，也可以不补充。

之前的 PRD 设计过宽，提前引入了过多的通用化能力。这个版本将范围收紧为两个明确阶段：

- 第一阶段：先把 Gateway 模式下的保存、展示、回退、继续执行做出来。
- 第二阶段：再补 session 管理和 checkout，新开 session 续跑。

## 2. 产品目标

## 第一目标

在 OpenClaw 的 `gateway` 运行模式下，实现一个可用的基础回退能力：

- 在执行期间自动保存 checkpoint
- 展示 checkpoint 列表
- 用户点击某个 checkpoint 后执行 rollback
- rollback 后系统进入可继续状态
- 如果用户选择 continue，可以从该 checkpoint 继续执行
- continue 时用户可以提供一个新的 prompt，也可以不提供

## 第二目标

在基础回退能力稳定后，引入按节点 checkout 的 session 管理能力：

- 用户在某个节点上点击 checkout
- 系统基于该节点新建一个 session
- 新 session 从该节点对应的状态继续执行后续任务
- 如果用户需要继续，也可以附加一个 prompt，也可以不附加

## 3. 产品边界

## 本次 PRD 聚焦范围

- 仅关注 OpenClaw **Gateway 模式**
- 仅关注本地可恢复状态
- 以 `session.jsonl` 作为执行轨迹索引
- 以 snapshot / checkpoint 作为实际恢复手段

## 不在第一阶段范围内

- `openclaw agent` 直连模式
- 第三方外部系统的真正撤销，例如发出的消息、邮件、远程 API 写入
- 一开始就做完整的 session 分支树管理
- 一开始就覆盖所有 tool 类型的定制恢复

## 4. 关键判断

这是本产品最重要的设计前提。

### 4.1 回退点来自 session，恢复动作来自 snapshot

`session.jsonl` 负责回答“回到哪里”。

snapshot 负责回答“怎么回去”。

也就是说：

- `session.jsonl` 是执行轨迹和 checkpoint 索引
- snapshot 是本地状态恢复材料

单靠 `session.jsonl` 不能真正撤销文件改动。

### 4.2 第一阶段不需要每一步都保存

OpenClaw 在运行中，真正有明确状态变化边界的通常是 **tool 调用前后**，尤其是文件写入、编辑、执行命令等动作。

因此第一阶段采用最直接的策略：

- **每次 tool 调用之前保存一个 checkpoint**

不需要对模型推理的每一步、每一条 message、每一个 token 都保存状态。

这样做的好处是：

- 简单
- 可解释
- 易于在 Gateway 中接入
- 足以覆盖大多数本地工作区损坏场景

### 4.3 第一阶段 rollback 后仍在当前运行链路继续

第一阶段不做完整 session checkout。

用户回退后，系统直接：

1. 恢复到所选 checkpoint 对应的本地状态
2. 把当前执行上下文重置到该 checkpoint 对应的执行节点
3. 进入“等待继续执行”的状态
4. 如果用户选择 continue，则让 Agent 从该点继续执行
5. continue 时，用户可以额外给一段 prompt，也可以不给

换句话说，第一阶段重点是“回退 -> 等待用户决定是否继续 -> 继续续跑”，而不是“回退并分叉一个新 session”。

### 4.4 第二阶段再引入 checkout / 新 session

第二阶段才处理：

- 从某个节点 checkout
- 基于该节点新建 session
- 在新 session 中继续执行
- 如果用户需要，也允许在 checkout 后继续时提供可选 prompt

这部分要与 OpenClaw 现有 session 存储模型对齐，并参考你提到的 `pinchbench/skill` 仓库对 session 文件消费和运行组织的方式做兼容性设计。

## 5. 目标用户

## 用户 1：本地开发者

在本机通过 Gateway 跑 OpenClaw，让 Agent 改代码、跑命令、处理工作区，希望出错时快速回退。

## 用户 2：高级操作者

希望在一个长任务里看到多个 checkpoint，手动选择回退点，而不是只能整段重来。

## 用户 3：后续的任务编排使用者

希望在某个节点 checkout 出新 session，保留旧历史，同时在新分支上续跑。

## 6. 当前依赖和假设

本 PRD 基于以下假设：

1. OpenClaw 的 session 仍由 Gateway 统一管理。
2. OpenClaw 当前 session 数据以 `sessions.json` 和 `<sessionId>.jsonl` 形式持久化。
3. `session.jsonl` 中可以定位出用户消息、assistant 消息、tool call、tool result 等关键节点。
4. 插件可以在 Gateway 运行时接入 tool 调用生命周期，至少能在 tool 调用前后执行自定义逻辑。
5. 第一阶段只要求恢复本地工作区和插件自有状态，不承诺恢复外部副作用。

## 7. 产品方案总览

## Phase 1：基础回退能力（Gateway Only）

### 目标

实现最小可用版本：

- 运行时自动保存 checkpoint
- 提供 checkpoint 列表
- 用户点击某个 checkpoint 执行 rollback
- rollback 后当前任务进入可继续状态
- 用户如果选择 continue，可以继续执行
- continue 时可选输入一个 prompt

### 用户可感知能力

1. 用户启动 Gateway 后，插件自动生效。
2. 每次 tool 调用前自动创建 checkpoint。
3. 执行界面中能看到一个 checkpoint 列表。
4. 每个 checkpoint 显示基本信息：
   - 序号
   - 时间
   - 对应 tool 名称
   - 简短说明
5. 用户点击某个 checkpoint 后：
   - 当前运行被暂停或中止
   - 本地状态恢复
   - 执行上下文回到该 checkpoint
   - 系统进入等待 continue 的状态
   - 用户可以直接 continue，或者输入一个 prompt 后 continue

### 核心规则

#### 规则 1：checkpoint 粒度

第一阶段 checkpoint 粒度固定为：

- **每次 tool 调用前**

不做更细粒度切分。

#### 规则 2：恢复范围

第一阶段恢复范围只覆盖：

- 当前工作区
- 插件自己维护的运行状态
- 与当前任务恢复直接相关的本地元数据

不覆盖：

- 已经发出的外部消息
- 外部 API 已产生的副作用
- 第三方系统状态

#### 规则 3：继续执行

rollback 完成后，不要求用户重新发起整个任务。

系统需要支持：

- 从 rollback 的 checkpoint 恢复
- 用户触发 continue 后继续跑后续步骤
- continue 时允许用户提供补充 prompt
- 该 prompt 是可选的

#### 规则 4：checkpoint 列表可见

第一阶段必须提供一个可供前端消费的 checkpoint 列表能力。

表现形式可以是：

- Gateway 对外暴露列表接口，前端渲染成侧边栏 / 弹层
- 或者内置一个简化列表面板

但从产品要求上，用户必须能：

- 看见可回退节点
- 点击节点触发 rollback

### 第一阶段不做的事

- 不做按任意历史节点 checkout 新 session
- 不做复杂的 session 树视图
- 不做跨 session 的 merge / compare
- 不做“自动判断最佳回退点”

## Phase 2：Session Checkout / Branch

### 目标

在某个节点点击 `checkout` 后，开一个新的 session 来继续执行任务。

### 用户可感知能力

1. 用户在某个 checkpoint 或某个 session 节点上点击 `checkout`
2. 系统新建一个 session
3. 新 session 从该节点对应状态开始继续执行
4. 原 session 保留，不被覆盖
5. 如果用户需要继续，也可以给一个 prompt，也可以不给

### Phase 2 的核心价值

第一阶段解决“回退并续跑”。

第二阶段解决“回退并分叉续跑”。

这意味着从第二阶段开始，回退不再只是恢复，而是引入接近版本控制的工作方式：

- 原 session 保留
- 新 session 作为分支继续发展

### 第二阶段范围

1. 基于节点创建新 session
2. 新旧 session 关系可追踪
3. checkout 后可以继续执行后续任务
4. checkout 后继续执行时支持可选 prompt
5. 节点级入口可以来自：
   - checkpoint
   - session timeline 中的某个执行节点

### 第二阶段设计约束

这一阶段必须兼容 OpenClaw 当前 session 存储方式，并参考：

- OpenClaw 的 `sessions.json`
- OpenClaw 的 `<sessionId>.jsonl`
- `pinchbench/skill` 仓库中对 OpenClaw session 文件的使用方式

## 8. 功能需求

## 8.1 Phase 1 功能需求

### FR-1 运行模式限制

插件第一阶段只支持 `gateway` 模式。

### FR-2 自动保存 checkpoint

在每次 tool 调用前，系统必须自动创建 checkpoint。

checkpoint 至少要记录：

- checkpointId
- sessionId
- runId 或当前执行标识
- 对应节点序号
- tool 名称
- 时间戳
- snapshot 路径或引用

### FR-3 checkpoint 列表

系统必须维护当前任务可见的 checkpoint 列表。

列表至少包含：

- checkpointId
- 序号
- 时间
- tool 名称
- 简短描述
- 是否可回退

### FR-4 rollback

用户点击某个 checkpoint 后，系统必须能够：

1. 停止当前继续向前执行
2. 恢复该 checkpoint 对应 snapshot
3. 将执行位置回到对应节点
4. 将当前任务置为“可继续”状态

### FR-5 当前 session 内继续执行

第一阶段 rollback 后，任务应支持在当前运行链路内继续执行。

本阶段不要求创建新 session。

### FR-6 Continue with optional prompt

在 Phase 1 中，系统必须支持用户在 rollback 之后显式触发 continue。

continue 时：

- 用户可以不提供 prompt，直接从 checkpoint 继续
- 用户也可以额外提供一段 prompt，作为回退后的补充指令
- 继续执行仍然发生在当前 session 链路内

### FR-7 最小 UI / 交互支持

第一阶段至少要有一个可被前端直接使用的 checkpoint 列表接口和 rollback 触发接口。

同时还必须有：

- continue 触发入口
- 可选 prompt 输入入口

## 8.2 Phase 2 功能需求

### FR-7 节点 checkout

用户可以在某个 checkpoint 或 session 节点上执行 checkout。

### FR-8 新 session 创建

checkout 后系统必须创建一个新的 session。

### FR-9 新 session 续跑

新 session 必须从被 checkout 的节点状态继续执行，而不是从头开始。

如果 checkout 后需要立即继续执行，则：

- 可以不提供 prompt
- 也可以提供一段新的 prompt

### FR-10 session 关联关系

系统必须能记录：

- 原 session
- 新 session
- checkout 来源节点

## 9. 非功能需求

## 9.1 可理解性

用户必须清楚知道：

- 当前有哪些 checkpoint
- 回退到哪里
- 回退后是继续当前任务，还是新建 session

## 9.2 性能

第一阶段 checkpoint 必然会增加 I/O 开销，因此需要控制：

- snapshot 速度
- snapshot 大小
- 单任务 checkpoint 数量

第一阶段可以接受“功能优先，性能次优”，但不能慢到让 Gateway 无法使用。

## 9.3 审计性

每次 rollback 至少要留下可追踪记录：

- 谁触发
- 回到哪个 checkpoint
- 是否成功
- rollback 后是否继续执行

## 10. 用户流程

## 10.1 Phase 1：运行中回退

1. 用户通过 Gateway 发起任务
2. Agent 开始执行
3. 每次 tool 调用前自动创建 checkpoint
4. 前端显示 checkpoint 列表
5. 用户点击某个 checkpoint
6. 系统执行 rollback
7. 系统进入等待 continue 的状态
8. 用户选择是否 continue
9. 如果用户 continue：
   - 可以输入 prompt，也可以不输入
   - Agent 从该 checkpoint 继续执行

## 10.2 Phase 2：checkout 新 session

1. 用户查看某个 session timeline
2. 用户在一个节点上点击 checkout
3. 系统创建新的 session
4. 新 session 从该节点状态启动
5. 后续任务在新 session 中继续

## 11. 数据与状态设计

## 11.1 Phase 1 最小数据对象

### Checkpoint

- checkpointId
- sessionId
- nodeIndex
- toolName
- createdAt
- snapshotRef
- status

### Rollback Record

- rollbackId
- sessionId
- fromCheckpointId
- triggeredAt
- result

## 11.2 Phase 2 新增对象

### Session Branch Record

- branchId
- sourceSessionId
- sourceNodeId
- newSessionId
- createdAt

## 12. 里程碑

## Milestone 1：Phase 1 可用版

交付内容：

- Gateway 模式接入
- 每次 tool 调用前自动 checkpoint
- checkpoint 列表
- 手动 rollback
- rollback 后等待 continue
- continue 时支持可选 prompt

验收标准：

1. 用户可以在执行过程中看到 checkpoint 列表
2. 用户可以点击任一 checkpoint 触发回退
3. 工作区恢复到对应 checkpoint 状态
4. rollback 后系统进入可继续状态
5. 用户可以选择 continue
6. continue 时可以带 prompt，也可以不带
7. Agent 能从该 checkpoint 继续执行

## Milestone 2：Phase 2 checkout 版

交付内容：

- 节点级 checkout
- 新 session 创建
- 新 session 续跑
- session 关联元数据

验收标准：

1. 用户可以在某个节点上执行 checkout
2. 系统会生成新 session
3. 新 session 从 checkout 节点继续执行
4. 原 session 不丢失

## 13. 风险

## 风险 1：checkpoint 数量过多

因为第一阶段是“每次 tool 调用前都保存”，长任务会产生大量 checkpoint。

应对方式：

- 单 session 设上限
- 滚动淘汰旧 checkpoint
- 后续再优化差量 snapshot

## 风险 2：外部副作用无法撤销

rollback 只能保证本地状态恢复，不能承诺撤销外部世界中的副作用。

应对方式：

- 第一阶段 PRD 中明确声明只恢复本地状态
- UI 上明确标记这类风险

## 风险 3：rollback 与正在执行的 run 冲突

如果任务还在执行中直接恢复，有可能出现状态竞争。

应对方式：

- rollback 前先暂停 / 停止当前 run
- 对同一 session 加锁

## 风险 4：第一阶段不做新 session，历史语义可能不够清晰

第一阶段是“当前链路回退后继续跑”，不是“分支式 session 管理”。

应对方式：

- 在产品文案和 UI 中明确区分：
  - rollback（当前链路继续）
  - checkout（新 session 继续，Phase 2）

## 14. 成功标准

这个产品在第一阶段算成功，不取决于是否已经有完整 session 分支系统，而取决于：

1. Gateway 模式下，用户确实可以看到 checkpoint
2. 用户确实可以选点回退
3. 工作区状态确实被恢复
4. rollback 后系统确实进入可继续状态
5. 用户确实可以选择是否 continue
6. continue 时确实可以附带或不附带 prompt
7. Agent 确实可以从该 checkpoint 继续执行

第二阶段成功标准则是：

1. 用户可以在节点上 checkout
2. 系统能新建 session
3. 新 session 能从 checkout 节点继续跑

## 15. 结论

这个插件的路线应当是“先做能用，再做完整”。

因此产品路线明确分成两步：

### 第一步

只做 Gateway 模式下的基础回退：

- 保存 checkpoint
- 展示 checkpoint
- rollback
- rollback 后等待用户决定是否 continue
- continue 时支持可选 prompt

### 第二步

再做 session 管理和 checkout：

- 某个节点 checkout
- 新 session 续跑
- 与 OpenClaw 现有 session 模型兼容

这个拆分能让第一阶段足够小、足够快落地，同时不给第二阶段的 session 分支能力制造结构性障碍。
