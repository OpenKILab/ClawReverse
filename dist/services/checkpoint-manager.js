import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { StepRollbackError, toStepRollbackError } from "../core/errors.js";
import {
  copyPath,
  ensureDir,
  nowIso,
  pathExists,
  readJson,
  removePath,
  replacePathWithCopy,
  snapshotEntryName,
  writeJson
} from "../core/utils.js";

const execFileAsync = promisify(execFile);
const TARGET_PARAM_KEYS = [
  "targetPath",
  "target_path",
  "path",
  "filePath",
  "file_path",
  "filepath",
  "file",
  "filename",
  "name",
  "target",
  "destination",
  "destinationPath",
  "destination_path",
  "dest",
  "output",
  "outputPath",
  "output_path",
  "source",
  "sourcePath",
  "source_path",
  "src",
  "url",
  "uri"
];
const COMMAND_PARAM_KEYS = ["command", "cmd", "script", "shell", "input", "text"];

function compactWhitespace(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function shortenSummaryValue(value, maxLength = 96) {
  const normalized = compactWhitespace(value);

  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizePathLike(value) {
  const raw = compactWhitespace(value);

  if (!raw) {
    return null;
  }

  const baseName = path.basename(raw);
  if (baseName && baseName !== raw && /\.[^./]+$/.test(baseName) && baseName.length <= 32) {
    return baseName;
  }

  const normalized = shortenSummaryValue(raw, 72);

  if (!normalized) {
    return null;
  }

  const parts = normalized.split(/[\\/]+/).filter(Boolean);

  if (normalized.length <= 40 || parts.length < 2) {
    return normalized;
  }

  return `.../${parts.slice(-2).join("/")}`;
}

function findNestedValueByKeys(value, keys, seen = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) {
    return null;
  }

  seen.add(value);

  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      return value[key];
    }
  }

  const entries = Array.isArray(value) ? value : Object.values(value);

  for (const entry of entries) {
    const nested = findNestedValueByKeys(entry, keys, seen, depth + 1);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function summarizeTargetValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    return summarizePathLike(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value
      .map((entry) => summarizeTargetValue(entry))
      .filter(Boolean);

    if (!items.length) {
      return null;
    }

    return shortenSummaryValue(items.slice(0, 2).join(", "), 72);
  }

  if (typeof value === "object") {
    const nested = findNestedValueByKeys(value, TARGET_PARAM_KEYS);
    return nested === null ? null : summarizeTargetValue(nested);
  }

  return shortenSummaryValue(value, 72);
}

function extractCommandText(params) {
  const command = findNestedValueByKeys(params, COMMAND_PARAM_KEYS);
  return typeof command === "string" ? compactWhitespace(command) : null;
}

function unquoteShellToken(token) {
  return String(token ?? "").replace(/^['"]|['"]$/g, "");
}

function summarizeExecCommand(commandText) {
  const raw = compactWhitespace(commandText);

  if (!raw) {
    return null;
  }

  const compact = shortenSummaryValue(raw, 88);
  const tokens = raw.match(/"[^"]+"|'[^']+'|\S+/g)?.map(unquoteShellToken) ?? [];
  const firstCommandIndex = tokens.findIndex((token) => !token.startsWith("-"));
  const command = firstCommandIndex >= 0 ? path.basename(tokens[firstCommandIndex]).toLowerCase() : "";
  const targetToken = tokens.slice(firstCommandIndex + 1).find((token) => token && !token.startsWith("-"));
  const target = summarizeTargetValue(targetToken);

  switch (command) {
    case "rm":
    case "unlink":
    case "del":
      return target ? `delete ${target}` : "delete files";
    case "mv":
      return target ? `move ${target}` : compact;
    case "cp":
      return target ? `copy ${target}` : compact;
    case "mkdir":
      return target ? `create ${target}` : compact;
    case "cat":
    case "less":
      return target ? `read ${target}` : compact;
    default:
      return compact;
  }
}

function buildCheckpointSummary(ctx) {
  const toolName = shortenSummaryValue(ctx?.toolName, 24) ?? "tool";
  const params = ctx?.params;

  if (typeof params === "string") {
    if (toolName.toLowerCase() === "exec") {
      const execSummary = summarizeExecCommand(params);
      if (execSummary) {
        return `before tool ${toolName} ${execSummary}`;
      }
    }

    const text = shortenSummaryValue(params, 72);
    if (text) {
      return `before tool ${toolName} ${text}`;
    }
  }

  if (params && typeof params === "object") {
    if (toolName.toLowerCase() === "exec") {
      const execSummary = summarizeExecCommand(extractCommandText(params));
      if (execSummary) {
        return `before tool ${toolName} ${execSummary}`;
      }
    }

    const target = summarizeTargetValue(findNestedValueByKeys(params, TARGET_PARAM_KEYS));
    if (target) {
      return `before tool ${toolName} ${target}`;
    }

    const command = extractCommandText(params);
    if (command) {
      return `before tool ${toolName} ${shortenSummaryValue(command, 88)}`;
    }
  }

  return `before tool ${toolName}`;
}

export class CheckpointManager {
  constructor({ config, registry, runtimeCursorManager, sequenceStore, logger }) {
    this.config = config;
    this.registry = registry;
    this.runtimeCursorManager = runtimeCursorManager;
    this.sequenceStore = sequenceStore;
    this.logger = logger ?? {
      info() {},
      warn() {},
      error() {},
      debug() {}
    };
  }

  async create(ctx) {
    const checkpointId = await this.sequenceStore.next("ckpt");
    const snapshotRoot = path.join(this.config.checkpointDir, checkpointId);
    const createdAt = nowIso();
    this.logger.info(
      `[step-rollback] checkpoint create start checkpoint='${checkpointId}' session='${ctx.sessionId}' tool='${ctx.toolName}' toolCallId='${ctx.toolCallId ?? "-"}'`
    );

    const runtimeState = await this.runtimeCursorManager.ensure(ctx.agentId, ctx.sessionId, {
      activeHeadEntryId: ctx.entryId ?? null,
      currentRunId: ctx.runId ?? null
    });

    const manifest = {
      checkpointId,
      createdAt,
      workspaceEntries: [],
      sessionRuntime: {
        included: true,
        fileName: "runtime-state.json"
      }
    };

    for (const rootPath of this.config.workspaceRoots) {
      manifest.workspaceEntries.push(
        await this.createWorkspaceSnapshotEntry(snapshotRoot, checkpointId, ctx, rootPath)
      );
    }

    await writeJson(path.join(snapshotRoot, "runtime-state.json"), runtimeState);
    await writeJson(path.join(snapshotRoot, "snapshot.json"), manifest);

    const record = {
      checkpointId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId ?? null,
      entryId: ctx.entryId,
      nodeIndex: ctx.nodeIndex,
      toolName: ctx.toolName,
      createdAt,
      snapshotRef: snapshotRoot,
      workspaceSnapshots: manifest.workspaceEntries.map((entry) => ({
        targetPath: entry.targetPath,
        existed: entry.existed,
        kind: entry.kind,
        backend: entry.backend,
        snapshotName: entry.snapshotName ?? null,
        repoDir: entry.repoDir ?? null,
        commitId: entry.commitId ?? null
      })),
      status: "ready",
      summary: buildCheckpointSummary(ctx)
    };

    await this.registry.add(record);

    const removed = await this.registry.pruneSession(
      ctx.agentId,
      ctx.sessionId,
      this.config.maxCheckpointsPerSession
    );

    for (const item of removed) {
      await this.removeArtifacts(item);
    }

    this.logger.info(
      `[step-rollback] checkpoint create complete checkpoint='${checkpointId}' session='${ctx.sessionId}' snapshotRef='${snapshotRoot}'`
    );

    return record;
  }

  async get(checkpointId) {
    return this.registry.get(checkpointId);
  }

  async list(agentId, sessionId) {
    return this.registry.list(agentId, sessionId);
  }

  async reconcile(ctx) {
    if (!ctx?.agentId || !ctx?.sessionId || !ctx?.toolCallId) {
      return null;
    }

    const checkpoints = await this.registry.list(ctx.agentId, ctx.sessionId);
    const candidate = [...checkpoints]
      .reverse()
      .find((checkpoint) => checkpoint.toolCallId === ctx.toolCallId);

    if (!candidate) {
      this.logger.warn(
        `[step-rollback] reconcile skipped because no checkpoint matched toolCallId='${ctx.toolCallId}' session='${ctx.sessionId}'`
      );
      return null;
    }

    if (candidate.entryId === ctx.entryId && candidate.nodeIndex === ctx.nodeIndex) {
      return candidate;
    }

    this.logger.info(
      `[step-rollback] reconciling checkpoint '${candidate.checkpointId}' to entry='${ctx.entryId}' node='${ctx.nodeIndex}' toolCallId='${ctx.toolCallId}'`
    );

    const nextSummary = buildCheckpointSummary({
      ...candidate,
      ...ctx,
      toolName: ctx.toolName ?? candidate.toolName
    });

    return this.registry.update(candidate.checkpointId, (current) => {
      current.entryId = ctx.entryId;
      current.nodeIndex = ctx.nodeIndex;
      current.toolCallId = ctx.toolCallId ?? current.toolCallId ?? null;
      current.summary = nextSummary;
      return current;
    });
  }

  async restore(checkpointId, options = {}) {
    const record = await this.registry.get(checkpointId);

    if (!record) {
      throw new StepRollbackError("CHECKPOINT_NOT_FOUND", `Checkpoint '${checkpointId}' was not found.`, {
        checkpointId
      });
    }

    const restoreWorkspace = options.restoreWorkspace ?? true;
    const restoreRuntimeState = options.restoreRuntimeState ?? true;

    await this.registry.update(checkpointId, (current) => {
      current.status = "restoring";
      return current;
    });

    this.logger.info(`[step-rollback] checkpoint restore start checkpoint='${checkpointId}'`);

    try {
      const manifest = await readJson(path.join(record.snapshotRef, "snapshot.json"), null);

      if (!manifest) {
        throw new StepRollbackError(
          "SNAPSHOT_RESTORE_FAILED",
          `Snapshot manifest for checkpoint '${checkpointId}' is missing.`,
          { checkpointId }
        );
      }

      if (restoreWorkspace) {
        for (const entry of manifest.workspaceEntries) {
          await this.restoreWorkspaceEntry(record.snapshotRef, entry);
        }
      }

      if (restoreRuntimeState && manifest.sessionRuntime?.included) {
        const runtimeState = await readJson(path.join(record.snapshotRef, manifest.sessionRuntime.fileName), null);
        if (runtimeState) {
          await this.runtimeCursorManager.replace(record.agentId, record.sessionId, runtimeState);
        }
      }

      return this.registry.update(checkpointId, (current) => {
        current.status = "restored";
        return current;
      });
    } catch (error) {
      this.logger.error(
        `[step-rollback] checkpoint restore failed checkpoint='${checkpointId}': ${error instanceof Error ? error.message : error}`
      );
      await this.registry.update(checkpointId, (current) => {
        current.status = "failed";
        return current;
      });

      throw toStepRollbackError(error, "SNAPSHOT_RESTORE_FAILED", { checkpointId });
    }
  }

  async restoreWorkspaceEntry(snapshotRoot, entry) {
    if (entry.backend === "git") {
      await this.restoreGitWorkspaceEntry(entry);
      return;
    }

    if (!entry.existed) {
      await removePath(entry.targetPath);
      return;
    }

    const snapshotPath = path.join(snapshotRoot, "workspace", entry.snapshotName);
    const exists = await pathExists(snapshotPath);

    if (!exists) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        `Snapshot payload '${entry.snapshotName}' is missing.`,
        entry
      );
    }

    await replacePathWithCopy(snapshotPath, entry.targetPath, entry.kind);
  }

  async createWorkspaceSnapshotEntry(snapshotRoot, checkpointId, ctx, rootPath) {
    const exists = await pathExists(rootPath);

    if (!exists) {
      this.logger.warn(
        `[step-rollback] workspace root '${rootPath}' did not exist while creating checkpoint '${checkpointId}'`
      );
      return {
        backend: "git",
        targetPath: rootPath,
        existed: false,
        kind: null,
        repoDir: this.gitRepoDir(rootPath),
        commitId: null
      };
    }

    const stats = await fs.lstat(rootPath);

    if (stats.isDirectory()) {
      const repoDir = this.gitRepoDir(rootPath);
      const commitId = await this.captureGitSnapshot(repoDir, rootPath, checkpointId, ctx.toolName);
      this.logger.info(
        `[step-rollback] git snapshot committed checkpoint='${checkpointId}' root='${rootPath}' commit='${commitId}' repo='${repoDir}'`
      );

      return {
        backend: "git",
        targetPath: rootPath,
        existed: true,
        kind: "directory",
        repoDir,
        commitId
      };
    }

    const snapshotName = snapshotEntryName(rootPath);
    const snapshotTarget = path.join(snapshotRoot, "workspace", snapshotName);
    const kind = await copyPath(rootPath, snapshotTarget);
    this.logger.info(
      `[step-rollback] copied snapshot checkpoint='${checkpointId}' target='${rootPath}' kind='${kind}'`
    );

    return {
      backend: "copy",
      targetPath: rootPath,
      snapshotName,
      existed: true,
      kind
    };
  }

  gitRepoDir(rootPath) {
    return path.join(this.config.checkpointDir, "_git", `${snapshotEntryName(rootPath)}.git`);
  }

  async captureGitSnapshot(repoDir, rootPath, checkpointId, toolName) {
    await this.ensureGitRepository(repoDir);

    const statusBeforeCommit = await this.describeGitWorkspace(repoDir, rootPath);
    this.logger.info(
      `[step-rollback] git workspace status checkpoint='${checkpointId}' root='${rootPath}' dirtyCount='${statusBeforeCommit.dirtyCount}' sample='${statusBeforeCommit.sample.join(" | ") || "-"}'`
    );

    await this.runGit(
      [
        "--git-dir",
        repoDir,
        "--work-tree",
        rootPath,
        "add",
        "-A",
        "-f",
        "--",
        "."
      ],
      { cwd: rootPath }
    );

    await this.runGit(
      [
        "--git-dir",
        repoDir,
        "--work-tree",
        rootPath,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=OpenClaw Step Rollback",
        "-c",
        "user.email=step-rollback@openclaw.local",
        "commit",
        "--allow-empty",
        "-m",
        `checkpoint ${checkpointId} before tool ${toolName}`
      ],
      { cwd: rootPath }
    );

    const { stdout } = await this.runGit(["--git-dir", repoDir, "rev-parse", "HEAD"], { cwd: rootPath });
    return stdout.trim();
  }

  async restoreGitWorkspaceEntry(entry) {
    if (!entry.existed) {
      await removePath(entry.targetPath);
      return;
    }

    if (!entry.commitId || !entry.repoDir) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        `Git snapshot metadata is missing for '${entry.targetPath}'.`,
        entry
      );
    }

    const repoExists = await pathExists(entry.repoDir);
    if (!repoExists) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        `Git snapshot repository '${entry.repoDir}' is missing.`,
        entry
      );
    }

    await removePath(entry.targetPath);
    await ensureDir(entry.targetPath);

    const archivePath = path.join(os.tmpdir(), `step-rollback-${path.basename(entry.repoDir)}-${Date.now()}.tar`);

    try {
      await this.runGit(
        ["--git-dir", entry.repoDir, "archive", "--format=tar", "-o", archivePath, entry.commitId],
        { cwd: entry.targetPath }
      );
      await execFileAsync("tar", ["-xf", archivePath, "-C", entry.targetPath], {
        cwd: entry.targetPath
      });
    } finally {
      await removePath(archivePath);
    }
  }

  async ensureGitRepository(repoDir) {
    const headPath = path.join(repoDir, "HEAD");
    if (await pathExists(headPath)) {
      return;
    }

    await ensureDir(path.dirname(repoDir));
    this.logger.info(`[step-rollback] initializing snapshot git repository '${repoDir}'`);
    await this.runGit(["init", "--bare", repoDir], {
      cwd: path.dirname(repoDir)
    });
  }

  async describeGitWorkspace(repoDir, rootPath) {
    const { stdout } = await this.runGit(
      ["--git-dir", repoDir, "--work-tree", rootPath, "status", "--short", "--untracked-files=all"],
      { cwd: rootPath }
    );

    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      dirtyCount: lines.length,
      sample: lines.slice(0, 5)
    };
  }

  async runGit(args, options = {}) {
    try {
      return await execFileAsync("git", args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "OpenClaw Step Rollback",
          GIT_AUTHOR_EMAIL: "step-rollback@openclaw.local",
          GIT_COMMITTER_NAME: "OpenClaw Step Rollback",
          GIT_COMMITTER_EMAIL: "step-rollback@openclaw.local"
        },
        maxBuffer: 16 * 1024 * 1024
      });
    } catch (error) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        error instanceof Error ? error.message : String(error),
        { args, cwd: options.cwd }
      );
    }
  }

  async removeArtifacts(record) {
    if (!record?.snapshotRef) {
      return;
    }

    await removePath(record.snapshotRef);
  }
}
