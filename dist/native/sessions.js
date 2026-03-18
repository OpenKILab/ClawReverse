import fs from "node:fs/promises";
import path from "node:path";

import { nowIso, readJson, resolveAbsolutePath } from "../core/utils.js";
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

export function resolveSessionTranscriptPath(api, agentId, sessionId) {
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
      enriched.transcriptPath = enriched.transcriptPath ?? transcriptMatch.transcriptPath;
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

  if (agentsConfig?.defaults && typeof agentsConfig.defaults === "object" && !Array.isArray(agentsConfig.defaults)) {
    return "main";
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

function resolveConfiguredAgentDefaults(api) {
  const defaultsEntry = api?.config?.agents?.defaults;

  if (!defaultsEntry || typeof defaultsEntry !== "object" || Array.isArray(defaultsEntry)) {
    return null;
  }

  return defaultsEntry;
}

function buildConfiguredAgentRecord(entry, fallbackId, defaultsEntry = null) {
  const normalizedEntry = typeof entry === "string"
    ? {
      id: entry,
      name: entry
    }
    : entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry
      : null;

  if (!normalizedEntry && !fallbackId) {
    return null;
  }

  const agentId = sanitizeSessionToken(
    pickFirst(normalizedEntry?.id, normalizedEntry?.name, normalizedEntry?.agentId, fallbackId),
    sanitizeSessionToken(fallbackId, "main")
  );

  return {
    id: agentId,
    name: pickFirst(normalizedEntry?.name, normalizedEntry?.id, normalizedEntry?.agentId, defaultsEntry?.name, agentId),
    workspace: pickFirst(
      normalizedEntry?.workspace,
      normalizedEntry?.workspaceRoot,
      normalizedEntry?.cwd,
      normalizedEntry?.root,
      defaultsEntry?.workspace,
      defaultsEntry?.workspaceRoot,
      defaultsEntry?.cwd,
      defaultsEntry?.root
    ),
    model: pickFirst(normalizedEntry?.model, normalizedEntry?.defaultModel, defaultsEntry?.model, defaultsEntry?.defaultModel)
  };
}

function mergeConfiguredAgentRecords(records) {
  const merged = new Map();

  for (const record of records) {
    if (!record?.id) {
      continue;
    }

    const current = merged.get(record.id) ?? {};
    const next = { ...current };

    for (const key of ["id", "name", "workspace", "model"]) {
      if (record[key] !== undefined) {
        next[key] = record[key];
      }
    }

    merged.set(record.id, next);
  }

  return [...merged.values()];
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
  const defaultsEntry = resolveConfiguredAgentDefaults(api);
  const defaultAgentId = resolveDefaultAgentId(api);
  const defaultRecord = defaultsEntry
    ? buildConfiguredAgentRecord(defaultsEntry, defaultAgentId)
    : null;
  const configured = pickFirst(
    api?.config?.agents?.list,
    api?.config?.agents?.entries,
    api?.config?.agents
  );

  if (Array.isArray(configured)) {
    const explicitEntries = configured
      .map((entry) => {
        const fallbackId = typeof entry === "string"
          ? entry
          : pickFirst(entry?.id, entry?.name, entry?.agentId);

        return buildConfiguredAgentRecord(entry, fallbackId, defaultsEntry);
      })
      .filter((entry) => entry?.id);

    return mergeConfiguredAgentRecords([
      ...(defaultRecord ? [defaultRecord] : []),
      ...explicitEntries
    ]);
  }

  if (configured && typeof configured === "object") {
    const explicitEntries = Object.entries(configured)
      .filter(([id]) => !["defaults", "list", "entries"].includes(id))
      .map(([id, entry]) => buildConfiguredAgentRecord({
        ...(entry && typeof entry === "object" ? entry : {}),
        id
      }, id, defaultsEntry))
      .filter((entry) => entry?.id);

    if (explicitEntries.length > 0 || defaultRecord) {
      return mergeConfiguredAgentRecords([
        ...(defaultRecord ? [defaultRecord] : []),
        ...explicitEntries
      ]);
    }
  }

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

function normalizeTranscriptEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.filter((entry) => entry && typeof entry === "object");
}

export async function readSessionTranscriptEntries(api, agentId, sessionId) {
  const transcriptPath = resolveSessionTranscriptPath(api, agentId, sessionId);
  const contents = await fs.readFile(transcriptPath, "utf8");
  const entries = contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return {
    transcriptPath,
    entries: normalizeTranscriptEntries(entries)
  };
}

export async function writeSessionTranscriptEntries(api, agentId, sessionId, entries) {
  const transcriptPath = resolveSessionTranscriptPath(api, agentId, sessionId);
  const normalizedEntries = normalizeTranscriptEntries(entries);

  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.writeFile(
    transcriptPath,
    normalizedEntries.length
      ? `${normalizedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "",
    "utf8"
  );

  return {
    transcriptPath,
    entries: normalizedEntries
  };
}

function remapWorkspacePath(value, sourceWorkspacePath, targetWorkspacePath) {
  if (
    typeof value !== "string" ||
    !sourceWorkspacePath ||
    !targetWorkspacePath ||
    value === ""
  ) {
    return value;
  }

  if (value === sourceWorkspacePath) {
    return targetWorkspacePath;
  }

  const prefix = `${sourceWorkspacePath}${path.sep}`;

  if (value.startsWith(prefix)) {
    return `${targetWorkspacePath}${value.slice(sourceWorkspacePath.length)}`;
  }

  return value;
}

function remapSessionMetadataValue(value, mapping) {
  if (typeof value === "string") {
    if (mapping.sourceSessionId && value === mapping.sourceSessionId) {
      return mapping.targetSessionId;
    }

    if (mapping.sourceSessionKey && value === mapping.sourceSessionKey) {
      return mapping.targetSessionKey;
    }

    if (mapping.sourceTranscriptPath && value === mapping.sourceTranscriptPath) {
      return mapping.targetTranscriptPath;
    }

    return remapWorkspacePath(value, mapping.sourceWorkspacePath, mapping.targetWorkspacePath);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => remapSessionMetadataValue(entry, mapping));
  }

  if (value && typeof value === "object") {
    const nextValue = {};

    for (const [key, entry] of Object.entries(value)) {
      nextValue[key] = remapSessionMetadataValue(entry, mapping);
    }

    return nextValue;
  }

  return value;
}

function selectForkTimestamp(value, timestampIso, timestampMs) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return timestampMs;
  }

  if (typeof value === "string" && value.trim()) {
    return timestampIso;
  }

  return value;
}

function findRawSessionIndexEntry(contents, reference = {}) {
  const sessionId = pickNonEmptyString(reference.sessionId);
  const sessionKey = pickNonEmptyString(reference.sessionKey);

  if (Array.isArray(contents)) {
    for (const entry of contents) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const entrySessionId = pickNonEmptyString(entry.sessionId, entry.id);
      const entrySessionKey = pickNonEmptyString(entry.sessionKey, entry.key);

      if (sessionKey && entrySessionKey === sessionKey) {
        return { key: null, entry };
      }

      if (sessionId && entrySessionId === sessionId) {
        return { key: null, entry };
      }
    }

    return null;
  }

  if (contents && typeof contents === "object") {
    for (const [key, entry] of Object.entries(contents)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const entrySessionId = pickNonEmptyString(entry.sessionId, entry.id);
      const entrySessionKey = pickNonEmptyString(entry.sessionKey, entry.key, key);

      if (sessionKey && entrySessionKey === sessionKey) {
        return { key, entry };
      }

      if (sessionId && entrySessionId === sessionId) {
        return { key, entry };
      }
    }
  }

  return null;
}

function buildForkedSessionRecord(sourceEntry, options = {}) {
  const timestampIso = nowIso();
  const timestampMs = Date.now();
  const targetRecord = sourceEntry && typeof sourceEntry === "object"
    ? remapSessionMetadataValue(structuredClone(sourceEntry), options)
    : {};

  targetRecord.sessionId = options.targetSessionId;
  targetRecord.sessionFile = options.targetTranscriptPath;
  targetRecord.branchOf = options.sourceSessionId;
  targetRecord.sourceSessionId = options.sourceSessionId;

  if (
    options.forceSessionKeyField ||
    Object.hasOwn(targetRecord, "sessionKey") ||
    Object.hasOwn(targetRecord, "key") ||
    !sourceEntry
  ) {
    targetRecord.sessionKey = options.targetSessionKey;
  }

  if (options.label) {
    if (Object.hasOwn(targetRecord, "title")) {
      targetRecord.title = options.label;
    }

    if (Object.hasOwn(targetRecord, "label")) {
      targetRecord.label = options.label;
    }

    if (Object.hasOwn(targetRecord, "summary")) {
      targetRecord.summary = options.label;
    }
  }

  if (sourceEntry && typeof sourceEntry === "object") {
    if (Object.hasOwn(targetRecord, "updatedAt")) {
      targetRecord.updatedAt = selectForkTimestamp(targetRecord.updatedAt, timestampIso, timestampMs);
    }

    if (Object.hasOwn(targetRecord, "lastUpdatedAt")) {
      targetRecord.lastUpdatedAt = selectForkTimestamp(targetRecord.lastUpdatedAt, timestampIso, timestampMs);
    }

    if (Object.hasOwn(targetRecord, "lastActivityAt")) {
      targetRecord.lastActivityAt = selectForkTimestamp(targetRecord.lastActivityAt, timestampIso, timestampMs);
    }

    return targetRecord;
  }

  return {
    sessionId: options.targetSessionId,
    sessionKey: options.targetSessionKey,
    title: options.label || "(untitled)",
    label: options.label || "(untitled)",
    createdAt: timestampIso,
    updatedAt: timestampIso,
    branchOf: options.sourceSessionId,
    sourceSessionId: options.sourceSessionId,
    sessionFile: options.targetTranscriptPath
  };
}

export function forkSessionTranscriptEntries(entries, options = {}) {
  const normalizedEntries = normalizeTranscriptEntries(entries).map((entry) => structuredClone(entry));
  let sawSessionEntry = false;

  for (const entry of normalizedEntries) {
    if (!entry || typeof entry !== "object" || entry.type !== "session") {
      continue;
    }

    entry.id = options.targetSessionId;

    if (typeof entry.sessionId === "string" || options.sourceSessionId) {
      entry.sessionId = options.targetSessionId;
    }

    if (typeof entry.cwd === "string" || options.targetWorkspacePath) {
      entry.cwd = options.targetWorkspacePath;
    }

    if (typeof entry.workspaceDir === "string" || options.targetWorkspacePath) {
      entry.workspaceDir = options.targetWorkspacePath;
    }

    sawSessionEntry = true;
    break;
  }

  if (!sawSessionEntry) {
    normalizedEntries.unshift({
      type: "session",
      version: 3,
      id: options.targetSessionId,
      timestamp: nowIso(),
      cwd: options.targetWorkspacePath
    });
  }

  return normalizedEntries;
}

export async function writeForkedSessionState(api, options = {}) {
  const sourceAgentId = normalizeAgentIdInput(api, options.sourceAgentId);
  const targetAgentId = normalizeAgentIdInput(api, options.targetAgentId);
  const sourceSessionId = pickNonEmptyString(options.sourceSessionId);
  const targetSessionId = pickNonEmptyString(options.targetSessionId);
  const targetSessionKey = pickNonEmptyString(options.targetSessionKey);
  const targetTranscriptPath = resolveSessionTranscriptPath(api, targetAgentId, targetSessionId);
  const sourceTranscriptPath = resolveSessionTranscriptPath(api, sourceAgentId, sourceSessionId);
  const sourceState = await readSessionIndexState(api, sourceAgentId);
  const targetState = options.preserveExistingSessions
    ? await readSessionIndexState(api, targetAgentId)
    : null;
  const sourceMatch = findRawSessionIndexEntry(sourceState.contents, {
    sessionId: sourceSessionId,
    sessionKey: options.sourceSessionKey
  });
  const nextRecord = buildForkedSessionRecord(sourceMatch?.entry, {
    sourceSessionId,
    sourceSessionKey: pickNonEmptyString(sourceMatch?.entry?.sessionKey, sourceMatch?.entry?.key, sourceMatch?.key),
    sourceTranscriptPath,
    sourceWorkspacePath: pickNonEmptyString(
      options.sourceWorkspacePath,
      sourceMatch?.entry?.systemPromptReport?.workspaceDir
    ),
    targetSessionId,
    targetSessionKey,
    targetTranscriptPath,
    targetWorkspacePath: options.targetWorkspacePath,
    label: options.label,
    forceSessionKeyField: Array.isArray(sourceState.contents)
  });
  let nextContents;

  if (options.preserveExistingSessions && Array.isArray(targetState?.contents)) {
    nextContents = [
      ...targetState.contents.filter((entry) => {
        const entrySessionId = pickNonEmptyString(entry?.sessionId, entry?.id);
        const entrySessionKey = pickNonEmptyString(entry?.sessionKey, entry?.key);
        return entrySessionId !== targetSessionId && entrySessionKey !== targetSessionKey;
      }),
      nextRecord
    ];
  } else if (options.preserveExistingSessions && targetState?.contents && typeof targetState.contents === "object") {
    const currentEntries = targetState.contents;
    nextContents = {
      ...currentEntries,
      [targetSessionKey]: {
        ...(currentEntries[targetSessionKey] && typeof currentEntries[targetSessionKey] === "object"
          ? currentEntries[targetSessionKey]
          : {}),
        ...nextRecord
      }
    };
  } else {
    nextContents = Array.isArray(sourceState.contents)
      ? [nextRecord]
      : {
        [targetSessionKey]: nextRecord
      };
  }
  const targetSessionIndexPath = resolveSessionIndexPath(api, targetAgentId);

  await writeSessionIndexState(targetSessionIndexPath, nextContents);

  return {
    agentId: targetAgentId,
    sessionIndexPath: targetSessionIndexPath,
    transcriptPath: targetTranscriptPath,
    contents: nextContents,
    record: nextRecord
  };
}

function normalizeSessionRecordPayload(record = {}) {
  const sessionId = pickNonEmptyString(record.sessionId, record.id);
  const sessionKey = pickNonEmptyString(record.sessionKey, record.key);
  const label = pickNonEmptyString(record.label, record.title) || "(untitled)";
  const createdAt = pickNonEmptyString(record.createdAt, record.startedAt) || nowIso();
  const updatedAt = pickNonEmptyString(record.updatedAt, record.lastUpdatedAt, record.lastActivityAt) || createdAt;
  const branchOf = pickNonEmptyString(record.branchOf, record.sourceSessionId);

  return {
    sessionId,
    sessionKey,
    title: label,
    label,
    createdAt,
    updatedAt,
    branchOf: branchOf || undefined,
    sourceSessionId: branchOf || undefined
  };
}

export async function upsertSessionRecord(api, agentId, record, options = {}) {
  const normalizedAgentId = normalizeAgentIdInput(api, agentId);
  const state = await readSessionIndexState(api, normalizedAgentId);
  const nextRecord = normalizeSessionRecordPayload(record);
  const referenceKey = nextRecord.sessionKey || nextRecord.sessionId;
  let nextContents = state.contents;

  if (Array.isArray(nextContents) || options.shape === "array") {
    const currentEntries = Array.isArray(nextContents) ? nextContents : [];
    const filteredEntries = currentEntries.filter((entry) => {
      const entrySessionId = pickNonEmptyString(entry?.sessionId, entry?.id);
      const entrySessionKey = pickNonEmptyString(entry?.sessionKey, entry?.key);
      return entrySessionId !== nextRecord.sessionId && entrySessionKey !== nextRecord.sessionKey;
    });

    nextContents = [
      ...filteredEntries,
      {
        ...nextRecord
      }
    ];
  } else {
    const currentEntries = nextContents && typeof nextContents === "object" ? nextContents : {};
    nextContents = {
      ...currentEntries,
      [referenceKey]: {
        ...(currentEntries[referenceKey] && typeof currentEntries[referenceKey] === "object"
          ? currentEntries[referenceKey]
          : {}),
        ...nextRecord
      }
    };
  }

  await writeSessionIndexState(state.sessionIndexPath, nextContents);

  return {
    agentId: normalizedAgentId,
    sessionIndexPath: state.sessionIndexPath,
    record: nextRecord,
    contents: nextContents
  };
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

export function buildAgentSessionKey(agentId) {
  return `agent:${sanitizeSessionToken(agentId, "main")}:main`;
}

export function buildBranchSessionLabel(sourceSessionId, branchId) {
  const compactSource = sanitizeSessionToken(sourceSessionId, "source").slice(0, 12);
  return `Rollback ${compactSource} ${branchId}`;
}

export { extractAgentRunMetadata };
