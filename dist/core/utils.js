import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const defaultConfig = {
  enabled: true,
  workspaceRoots: ["~/.openclaw/workspace"],
  checkpointDir: "~/.openclaw/plugins/step-rollback/checkpoints",
  registryDir: "~/.openclaw/plugins/step-rollback/registry",
  runtimeDir: "~/.openclaw/plugins/step-rollback/runtime",
  reportsDir: "~/.openclaw/plugins/step-rollback/reports",
  maxCheckpointsPerSession: 100,
  allowContinuePrompt: true,
  stopRunBeforeRollback: true
};

export function nowIso() {
  return new Date().toISOString();
}

export function expandHomePath(value) {
  if (typeof value !== "string") {
    return value;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

export function isPlaceholderHomePath(value) {
  if (typeof value !== "string") {
    return false;
  }

  return (
    value === "/Users/you" ||
    value.startsWith("/Users/you/") ||
    value === "/home/you" ||
    value.startsWith("/home/you/")
  );
}

export function repairPlaceholderHomePath(value) {
  if (!isPlaceholderHomePath(value)) {
    return value;
  }

  if (value === "/Users/you" || value === "/home/you") {
    return os.homedir();
  }

  if (value.startsWith("/Users/you/")) {
    return path.join(os.homedir(), value.slice("/Users/you/".length));
  }

  return path.join(os.homedir(), value.slice("/home/you/".length));
}

export function safeProcessCwd(fallback = os.homedir()) {
  try {
    return process.cwd();
  } catch {
    return fallback;
  }
}

export function resolveAbsolutePath(value, cwd) {
  const expanded = expandHomePath(repairPlaceholderHomePath(value));
  const baseDir = typeof cwd === "string" && cwd ? cwd : safeProcessCwd();
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

export function resolveConfig(config = {}) {
  const merged = {
    ...defaultConfig,
    ...config
  };

  return {
    ...merged,
    workspaceRoots: merged.workspaceRoots.map((entry) => resolveAbsolutePath(entry)),
    checkpointDir: resolveAbsolutePath(merged.checkpointDir),
    registryDir: resolveAbsolutePath(merged.registryDir),
    runtimeDir: resolveAbsolutePath(merged.runtimeDir),
    reportsDir: resolveAbsolutePath(merged.reportsDir)
  };
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallbackValue = null) {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return JSON.parse(contents);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export function snapshotEntryName(targetPath) {
  const baseName = path.basename(targetPath) || "root";
  const safeBase = baseName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const digest = crypto.createHash("sha256").update(targetPath).digest("hex").slice(0, 10);
  return `${safeBase}-${digest}`;
}

export async function copyPath(sourcePath, destinationPath) {
  const stats = await fs.lstat(sourcePath);

  await ensureDir(path.dirname(destinationPath));

  if (stats.isDirectory()) {
    await fs.cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      preserveTimestamps: true
    });
    return "directory";
  }

  await fs.cp(sourcePath, destinationPath, {
    force: true,
    preserveTimestamps: true
  });
  return "file";
}

export async function replacePathWithCopy(sourcePath, destinationPath, kind) {
  await removePath(destinationPath);
  await ensureDir(path.dirname(destinationPath));

  if (kind === "directory") {
    await fs.cp(sourcePath, destinationPath, {
      recursive: true,
      force: true,
      preserveTimestamps: true
    });
    return;
  }

  await fs.cp(sourcePath, destinationPath, {
    force: true,
    preserveTimestamps: true
  });
}

export function createDefaultHostBridge(host = {}) {
  return {
    stopRun: host.stopRun ?? (async ({ agentId, sessionId, runId }) => ({
      stopped: true,
      agentId,
      sessionId,
      runId
    })),
    startContinueRun: host.startContinueRun ?? (async () => ({
      runId: `run_${crypto.randomUUID()}`
    })),
    forkContinue: host.forkContinue ?? (async ({
      sourceAgentId,
      sourceSessionId,
      checkpoint,
      prompt,
      newAgentId
    }) => ({
      ok: true,
      parentAgentId: sourceAgentId,
      parentSessionId: sourceSessionId,
      newAgentId: newAgentId ?? `${sourceAgentId}-cp-${crypto.randomUUID().slice(0, 8)}`,
      newWorkspacePath: null,
      newAgentDir: null,
      newSessionId: crypto.randomUUID(),
      newSessionKey: null,
      checkpointId: checkpoint?.checkpointId ?? null,
      prompt,
      started: false,
      createdNewAgent: true
    })),
    createSession: host.createSession ?? (async () => ({
      sessionId: crypto.randomUUID()
    }))
  };
}

export class SequenceStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async next(prefix) {
    const state = await readJson(this.filePath, {});
    const nextValue = (state[prefix] ?? 0) + 1;

    state[prefix] = nextValue;
    await writeJson(this.filePath, state);

    return `${prefix}_${String(nextValue).padStart(4, "0")}`;
  }
}

export function cloneValue(value) {
  return structuredClone(value);
}

export function fileExistsSync(filePath) {
  return existsSync(filePath);
}
