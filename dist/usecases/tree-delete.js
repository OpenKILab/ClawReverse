import { manifest } from "../core/contracts.js";
import { ensureCondition } from "../core/errors.js";

import { buildSessionTree } from "./session-tree.js";

function buildSessionTreeKey(agentId, sessionId) {
  return `${agentId}::${sessionId}`;
}

function collectDescendantDeletionOrder(rootNode) {
  const descendants = [];

  const visit = (node, isRoot = false) => {
    if (!node) {
      return;
    }

    for (const child of node.children ?? []) {
      visit(child, false);
    }

    if (!isRoot) {
      descendants.push(node);
    }
  };

  visit(rootNode, true);
  return descendants;
}

export async function deleteSessionTree({
  services,
  host,
  checkpointId,
  logger
}) {
  ensureCondition(checkpointId, "CHECKPOINT_NOT_FOUND", "checkpointId is required.");
  const rootCheckpoint = await services.checkpointManager.get(checkpointId);

  ensureCondition(
    rootCheckpoint,
    "CHECKPOINT_NOT_FOUND",
    `Checkpoint '${checkpointId}' was not found.`,
    { checkpointId }
  );

  return services.lockManager.withLock(rootCheckpoint.agentId, rootCheckpoint.sessionId, async () => {
    const treeResult = await buildSessionTree({
      services,
      nodeId: checkpointId
    });
    const descendantNodes = collectDescendantDeletionOrder(treeResult.tree);
    const descendantCheckpointIds = descendantNodes.map((node) => node.checkpointId);
    const descendantCheckpointSet = new Set(descendantCheckpointIds);
    const subtreeCheckpointSet = new Set([
      treeResult.root.checkpointId,
      ...descendantCheckpointIds
    ]);
    const rootSessionKey = buildSessionTreeKey(treeResult.root.agentId, treeResult.root.sessionId);
    const deletedSessions = new Map();

    const rememberDeletedSession = (agentId, sessionId, sessionKey = null) => {
      if (!agentId || !sessionId) {
        return;
      }

      const key = buildSessionTreeKey(agentId, sessionId);

      if (key === rootSessionKey) {
        return;
      }

      if (!deletedSessions.has(key)) {
        deletedSessions.set(key, {
          agentId,
          sessionId,
          sessionKey: sessionKey || null
        });
      }
    };

    for (const node of descendantNodes) {
      rememberDeletedSession(node.agentId, node.sessionId);
    }

    const allBranches = await services.registry.listBranches();
    const branchesToDelete = allBranches.filter(
      (branch) => branch?.sourceCheckpointId && subtreeCheckpointSet.has(branch.sourceCheckpointId)
    );

    for (const branch of branchesToDelete) {
      rememberDeletedSession(branch.newAgentId, branch.newSessionId, branch.newSessionKey ?? null);
    }

    const allReports = await services.reportWriter.list();
    const reportsToDelete = allReports.filter((report) => {
      if (descendantCheckpointSet.has(report?.checkpointId)) {
        return true;
      }

      if (!report?.agentId || !report?.sessionId) {
        return false;
      }

      return deletedSessions.has(buildSessionTreeKey(report.agentId, report.sessionId));
    });

    logger.info?.(
      `[${manifest.id}] tree delete requested root='${treeResult.root.checkpointId}' deleteCheckpoints='${descendantCheckpointIds.length}' deleteBranches='${branchesToDelete.length}' deleteSessions='${deletedSessions.size}'`
    );

    const deletedReports = [];

    for (const report of reportsToDelete) {
      const removed = await services.reportWriter.remove(report.rollbackId);
      if (removed) {
        deletedReports.push(removed);
      }
    }

    const deletedCheckpoints = [];

    for (const node of descendantNodes) {
      const removed = await services.registry.remove(node.checkpointId);
      if (!removed) {
        continue;
      }

      await services.checkpointManager.removeArtifacts(removed);
      deletedCheckpoints.push(removed);
    }

    const deletedBranches = [];

    for (const branch of branchesToDelete) {
      const removed = await services.registry.removeBranch(branch.branchId);
      if (removed) {
        deletedBranches.push(removed);
      }
    }

    const deletedPluginSessions = [];

    for (const session of deletedSessions.values()) {
      await services.runtimeCursorManager.remove(session.agentId, session.sessionId);
      await services.lockManager.remove(session.agentId, session.sessionId);
      await services.registry.removeSession(session.agentId, session.sessionId);
      deletedPluginSessions.push(session);
    }

    const nativeCleanup = typeof host?.cleanupDeletedTree === "function"
      ? await host.cleanupDeletedTree({
        rootCheckpoint: treeResult.root,
        deletedCheckpoints,
        deletedBranches,
        deletedSessions: deletedPluginSessions
      })
      : null;

    logger.info?.(
      `[${manifest.id}] tree delete completed root='${treeResult.root.checkpointId}' deletedCheckpoints='${deletedCheckpoints.length}' deletedBranches='${deletedBranches.length}' deletedReports='${deletedReports.length}'`
    );

    return {
      ok: true,
      rootCheckpointId: treeResult.root.checkpointId,
      preservedCheckpointId: treeResult.root.checkpointId,
      deletedCheckpointIds: deletedCheckpoints.map((record) => record.checkpointId),
      deletedBranchIds: deletedBranches.map((record) => record.branchId),
      deletedSessionIds: deletedPluginSessions.map((session) => ({
        agentId: session.agentId,
        sessionId: session.sessionId
      })),
      deletedReportIds: deletedReports.map((report) => report.rollbackId),
      nativeCleanup: nativeCleanup ?? undefined
    };
  });
}
