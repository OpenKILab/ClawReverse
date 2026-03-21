import path from "node:path";

import { updateJsonFile } from "../core/persistence.js";
import { nowIso, readJson, removePath, writeJson } from "../core/utils.js";

function createInitialState(agentId, sessionId, seed = {}) {
  return {
    agentId,
    sessionId,
    activeHeadEntryId: seed.activeHeadEntryId ?? null,
    currentRunId: seed.currentRunId ?? null,
    toolCallSequence: seed.toolCallSequence ?? 0,
    lastObservedToolCallId: seed.lastObservedToolCallId ?? null,
    rollbackInProgress: false,
    awaitingContinue: false,
    lastContinuePrompt: seed.lastContinuePrompt,
    lastRollbackCheckpointId: seed.lastRollbackCheckpointId,
    lastContinueSessionId: seed.lastContinueSessionId ?? null,
    lastContinueSessionKey: seed.lastContinueSessionKey ?? null,
    lastContinuedBranchId: seed.lastContinuedBranchId ?? null,
    updatedAt: nowIso()
  };
}

export class RuntimeCursorManager {
  constructor({ config }) {
    this.config = config;
  }

  filePath(agentId, sessionId) {
    return path.join(this.config.runtimeDir, "sessions", agentId, `${sessionId}.json`);
  }

  async get(agentId, sessionId) {
    return readJson(this.filePath(agentId, sessionId), null);
  }

  async ensure(agentId, sessionId, seed = {}) {
    const existing = await this.get(agentId, sessionId);

    if (existing) {
      return existing;
    }

    const state = createInitialState(agentId, sessionId, seed);
    await writeJson(this.filePath(agentId, sessionId), state);
    return state;
  }

  async replace(agentId, sessionId, state) {
    const nextState = {
      ...createInitialState(agentId, sessionId),
      ...state,
      agentId,
      sessionId,
      updatedAt: nowIso()
    };

    await writeJson(this.filePath(agentId, sessionId), nextState);
    return nextState;
  }

  async update(agentId, sessionId, updater, seed = {}) {
    return updateJsonFile(
      this.filePath(agentId, sessionId),
      createInitialState(agentId, sessionId, seed),
      (current) => {
        const nextState = updater(current) ?? current;
        nextState.agentId = agentId;
        nextState.sessionId = sessionId;
        nextState.updatedAt = nowIso();
        return nextState;
      }
    );
  }

  async setActiveHead(agentId, sessionId, entryId) {
    return this.update(agentId, sessionId, (state) => {
      state.activeHeadEntryId = entryId ?? null;
      return state;
    });
  }

  async setCurrentRun(agentId, sessionId, runId) {
    return this.update(agentId, sessionId, (state) => {
      state.currentRunId = runId ?? null;
      return state;
    });
  }

  async syncToolCallSequence(agentId, sessionId, value, toolCallId) {
    return this.update(agentId, sessionId, (state) => {
      const normalizedValue = Number.isInteger(value) && value > 0 ? value : state.toolCallSequence ?? 0;
      state.toolCallSequence = Math.max(state.toolCallSequence ?? 0, normalizedValue);
      if (toolCallId) {
        state.lastObservedToolCallId = toolCallId;
      }
      return state;
    });
  }

  async nextToolCallSequence(agentId, sessionId, toolCallId) {
    let nextValue = 1;

    await this.update(agentId, sessionId, (state) => {
      nextValue = (state.toolCallSequence ?? 0) + 1;
      state.toolCallSequence = nextValue;
      if (toolCallId) {
        state.lastObservedToolCallId = toolCallId;
      }
      return state;
    });

    return nextValue;
  }

  async setRollbackState(agentId, sessionId, inProgress) {
    return this.update(agentId, sessionId, (state) => {
      state.rollbackInProgress = Boolean(inProgress);
      return state;
    });
  }

  async setAwaitingContinue(agentId, sessionId, awaiting) {
    return this.update(agentId, sessionId, (state) => {
      state.awaitingContinue = Boolean(awaiting);
      return state;
    });
  }

  async applyRollback(agentId, sessionId, { entryId, checkpointId }) {
    return this.update(agentId, sessionId, (state) => {
      state.activeHeadEntryId = entryId ?? null;
      state.currentRunId = null;
      state.rollbackInProgress = false;
      state.awaitingContinue = false;
      state.lastRollbackCheckpointId = checkpointId;
      return state;
    });
  }

  async applyContinue(agentId, sessionId, { prompt, runId }) {
    return this.update(agentId, sessionId, (state) => {
      state.awaitingContinue = false;
      state.rollbackInProgress = false;
      state.lastContinuePrompt = prompt || undefined;
      state.currentRunId = runId ?? null;
      return state;
    });
  }

  async clearCurrentRun(agentId, sessionId) {
    return this.setCurrentRun(agentId, sessionId, null);
  }

  async remove(agentId, sessionId) {
    await removePath(this.filePath(agentId, sessionId));
    return {
      agentId,
      sessionId
    };
  }
}
