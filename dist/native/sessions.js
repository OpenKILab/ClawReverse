import fs from "node:fs/promises";
import path from "node:path";

import { readJson, resolveAbsolutePath } from "../core/utils.js";
import { manifest } from "../plugin.js";
import { pickFirst, pickInteger, pickNonEmptyString, unwrapRpcResult } from "./shared.js";

function sanitizeSessionToken(value, fallback = "branch") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function normalizeSessionStoreRecords(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        return {
          ...entry,
          sessionKey: pickFirst(entry.sessionKey, entry.key)
        };
      })
      .filter(Boolean);
  }

  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, entry]) => ({
      ...(entry && typeof entry === "object" ? entry : {}),
      sessionKey: pickFirst(entry?.sessionKey, entry?.key, key)
    }));
  }

  return [];
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);

      if (Number.isFinite(numeric)) {
        const date = new Date(numeric);
        return Number.isNaN(date.getTime()) ? null : date;
      }
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function formatTimestamp(value) {
  const date = normalizeTimestamp(value);

  if (!date) {
    return "-";
  }

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function timestampSortValue(...values) {
  for (const value of values) {
    const date = normalizeTimestamp(value);

    if (date) {
      return date.getTime();
    }
  }

  return 0;
}

function resolveSessionTranscriptPath(api, agentId, sessionId) {
  const configuredPath = pickFirst(
    api?.config?.session?.storePath,
    api?.config?.session?.indexPath,
    api?.config?.sessions?.storePath,
    api?.config?.sessions?.indexPath
  );

  if (typeof configuredPath === "string") {
    const resolvedPath = resolveAbsolutePath(
      configuredPath
        .replaceAll("{agentId}", agentId)
        .replaceAll("{agent}", agentId)
        .replaceAll("{sessionId}", sessionId)
    );

    if (resolvedPath.endsWith(".jsonl")) {
      return resolvedPath;
    }

    return path.join(path.dirname(resolvedPath), `${sessionId}.jsonl`);
  }

  return resolveAbsolutePath(`~/.openclaw/agents/${agentId}/sessions/${sessionId}.jsonl`);
}

function extractToolCallsFromAssistantEntry(entry) {
  const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
  const toolCalls = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    const toolCallId = pickFirst(item.id, item.toolCallId, item.tool_call_id);
    const toolName = pickFirst(item.name, item.toolName, item.tool_name);

    if (
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(type) ||
      (toolCallId && toolName && item.arguments !== undefined)
    ) {
      toolCalls.push({
        toolCallId,
        toolName,
        params: pickFirst(item.arguments, item.params, item.input, item.args)
      });
    }
  }

  return toolCalls;
}

async function resolveToolCallEntryFromTranscript(api, normalized, logger) {
  if (!normalized.agentId || !normalized.sessionId || !normalized.toolCallId) {
    return null;
  }

  const transcriptPath = resolveSessionTranscriptPath(api, normalized.agentId, normalized.sessionId);
  let contents;

  try {
    contents = await fs.readFile(transcriptPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      logger.warn?.(
        `[${manifest.id}] hook '${normalized.hookName}' could not inspect transcript because it does not exist yet: ${transcriptPath}`
      );
      return null;
    }

    throw error;
  }

  const lines = contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let nodeIndex = 0;

  for (const line of lines) {
    let entry;

    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry?.type !== "message" || entry?.message?.role !== "assistant") {
      continue;
    }

    for (const toolCall of extractToolCallsFromAssistantEntry(entry)) {
      nodeIndex += 1;

      if (toolCall.toolCallId === normalized.toolCallId) {
        return {
          entryId: pickFirst(entry.id, normalized.toolCallId),
          nodeIndex,
          params: toolCall.params,
          transcriptPath
        };
      }
    }
  }

  logger.warn?.(
    `[${manifest.id}] hook '${normalized.hookName}' did not find toolCallId='${normalized.toolCallId}' in transcript '${transcriptPath}' yet`
  );

  return null;
}

export async function resolveToolHookContext(api, engine, normalized, logger) {
  const enriched = { ...normalized };
  const runtimeCursorManager = engine?.services?.runtimeCursorManager;

  if (!enriched.toolName) {
    return enriched;
  }

  if ((!enriched.entryId || !Number.isInteger(enriched.nodeIndex)) && enriched.toolCallId) {
    const transcriptMatch = await resolveToolCallEntryFromTranscript(api, enriched, logger);

    if (transcriptMatch) {
      enriched.entryId = enriched.entryId ?? transcriptMatch.entryId;
      enriched.nodeIndex = Number.isInteger(enriched.nodeIndex) ? enriched.nodeIndex : transcriptMatch.nodeIndex;
      enriched.params = enriched.params ?? transcriptMatch.params;
      logger.info?.(
        `[${manifest.id}] resolved tool checkpoint context from transcript toolCallId='${enriched.toolCallId}' entry='${enriched.entryId}' node='${enriched.nodeIndex}'`
      );
    }
  }

  if (runtimeCursorManager) {
    if (Number.isInteger(enriched.nodeIndex)) {
      await runtimeCursorManager.syncToolCallSequence(
        enriched.agentId,
        enriched.sessionId,
        enriched.nodeIndex,
        enriched.toolCallId
      );
    } else {
      enriched.nodeIndex = await runtimeCursorManager.nextToolCallSequence(
        enriched.agentId,
        enriched.sessionId,
        enriched.toolCallId
      );
      logger.warn?.(
        `[${manifest.id}] fallback tool checkpoint sequence was used for tool='${enriched.toolName}' toolCallId='${enriched.toolCallId ?? "-"}' node='${enriched.nodeIndex}'`
      );
    }
  }

  if (!enriched.entryId) {
    enriched.entryId = enriched.toolCallId ? `toolcall:${enriched.toolCallId}` : `toolcall:${enriched.nodeIndex ?? "unknown"}`;
    logger.warn?.(
      `[${manifest.id}] fallback checkpoint entry id was used for tool='${enriched.toolName}' toolCallId='${enriched.toolCallId ?? "-"}' entry='${enriched.entryId}'`
    );
  }

  return enriched;
}

function resolveDefaultAgentId(api) {
  const agentsConfig = api?.config?.agents;
  const configuredList = Array.isArray(agentsConfig?.list)
    ? agentsConfig.list
    : Array.isArray(agentsConfig?.entries)
      ? agentsConfig.entries
      : [];
  const defaultEntry = configuredList.find(
    (entry) => entry && typeof entry === "object" && entry.default === true && typeof entry.id === "string" && entry.id.trim()
  );

  if (defaultEntry) {
    return sanitizeSessionToken(defaultEntry.id, "main");
  }

  const routingDefault = typeof api?.config?.routing?.defaultAgentId === "string"
    ? api.config.routing.defaultAgentId.trim()
    : "";

  if (routingDefault) {
    return sanitizeSessionToken(routingDefault, "main");
  }

  const firstEntry = configuredList.find(
    (entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim()
  );

  if (firstEntry) {
    return sanitizeSessionToken(firstEntry.id, "main");
  }

  return "main";
}

export function normalizeAgentIdInput(api, value) {
  const defaultAgentId = resolveDefaultAgentId(api);
  const raw = typeof value === "string" ? value.trim() : "";

  if (!raw) {
    return defaultAgentId;
  }

  const normalized = sanitizeSessionToken(raw, defaultAgentId);

  if (normalized === "default" || normalized === "defaults") {
    return defaultAgentId;
  }

  return normalized;
}

export function normalizeExternalParams(api, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params ?? {};
  }

  const nextParams = { ...params };

  if (typeof nextParams.agentId === "string") {
    nextParams.agentId = normalizeAgentIdInput(api, nextParams.agentId);
  }

  return nextParams;
}

export function getConfiguredAgents(api) {
  const configured = pickFirst(
    api?.config?.agents?.list,
    api?.config?.agents?.entries,
    api?.config?.agents
  );

  if (Array.isArray(configured)) {
    return configured
      .map((entry) => {
        if (typeof entry === "string") {
          return { id: entry, name: entry };
        }

        if (entry && typeof entry === "object") {
          return {
            id: pickFirst(entry.id, entry.name, entry.agentId),
            name: pickFirst(entry.name, entry.id, entry.agentId),
            workspace: pickFirst(entry.workspace, entry.workspaceRoot, entry.cwd, entry.root),
            model: pickFirst(entry.model, entry.defaultModel)
          };
        }

        return null;
      })
      .filter((entry) => entry?.id);
  }

  if (configured && typeof configured === "object") {
    const explicitEntries = Object.entries(configured)
      .filter(([id]) => !["defaults", "list", "entries"].includes(id))
      .map(([id, entry]) => ({
        id: sanitizeSessionToken(id, "main"),
        name: pickFirst(entry?.name, id),
        workspace: pickFirst(entry?.workspace, entry?.workspaceRoot, entry?.cwd, entry?.root),
        model: pickFirst(entry?.model, entry?.defaultModel)
      }))
      .filter((entry) => entry?.id);

    if (explicitEntries.length > 0) {
      return explicitEntries;
    }

    const defaultsEntry = configured.defaults;

    if (defaultsEntry && typeof defaultsEntry === "object") {
      const defaultAgentId = resolveDefaultAgentId(api);

      return [{
        id: defaultAgentId,
        name: pickFirst(defaultsEntry?.name, defaultAgentId),
        workspace: pickFirst(defaultsEntry?.workspace, defaultsEntry?.workspaceRoot, defaultsEntry?.cwd, defaultsEntry?.root),
        model: pickFirst(defaultsEntry?.model, defaultsEntry?.defaultModel)
      }];
    }
  }

  const defaultAgentId = resolveDefaultAgentId(api);
  return [{ id: defaultAgentId, name: defaultAgentId }];
}

function resolveSessionIndexPath(api, agentId) {
  const configuredPath = pickFirst(
    api?.config?.session?.storePath,
    api?.config?.session?.indexPath,
    api?.config?.sessions?.storePath,
    api?.config?.sessions?.indexPath
  );
  const template = typeof configuredPath === "string"
    ? configuredPath
    : "~/.openclaw/agents/{agentId}/sessions/sessions.json";

  return resolveAbsolutePath(
    template
      .replaceAll("{agentId}", agentId)
      .replaceAll("{agent}", agentId)
  );
}

export async function readSessionIndexState(api, agentId) {
  const resolvedAgentId = normalizeAgentIdInput(api, agentId);
  const sessionIndexPath = resolveSessionIndexPath(api, resolvedAgentId);
  const contents = await readJson(sessionIndexPath, []);
  const records = normalizeSessionStoreRecords(contents).map((entry) => ({
    sessionId: pickFirst(entry?.sessionId, entry?.id),
    sessionKey: pickFirst(entry?.sessionKey, entry?.key),
    title: pickFirst(entry?.title, entry?.summary, entry?.label) || "(untitled)",
    createdAtRaw: pickFirst(entry?.createdAt, entry?.startedAt),
    updatedAtRaw: pickFirst(entry?.updatedAt, entry?.lastUpdatedAt, entry?.lastActivityAt),
    branchOf: pickFirst(entry?.branchOf, entry?.sourceSessionId)
  }));

  return {
    agentId: resolvedAgentId,
    sessionIndexPath,
    contents,
    records
  };
}

export async function listSessionsForAgent(api, agentId) {
  const state = await readSessionIndexState(api, agentId);

  return state.records
    .filter((entry) => entry.sessionId)
    .sort(
      (left, right) =>
        timestampSortValue(right.updatedAtRaw, right.createdAtRaw) -
        timestampSortValue(left.updatedAtRaw, left.createdAtRaw)
    )
    .map((entry, index) => ({
      sessionId: entry.sessionId,
      sessionKey: entry.sessionKey,
      marker: index === 0 ? "latest" : "",
      title: entry.title,
      updatedAt: formatTimestamp(entry.updatedAtRaw),
      createdAt: formatTimestamp(entry.createdAtRaw),
      branchOf: entry.branchOf ?? "-"
    }));
}

function findSessionRecord(records, reference = {}) {
  const sessionId = typeof reference.sessionId === "string" ? reference.sessionId.trim() : "";
  const sessionKey = typeof reference.sessionKey === "string" ? reference.sessionKey.trim() : "";

  if (!sessionId && !sessionKey) {
    return null;
  }

  return records.find((entry) => {
    if (sessionKey && entry.sessionKey === sessionKey) {
      return true;
    }

    return sessionId ? entry.sessionId === sessionId : false;
  }) ?? null;
}

export async function resolveSessionRecord(api, agentId, reference = {}) {
  const state = await readSessionIndexState(api, agentId);
  return findSessionRecord(state.records, reference);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function resolveSessionRecordEventually(api, agentId, reference = {}, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 5);
  const delayMs = Math.max(0, options.delayMs ?? 50);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const match = await resolveSessionRecord(api, agentId, reference);

    if (match || attempt === attempts - 1) {
      return match;
    }

    await sleep(delayMs);
  }

  return null;
}

function extractAgentRunMetadata(payload) {
  const unwrapped = unwrapRpcResult(payload);
  const resultRecord = unwrapped && typeof unwrapped === "object" ? unwrapped : {};
  const nestedResult = resultRecord.result && typeof resultRecord.result === "object"
    ? resultRecord.result
    : {};

  return {
    raw: unwrapped,
    runId: pickNonEmptyString(
      resultRecord.runId,
      nestedResult.runId,
      resultRecord.id,
      nestedResult.id
    ) || null,
    sessionId: pickNonEmptyString(resultRecord.sessionId, nestedResult.sessionId) || null,
    sessionKey: pickNonEmptyString(resultRecord.sessionKey, nestedResult.sessionKey) || null
  };
}

export async function findContinuationSessionRecord(api, agentId, beforeRecords, options = {}) {
  const { records } = await readSessionIndexState(api, agentId);
  const excludedSessionId = pickNonEmptyString(options.excludeSessionId);
  const beforeSessionIds = new Set(
    (beforeRecords ?? [])
      .map((entry) => entry?.sessionId)
      .filter(Boolean)
  );
  const startedAtMs = Number.isFinite(options.startedAtMs) ? options.startedAtMs : 0;
  const slackMs = Math.max(0, options.slackMs ?? 2000);
  const sorted = records
    .filter((entry) => entry.sessionId && entry.sessionId !== excludedSessionId)
    .sort(
      (left, right) =>
        timestampSortValue(right.updatedAtRaw, right.createdAtRaw) -
        timestampSortValue(left.updatedAtRaw, left.createdAtRaw)
    );
  const newRecords = sorted.filter((entry) => !beforeSessionIds.has(entry.sessionId));

  if (newRecords.length > 0) {
    return newRecords[0];
  }

  if (startedAtMs > 0) {
    const recentRecord = sorted.find(
      (entry) => timestampSortValue(entry.updatedAtRaw, entry.createdAtRaw) >= startedAtMs - slackMs
    );

    if (recentRecord) {
      return recentRecord;
    }
  }

  return sorted[0] ?? null;
}

async function writeSessionIndexState(sessionIndexPath, contents) {
  await fs.mkdir(path.dirname(sessionIndexPath), { recursive: true });
  await fs.writeFile(sessionIndexPath, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
}

export async function annotateBranchSessionRecord(api, agentId, reference, metadata, logger) {
  const sessionId = pickNonEmptyString(reference?.sessionId);
  const sessionKey = pickNonEmptyString(reference?.sessionKey);

  if (!sessionId && !sessionKey) {
    return false;
  }

  const state = await readSessionIndexState(api, agentId);
  const branchOf = pickNonEmptyString(metadata?.sourceSessionId);
  const label = pickNonEmptyString(metadata?.label);
  let changed = false;

  const matchesRecord = (entry, fallbackKey) => {
    const entrySessionId = pickNonEmptyString(entry?.sessionId, entry?.id);
    const entrySessionKey = pickNonEmptyString(entry?.sessionKey, entry?.key, fallbackKey);

    if (sessionKey && entrySessionKey === sessionKey) {
      return true;
    }

    return sessionId ? entrySessionId === sessionId : false;
  };

  const updateEntry = (entry, fallbackKey) => {
    if (!entry || typeof entry !== "object" || !matchesRecord(entry, fallbackKey)) {
      return entry;
    }

    const nextEntry = { ...entry };

    if (sessionKey && pickNonEmptyString(nextEntry.sessionKey, nextEntry.key, fallbackKey) !== sessionKey) {
      nextEntry.sessionKey = sessionKey;
      changed = true;
    }

    if (label && pickNonEmptyString(nextEntry.label) !== label) {
      nextEntry.label = label;
      changed = true;
    }

    if (branchOf && pickNonEmptyString(nextEntry.branchOf) !== branchOf) {
      nextEntry.branchOf = branchOf;
      changed = true;
    }

    if (branchOf && pickNonEmptyString(nextEntry.sourceSessionId) !== branchOf) {
      nextEntry.sourceSessionId = branchOf;
      changed = true;
    }

    return nextEntry;
  };

  if (Array.isArray(state.contents)) {
    state.contents = state.contents.map((entry) => updateEntry(entry));
  } else if (state.contents && typeof state.contents === "object") {
    const nextContents = {};

    for (const [key, entry] of Object.entries(state.contents)) {
      nextContents[key] = updateEntry(entry, key);
    }

    state.contents = nextContents;
  } else {
    return false;
  }

  if (!changed) {
    return false;
  }

  await writeSessionIndexState(state.sessionIndexPath, state.contents);
  logger.info?.(
    `[${manifest.id}] annotated branch session metadata session='${sessionId || sessionKey}' branchOf='${branchOf || "-"}'`
  );
  return true;
}

export function buildBranchSessionKey(agentId, branchId) {
  return `agent:${sanitizeSessionToken(agentId, "main")}:direct:step-rollback-${sanitizeSessionToken(branchId, "branch")}`;
}

export function buildBranchSessionLabel(sourceSessionId, branchId) {
  const compactSource = sanitizeSessionToken(sourceSessionId, "source").slice(0, 12);
  return `Rollback ${compactSource} ${branchId}`;
}

export { extractAgentRunMetadata };
