# PRD: SecureStepClaw / Step Rollback

## 1. Executive Summary

SecureStepClaw brings recoverable history and safe branching to OpenClaw agent execution. The product creates automatic checkpoints before state-changing tool calls, lets users inspect and restore historical execution state, and lets them continue from a checkpoint into a clean child branch without mutating the parent.

Phase 1 is the current shipping baseline. It establishes the core contract: checkpoints capture recoverable state, rollback restores the source side without becoming a branch operation, and continue is the only fork operation into a new workspace, new agent, and new session.

Phase 2 expands the product into sandbox-backed execution. It adds sandbox-aware capture, restore, continue, provider abstraction, environment reproducibility where supported, and the operational controls required to run sandbox-backed history safely and economically at scale.

## 2. Background and User Pain Points

OpenClaw agents can change files, session state, and runtime context quickly, but historical recovery is difficult without a first-class model for durable checkpoints and clean branch creation.

Common pain points:

- A user wants to return to a known-good state after several tool calls have changed the workspace.
- A user wants to explore an alternate path from an earlier point without polluting the parent agent or parent workspace.
- A user needs a trustworthy mapping between historical file state, session history, and downstream branches.
- Operators need history management that is inspectable, recoverable, and safe to run in real projects.
- As sandbox usage grows, users need the same guarantees to extend beyond files alone and into the execution environment where feasible.

## 3. Target Users / Personas

- Individual OpenClaw users who need safe undo, inspection, and branching during iterative work.
- Power users and prompt engineers who want to compare alternate continuations from the same historical checkpoint.
- Agent platform operators who need reliable lineage, rollback visibility, and auditable execution history.
- Teams adopting sandboxed execution who need reproducible branch creation with clear security and cost boundaries.

## 4. Core Product Principles and Invariants

- A checkpoint is a historical snapshot, not a branch entity.
- Automatic checkpoints are created only for state-changing tool calls. Read-only calls do not create checkpoints.
- A checkpoint must preserve a recoverable state boundary across workspace state, a closed session transcript prefix, and lineage metadata.
- `rollback` restores the source side to a chosen checkpoint. It must not create a new workspace, agent, or session.
- `rollback` preserves the current semantic contract: by default it does not rewrite the parent workspace, and only performs in-place workspace restoration when explicitly requested.
- `continue` is the only fork operation.
- `continue` preserves the current semantic contract: a checkpoint is required, `--prompt` is required, and the result is a new workspace, new agent, and new session.
- `continue` must not pollute the parent workspace, parent session, parent agent directory, or parent runtime state.
- Transcript restoration must use a closed historical prefix, never an arbitrary truncation.
- Node, checkout, report, and branch flows are checkpoint-backed product surfaces, but they do not redefine the meaning of checkpoint, rollback, or continue.

## 5. Phase 1

### Goals

- Ship a stable baseline for checkpoint-backed recovery and branching.
- Make historical state easy to discover, inspect, and act on.
- Keep the parent side safe while enabling clean continuation into child branches.
- Establish durable lineage across checkpoints, rollbacks, sessions, and branches.

### In Scope

- Automatic checkpoints on state-changing tool calls.
- Checkpoint list and detail queries.
- Rollback and rollback-status.
- Continue from a checkpoint into a new workspace, new agent, and new session.
- Agent and session inspection.
- Checkpoint-backed node, checkout, report, and branch flows.
- Consistent CLI discoverability through `openclaw steprollback --help`.

### Out of Scope

- Sandbox-aware checkpoint capture and restore.
- Environment reproduction beyond the current baseline workspace and session contract.
- Cross-machine checkpoint portability or synchronization.
- Capture of external side effects such as databases, remote APIs, or third-party systems.
- Mutation of the user's real Git history.
- Continue without a prompt.

### Primary User Stories

- As a user, I want checkpoints to be created automatically when tools change state so I do not need to snapshot manually.
- As a user, I want to inspect the checkpoint timeline for a session and understand what historical state is available.
- As a user, I want to rollback to a checkpoint for investigation or recovery without accidentally turning rollback into a fork.
- As a user, I want to continue from a checkpoint into an isolated child branch so I can explore a new direction safely.
- As an operator, I want lineage and status views so I can understand how sessions, checkpoints, rollbacks, and branches relate.

### Key User Flows

- Normal execution: the user runs an agent, state-changing tool calls automatically create checkpoints, and read-only calls do not.
- Historical inspection: the user lists checkpoints, opens a checkpoint detail view, and chooses a point to recover or branch from.
- Source-side recovery: the user runs rollback to restore source-side state and verifies state through rollback-status and reports.
- Clean branching: the user continues from a checkpoint with a required prompt, producing a child workspace, child agent, and child session with traceable lineage.
- Derived branching workflows: the user discovers checkpoint-backed nodes and uses checkout or branch views without changing the core contract.

### Functional Requirements

- The system must automatically create a checkpoint before each state-changing tool call and skip read-only calls.
- The system must expose checkpoint list and detail views for a specific agent and session.
- Each checkpoint must record enough information to recover a workspace snapshot, a closed transcript prefix, and lineage metadata.
- Rollback must target an existing checkpoint and restore the source-side historical state without creating a new branch artifact.
- Rollback must keep the parent workspace untouched by default and support explicit in-place workspace restoration when requested.
- Rollback-status must show whether a session is in a post-rollback state and which checkpoint was last restored.
- Continue must require both a checkpoint and a prompt.
- Continue must create a new workspace, a new agent, and a new session, materialized from the selected checkpoint.
- Continue must rebuild the child session from the checkpoint transcript prefix, append the new prompt, and then resume execution through the normal child-agent path.
- Continue must copy only the safe, schema-valid subset of parent agent configuration needed to run the child branch.
- Agent and session inspection must expose enough summary metadata to locate active sessions, checkpoints, and lineage relationships.
- Node, checkout, report, and branch flows must remain checkpoint-backed and queryable without changing the checkpoint, rollback, or continue semantics.

### Non-Functional Requirements

- Safety: write operations must fail cleanly, surface stable error codes, and avoid partial corruption of parent state.
- Traceability: checkpoints, rollbacks, and branches must remain searchable and lineage-linked.
- Performance: checkpoint queries should remain fast enough for routine interactive use.
- Discoverability: the CLI should be easy to explore without requiring the PRD to duplicate command help.
- Compatibility: plugin behavior must respect current OpenClaw schema and configuration rules.
- Privacy: logs and user-facing output must avoid exposing secrets or auth material.

### Acceptance Criteria

- State-changing tool calls automatically create checkpoints, while read-only calls do not.
- A user can list checkpoints for a session and inspect a single checkpoint in detail.
- `rollback` restores the source side only and does not create a child workspace, child agent, or child session.
- By default, `rollback` does not rewrite the parent workspace; explicit in-place restore remains opt-in.
- `rollback-status` accurately reports post-rollback state for a session.
- `continue` without `--prompt` fails with a stable, user-actionable error.
- `continue` from a checkpoint creates a new workspace, new agent, and new session.
- The child session contains the checkpoint transcript prefix plus the new prompt, and the parent side remains untouched.
- Agent, session, node, checkout, report, and branch surfaces remain available and lineage-aware.

### Success Metrics

- Automatic checkpoint creation succeeds at a high stable rate on eligible tool calls.
- Checkpoint list and detail queries remain reliably fast in typical session sizes.
- Continue succeeds at creating child branches at a high stable rate with no parent-state damage.
- Rollback recovery succeeds without unintended branch creation.
- Lineage across checkpoints, rollbacks, nodes, checkouts, and branches is traceable and debuggable.

## 6. Phase 2: Sandbox Expansion

### Vision

Extend SecureStepClaw from workspace-and-session recovery into sandbox-aware execution history. A checkpoint should remain the same product concept, but when the agent is running in a supported sandbox, the system should also capture enough sandbox context to restore or reproduce execution fidelity safely, predictably, and within explicit policy boundaries.

### Goals

- Make checkpoint capture aware of sandbox-backed execution environments.
- Support sandbox-aware rollback and continue while preserving the Phase 1 contract.
- Reproduce the execution environment where provider capabilities allow it.
- Introduce a provider abstraction so multiple sandbox backends can participate under one product model.
- Add lifecycle, policy, observability, and cost controls needed for sandbox-backed history.

### User Stories

- As a user, I want a checkpoint from a sandboxed run to preserve not just files but the relevant execution environment so follow-up work behaves predictably.
- As a user, I want continue to create an isolated child sandbox when possible so a branch starts from the same practical environment as the checkpoint.
- As an operator, I want the system to tell me when full sandbox restoration is possible, partially reproducible, or unavailable.
- As an operator, I want retention, cleanup, quota, and cost controls so sandbox-backed history remains sustainable.
- As a security owner, I want explicit rules for secrets, mounts, and external resources so sandbox capture does not over-collect sensitive state.

### Key Workflows

- Sandbox checkpoint capture: a state-changing tool call in a supported sandbox records the normal Phase 1 checkpoint plus sandbox metadata and provider-backed snapshot references where allowed.
- Sandbox rollback: rollback restores source-side state and, when requested and supported, re-materializes the checkpoint environment with the correct sandbox fidelity level.
- Sandbox continue: continue creates a child workspace, child agent, child session, and child sandbox materialization path derived from the checkpoint.
- Ephemeral clone workflow: the system materializes a short-lived sandbox clone for inspection, diffing, replay, or branch startup without mutating the parent sandbox.
- Sandbox lifecycle workflow: operators can inspect, stop, expire, extend, and destroy sandbox-backed materializations without breaking checkpoint lineage.
- Degraded restore workflow: when full sandbox restoration is not possible, the system restores the Phase 1 baseline state and clearly reports the fidelity gap.

### Sandbox State Model

The sandbox state model should separate four layers so the product can capture and restore them independently based on provider support:

| Layer | Purpose | Typical Source |
| --- | --- | --- |
| Workspace state | Recover project files and related checkpointed filesystem state | SecureStepClaw snapshot data |
| Session state | Rebuild the closed transcript prefix and lineage | OpenClaw session history plus checkpoint metadata |
| Environment descriptor | Reproduce the sandbox definition, image, toolchain, mounts, and policy envelope | Provider metadata plus plugin-managed manifest |
| Provider-native snapshot handle | Fast-path restore or clone when the backend supports native snapshotting | Sandbox provider API |

### What Must Be Captured / Restored / Materialized

Must be captured:

- Workspace snapshot within approved capture boundaries.
- Closed transcript prefix and lineage metadata.
- Sandbox identity, provider, base image or template reference, and capability flags.
- Environment descriptor needed to reproduce the sandbox where supported, including runtime versioning, declared mounts, policy profile, and reproducibility metadata.
- Snapshot policy outcome for each checkpoint, including whether the checkpoint is full-fidelity, reproducible, or filesystem-only.

Must be restored or materialized when supported:

- Checkpoint workspace state.
- Child session transcript prefix and prompt append behavior identical to Phase 1.
- Sandbox configuration required to launch a compatible environment.
- Provider-native clone or restore path for eligible checkpoints.
- Lineage links between the checkpoint, any restored sandbox instance, and any child branch created from it.

May be materialized as best-effort rather than exact restore:

- Package caches, downloaded dependencies, and other performance-oriented artifacts.
- Non-critical environment accelerators that do not change product semantics.

Must not be captured by default:

- Secrets stored outside approved plugin or provider mechanisms.
- Arbitrary host files outside allowed workspace or mount policy.
- External service state, network side effects, or remote system mutations.
- Provider credentials or auth material in logs, reports, or user-visible command output.

### What Is Explicitly Out of Scope

- Guaranteeing bit-for-bit identical replay across all providers.
- Capturing live network state or external system side effects.
- Universal restore of unsupported provider features.
- Long-lived sandbox preservation without retention limits.
- Silent fallback that hides when sandbox fidelity has degraded.

### Provider Model / Compatibility Expectations

Phase 2 should define a provider abstraction with explicit capability discovery and compatibility tiers:

- Tier 1: full sandbox snapshot and clone. The provider can restore or fork from a checkpoint with high fidelity using native snapshotting.
- Tier 2: reproducible materialization. The provider cannot restore a full snapshot, but can recreate a compatible environment from a saved descriptor plus workspace snapshot.
- Tier 3: filesystem-only fallback. The provider cannot restore meaningful environment state, so the system falls back to the Phase 1 contract and surfaces that downgrade clearly.

Provider integrations should expose at least:

- Provider identifier and version.
- Supported snapshot fidelity tier.
- Clone, restore, and cleanup capabilities.
- Limits on mounts, environment variables, storage, and network policy.
- The tradeoff envelope between fidelity, startup latency, storage growth, and provider cost.
- Cost and quota signals needed for safe planning.

### Security and Compliance Constraints

- Sandbox snapshot policy must be allowlist-based, not capture-everything by default.
- Secret handling must distinguish between reproducible environment definition and secret injection at runtime.
- Secret values must never be written into checkpoint payloads, logs, reports, or lineage views.
- Mount capture must respect workspace and sandbox policy boundaries and exclude disallowed host paths.
- Continue and rollback must preserve isolation boundaries between parent and child sandboxes.
- Provider-specific security controls must be surfaced as capability metadata rather than hidden implementation details.

### Operational Controls: TTL, Retention, Cleanup, Quotas, Diagnostics, Metrics

- Lifecycle controls: operators should be able to inspect, stop, extend, expire, and destroy sandbox-backed artifacts and materialized clones.
- TTL: sandbox-backed artifacts should support explicit time-to-live policies for snapshots, temporary clones, and materialized environments.
- Retention: retention should be configurable by age, count, lineage depth, provider tier, and storage cost class.
- Cleanup: the system should provide safe cleanup of expired or orphaned snapshots, temporary sandboxes, and unused materializations.
- Quotas: operators should be able to cap snapshot count, storage consumption, clone concurrency, and provider spend.
- Diagnostics: every sandbox-backed checkpoint should expose capture mode, restore mode, provider outcome, and actionable failure reasons.
- Metrics: the system should track capture success rate, restore success rate, clone latency, storage consumption, cleanup efficiency, degraded-fidelity rate, and per-provider cost.

### Failure Modes and Fallback Behavior

- If provider-native snapshot capture fails, the system should still preserve the Phase 1 checkpoint when possible and mark the sandbox portion as degraded.
- If full sandbox restoration is unavailable, rollback and continue should fall back to reproducible materialization when supported.
- If reproducible materialization is also unavailable, rollback and continue should fall back to the Phase 1 workspace-and-session contract and report the fidelity loss explicitly.
- If quota, TTL, or policy limits block sandbox capture, the checkpoint should still be recorded with the correct capability state rather than failing silently.
- If secrets or restricted mounts cannot be restored, the system should require fresh runtime injection rather than attempting unsafe persistence.
- If provider cleanup fails, the system should retain enough diagnostics and lineage metadata to allow later remediation.

### Acceptance Criteria

- A sandbox-backed checkpoint records both the Phase 1 checkpoint data and sandbox capability metadata.
- The system classifies each sandbox-backed checkpoint by restoration fidelity and surfaces that status to users and operators.
- Continue from a sandbox-backed checkpoint preserves the Phase 1 contract while creating a child sandbox path when provider support exists.
- Rollback from a sandbox-backed checkpoint never mutates the parent into a branch and reports any sandbox fidelity downgrade clearly.
- Environment reproduction succeeds on supported providers using either native snapshot restore or reproducible materialization.
- Secrets and disallowed mounts are excluded from checkpoint payloads and user-visible diagnostics.
- Retention, TTL, quota, and cleanup controls operate on sandbox-backed artifacts without breaking checkpoint lineage.
- Metrics and diagnostics are sufficient to explain provider failures, degraded restores, and cost hot spots.

### Risks, Dependencies, and Open Questions

- Provider APIs may differ substantially in snapshot fidelity, mount behavior, secret handling, and cleanup guarantees.
- Environment reproducibility may depend on base image pinning, package manager determinism, and provider support for reusable templates.
- Capturing too little state weakens reproducibility; capturing too much creates security and cost risk.
- Storage growth and clone latency may increase sharply for large workspaces or dependency-heavy environments.
- Open questions include how to standardize lineage across provider-native snapshot IDs, which sandbox fields belong in the stable provider contract, and what operator defaults should apply when cost and fidelity goals conflict.

## 7. CLI and Documentation Principles

- The CLI is the operational surface; the PRD defines product behavior, not exhaustive command syntax.
- Command discovery should live primarily in `openclaw steprollback --help` and command-specific help output.
- Documentation should explain product concepts, invariants, workflows, and operator expectations before listing command details.
- Output formats should be human-readable by default and structured where automation needs stable machine-readable data.
- Product terminology should remain consistent across docs, CLI help, reports, and lineage views, especially for checkpoint, rollback, continue, branch, sandbox, and fidelity states.
- Phase 2 additions should extend existing terms rather than introduce parallel concepts that weaken the checkpoint or continue contract.

## 8. Rollout Plan / Milestones

### Milestone 1: Phase 1 Baseline Hardening

- Keep the current shipping checkpoint, rollback, continue, inspection, and checkpoint-backed branch flows stable.
- Tighten acceptance coverage around parent-state safety, prompt-required continue, rollback semantics, and lineage visibility.
- Ensure product docs and CLI help align on the same contract.

### Milestone 2: Sandbox Metadata Foundation

- Introduce provider abstraction, capability discovery, and sandbox metadata capture.
- Ship checkpoint fidelity classification and degraded-mode reporting without changing the Phase 1 contract.
- Add initial diagnostics, metrics, and cleanup hooks for sandbox-backed artifacts.

### Milestone 3: Sandbox Restore and Continue

- Add provider-native restore and clone paths where supported.
- Add reproducible materialization for providers that cannot restore native snapshots.
- Preserve Phase 1 semantics while adding sandbox-backed rollback and continue behavior.

### Milestone 4: Operational Readiness

- Add TTL, retention, quota, and cleanup policies for sandbox-backed history.
- Add observability for capture success, restore success, latency, degraded fidelity, and cost.
- Define production guardrails, default policies, and operator playbooks for supported providers.
