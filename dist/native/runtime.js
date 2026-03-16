import crypto from "node:crypto";

import { StepRollbackError } from "../core/errors.js";
import { manifest } from "../plugin.js";
import { invokeAgentViaCli } from "./cli.js";
import { buildBranchSessionKey, buildBranchSessionLabel, normalizeExternalParams, resolveSessionRecord, resolveSessionRecordEventually, resolveToolHookContext } from "./sessions.js";
import { callFirstHelper, callGatewayMethod, extractGatewayParams, normalizeHookContext, toNativeErrorPayload, unwrapRpcResult } from "./shared.js";

const HOOK_BINDINGS = [
  { hookName: "session_start", handlerName: "sessionStart", kind: "session" },
  { hookName: "session_end", handlerName: "sessionEnd", kind: "session" },
  { hookName: "before_tool_call", handlerName: "beforeToolCall", kind: "tool" },
  { hookName: "after_tool_call", handlerName: "afterToolCall", kind: "tool" }
];

const GATEWAY_METHOD_NAMES = [
  "steprollback.status",
  "steprollback.checkpoints.list",
  "steprollback.checkpoints.get",
  "steprollback.rollback",
  "steprollback.continue",
  "steprollback.rollback.status",
  "steprollback.reports.get",
  "steprollback.session.nodes.list",
  "steprollback.session.checkout",
  "steprollback.session.branch.get"
];

export function createNativeHostBridge(api, logger, options = {}) {
  return {
    async stopRun({ agentId, sessionId, runId }) {
      const directResult = await callFirstHelper(api, [
        ["runtime", "agent", "stopRun"],
        ["runtime", "agent", "stop"],
        ["runtime", "runs", "stop"],
        ["runtime", "runControl", "stopRun"]
      ], {
        agentId,
        sessionId,
        runId
      });

      if (directResult !== undefined) {
        return directResult;
      }

      const rpcResult = await callGatewayMethod(api, "agent", {
        agentId,
        sessionId,
        message: "/stop"
      });

      if (rpcResult !== undefined) {
        const unwrapped = unwrapRpcResult(rpcResult);
        return {
          stopped: true,
          via: "agent:/stop",
          runId: unwrapped?.runId ?? runId
        };
      }

      logger.warn(
        `[${manifest.id}] No documented runtime stop helper was found. Assuming run '${runId ?? "unknown"}' is already stopped.`
      );

      return {
        stopped: true,
        assumed: true,
        runId
      };
    },

    async startContinueRun({ agentId, sessionId, sessionKey, entryId, prompt, sourceSessionId, branchId, label }) {
      const knownSession = await resolveSessionRecord(api, agentId, {
        sessionId,
        sessionKey
      });
      const targetSessionKey = sessionKey ?? knownSession?.sessionKey;
      const targetSessionId = sessionId ?? knownSession?.sessionId;
      const syntheticMessage = prompt?.trim() || "Continue from the restored checkpoint.";
      const branchLabel = label ?? buildBranchSessionLabel(sourceSessionId ?? targetSessionId ?? "session", branchId ?? "continue");

      if (targetSessionKey && typeof api?.runtime?.subagent?.run === "function") {
        try {
          const subagentResult = await api.runtime.subagent.run({
            sessionKey: targetSessionKey,
            message: syntheticMessage,
            deliver: false
          });
          const resolvedSession = await resolveSessionRecordEventually(api, agentId, {
            sessionId: targetSessionId,
            sessionKey: targetSessionKey
          });

          return {
            started: true,
            runId: subagentResult?.runId ?? null,
            sessionId: resolvedSession?.sessionId ?? targetSessionId ?? null,
            sessionKey: resolvedSession?.sessionKey ?? targetSessionKey ?? null,
            label: branchLabel
          };
        } catch (error) {
          logger.warn?.(
            `[${manifest.id}] runtime.subagent.run could not continue branch session '${targetSessionKey}': ${error instanceof Error ? error.message : error}`
          );
        }
      }

      try {
        return await invokeAgentViaCli(api, logger, {
          ...options,
          agentId,
          prompt: syntheticMessage,
          sourceSessionId: sourceSessionId ?? targetSessionId,
          branchId,
          label: branchLabel
        });
      } catch (error) {
        logger.warn?.(
          `[${manifest.id}] openclaw agent continuation fallback failed for sourceSession='${sourceSessionId ?? targetSessionId ?? "-"}': ${error instanceof Error ? error.message : error}`
        );
      }

      const rpcResult = await callGatewayMethod(api, "agent", {
        agentId,
        ...(targetSessionKey ? { sessionKey: targetSessionKey } : {}),
        ...(!targetSessionKey && targetSessionId ? { sessionId: targetSessionId } : {}),
        message: syntheticMessage,
        label: branchLabel,
        deliver: false,
        channel: "webchat"
      });

      if (rpcResult !== undefined) {
        const unwrapped = unwrapRpcResult(rpcResult);
        const resolvedSession = await resolveSessionRecordEventually(api, agentId, {
          sessionId: targetSessionId,
          sessionKey: targetSessionKey
        });

        return {
          started: true,
          runId: unwrapped?.runId ?? null,
          sessionId: resolvedSession?.sessionId ?? targetSessionId ?? null,
          sessionKey: resolvedSession?.sessionKey ?? targetSessionKey ?? null,
          label: branchLabel
        };
      }

      const directResult = await callFirstHelper(api, [
        ["runtime", "agent", "startRun"],
        ["runtime", "runs", "start"],
        ["runtime", "runControl", "startRun"]
      ], {
        agentId,
        sessionId: targetSessionId,
        sessionKey: targetSessionKey,
        message: syntheticMessage,
        prompt: syntheticMessage
      });

      if (directResult !== undefined) {
        return {
          started: directResult === true || directResult?.started !== false,
          runId: directResult?.runId ?? null,
          sessionId: targetSessionId ?? null,
          sessionKey: targetSessionKey ?? null,
          label: branchLabel
        };
      }

      throw new StepRollbackError(
        "CONTINUE_START_FAILED",
        "OpenClaw did not expose runtime.subagent.run, a Gateway caller, or a startRun helper that the plugin could use to continue in a branched session.",
        { agentId, sessionId: targetSessionId, sessionKey: targetSessionKey, entryId }
      );
    },

    async createSession({ agentId, sourceSessionId, sourceEntryId, branchId }) {
      const directResult = await callFirstHelper(api, [
        ["runtime", "sessions", "createSession"],
        ["runtime", "session", "create"],
        ["runtime", "sessionUtils", "createSession"]
      ], {
        agentId,
        sourceSessionId,
        sourceEntryId
      });

      if (directResult !== undefined) {
        return directResult;
      }

      const sessionKey = buildBranchSessionKey(agentId, branchId ?? crypto.randomUUID());
      return {
        sessionId: crypto.randomUUID(),
        sessionKey,
        label: buildBranchSessionLabel(sourceSessionId, branchId ?? "branch"),
        assumed: true
      };
    }
  };
}

export function registerGatewayMethods(api, engine, logger) {
  if (typeof api?.registerGatewayMethod !== "function") {
    throw new StepRollbackError(
      "CONTINUE_START_FAILED",
      "OpenClaw plugin API did not provide registerGatewayMethod(...)."
    );
  }

  for (const methodName of GATEWAY_METHOD_NAMES) {
    api.registerGatewayMethod(methodName, async (request = {}) => {
      try {
        const result = await engine.methods[methodName](normalizeExternalParams(api, extractGatewayParams(request)));

        if (typeof request.respond === "function") {
          request.respond(true, result);
          return;
        }

        return result;
      } catch (error) {
        logger.error?.(`[${manifest.id}] Gateway method '${methodName}' failed: ${error instanceof Error ? error.message : error}`);

        const payload = toNativeErrorPayload(error);

        if (typeof request.respond === "function") {
          request.respond(false, payload.error);
          return;
        }

        throw error;
      }
    });
  }
}

export function registerLifecycleHooks(api, engine, logger) {
  if (typeof api?.registerHook !== "function" && typeof api?.on !== "function") {
    throw new StepRollbackError(
      "CONTINUE_START_FAILED",
      "OpenClaw plugin API did not provide registerHook(...) or api.on(...)."
    );
  }

  for (const binding of HOOK_BINDINGS) {
    const handler = async (event, ctx) => {
      const normalized = {
        ...normalizeHookContext(binding.kind, event, ctx),
        hookName: binding.hookName
      };

      try {
        logger.info?.(
          `[${manifest.id}] hook '${binding.hookName}' agent='${normalized.agentId ?? "-"}' session='${normalized.sessionId ?? "-"}' tool='${normalized.toolName ?? "-"}' toolCallId='${normalized.toolCallId ?? "-"}' entry='${normalized.entryId ?? "-"}' node='${normalized.nodeIndex ?? "-"}'`
        );

        if (!normalized.agentId || !normalized.sessionId) {
          logger.warn?.(
            `[${manifest.id}] Skipping hook '${binding.hookName}' because agent/session ids were missing. eventKeys=${Object.keys(event ?? {}).join(",")} ctxKeys=${Object.keys(ctx ?? {}).join(",")}`
          );
          return null;
        }

        if (binding.kind === "tool") {
          if (!normalized.toolName) {
            logger.warn?.(
              `[${manifest.id}] Skipping hook '${binding.hookName}' because toolName was missing. eventKeys=${Object.keys(event ?? {}).join(",")} ctxKeys=${Object.keys(ctx ?? {}).join(",")}`
            );
            return null;
          }

          const resolvedToolContext = await resolveToolHookContext(api, engine, normalized, logger);
          return engine.hooks[binding.handlerName](resolvedToolContext);
        }

        return engine.hooks[binding.handlerName](normalized);
      } catch (error) {
        logger.error?.(
          `[${manifest.id}] Hook '${binding.hookName}' failed: ${error instanceof Error ? error.message : error}`
        );
        throw error;
      }
    };

    if (typeof api?.on === "function") {
      api.on(binding.hookName, handler);
      continue;
    }

    api.registerHook(binding.hookName, handler, {
      name: `${manifest.id}.${binding.hookName}`,
      description: `Step Rollback handler for ${binding.hookName}`
    });
  }
}

export function registerService(api, engine, logger) {
  if (typeof api?.registerService !== "function") {
    return;
  }

  api.registerService({
    id: `${manifest.id}-runtime`,
    start: () => {
      logger.info?.(`[${manifest.id}] native runtime ready`);
      return engine.status();
    },
    stop: () => {
      logger.info?.(`[${manifest.id}] native runtime stopped`);
    }
  });
}
