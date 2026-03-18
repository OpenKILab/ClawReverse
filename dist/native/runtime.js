import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { StepRollbackError } from "../core/errors.js";
import { copyPath, ensureDir, pathExists, readJson, removePath, resolveAbsolutePath, writeJson } from "../core/utils.js";
import { manifest } from "../plugin.js";
import { invokeAgentViaCli } from "./cli.js";
import {
  buildAgentSessionKey,
  buildBranchSessionKey,
  buildBranchSessionLabel,
  forkSessionTranscriptEntries,
  normalizeAgentIdInput,
  normalizeExternalParams,
  readSessionTranscriptEntries,
  resolveSessionRecord,
  resolveSessionRecordEventually,
  resolveToolHookContext,
  writeForkedSessionState,
  writeSessionTranscriptEntries
} from "./sessions.js";
import {
  callFirstHelper,
  callGatewayMethod,
  extractGatewayParams,
  normalizeHookContext,
  pickNonEmptyString,
  resolveOpenClawConfigPath,
  resolveOpenClawStateDir,
  toNativeErrorPayload,
  unwrapRpcResult
} from "./shared.js";

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

const OMITTED_AUTH_KEYS = new Set([
  "auth",
  "token",
  "tokens",
  "password",
  "passwords",
  "apiKey",
  "apiKeys",
  "headers",
  "header",
  "secret",
  "secrets"
]);

const ALLOWED_AGENT_OVERRIDE_KEYS = [
  "model",
  "params",
  "identity",
  "groupChat",
  "sandbox",
  "tools",
  "runtime",
  "heartbeat"
];

const ALLOWED_SUBAGENT_KEYS = [
  "allowAgents"
];

const LEGACY_AGENT_DEFAULT_KEYS = [
  "models",
  "compaction",
  "maxConcurrent"
];

function sanitizeAgentToken(value, fallback = "agent") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function resolvePluginStateRoot(config) {
  return path.dirname(config?.checkpointDir ?? resolveAbsolutePath("~/.openclaw/plugins/step-rollback/checkpoints"));
}

function resolveForkWorkspacePath(config, agentId) {
  return path.join(resolvePluginStateRoot(config), "workspaces", agentId);
}

function resolveContinueLogFilePath(config, agentId, branchId) {
  const runtimeDir = config?.runtimeDir ?? path.join(resolvePluginStateRoot(config), "runtime");
  return path.join(
    runtimeDir,
    "logs",
    `continue-${sanitizeAgentToken(agentId, "agent")}-${sanitizeAgentToken(branchId, "continue")}.log`
  );
}

function resolveAgentRootDirectory(agentId) {
  return path.join(resolveOpenClawStateDir(), "agents", agentId);
}

async function resolveAgentDirectory(agentId, entry = null) {
  const configuredAgentDir = pickNonEmptyString(entry?.agentDir);

  if (configuredAgentDir) {
    return resolveAbsolutePath(configuredAgentDir);
  }

  const agentRootDir = resolveAgentRootDirectory(agentId);
  const nestedAgentDir = path.join(agentRootDir, "agent");

  if (await pathExists(nestedAgentDir)) {
    return nestedAgentDir;
  }

  return nestedAgentDir;
}

async function resolveForkAgentStorage(sourceAgentId, sourceEntry, childAgentId) {
  const sourceAgentRootDir = resolveAgentRootDirectory(sourceAgentId);
  const sourceAgentDir = await resolveAgentDirectory(sourceAgentId, sourceEntry);
  let relativeAgentDir = "agent";

  if (sourceAgentDir === sourceAgentRootDir) {
    relativeAgentDir = ".";
  } else if (sourceAgentDir.startsWith(`${sourceAgentRootDir}${path.sep}`)) {
    relativeAgentDir = path.relative(sourceAgentRootDir, sourceAgentDir) || ".";
  }

  const childAgentRootDir = resolveAgentRootDirectory(childAgentId);
  const childAgentDir = relativeAgentDir === "."
    ? childAgentRootDir
    : path.join(childAgentRootDir, relativeAgentDir);

  return {
    sourceAgentRootDir,
    sourceAgentDir,
    childAgentRootDir,
    childAgentDir,
    relativeAgentDir
  };
}

async function seedForkedAgentDirectory({ sourceAgentDir, sourceAgentRootDir, childAgentDir, childAgentRootDir, relativeAgentDir }) {
  const sourceExists = await pathExists(sourceAgentDir);

  await ensureDir(childAgentRootDir);

  if (!sourceExists) {
    await ensureDir(childAgentDir);
    return;
  }

  if (relativeAgentDir === ".") {
    await ensureDir(childAgentDir);

    for (const entry of await fs.readdir(sourceAgentRootDir, { withFileTypes: true })) {
      if (entry.name === "sessions") {
        continue;
      }

      await copyPath(
        path.join(sourceAgentRootDir, entry.name),
        path.join(childAgentRootDir, entry.name)
      );
    }

    return;
  }

  await copyPath(sourceAgentDir, childAgentDir);
}

function resolveConfiguredWorkspace(entry) {
  return pickNonEmptyString(entry?.workspace, entry?.workspaceRoot, entry?.cwd, entry?.root);
}

function sanitizeSubagentConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const sanitized = {};

  for (const key of ALLOWED_SUBAGENT_KEYS) {
    if (value[key] !== undefined) {
      sanitized[key] = structuredClone(value[key]);
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizeConfiguredAgentEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const sanitized = {};
  const workspace = resolveConfiguredWorkspace(entry);
  const agentId = pickNonEmptyString(entry.id);
  const agentName = pickNonEmptyString(entry.name, agentId);

  if (agentId) {
    sanitized.id = agentId;
  }

  if (entry.default === true) {
    sanitized.default = true;
  }

  if (agentName) {
    sanitized.name = agentName;
  }

  if (workspace) {
    sanitized.workspace = workspace;
  }

  if (pickNonEmptyString(entry.agentDir)) {
    sanitized.agentDir = entry.agentDir;
  }

  for (const key of ALLOWED_AGENT_OVERRIDE_KEYS) {
    if (entry[key] !== undefined) {
      sanitized[key] = structuredClone(entry[key]);
    }
  }

  const sanitizedSubagents = sanitizeSubagentConfig(entry.subagents);

  if (sanitizedSubagents) {
    sanitized.subagents = sanitizedSubagents;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function cloneAgentEntryForFork(parentEntry, { newAgentId, newWorkspacePath, newAgentDir, cloneAuth }) {
  const sourceEntry = parentEntry && typeof parentEntry === "object" ? structuredClone(parentEntry) : {};
  const nextEntry = {
    id: newAgentId,
    name: newAgentId,
    workspace: newWorkspacePath,
    agentDir: newAgentDir
  };

  for (const key of ALLOWED_AGENT_OVERRIDE_KEYS) {
    const value = sourceEntry[key];
    if (value !== undefined) {
      nextEntry[key] = structuredClone(value);
    }
  }

  const sanitizedSubagents = sanitizeSubagentConfig(sourceEntry.subagents);

  if (sanitizedSubagents) {
    nextEntry.subagents = sanitizedSubagents;
  }

  if (cloneAuth === "never") {
    for (const key of OMITTED_AUTH_KEYS) {
      delete nextEntry[key];
    }
  }

  return nextEntry;
}

function isPluginManagedForkEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  const workspace = pickNonEmptyString(entry.workspace);
  const agentId = pickNonEmptyString(entry.id);

  return workspace.includes("/plugins/step-rollback/workspaces/") || /-cp-\d+$/i.test(agentId);
}

function sanitizeListAgentEntry(entry) {
  if (!isPluginManagedForkEntry(entry)) {
    return sanitizeConfiguredAgentEntry(entry);
  }

  return cloneAgentEntryForFork(entry, {
    newAgentId: entry.id,
    newWorkspacePath: resolveConfiguredWorkspace(entry),
    newAgentDir: entry.agentDir,
    cloneAuth: "auto"
  });
}

function repairConfiguredAgentEntries(entries, defaultsEntry) {
  const hadDefaults = defaultsEntry && typeof defaultsEntry === "object" && !Array.isArray(defaultsEntry);
  const nextDefaults = hadDefaults ? structuredClone(defaultsEntry) : {};
  const repairedEntries = [];

  for (const [index, entry] of (entries ?? []).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    if (entry.default === true || index === 0 || entry.id === "main") {
      for (const key of LEGACY_AGENT_DEFAULT_KEYS) {
        if (entry[key] !== undefined && nextDefaults[key] === undefined) {
          nextDefaults[key] = structuredClone(entry[key]);
        }
      }
    }

    const sanitized = sanitizeListAgentEntry(entry);

    if (sanitized) {
      repairedEntries.push(sanitized);
    }
  }

  return {
    entries: repairedEntries,
    defaults: hadDefaults || Object.keys(nextDefaults).length > 0 ? nextDefaults : undefined
  };
}

function resolveAgentsConfig(api, configDocument = null) {
  return configDocument?.agents ?? api?.config?.agents;
}

function resolveParentAgentEntry(api, agentId, configDocument = null) {
  const configApi = configDocument ? { config: configDocument } : api;
  const normalizedAgentId = normalizeAgentIdInput(configApi, agentId);
  const agentsConfig = resolveAgentsConfig(api, configDocument);

  if (Array.isArray(agentsConfig?.list)) {
    const match = agentsConfig.list.find((entry) => entry && typeof entry === "object" && entry.id === normalizedAgentId);
    if (match) {
      return { entry: match, shape: "list" };
    }
  }

  if (Array.isArray(agentsConfig?.entries)) {
    const match = agentsConfig.entries.find((entry) => entry && typeof entry === "object" && entry.id === normalizedAgentId);
    if (match) {
      return { entry: match, shape: "entries" };
    }
  }

  if (agentsConfig && typeof agentsConfig === "object" && !Array.isArray(agentsConfig)) {
    if (agentsConfig[normalizedAgentId] && typeof agentsConfig[normalizedAgentId] === "object") {
      return { entry: agentsConfig[normalizedAgentId], shape: "object" };
    }

    const defaultAgentId = normalizeAgentIdInput(configApi, "default");
    if (normalizedAgentId === defaultAgentId && agentsConfig.defaults && typeof agentsConfig.defaults === "object") {
      return { entry: agentsConfig.defaults, shape: "defaults" };
    }
  }

  return {
    entry: {
      id: normalizedAgentId,
      name: normalizedAgentId
    },
    shape: "generated"
  };
}

function collectLegacyAgentEntries(agentsConfig) {
  if (!agentsConfig || typeof agentsConfig !== "object" || Array.isArray(agentsConfig)) {
    return [];
  }

  return Object.entries(agentsConfig)
    .filter(([key, value]) =>
      !["defaults", "list", "entries"].includes(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    )
    .map(([key, value]) => ({
      ...value,
      id: typeof value.id === "string" && value.id.trim() ? value.id : key
    }));
}

function resolveContinueNewAgentId(api, configDocument, sourceAgentId, newAgentId) {
  const configApi = configDocument ? { config: configDocument } : api;
  const normalizedSourceAgentId = normalizeAgentIdInput(configApi, sourceAgentId);
  const requestedNewAgentId = pickNonEmptyString(newAgentId);

  if (!requestedNewAgentId) {
    return null;
  }

  const normalizedNewAgentId = normalizeAgentIdInput(configApi, requestedNewAgentId);

  if (normalizedNewAgentId === normalizedSourceAgentId) {
    throw new StepRollbackError(
      "CONTINUE_TARGET_CONFLICT",
      `New agent '${normalizedNewAgentId}' cannot be the same as the source agent.`,
      { sourceAgentId: normalizedSourceAgentId, newAgentId: normalizedNewAgentId }
    );
  }

  return normalizedNewAgentId;
}

function hasConfiguredAgent(api, configDocument, agentId) {
  const normalizedAgentId = sanitizeAgentToken(agentId, "agent");
  const agentsConfig = configDocument?.agents ?? api?.config?.agents;

  if (Array.isArray(agentsConfig?.list)) {
    return agentsConfig.list.some((entry) => entry && typeof entry === "object" && entry.id === normalizedAgentId);
  }

  if (Array.isArray(agentsConfig?.entries)) {
    return agentsConfig.entries.some((entry) => entry && typeof entry === "object" && entry.id === normalizedAgentId);
  }

  if (agentsConfig && typeof agentsConfig === "object") {
    if (Boolean(agentsConfig[normalizedAgentId])) {
      return true;
    }

    return collectLegacyAgentEntries(agentsConfig).some((entry) => entry.id === normalizedAgentId);
  }

  return false;
}

function patchConfigWithForkedAgent(configDocument, agentId, agentEntry) {
  const nextConfig = structuredClone(configDocument ?? {});
  const nextAgents = nextConfig.agents && typeof nextConfig.agents === "object" && !Array.isArray(nextConfig.agents)
    ? nextConfig.agents
    : {};
  const legacyEntries = collectLegacyAgentEntries(nextAgents);
  const normalizedLegacyEntries = legacyEntries.filter((entry) => entry.id !== agentId);
  const sanitizedAgentEntry = sanitizeConfiguredAgentEntry({
    ...agentEntry,
    id: agentId,
    name: pickNonEmptyString(agentEntry?.name, agentId)
  }) ?? {
    ...agentEntry,
    id: agentId
  };

  if (Array.isArray(nextAgents?.list)) {
    const repaired = repairConfiguredAgentEntries(nextAgents.list, nextAgents.defaults);

    nextAgents.list = [
      ...repaired.entries.filter((entry) => entry?.id !== agentId),
      sanitizedAgentEntry
    ];

    if (repaired.defaults !== undefined) {
      nextAgents.defaults = repaired.defaults;
    }

    return nextConfig;
  }

  if (Array.isArray(nextAgents?.entries)) {
    const repaired = repairConfiguredAgentEntries(nextAgents.entries, nextAgents.defaults);

    nextAgents.entries = [
      ...repaired.entries.filter((entry) => entry?.id !== agentId),
      sanitizedAgentEntry
    ];

    if (repaired.defaults !== undefined) {
      nextAgents.defaults = repaired.defaults;
    }

    return nextConfig;
  }

  const repaired = repairConfiguredAgentEntries(normalizedLegacyEntries, nextAgents.defaults);

  nextConfig.agents = {
    ...nextAgents,
    ...(repaired.defaults !== undefined ? { defaults: repaired.defaults } : {}),
    list: [
      ...repaired.entries,
      sanitizedAgentEntry
    ]
  };

  for (const key of Object.keys(nextConfig.agents)) {
    if (!["defaults", "list", "entries"].includes(key) && typeof nextConfig.agents[key] === "object") {
      delete nextConfig.agents[key];
    }
  }

  return nextConfig;
}

function syncApiConfig(api, nextConfig) {
  if (!api) {
    return;
  }

  if (!api.config || typeof api.config !== "object") {
    api.config = nextConfig;
    return;
  }

  for (const key of Object.keys(api.config)) {
    if (!(key in nextConfig)) {
      delete api.config[key];
    }
  }

  Object.assign(api.config, nextConfig);
}

async function loadCheckpointTranscriptPrefix(api, checkpoint) {
  const snapshotInfo = checkpoint?.transcriptSnapshot;
  const snapshotFile = snapshotInfo?.included && snapshotInfo?.fileName
    ? path.join(checkpoint.snapshotRef, snapshotInfo.fileName)
    : path.join(checkpoint.snapshotRef, "transcript-prefix.jsonl");

  if (await pathExists(snapshotFile)) {
    const contents = await fs.readFile(snapshotFile, "utf8");
    return contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const transcript = await readSessionTranscriptEntries(api, checkpoint.agentId, checkpoint.sessionId);
  const prefix = [];

  for (const entry of transcript.entries) {
    prefix.push(entry);

    if (entry?.id === checkpoint.entryId) {
      return prefix;
    }
  }

  throw new StepRollbackError(
    "ERR_SESSION_REBUILD_FAILED",
    `Could not rebuild transcript prefix for checkpoint '${checkpoint.checkpointId}'.`,
    {
      checkpointId: checkpoint.checkpointId,
      agentId: checkpoint.agentId,
      sessionId: checkpoint.sessionId,
      entryId: checkpoint.entryId
    }
  );
}

export function createNativeHostBridge(api, logger, options = {}) {
  const resolvedPluginConfig = options.config ?? {};
  const getEngine = typeof options.getEngine === "function" ? options.getEngine : () => null;
  const bridge = {
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

    async startContinueRun({ agentId, sessionId, sessionKey, entryId, prompt, sourceSessionId, branchId, label, log = false }) {
      const knownSession = await resolveSessionRecord(api, agentId, {
        sessionId,
        sessionKey
      });
      const targetSessionKey = sessionKey ?? knownSession?.sessionKey;
      const targetSessionId = sessionId ?? knownSession?.sessionId;
      const syntheticMessage = prompt?.trim() || "Continue from the restored checkpoint.";
      const branchLabel = label ?? buildBranchSessionLabel(sourceSessionId ?? targetSessionId ?? "session", branchId ?? "continue");
      const configDocument = await readJson(resolveOpenClawConfigPath(), api?.config ?? {});
      const targetAgent = resolveParentAgentEntry(api, agentId, configDocument);
      const cliCwd = pickNonEmptyString(
        resolveConfiguredWorkspace(targetAgent.entry),
        options.cliCwd,
        resolvedPluginConfig.workspaceRoots[0]
      );
      const logFilePath = log
        ? resolveContinueLogFilePath(resolvedPluginConfig, agentId, branchId ?? targetSessionId ?? crypto.randomUUID())
        : "";

      if (log) {
        logger.info?.(
          `[${manifest.id}] continue diagnostics agent='${agentId}' session='${targetSessionId || "-"}' sessionKey='${targetSessionKey || "-"}' cwd='${cliCwd || "-"}' logFile='${logFilePath || "-"}'`
        );
      }

      try {
        return await invokeAgentViaCli(api, logger, {
          ...options,
          agentId,
          sessionId: targetSessionId,
          sessionKey: targetSessionKey,
          prompt: syntheticMessage,
          sourceSessionId: sourceSessionId ?? targetSessionId,
          branchId,
          label: branchLabel,
          cliCwd,
          log,
          logFilePath
        });
      } catch (error) {
        logger.warn?.(
          `[${manifest.id}] openclaw agent continuation fallback failed for sourceSession='${sourceSessionId ?? targetSessionId ?? "-"}': ${error instanceof Error ? error.message : error}`
        );
      }

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
    },

    async forkContinue({ sourceAgentId, sourceSessionId, checkpoint, prompt, newAgentId, cloneAuth, branchId, log = false }) {
      const engine = getEngine();
      if (!engine?.services?.checkpointManager) {
        throw new StepRollbackError(
          "CONTINUE_START_FAILED",
          "Step Rollback could not access its runtime services while forking a child agent.",
          { sourceAgentId, sourceSessionId, checkpointId: checkpoint?.checkpointId }
        );
      }

      const configPath = resolveOpenClawConfigPath();
      const configDocument = await readJson(configPath, api?.config ?? {});
      const parentAgent = resolveParentAgentEntry(api, sourceAgentId, configDocument);
      const childSessionId = crypto.randomUUID();
      const childLabel = buildBranchSessionLabel(sourceSessionId, branchId ?? "continue");
      const transcriptPrefix = await loadCheckpointTranscriptPrefix(api, checkpoint);
      const sourceWorkspacePath = pickNonEmptyString(
        checkpoint?.workspaceSnapshots?.[0]?.targetPath,
        resolveConfiguredWorkspace(parentAgent.entry),
        engine.config.workspaceRoots[0]
      );
      const requestedNewAgentId = resolveContinueNewAgentId(api, configDocument, sourceAgentId, newAgentId);
      const createdNewAgent = true;
      const childAgentId = sanitizeAgentToken(
        requestedNewAgentId || `${sourceAgentId}-cp-${String(branchId ?? crypto.randomUUID()).slice(-4)}`,
        "agent"
      );
      const childWorkspacePath = resolveForkWorkspacePath(resolvedPluginConfig, childAgentId);
      const childSessionKey = buildAgentSessionKey(childAgentId);
      const sourceAgentStorage = await resolveForkAgentStorage(sourceAgentId, parentAgent.entry, childAgentId);
      const childAgentRootDir = sourceAgentStorage.childAgentRootDir;
      const childAgentDir = sourceAgentStorage.childAgentDir;
      const relativeAgentDir = sourceAgentStorage.relativeAgentDir;
      const logFilePath = log
        ? resolveContinueLogFilePath(resolvedPluginConfig, childAgentId, branchId ?? childSessionId)
        : "";
      let configWritten = false;

      if (hasConfiguredAgent(api, configDocument, childAgentId)) {
        throw new StepRollbackError(
          "ERR_AGENT_ALREADY_EXISTS",
          `Agent '${childAgentId}' already exists.`,
          {
            sourceAgentId,
            sourceSessionId,
            checkpointId: checkpoint?.checkpointId,
            newAgentId: childAgentId
          }
        );
      }

      if (!childWorkspacePath) {
        throw new StepRollbackError(
          "ERR_WORKSPACE_MATERIALIZE_FAILED",
          `Agent '${childAgentId}' does not have a configured workspace.`,
          {
            sourceAgentId,
            sourceSessionId,
            checkpointId: checkpoint?.checkpointId,
            newAgentId: childAgentId
          }
        );
      }

      if (await pathExists(childWorkspacePath)) {
        throw new StepRollbackError(
          "ERR_AGENT_ALREADY_EXISTS",
          `Workspace '${childWorkspacePath}' already exists for agent '${childAgentId}'.`,
          {
            sourceAgentId,
            sourceSessionId,
            checkpointId: checkpoint?.checkpointId,
            newAgentId: childAgentId,
            newWorkspacePath: childWorkspacePath
          }
        );
      }

      if (await pathExists(childAgentRootDir)) {
        throw new StepRollbackError(
          "ERR_AGENT_ALREADY_EXISTS",
          `Agent directory '${childAgentRootDir}' already exists for agent '${childAgentId}'.`,
          {
            sourceAgentId,
            sourceSessionId,
            checkpointId: checkpoint?.checkpointId,
            newAgentId: childAgentId,
            newAgentDir: childAgentDir
          }
        );
      }

      try {
        await seedForkedAgentDirectory({
          sourceAgentDir: sourceAgentStorage.sourceAgentDir,
          sourceAgentRootDir: sourceAgentStorage.sourceAgentRootDir,
          childAgentDir,
          childAgentRootDir,
          relativeAgentDir
        });
        await ensureDir(path.join(childAgentRootDir, "sessions"));

        await engine.services.checkpointManager.materialize(checkpoint.checkpointId, {
          resolveTargetPath(entry, index) {
            if (entry.targetPath === checkpoint.workspaceSnapshots?.[0]?.targetPath) {
              return childWorkspacePath;
            }

            if (entry.targetPath === engine.config.workspaceRoots[0]) {
              return childWorkspacePath;
            }

            return path.join(childWorkspacePath, "__roots__", `${index + 1}-${path.basename(entry.targetPath || "root")}`);
          }
        });

        const childTranscriptEntries = forkSessionTranscriptEntries(transcriptPrefix, {
          sourceSessionId,
          targetSessionId: childSessionId,
          targetWorkspacePath: childWorkspacePath
        });

        await writeSessionTranscriptEntries(api, childAgentId, childSessionId, childTranscriptEntries);
        await writeForkedSessionState(api, {
          sourceAgentId,
          sourceSessionId,
          targetAgentId: childAgentId,
          targetSessionId: childSessionId,
          targetSessionKey: childSessionKey,
          sourceWorkspacePath,
          targetWorkspacePath: childWorkspacePath,
          label: childLabel,
          preserveExistingSessions: false
        });

        const childAgentEntry = cloneAgentEntryForFork(parentAgent.entry, {
          newAgentId: childAgentId,
          newWorkspacePath: childWorkspacePath,
          newAgentDir: childAgentDir,
          cloneAuth: pickNonEmptyString(cloneAuth).toLowerCase() || "auto"
        });
        const nextConfig = patchConfigWithForkedAgent(configDocument, childAgentId, childAgentEntry);

        await writeJson(configPath, nextConfig);
        syncApiConfig(api, nextConfig);
        configWritten = true;

        if (log) {
          logger.info?.(
            `[${manifest.id}] continue diagnostics sourceAgent='${sourceAgentId}' sourceSession='${sourceSessionId}' childAgent='${childAgentId}' childSession='${childSessionId}' sourceWorkspace='${sourceWorkspacePath}' childWorkspace='${childWorkspacePath}' childAgentDir='${childAgentDir}' logFile='${logFilePath || "-"}'`
          );
        }

        let runResult = null;

        try {
          runResult = await invokeAgentViaCli(api, logger, {
            ...options,
            agentId: childAgentId,
            sessionId: childSessionId,
            sessionKey: childSessionKey,
            prompt,
            sourceSessionId,
            label: childLabel,
            cliCwd: childWorkspacePath,
            log,
            logFilePath
          });
        } catch (error) {
          logger.warn?.(
            `[${manifest.id}] openclaw agent launch fallback failed for child agent '${childAgentId}': ${error instanceof Error ? error.message : error}`
          );
        }

        if (!runResult && typeof api?.runtime?.subagent?.run === "function") {
          try {
            const subagentResult = await api.runtime.subagent.run({
              sessionKey: childSessionKey,
              message: prompt,
              deliver: false
            });
            runResult = {
              started: true,
              runId: subagentResult?.runId ?? null,
              sessionId: childSessionId,
              sessionKey: childSessionKey
            };
          } catch (error) {
            logger.warn?.(
              `[${manifest.id}] runtime.subagent.run could not launch child agent '${childAgentId}': ${error instanceof Error ? error.message : error}`
            );
          }
        }

        return {
          started: runResult?.started !== false,
          runId: runResult?.runId ?? null,
          newAgentId: childAgentId,
          newWorkspacePath: childWorkspacePath,
          newAgentDir: childAgentDir,
          newSessionId: runResult?.sessionId ?? childSessionId,
          newSessionKey: runResult?.sessionKey ?? childSessionKey,
          createdNewAgent,
          logFilePath: runResult?.logFilePath ?? (logFilePath || null)
        };
      } catch (error) {
        if (!configWritten) {
          await removePath(childWorkspacePath).catch(() => {});
          await removePath(childAgentRootDir).catch(() => {});
        }

        if (error instanceof StepRollbackError) {
          throw error;
        }

        throw new StepRollbackError(
          "ERR_WORKSPACE_MATERIALIZE_FAILED",
          `Failed to fork child agent '${childAgentId}' from checkpoint '${checkpoint?.checkpointId ?? "-"}'. ${error instanceof Error ? error.message : error}`,
          {
            sourceAgentId,
            sourceSessionId,
            checkpointId: checkpoint?.checkpointId,
            newAgentId: childAgentId
          }
        );
      }
    }
  };

  return bridge;
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
