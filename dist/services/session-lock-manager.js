import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, nowIso, removePath } from "../core/utils.js";

export class SessionLockManager {
  constructor({ config }) {
    this.config = config;
    this.queues = new Map();
  }

  lockFile(agentId, sessionId) {
    return path.join(this.config.runtimeDir, "locks", agentId, `${sessionId}.lock`);
  }

  async withLock(agentId, sessionId, task) {
    const key = `${agentId}:${sessionId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    let releaseCurrent;
    const currentTurn = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    const queueTail = previous.then(() => currentTurn);

    this.queues.set(key, queueTail);

    await previous;

    const lockFile = this.lockFile(agentId, sessionId);
    await ensureDir(path.dirname(lockFile));
    await fs.writeFile(lockFile, `${JSON.stringify({ agentId, sessionId, lockedAt: nowIso() }, null, 2)}\n`, "utf8");

    try {
      return await task();
    } finally {
      await removePath(lockFile);
      releaseCurrent();

      if (this.queues.get(key) === queueTail) {
        this.queues.delete(key);
      }
    }
  }
}
