# PRD：SecureStepClaw / Step Rollback

## 1. 执行摘要

SecureStepClaw 为 OpenClaw agent 执行提供可恢复的历史管理与安全分叉能力。产品会在会改变状态的 tool call 之前自动创建 checkpoint，允许用户查询和恢复历史执行状态，并基于某个 checkpoint 在不污染 parent 的前提下继续演化出新的 child 分支。

Phase 1 代表当前已交付的产品基线。它确立了核心契约：checkpoint 负责捕获可恢复状态，rollback 只负责 source 侧恢复而不是分支操作，continue 是唯一的 fork 操作，并且必须创建新的 workspace、新的 agent、和新的 session。

Phase 2 将产品扩展到 sandbox 场景。它引入 sandbox-aware 的捕获、恢复与 continue，补充 provider 抽象、在支持条件下的环境复现能力，以及运行 sandbox-backed 历史管理所需的策略、观测与成本控制。

## 2. 背景与用户痛点

OpenClaw agent 可以快速改变文件、session 状态和运行时上下文，但如果没有一套一等公民级别的历史管理模型，历史恢复与安全分叉会变得困难。

常见痛点包括：

- 用户希望回到若干次 tool call 之前的稳定状态，但当前难以可靠定位并恢复。
- 用户希望从某个历史点探索另一条路径，但不希望污染当前 parent agent 或 parent workspace。
- 用户需要把历史文件状态、session 历史与下游分支之间的关系清晰地追踪起来。
- 平台运维方需要一套可检查、可恢复、可审计的历史执行机制。
- 随着 sandbox 使用增加，用户希望这些能力不只覆盖文件，还能尽可能覆盖执行环境本身。

## 3. 目标用户 / 用户画像

- 日常使用 OpenClaw 的个人用户，需要安全回退、历史检查和分支探索能力。
- 高阶用户和 prompt engineer，希望从同一个 checkpoint 派生多条不同继续路径进行比较。
- Agent 平台运维人员，需要可靠的 lineage、rollback 可见性与可审计的执行历史。
- 正在采用 sandbox 执行的团队，需要兼顾可复现性、安全边界和成本控制的分叉方案。

## 4. 核心产品原则与不变量

- checkpoint 是历史快照，不是 branch 实体。
- 只有会改变状态的 tool call 才会自动创建 checkpoint；只读调用不会创建 checkpoint。
- checkpoint 必须保留可恢复状态边界，至少包括 workspace 状态、闭合的 session transcript prefix，以及 lineage metadata。
- `rollback` 负责把 source 恢复到指定 checkpoint，不得创建新的 workspace、agent 或 session。
- `rollback` 必须保留当前语义契约：默认不改写 parent workspace，只有显式要求时才允许原地恢复 workspace。
- `continue` 是唯一的 fork 操作。
- `continue` 必须保留当前语义契约：必须指定 checkpoint，必须提供 `--prompt`，结果必须是新的 workspace、新的 agent、和新的 session。
- `continue` 不得污染 parent workspace、parent session、parent agentDir 或 parent runtime 状态。
- transcript 恢复必须基于闭合的历史前缀，不能是任意截断。
- node、checkout、report、branch 等流程都必须建立在 checkpoint 之上，但不能重新定义 checkpoint、rollback 或 continue 的语义。

## 5. Phase 1

### Goals

- 交付稳定的 checkpoint-backed 恢复与分支基线能力。
- 让用户更容易发现、检查并操作历史状态。
- 在保证 parent 侧安全的前提下，支持从历史点继续演化出 child 分支。
- 在 checkpoint、rollback、session 和 branch 之间建立可追踪的 lineage。

### In Scope

- 会改变状态的 tool call 自动创建 checkpoint。
- checkpoint 列表与详情查询。
- rollback 与 rollback-status。
- 基于 checkpoint continue 到新的 workspace、新的 agent、和新的 session。
- agent 与 session 查询。
- checkpoint-backed 的 node、checkout、report、branch 流程。
- 通过 `openclaw steprollback --help` 提供一致的 CLI 可发现性。

### Out of Scope

- sandbox-aware 的 checkpoint 捕获与恢复。
- 超出当前 workspace 与 session 契约之外的环境复现。
- 跨机器 checkpoint 可移植性或同步。
- 对数据库、远端 API 或第三方系统副作用的捕获。
- 修改用户真实项目的 Git 历史。
- 不带 prompt 的 continue。

### Primary User Stories

- 作为用户，我希望在工具真正改变状态时自动创建 checkpoint，这样我不需要手动做快照。
- 作为用户，我希望查看某个 session 的 checkpoint 时间线，并理解有哪些历史状态可用。
- 作为用户，我希望 rollback 到某个 checkpoint 用于分析或恢复，但不会让 rollback 变成隐式 fork。
- 作为用户，我希望从某个 checkpoint 继续到隔离的 child 分支，从而安全探索新的方向。
- 作为运维人员，我希望通过 lineage 和状态视图理解 session、checkpoint、rollback 和 branch 之间的关系。

### Key User Flows

- 正常执行：用户运行 agent，会改变状态的 tool call 自动创建 checkpoint，只读调用被跳过。
- 历史检查：用户列出 checkpoints，查看 checkpoint 详情，并选择某个历史点进行恢复或继续。
- Source 侧恢复：用户执行 rollback 恢复 source 状态，并通过 rollback-status 和 report 确认结果。
- 安全分叉：用户从某个 checkpoint 携带必填 prompt 执行 continue，得到带 lineage 的 child workspace、child agent 和 child session。
- 派生分支流程：用户通过 checkpoint-backed node 发现可操作历史点，并结合 checkout 或 branch 做进一步操作，而不改变核心语义。

### Functional Requirements

- 系统必须在每次会改变状态的 tool call 之前自动创建 checkpoint，并跳过只读调用。
- 系统必须支持针对指定 agent 与 session 的 checkpoint 列表和详情视图。
- 每个 checkpoint 必须记录足以恢复 workspace snapshot、闭合 transcript prefix 和 lineage metadata 的信息。
- rollback 必须基于一个存在的 checkpoint 执行，只恢复 source 侧历史状态，不能创建新的 branch 实体。
- rollback 必须默认保持 parent workspace 不变，并支持显式请求时的原地 workspace 恢复。
- rollback-status 必须能够显示某个 session 是否处于 rollback 之后的状态，以及最近一次恢复到哪个 checkpoint。
- continue 必须同时要求 checkpoint 和 prompt。
- continue 必须从选定 checkpoint 物化新的 workspace、创建新的 agent、并创建新的 session。
- continue 必须先用 checkpoint transcript prefix 重建 child session，再追加新的 prompt，然后通过标准 child-agent 路径继续执行。
- continue 只能复制运行 child 分支所需的、安全且符合 schema 的 parent agent 配置子集。
- agent 与 session 查询必须暴露足够的摘要信息，帮助用户定位活跃 session、checkpoint 和 lineage 关系。
- node、checkout、report、branch 流程必须保持 checkpoint-backed 且可查询，但不能改变 checkpoint、rollback、continue 的产品语义。

### Non-Functional Requirements

- 安全性：写操作必须可清理、可失败、带稳定错误码，且不能造成 parent 状态的部分损坏。
- 可追踪性：checkpoint、rollback 和 branch 必须保持可搜索、可关联 lineage。
- 性能：checkpoint 查询在日常交互场景下应保持足够快。
- 可发现性：CLI 应易于通过帮助信息探索，而 PRD 不应重复命令帮助文档。
- 兼容性：插件行为必须遵守当前 OpenClaw schema 和配置规则。
- 隐私性：日志和用户可见输出不得泄露 secrets 或认证材料。

### Acceptance Criteria

- 会改变状态的 tool call 会自动创建 checkpoint，只读调用不会。
- 用户可以查看某个 session 的 checkpoint 列表，并检查单个 checkpoint 详情。
- `rollback` 只恢复 source 侧，不会创建 child workspace、child agent 或 child session。
- 默认情况下，`rollback` 不会改写 parent workspace；原地恢复仍然必须显式开启。
- `rollback-status` 能准确反映某个 session 的 rollback 后状态。
- 缺少 `--prompt` 的 `continue` 必须失败，并返回稳定且可理解的错误。
- 基于 checkpoint 的 `continue` 会创建新的 workspace、新的 agent、和新的 session。
- child session 只包含 checkpoint transcript prefix 加新 prompt，且 parent 侧保持不变。
- agent、session、node、checkout、report、branch 等能力仍然可用且具备 lineage 可见性。

### Success Metrics

- 自动 checkpoint 在符合条件的 tool call 上以高且稳定的成功率运行。
- checkpoint 列表和详情查询在典型 session 规模下保持稳定快速。
- continue 以高且稳定的成功率创建 child 分支，并且不对 parent 状态造成损害。
- rollback 恢复成功且不会意外创建分支。
- checkpoint、rollback、node、checkout 与 branch 之间的 lineage 可追踪、可调试。

## 6. Phase 2：Sandbox Expansion

### Vision

将 SecureStepClaw 从“workspace 与 session 的恢复能力”扩展为“sandbox-aware 的执行历史管理能力”。checkpoint 的产品定义保持不变，但当 agent 运行在受支持的 sandbox 中时，系统应额外捕获足够的 sandbox 上下文，以便在明确策略边界内安全、可预测地恢复或复现执行环境。

### Goals

- 让 checkpoint 捕获感知 sandbox 执行环境。
- 在不破坏 Phase 1 契约的前提下支持 sandbox-aware 的 rollback 与 continue。
- 在 provider 能力允许的情况下复现执行环境。
- 引入 provider 抽象，使不同 sandbox backend 能在统一产品模型下工作。
- 增加 sandbox-backed 历史管理所需的生命周期、策略、可观测性与成本控制能力。

### User Stories

- 作为用户，我希望 sandbox 中生成的 checkpoint 不只保留文件，还保留足够的环境信息，以便后续行为更可预测。
- 作为用户，我希望 continue 在可能时创建隔离的 child sandbox，使新分支从与 checkpoint 更一致的环境起步。
- 作为运维人员，我希望系统能明确告诉我某个 checkpoint 是可完全恢复、可部分复现，还是只能降级处理。
- 作为运维人员，我希望对 retention、cleanup、quota 和成本有显式控制，让 sandbox-backed 历史管理可持续运行。
- 作为安全负责人，我希望 secrets、mounts 和外部资源都有清晰边界，避免 sandbox 捕获过度收集敏感状态。

### Key Workflows

- Sandbox checkpoint capture：当受支持 sandbox 中发生会改变状态的 tool call 时，系统在 Phase 1 checkpoint 之外，还记录 sandbox metadata，以及在允许条件下记录 provider-backed snapshot 引用。
- Sandbox rollback：rollback 恢复 source 侧状态，并在支持且被请求时，以正确的 sandbox fidelity 级别重新物化 checkpoint 对应环境。
- Sandbox continue：continue 创建 child workspace、child agent、child session，以及从 checkpoint 派生出的 child sandbox 物化路径。
- Ephemeral clone workflow：系统物化一个短生命周期 sandbox clone，用于检查、diff、replay 或 branch 启动，而不污染 parent sandbox。
- Sandbox lifecycle workflow：运维人员可以检查、停止、过期、延长或销毁 sandbox-backed 物化实例，而不会破坏 checkpoint lineage。
- Degraded restore workflow：当无法进行完整 sandbox 恢复时，系统回退到 Phase 1 基线能力，并明确暴露 fidelity 缺口。

### Sandbox State Model

sandbox 状态模型应拆分为四层，以便系统根据 provider 能力独立捕获和恢复：

| 层级 | 作用 | 典型来源 |
| --- | --- | --- |
| Workspace state | 恢复项目文件和相关文件系统状态 | SecureStepClaw snapshot 数据 |
| Session state | 重建闭合 transcript prefix 和 lineage | OpenClaw session 历史与 checkpoint metadata |
| Environment descriptor | 复现 sandbox 定义、镜像、工具链、mount 和策略边界 | Provider metadata 与插件维护的 manifest |
| Provider-native snapshot handle | 在 provider 支持原生快照时走快速恢复或 clone 路径 | Sandbox provider API |

### What Must Be Captured / Restored / Materialized

必须捕获：

- 在允许边界内的 workspace snapshot。
- 闭合的 transcript prefix 与 lineage metadata。
- sandbox 身份、provider、基础镜像或模板引用，以及能力标记。
- 在支持条件下用于复现 sandbox 的 environment descriptor，包括 runtime 版本、声明的 mounts、策略 profile 和复现元数据。
- 每个 checkpoint 的 snapshot policy 结果，包括该 checkpoint 是 full-fidelity、reproducible 还是 filesystem-only。

在支持条件下必须恢复或物化：

- checkpoint 对应的 workspace 状态。
- 与 Phase 1 完全一致的 child session transcript prefix 与 prompt 追加行为。
- 启动兼容环境所需的 sandbox 配置。
- 针对合格 checkpoint 的 provider-native clone 或 restore 路径。
- checkpoint、恢复出的 sandbox 实例，以及由它派生的 child branch 之间的 lineage 关系。

可按 best-effort 物化，而不要求精确恢复：

- 包缓存、下载依赖等偏性能优化的产物。
- 不改变产品语义的非关键环境加速层。

默认不得捕获：

- 未通过插件或 provider 许可机制管理的 secrets。
- workspace 或 mount 策略之外的任意 host 文件。
- 外部服务状态、网络副作用或远端系统变更。
- provider 凭证或任何认证材料在日志、report 或用户可见输出中的泄露。

### What Is Explicitly Out of Scope

- 保证所有 provider 上的 bit-for-bit 完全一致回放。
- 捕获实时网络状态或外部系统副作用。
- 对不受支持 provider 特性的通用恢复承诺。
- 没有 retention 限制的长期 sandbox 保留。
- 隐藏 fidelity 降级事实的静默 fallback。

### Provider Model / Compatibility Expectations

Phase 2 应定义带显式能力发现的 provider 抽象，并将兼容性分为以下层级：

- Tier 1：完整 sandbox snapshot 与 clone。provider 能基于原生快照以高 fidelity 恢复或 fork checkpoint。
- Tier 2：reproducible materialization。provider 不能恢复完整快照，但可基于保存的 descriptor 与 workspace snapshot 重新构建兼容环境。
- Tier 3：filesystem-only fallback。provider 无法恢复有意义的环境状态，系统退回到 Phase 1 契约，并明确暴露降级结果。

Provider 集成至少应暴露：

- provider 标识与版本。
- 支持的 snapshot fidelity 层级。
- clone、restore 和 cleanup 能力。
- mount、环境变量、存储和网络策略方面的限制。
- fidelity、启动延迟、存储增长与 provider 成本之间的权衡边界。
- 用于安全规划的成本和 quota 信号。

### Security and Compliance Constraints

- sandbox snapshot policy 必须采用 allowlist 策略，而不是默认捕获全部状态。
- secret handling 必须区分“可复现环境定义”与“运行时注入的 secret”。
- secret 值绝不能写入 checkpoint payload、日志、report 或 lineage 视图。
- mount 捕获必须遵守 workspace 与 sandbox policy 边界，并排除不允许的 host 路径。
- continue 和 rollback 都必须维持 parent 与 child sandbox 之间的隔离边界。
- provider 特有的安全控制应以 capability metadata 的形式暴露，而不是隐藏为实现细节。

### Operational Controls：TTL、Retention、Cleanup、Quotas、Diagnostics、Metrics

- Lifecycle controls：运维人员应能检查、停止、延长、过期和销毁 sandbox-backed artifacts 与 materialized clone。
- TTL：sandbox-backed artifacts 应支持针对 snapshot、临时 clone 和 materialized environment 的显式生存时间策略。
- Retention：应支持按时间、数量、lineage 深度、provider 层级和存储成本等级配置保留策略。
- Cleanup：系统应安全清理过期或孤儿化的 snapshot、临时 sandbox 和未使用的 materialization。
- Quotas：运维人员应能限制 snapshot 数量、存储占用、clone 并发度和 provider 花费。
- Diagnostics：每个 sandbox-backed checkpoint 都应暴露 capture mode、restore mode、provider outcome 和可操作的失败原因。
- Metrics：系统应跟踪 capture success rate、restore success rate、clone latency、storage consumption、cleanup efficiency、degraded-fidelity rate 以及各 provider 成本。

### Failure Modes and Fallback Behavior

- 如果 provider-native snapshot capture 失败，只要可能，系统仍应保留 Phase 1 checkpoint，并将 sandbox 部分标记为 degraded。
- 如果完整 sandbox restoration 不可用，rollback 和 continue 应在支持条件下回退到 reproducible materialization。
- 如果 reproducible materialization 也不可用，rollback 和 continue 应退回到 Phase 1 的 workspace-and-session 契约，并明确报告 fidelity 损失。
- 如果 quota、TTL 或 policy 限制阻止 sandbox capture，checkpoint 仍应被记录，并准确标注 capability 状态，而不是静默失败。
- 如果 secrets 或受限 mounts 无法恢复，系统应要求重新注入运行时信息，而不是尝试进行不安全持久化。
- 如果 provider cleanup 失败，系统应保留足够的诊断信息和 lineage metadata，便于后续补救。

### Acceptance Criteria

- sandbox-backed checkpoint 同时记录 Phase 1 checkpoint 数据和 sandbox capability metadata。
- 系统会为每个 sandbox-backed checkpoint 标记 restoration fidelity，并向用户和运维人员暴露该状态。
- 基于 sandbox-backed checkpoint 的 continue 在保留 Phase 1 契约的同时，会在 provider 支持时创建 child sandbox 路径。
- 基于 sandbox-backed checkpoint 的 rollback 不会把 parent 变成 branch，并会明确报告任何 sandbox fidelity 降级。
- 在受支持 provider 上，环境复现可以通过 native snapshot restore 或 reproducible materialization 成功完成。
- secrets 和不允许的 mounts 不会出现在 checkpoint payload 或用户可见诊断信息中。
- retention、TTL、quota 和 cleanup 控制可作用于 sandbox-backed artifacts，且不会破坏 checkpoint lineage。
- metrics 与 diagnostics 足以解释 provider 失败、降级恢复和成本热点。

### Risks, Dependencies, and Open Questions

- 不同 provider 在 snapshot fidelity、mount 行为、secret handling 和 cleanup 保证方面可能差异很大。
- 环境可复现性可能依赖基础镜像固定、包管理器确定性，以及 provider 是否支持可复用模板。
- 捕获过少会削弱复现能力；捕获过多会引入安全与成本风险。
- 对于大型 workspace 或依赖较重的环境，存储增长和 clone 延迟可能显著上升。
- 仍待回答的问题包括：如何统一 provider-native snapshot ID 的 lineage 表示，哪些 sandbox 字段应进入稳定 provider 契约，以及当成本与 fidelity 目标冲突时应采用怎样的默认策略。

## 7. CLI 与文档原则

- CLI 是操作界面；PRD 负责定义产品行为，而不是穷举命令语法。
- 命令发现主要应通过 `openclaw steprollback --help` 与命令级帮助完成。
- 文档应优先解释产品概念、不变量、工作流和运维预期，而不是展开命令清单。
- 输出格式默认应对人类友好；在自动化需要时再提供稳定的结构化输出。
- checkpoint、rollback、continue、branch、sandbox、fidelity 等术语必须在文档、CLI help、report 和 lineage 视图中保持一致。
- Phase 2 的扩展应延续现有术语体系，而不是引入平行概念去削弱 checkpoint 或 continue 契约。

## 8. Rollout Plan / Milestones

### Milestone 1：Phase 1 Baseline Hardening

- 保持当前已交付的 checkpoint、rollback、continue、inspection 和 checkpoint-backed branch 流程稳定。
- 强化围绕 parent-state 安全、prompt-required continue、rollback 语义和 lineage 可见性的验收覆盖。
- 确保产品文档与 CLI help 对同一契约保持一致。

### Milestone 2：Sandbox Metadata Foundation

- 引入 provider 抽象、能力发现和 sandbox metadata 捕获。
- 在不改变 Phase 1 契约的前提下交付 checkpoint fidelity 分类和 degraded-mode 报告。
- 为 sandbox-backed artifacts 增加初步 diagnostics、metrics 与 cleanup hook。

### Milestone 3：Sandbox Restore and Continue

- 在支持的 provider 上增加 provider-native restore 与 clone 路径。
- 为无法恢复原生快照的 provider 增加 reproducible materialization 能力。
- 在保留 Phase 1 语义的前提下，补充 sandbox-backed rollback 与 continue。

### Milestone 4：Operational Readiness

- 为 sandbox-backed 历史管理增加 TTL、retention、quota 和 cleanup 策略。
- 增加对 capture success、restore success、latency、degraded fidelity 和成本的 observability。
- 为受支持 provider 制定生产级 guardrail、默认策略和运维手册。
