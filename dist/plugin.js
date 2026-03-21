import path from "node:path";

import { METHOD_NAMES, defaultConfig, manifest } from "./core/contracts.js";
import { ensureCondition } from "./core/errors.js";
import { SequenceStore, createDefaultHostBridge, resolveConfig } from "./core/utils.js";
import { CheckpointManager } from "./services/checkpoint-manager.js";
import { CheckpointRegistry } from "./services/checkpoint-registry.js";
import { ReportWriter } from "./services/report-writer.js";
import { RuntimeCursorManager } from "./services/runtime-cursor-manager.js";
import { SessionLockManager } from "./services/session-lock-manager.js";
import { captureCheckpointBeforeTool, reconcileCheckpointAfterTool } from "./usecases/checkpoint-flow.js";
import { executeCheckout } from "./usecases/checkout-flow.js";
import { executeContinue } from "./usecases/continue-flow.js";
import { executeRollback } from "./usecases/rollback-flow.js";
import { buildSessionTree } from "./usecases/session-tree.js";
import { deleteSessionTree } from "./usecases/tree-delete.js";
import { assertSessionRequest, toRollbackStatus } from "./usecases/session-support.js";

function createNoopLogger() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop
  };
}

export class StepRollbackPlugin {
  constructor({ config, host, services, logger }) {
    this.config = config;
    this.host = host;
    this.services = services;
    this.logger = logger ?? createNoopLogger();
    this.manifest = manifest;

    this.hooks = {
      sessionStart: (ctx) => this.sessionStart(ctx),
      sessionEnd: (ctx) => this.sessionEnd(ctx),
      beforeToolCall: (ctx) => this.beforeToolCall(ctx),
      afterToolCall: (ctx) => this.afterToolCall(ctx)
    };

    this.methods = {
      [METHOD_NAMES.status]: () => this.status(),
      [METHOD_NAMES.checkpointsList]: (input) => this.listCheckpoints(input),
      [METHOD_NAMES.checkpointsGet]: (input) => this.getCheckpoint(input),
      [METHOD_NAMES.rollback]: (input) => this.rollback(input),
      [METHOD_NAMES.continue]: (input) => this.continue(input),
      [METHOD_NAMES.rollbackStatus]: (input) => this.rollbackStatus(input),
      [METHOD_NAMES.reportsGet]: (input) => this.getReport(input),
      [METHOD_NAMES.sessionNodesList]: (input) => this.listSessionNodes(input),
      [METHOD_NAMES.sessionTree]: (input) => this.listSessionTree(input),
      [METHOD_NAMES.sessionTreeDelete]: (input) => this.deleteSessionTree(input),
      [METHOD_NAMES.sessionCheckout]: (input) => this.checkoutSession(input),
      [METHOD_NAMES.sessionBranchGet]: (input) => this.getBranch(input)
    };
  }

  async status() {
    return {
      pluginId: manifest.id,
      enabled: this.config.enabled,
      gatewayModeOnly: true,
      allowContinuePrompt: this.config.allowContinuePrompt
    };
  }

  async sessionStart(ctx) {
    ensureCondition(ctx?.agentId, "SESSION_NOT_FOUND", "sessionStart requires agentId.");
    ensureCondition(ctx?.sessionId, "SESSION_NOT_FOUND", "sessionStart requires sessionId.");

    this.logger.info(
      `[${manifest.id}] session_start agent='${ctx.agentId}' session='${ctx.sessionId}' run='${ctx.runId ?? "-"}'`
    );

    return this.services.runtimeCursorManager.update(
      ctx.agentId,
      ctx.sessionId,
      (state) => {
        state.activeHeadEntryId = ctx.entryId ?? state.activeHeadEntryId ?? null;
        state.currentRunId = ctx.runId ?? state.currentRunId ?? null;
        return state;
      },
      {
        activeHeadEntryId: ctx.entryId ?? null,
        currentRunId: ctx.runId ?? null
      }
    );
  }

  async sessionEnd(ctx) {
    ensureCondition(ctx?.agentId, "SESSION_NOT_FOUND", "sessionEnd requires agentId.");
    ensureCondition(ctx?.sessionId, "SESSION_NOT_FOUND", "sessionEnd requires sessionId.");

    this.logger.info(
      `[${manifest.id}] session_end agent='${ctx.agentId}' session='${ctx.sessionId}' run='${ctx.runId ?? "-"}'`
    );

    return this.services.runtimeCursorManager.clearCurrentRun(ctx.agentId, ctx.sessionId);
  }

  async beforeToolCall(ctx) {
    if (!this.config.enabled) {
      return null;
    }

    this.assertToolContext(ctx, "before_tool_call");
    this.logger.info(
      `[${manifest.id}] before_tool_call agent='${ctx.agentId}' session='${ctx.sessionId}' entry='${ctx.entryId}' node='${ctx.nodeIndex}' tool='${ctx.toolName}' toolCallId='${ctx.toolCallId ?? "-"}'`
    );

    return captureCheckpointBeforeTool({
      services: this.services,
      logger: this.logger,
      ctx
    });
  }

  async afterToolCall(ctx) {
    if (!this.config.enabled) {
      return null;
    }

    this.assertToolContext(ctx, "after_tool_call");
    this.logger.debug(
      `[${manifest.id}] after_tool_call agent='${ctx.agentId}' session='${ctx.sessionId}' entry='${ctx.entryId}' node='${ctx.nodeIndex}' tool='${ctx.toolName}' toolCallId='${ctx.toolCallId ?? "-"}'`
    );

    return reconcileCheckpointAfterTool({
      services: this.services,
      ctx
    });
  }

  async listCheckpoints({ agentId, sessionId }) {
    assertSessionRequest(agentId, sessionId);
    return {
      agentId,
      sessionId,
      checkpoints: await this.services.checkpointManager.list(agentId, sessionId)
    };
  }

  async getCheckpoint({ checkpointId }) {
    ensureCondition(checkpointId, "CHECKPOINT_NOT_FOUND", "checkpointId is required.");
    const checkpoint = await this.services.checkpointManager.get(checkpointId);

    ensureCondition(
      checkpoint,
      "CHECKPOINT_NOT_FOUND",
      `Checkpoint '${checkpointId}' was not found.`,
      { checkpointId }
    );

    return { checkpoint };
  }

  async rollbackStatus({ agentId, sessionId }) {
    assertSessionRequest(agentId, sessionId);
    return toRollbackStatus(
      agentId,
      sessionId,
      await this.services.runtimeCursorManager.get(agentId, sessionId)
    );
  }

  async getReport({ rollbackId }) {
    ensureCondition(rollbackId, "ENTRY_NOT_FOUND", "rollbackId is required.");
    return this.services.reportWriter.get(rollbackId);
  }

  async rollback({ agentId, sessionId, checkpointId, restoreWorkspace = false }) {
    assertSessionRequest(agentId, sessionId);
    ensureCondition(checkpointId, "CHECKPOINT_NOT_FOUND", "checkpointId is required.");

    this.logger.info(
      `[${manifest.id}] rollback requested agent='${agentId}' session='${sessionId}' checkpoint='${checkpointId}' restoreWorkspace='${restoreWorkspace ? "true" : "false"}'`
    );

    return executeRollback({
      config: this.config,
      host: this.host,
      services: this.services,
      agentId,
      sessionId,
      checkpointId,
      restoreWorkspace,
      logger: this.logger
    });
  }

  async continue({ agentId, sessionId, checkpointId, prompt, newAgentId, cloneAuth, log = false }) {
    assertSessionRequest(agentId, sessionId);

    this.logger.info(
      `[${manifest.id}] continue requested agent='${agentId}' session='${sessionId}' checkpoint='${checkpointId ?? "-"}' prompt='${prompt ?? "-"}' newAgent='${newAgentId ?? "-"}' log='${log ? "true" : "false"}'`
    );

    return executeContinue({
      config: this.config,
      host: this.host,
      services: this.services,
      agentId,
      sessionId,
      checkpointId,
      prompt,
      newAgentId,
      cloneAuth,
      log,
      logger: this.logger
    });
  }

  async listSessionNodes({ agentId, sessionId }) {
    assertSessionRequest(agentId, sessionId);
    return {
      agentId,
      sessionId,
      nodes: await this.services.registry.listNodes(agentId, sessionId)
    };
  }

  async listSessionTree(input) {
    return buildSessionTree({
      services: this.services,
      ...input
    });
  }

  async deleteSessionTree({ nodeId, checkpointId }) {
    const resolvedCheckpointId = typeof nodeId === "string" && nodeId.trim()
      ? nodeId.trim()
      : typeof checkpointId === "string" && checkpointId.trim()
        ? checkpointId.trim()
        : "";

    return deleteSessionTree({
      services: this.services,
      host: this.host,
      checkpointId: resolvedCheckpointId,
      logger: this.logger
    });
  }

  async checkoutSession({ agentId, sourceSessionId, sourceEntryId, continueAfterCheckout = false, prompt }) {
    ensureCondition(agentId, "SESSION_NOT_FOUND", "agentId is required.");
    ensureCondition(sourceSessionId, "SESSION_NOT_FOUND", "sourceSessionId is required.");
    ensureCondition(sourceEntryId, "ENTRY_NOT_FOUND", "sourceEntryId is required.");

    return executeCheckout({
      host: this.host,
      services: this.services,
      agentId,
      sourceSessionId,
      sourceEntryId,
      continueAfterCheckout,
      prompt
    });
  }

  async getBranch({ branchId }) {
    ensureCondition(branchId, "ENTRY_NOT_FOUND", "branchId is required.");
    return this.services.registry.getBranch(branchId);
  }

  assertToolContext(ctx, hookName) {
    ensureCondition(ctx?.agentId, "SESSION_NOT_FOUND", `${hookName} requires agentId.`);
    ensureCondition(ctx?.sessionId, "SESSION_NOT_FOUND", `${hookName} requires sessionId.`);
    ensureCondition(ctx?.entryId, "ENTRY_NOT_FOUND", `${hookName} requires entryId.`);
    ensureCondition(
      Number.isInteger(ctx?.nodeIndex),
      "ENTRY_NOT_FOUND",
      `${hookName} requires an integer nodeIndex.`
    );
    ensureCondition(ctx?.toolName, "ENTRY_NOT_FOUND", `${hookName} requires toolName.`);
  }
}

export function createStepRollbackPlugin(options = {}) {
  const config = resolveConfig(options.config);
  const host = createDefaultHostBridge(options.host);
  const logger = options.logger ?? createNoopLogger();
  const sequenceStore = new SequenceStore(path.join(config.registryDir, "_sequences.json"));
  const runtimeCursorManager = new RuntimeCursorManager({ config });
  const registry = new CheckpointRegistry({ config });
  const checkpointManager = new CheckpointManager({
    config,
    registry,
    runtimeCursorManager,
    sequenceStore,
    logger
  });
  const reportWriter = new ReportWriter({ config });
  const lockManager = new SessionLockManager({ config });

  return new StepRollbackPlugin({
    config,
    host,
    logger,
    services: {
      sequenceStore,
      runtimeCursorManager,
      registry,
      checkpointManager,
      reportWriter,
      lockManager
    }
  });
}

export { defaultConfig, manifest };
