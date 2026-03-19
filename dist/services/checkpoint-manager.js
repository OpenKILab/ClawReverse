import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { StepRollbackError, toStepRollbackError } from "../core/errors.js";
import { buildCheckpointSummary } from "../core/tooling.js";
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
      `[clawreverse] checkpoint create start checkpoint='${checkpointId}' session='${ctx.sessionId}' tool='${ctx.toolName}' toolCallId='${ctx.toolCallId ?? "-"}'`
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
      },
      sessionTranscript: null
    };

    for (const rootPath of this.config.workspaceRoots) {
      manifest.workspaceEntries.push(
        await this.createWorkspaceSnapshotEntry(snapshotRoot, checkpointId, ctx, rootPath)
      );
    }

    await writeJson(path.join(snapshotRoot, "runtime-state.json"), runtimeState);
    manifest.sessionTranscript = await this.captureTranscriptPrefix(snapshotRoot, ctx);
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
      summary: buildCheckpointSummary(ctx),
      transcriptSnapshot: manifest.sessionTranscript
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
      `[clawreverse] checkpoint create complete checkpoint='${checkpointId}' session='${ctx.sessionId}' snapshotRef='${snapshotRoot}'`
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
        `[clawreverse] reconcile skipped because no checkpoint matched toolCallId='${ctx.toolCallId}' session='${ctx.sessionId}'`
      );
      return null;
    }

    if (candidate.entryId === ctx.entryId && candidate.nodeIndex === ctx.nodeIndex) {
      return candidate;
    }

    this.logger.info(
      `[clawreverse] reconciling checkpoint '${candidate.checkpointId}' to entry='${ctx.entryId}' node='${ctx.nodeIndex}' toolCallId='${ctx.toolCallId}'`
    );

    const nextSummary = buildCheckpointSummary({
      ...candidate,
      ...ctx,
      toolName: ctx.toolName ?? candidate.toolName
    });
    const transcriptSnapshot = await this.captureTranscriptPrefix(candidate.snapshotRef, {
      ...candidate,
      ...ctx,
      entryId: ctx.entryId ?? candidate.entryId,
      sessionId: ctx.sessionId ?? candidate.sessionId,
      agentId: ctx.agentId ?? candidate.agentId,
      transcriptPath: ctx.transcriptPath
    });

    return this.registry.update(candidate.checkpointId, (current) => {
      current.entryId = ctx.entryId;
      current.nodeIndex = ctx.nodeIndex;
      current.toolCallId = ctx.toolCallId ?? current.toolCallId ?? null;
      current.summary = nextSummary;
      if (transcriptSnapshot) {
        current.transcriptSnapshot = transcriptSnapshot;
      }
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

    this.logger.info(`[clawreverse] checkpoint restore start checkpoint='${checkpointId}'`);

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
        `[clawreverse] checkpoint restore failed checkpoint='${checkpointId}': ${error instanceof Error ? error.message : error}`
      );
      await this.registry.update(checkpointId, (current) => {
        current.status = "failed";
        return current;
      });

      throw toStepRollbackError(error, "SNAPSHOT_RESTORE_FAILED", { checkpointId });
    }
  }

  async materialize(checkpointId, options = {}) {
    const record = await this.registry.get(checkpointId);

    if (!record) {
      throw new StepRollbackError("CHECKPOINT_NOT_FOUND", `Checkpoint '${checkpointId}' was not found.`, {
        checkpointId
      });
    }

    const manifest = await readJson(path.join(record.snapshotRef, "snapshot.json"), null);

    if (!manifest) {
      throw new StepRollbackError(
        "SNAPSHOT_RESTORE_FAILED",
        `Snapshot manifest for checkpoint '${checkpointId}' is missing.`,
        { checkpointId }
      );
    }

    const materializedEntries = [];

    for (const [index, entry] of manifest.workspaceEntries.entries()) {
      const targetPath = typeof options.resolveTargetPath === "function"
        ? options.resolveTargetPath(entry, index, manifest.workspaceEntries)
        : entry.targetPath;
      const materializedEntry = {
        ...entry,
        targetPath
      };

      await this.restoreWorkspaceEntry(record.snapshotRef, materializedEntry);
      materializedEntries.push(materializedEntry);
    }

    return {
      checkpointId,
      snapshotRef: record.snapshotRef,
      workspaceEntries: materializedEntries,
      transcriptSnapshot: manifest.sessionTranscript ?? record.transcriptSnapshot ?? null
    };
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

  async captureTranscriptPrefix(snapshotRoot, ctx) {
    const transcriptPath = typeof ctx?.transcriptPath === "string" && ctx.transcriptPath.trim()
      ? ctx.transcriptPath.trim()
      : "";
    const entryId = typeof ctx?.entryId === "string" && ctx.entryId.trim() ? ctx.entryId.trim() : "";

    if (!transcriptPath || !entryId) {
      return null;
    }

    try {
      const contents = await fs.readFile(transcriptPath, "utf8");
      const lines = contents
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const prefixLines = [];
      let matched = false;

      for (const line of lines) {
        prefixLines.push(line);

        try {
          const entry = JSON.parse(line);

          if (entry?.id === entryId) {
            matched = true;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!matched || !prefixLines.length) {
        return null;
      }

      const fileName = "transcript-prefix.jsonl";
      await fs.writeFile(path.join(snapshotRoot, fileName), `${prefixLines.join("\n")}\n`, "utf8");

      return {
        included: true,
        fileName,
        entryCount: prefixLines.length,
        sourcePath: transcriptPath
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.logger.warn?.(
          `[clawreverse] transcript snapshot skipped because source transcript was missing: ${transcriptPath}`
        );
        return null;
      }

      throw error;
    }
  }

  async createWorkspaceSnapshotEntry(snapshotRoot, checkpointId, ctx, rootPath) {
    const exists = await pathExists(rootPath);

    if (!exists) {
      this.logger.warn(
        `[clawreverse] workspace root '${rootPath}' did not exist while creating checkpoint '${checkpointId}'`
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
        `[clawreverse] git snapshot committed checkpoint='${checkpointId}' root='${rootPath}' commit='${commitId}' repo='${repoDir}'`
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
      `[clawreverse] copied snapshot checkpoint='${checkpointId}' target='${rootPath}' kind='${kind}'`
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
      `[clawreverse] git workspace status checkpoint='${checkpointId}' root='${rootPath}' dirtyCount='${statusBeforeCommit.dirtyCount}' sample='${statusBeforeCommit.sample.join(" | ") || "-"}'`
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
        "user.name=ClawReverse",
        "-c",
        "user.email=clawreverse@openclaw.local",
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

    const archivePath = path.join(os.tmpdir(), `clawreverse-${path.basename(entry.repoDir)}-${Date.now()}.tar`);

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
    this.logger.info(`[clawreverse] initializing snapshot git repository '${repoDir}'`);
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
          GIT_AUTHOR_NAME: "ClawReverse",
          GIT_AUTHOR_EMAIL: "clawreverse@openclaw.local",
          GIT_COMMITTER_NAME: "ClawReverse",
          GIT_COMMITTER_EMAIL: "clawreverse@openclaw.local"
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
