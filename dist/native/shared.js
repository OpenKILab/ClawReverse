import path from "node:path";

import { CONFIG_DIRECTORY_KEYS, defaultConfig, manifest } from "../core/contracts.js";
import { StepRollbackError, toStepRollbackError } from "../core/errors.js";
import { fileExistsSync, isPlaceholderHomePath, resolveAbsolutePath, resolveConfig } from "../core/utils.js";

export function createLogger(api) {
  const noop = () => { };
  const logger = api?.logger ?? {};

  return {
    info: logger.info?.bind(logger) ?? noop,
    warn: logger.warn?.bind(logger) ?? noop,
    error: logger.error?.bind(logger) ?? noop,
    debug: logger.debug?.bind(logger) ?? noop
  };
}

export function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

export function pickInteger(...values) {
  for (const value of values) {
    if (Number.isInteger(value)) {
      return value;
    }
  }

  return undefined;
}

export function pickNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function resolveCallable(root, pathSegments) {
  let current = root;

  for (const segment of pathSegments) {
    if (!current || typeof current !== "object") {
      return null;
    }

    current = current[segment];
  }

  if (typeof current !== "function") {
    return null;
  }

  const thisArg = pathSegments.length > 1 ? pathSegments.slice(0, -1).reduce((acc, key) => acc?.[key], root) : root;
  return {
    fn: current,
    thisArg: thisArg ?? root
  };
}

export async function callFirstHelper(root, candidates, payload) {
  for (const pathSegments of candidates) {
    const resolved = resolveCallable(root, pathSegments);

    if (!resolved) {
      continue;
    }

    return resolved.fn.call(resolved.thisArg, payload);
  }

  return undefined;
}

export async function callGatewayMethod(api, method, params) {
  const callerPaths = [
    ["runtime", "gateway", "call"],
    ["runtime", "rpc", "call"],
    ["runtime", "callGatewayMethod"],
    ["gateway", "call"],
    ["rpc", "call"],
    ["callGatewayMethod"]
  ];

  let foundCaller = false;
  let lastError = null;

  for (const callerPath of callerPaths) {
    const resolved = resolveCallable(api, callerPath);

    if (!resolved) {
      continue;
    }

    foundCaller = true;

    const callPatterns = [
      () => resolved.fn.call(resolved.thisArg, method, params),
      () => resolved.fn.call(resolved.thisArg, { method, params }),
      () => resolved.fn.call(resolved.thisArg, method, { params })
    ];

    for (const attempt of callPatterns) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (foundCaller && lastError) {
    throw lastError;
  }

  return undefined;
}

export function unwrapRpcResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }

  if ("ok" in result && "data" in result) {
    return result.ok ? result.data : result;
  }

  return result;
}

export function resolvePluginConfig(api, pluginId) {
  const entryConfig = api?.config?.plugins?.entries?.[pluginId]?.config;
  const directConfig = api?.pluginConfig;

  return {
    ...(entryConfig && typeof entryConfig === "object" ? entryConfig : {}),
    ...(directConfig && typeof directConfig === "object" ? directConfig : {})
  };
}

function findPlaceholderConfigPaths(rawConfig) {
  const warnings = [];

  for (const rootPath of rawConfig.workspaceRoots ?? []) {
    if (isPlaceholderHomePath(rootPath)) {
      warnings.push(`workspaceRoots contains placeholder path '${rootPath}'`);
    }
  }

  for (const key of CONFIG_DIRECTORY_KEYS) {
    if (isPlaceholderHomePath(rawConfig[key])) {
      warnings.push(`${key} contains placeholder path '${rawConfig[key]}'`);
    }
  }

  return warnings;
}

export function prepareResolvedConfig(rawConfig, logger) {
  const resolvedConfig = resolveConfig(rawConfig);

  for (const warning of findPlaceholderConfigPaths(rawConfig)) {
    logger.warn?.(
      `[${manifest.id}] ${warning}. The plugin will repair it to the current home directory automatically.`
    );
  }

  for (const rootPath of resolvedConfig.workspaceRoots) {
    if (!fileExistsSync(rootPath)) {
      logger.warn?.(`[${manifest.id}] configured workspace root does not exist: ${rootPath}`);
    }
  }

  return resolvedConfig;
}

export function resolveOpenClawStateDir() {
  return resolveAbsolutePath(
    process.env.OPENCLAW_STATE_DIR ||
    process.env.OPENCLAW_HOME ||
    "~/.openclaw"
  );
}

export function resolveOpenClawConfigPath() {
  return resolveAbsolutePath(
    process.env.OPENCLAW_CONFIG_PATH ||
    path.join(resolveOpenClawStateDir(), "openclaw.json")
  );
}

function normalizeSetupBaseDir(baseDir) {
  const raw = pickNonEmptyString(
    baseDir,
    process.env.OPENCLAW_STATE_DIR,
    process.env.OPENCLAW_HOME,
    "~/.openclaw"
  );

  if (!raw) {
    return "~/.openclaw";
  }

  return raw.replace(/[\\/]+$/, "") || raw;
}

function joinSetupPath(baseDir, ...parts) {
  return [normalizeSetupBaseDir(baseDir), ...parts]
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
}

export function buildSetupPluginConfig(baseDir) {
  const pluginRoot = joinSetupPath(baseDir, "plugins", manifest.id);

  return {
    enabled: defaultConfig.enabled,
    workspaceRoots: [
      joinSetupPath(baseDir, "workspace")
    ],
    checkpointDir: joinSetupPath(pluginRoot, "checkpoints"),
    registryDir: joinSetupPath(pluginRoot, "registry"),
    runtimeDir: joinSetupPath(pluginRoot, "runtime"),
    reportsDir: joinSetupPath(pluginRoot, "reports"),
    maxCheckpointsPerSession: defaultConfig.maxCheckpointsPerSession,
    allowContinuePrompt: defaultConfig.allowContinuePrompt,
    stopRunBeforeRollback: defaultConfig.stopRunBeforeRollback
  };
}

export function patchPluginSetupDocument(configDocument, pluginId, pluginConfig) {
  const nextConfig = structuredClone(
    configDocument && typeof configDocument === "object" && !Array.isArray(configDocument)
      ? configDocument
      : {}
  );
  const existingPlugins = nextConfig.plugins && typeof nextConfig.plugins === "object" && !Array.isArray(nextConfig.plugins)
    ? nextConfig.plugins
    : {};
  const existingEntries = existingPlugins.entries && typeof existingPlugins.entries === "object" && !Array.isArray(existingPlugins.entries)
    ? existingPlugins.entries
    : {};
  const existingAllow = Array.isArray(existingPlugins.allow) ? existingPlugins.allow.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  const nextAllow = existingAllow.includes(pluginId) ? existingAllow : [...existingAllow, pluginId];
  const previousSnapshot = JSON.stringify(nextConfig);

  nextConfig.plugins = {
    ...existingPlugins,
    enabled: true,
    allow: nextAllow,
    entries: {
      ...existingEntries,
      [pluginId]: {
        ...(existingEntries[pluginId] && typeof existingEntries[pluginId] === "object" ? existingEntries[pluginId] : {}),
        enabled: true,
        config: {
          ...(existingEntries[pluginId]?.config && typeof existingEntries[pluginId].config === "object"
            ? existingEntries[pluginId].config
            : {}),
          ...pluginConfig
        }
      }
    }
  };

  return {
    document: nextConfig,
    changed: JSON.stringify(nextConfig) !== previousSnapshot
  };
}

export function patchPluginDisableDocument(configDocument, pluginId) {
  const nextConfig = structuredClone(
    configDocument && typeof configDocument === "object" && !Array.isArray(configDocument)
      ? configDocument
      : {}
  );
  const existingPlugins = nextConfig.plugins && typeof nextConfig.plugins === "object" && !Array.isArray(nextConfig.plugins)
    ? nextConfig.plugins
    : {};
  const existingEntries = existingPlugins.entries && typeof existingPlugins.entries === "object" && !Array.isArray(existingPlugins.entries)
    ? existingPlugins.entries
    : {};
  const previousSnapshot = JSON.stringify(nextConfig);

  nextConfig.plugins = {
    ...existingPlugins,
    entries: {
      ...existingEntries,
      [pluginId]: {
        ...(existingEntries[pluginId] && typeof existingEntries[pluginId] === "object" ? existingEntries[pluginId] : {}),
        enabled: false
      }
    }
  };

  return {
    document: nextConfig,
    changed: JSON.stringify(nextConfig) !== previousSnapshot
  };
}

export function extractGatewayParams(request) {
  if (!request || typeof request !== "object") {
    return {};
  }

  return pickFirst(
    request.params,
    request.input,
    request.body?.params,
    request.request?.body?.params,
    request.payload,
    request
  ) ?? {};
}

export function normalizeHookContext(kind, event, ctx) {
  const payload = {
    agentId: pickFirst(
      event?.agentId,
      event?.agent?.id,
      event?.session?.agentId,
      ctx?.agentId,
      ctx?.agent?.id,
      ctx?.session?.agentId
    ),
    sessionId: pickFirst(
      event?.sessionId,
      event?.session?.id,
      ctx?.sessionId,
      ctx?.session?.id
    ),
    runId: pickFirst(
      event?.runId,
      event?.run?.id,
      ctx?.runId,
      ctx?.run?.id
    ),
    toolCallId: pickFirst(
      event?.toolCallId,
      event?.tool_call_id,
      event?.toolCall?.id,
      ctx?.toolCallId,
      ctx?.tool_call_id,
      ctx?.toolCall?.id
    ),
    entryId: pickFirst(
      event?.entryId,
      event?.entry?.id,
      event?.toolCall?.entryId,
      event?.toolCall?.entry?.id,
      ctx?.entryId,
      ctx?.entry?.id
    ),
    nodeIndex: pickInteger(
      event?.nodeIndex,
      event?.entry?.nodeIndex,
      event?.toolCall?.nodeIndex,
      ctx?.nodeIndex,
      ctx?.entry?.nodeIndex
    ),
    toolName: pickFirst(
      event?.toolName,
      event?.tool?.name,
      event?.toolCall?.name,
      event?.call?.toolName,
      ctx?.toolName,
      ctx?.tool?.name
    ),
    success: pickFirst(event?.success, ctx?.success),
    cwd: pickFirst(
      event?.cwd,
      event?.session?.cwd,
      ctx?.cwd,
      ctx?.session?.cwd
    ),
    params: pickFirst(event?.params, event?.input, ctx?.params, ctx?.input)
  };

  if (kind === "session") {
    return {
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      runId: payload.runId,
      entryId: payload.entryId
    };
  }

  return payload;
}

export function toNativeErrorPayload(error) {
  const normalized = toStepRollbackError(error, "CONTINUE_START_FAILED");

  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details
    }
  };
}

export function parseJsonOutput(output, code = "GATEWAY_CALL_FAILED") {
  const trimmed = typeof output === "string" ? output.trim() : "";

  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    for (let start = 0; start < lines.length; start += 1) {
      const candidate = lines.slice(start).join("\n");

      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
  }

  throw new StepRollbackError(
    code,
    "OpenClaw command did not return valid JSON output.",
    { output: trimmed }
  );
}
