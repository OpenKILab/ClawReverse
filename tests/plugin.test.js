import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import nativeStepRollbackPlugin, {
  createNativeStepRollbackPlugin,
  createStepRollbackPlugin
} from "../dist/index.js";
import { resolveAbsolutePath } from "../dist/core/utils.js";

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-step-claw-"));
  const workspace = path.join(root, "workspace");
  const pluginRoot = path.join(root, "plugin-data");
  const configPath = path.join(root, "openclaw.json");

  await fs.mkdir(workspace, { recursive: true });

  return {
    root,
    configPath,
    workspace,
    checkpointDir: path.join(pluginRoot, "checkpoints"),
    registryDir: path.join(pluginRoot, "registry"),
    runtimeDir: path.join(pluginRoot, "runtime"),
    reportsDir: path.join(pluginRoot, "reports")
  };
}

async function writeOpenClawConfig(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSessionTranscript(root, agentId, sessionId, entries) {
  const sessionsDir = path.join(root, "agents", agentId, "sessions");
  const transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);

  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    transcriptPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );

  return {
    transcriptPath,
    sessionStoreTemplate: path.join(root, "agents", "{agentId}", "sessions", "sessions.json")
  };
}

async function writeSessionIndex(root, agentId, contents) {
  const sessionsDir = path.join(root, "agents", agentId, "sessions");
  const sessionIndexPath = path.join(sessionsDir, "sessions.json");

  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(sessionIndexPath, `${JSON.stringify(contents, null, 2)}\n`, "utf8");

  return sessionIndexPath;
}

function createFakeProgram() {
  const commands = new Map();

  function createCommand(pathParts) {
    const record = {
      path: pathParts.join(" "),
      action: null,
      descriptionText: "",
      options: [],
      helpTexts: {},
      events: new Map()
    };

    if (record.path) {
      commands.set(record.path, record);
    }

    return {
      command(name) {
        return createCommand([...pathParts, name]);
      },
      description(text) {
        record.descriptionText = text ?? "";
        return this;
      },
      option(flags, description) {
        record.options.push({
          flags,
          description,
          required: false
        });
        return this;
      },
      requiredOption(flags, description) {
        record.options.push({
          flags,
          description,
          required: true
        });
        return this;
      },
      addHelpText(position, text) {
        record.helpTexts[position] = [
          ...(record.helpTexts[position] ?? []),
          text
        ];
        return this;
      },
      on(eventName, handler) {
        record.events.set(eventName, handler);
        return this;
      },
      action(handler) {
        record.action = handler;
        return this;
      }
    };
  }

  return {
    program: createCommand([]),
    commands
  };
}

async function captureConsoleLog(fn) {
  const original = console.log;
  const output = [];

  console.log = (...args) => {
    output.push(args.join(" "));
  };

  try {
    await fn();
  } finally {
    console.log = original;
  }

  return output.join("\n");
}

async function withEnv(name, value, fn) {
  const previous = process.env[name];

  if (value === undefined || value === null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

async function withTempEnv(entries, fn) {
  const previous = new Map();

  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);

    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function waitForFile(filePath, attempts = 80, delayMs = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch (error) {
      if (attempt === attempts - 1) {
        throw error;
      }
    }

    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  return filePath;
}

test("creates checkpoints, keeps workspace untouched on rollback by default, and continues from the checkpoint", async () => {
  const fixture = await createFixture();
  const calls = {
    stopRun: [],
    forkContinue: []
  };

  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: [fixture.workspace],
      checkpointDir: fixture.checkpointDir,
      registryDir: fixture.registryDir,
      runtimeDir: fixture.runtimeDir,
      reportsDir: fixture.reportsDir
    },
    host: {
      async stopRun(input) {
        calls.stopRun.push(input);
        return { stopped: true };
      },
      async forkContinue(input) {
        calls.forkContinue.push(input);
        return {
          started: true,
          runId: "run-child-1",
          newAgentId: "main-cp-0001",
          newWorkspacePath: path.join(fixture.root, "forks", "main-cp-0001"),
          newAgentDir: path.join(fixture.root, "agents", "main-cp-0001"),
          newSessionId: "session-child-1",
          newSessionKey: "agent:main-cp-0001:main"
        };
      }
    }
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "v1\n", "utf8");

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-1",
    runId: "run-1"
  });

  const firstCheckpoint = await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-1",
    entryId: "entry-1",
    nodeIndex: 1,
    toolName: "write",
    runId: "run-1"
  });

  assert.equal(firstCheckpoint.workspaceSnapshots[0].backend, "git");
  assert.equal(firstCheckpoint.workspaceSnapshots[0].targetPath, fixture.workspace);
  assert.match(firstCheckpoint.workspaceSnapshots[0].commitId, /^[0-9a-f]{40}$/);

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "v2\n", "utf8");

  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-1",
    entryId: "entry-2",
    nodeIndex: 2,
    toolName: "write",
    runId: "run-1"
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "broken\n", "utf8");

  const listResponse = await plugin.methods["steprollback.checkpoints.list"]({
    agentId: "main",
    sessionId: "session-1"
  });

  assert.equal(listResponse.checkpoints.length, 2);
  assert.equal(listResponse.checkpoints[0].summary, "before tool write");

  const rollbackResponse = await plugin.methods["steprollback.rollback"]({
    agentId: "main",
    sessionId: "session-1",
    checkpointId: listResponse.checkpoints[0].checkpointId
  });

  assert.equal(rollbackResponse.result, "success");
  assert.equal(rollbackResponse.restoredWorkspace, false);
  assert.equal(rollbackResponse.awaitingContinue, false);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "app.txt"), "utf8"), "broken\n");
  assert.equal(calls.stopRun.length, 1);

  const rollbackStatus = await plugin.methods["steprollback.rollback.status"]({
    agentId: "main",
    sessionId: "session-1"
  });

  assert.equal(rollbackStatus.awaitingContinue, false);
  assert.equal(rollbackStatus.activeHeadEntryId, "entry-1");

  const continueResponse = await plugin.methods["steprollback.continue"]({
    agentId: "main",
    sessionId: "session-1",
    checkpointId: listResponse.checkpoints[0].checkpointId,
    prompt: "Retry, but inspect dependencies first."
  });

  assert.equal(continueResponse.continued, true);
  assert.equal(continueResponse.usedPrompt, true);
  assert.equal(continueResponse.newAgentId, "main-cp-0001");
  assert.equal(continueResponse.newSessionId, "session-child-1");
  assert.equal(continueResponse.newSessionKey, "agent:main-cp-0001:main");
  assert.equal(calls.forkContinue.length, 1);
  assert.equal(calls.forkContinue[0].sourceEntryId, "entry-1");
  assert.equal(calls.forkContinue[0].checkpoint.checkpointId, listResponse.checkpoints[0].checkpointId);
  assert.equal(calls.forkContinue[0].prompt, "Retry, but inspect dependencies first.");

  const report = await plugin.methods["steprollback.reports.get"]({
    rollbackId: rollbackResponse.rollbackId
  });

  assert.equal(report.result, "success");
  assert.match(report.message, /rollback completed/);

  const finalState = await plugin.services.runtimeCursorManager.get("main", "session-1");
  assert.equal(finalState.awaitingContinue, false);
  assert.equal(finalState.currentRunId, null);
  assert.equal(finalState.lastContinueSessionId, "session-child-1");

  const branchedState = await plugin.services.runtimeCursorManager.get("main-cp-0001", "session-child-1");
  assert.equal(branchedState.currentRunId, "run-child-1");

  const branch = await plugin.methods["steprollback.session.branch.get"]({
    branchId: continueResponse.branchId
  });
  assert.equal(branch.branchType, "agent");
  assert.equal(branch.sourceSessionId, "session-1");
  assert.equal(branch.newAgentId, "main-cp-0001");
  assert.equal(branch.newSessionId, "session-child-1");
});

test("builds checkpoint summaries from tool targets and exec commands", async () => {
  const fixture = await createFixture();
  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: [fixture.workspace],
      checkpointDir: fixture.checkpointDir,
      registryDir: fixture.registryDir,
      runtimeDir: fixture.runtimeDir,
      reportsDir: fixture.reportsDir
    }
  });

  const reportPath = path.join(fixture.workspace, "docs", "report.pdf");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, "v1\n", "utf8");

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-summary",
    runId: "run-summary"
  });

  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-summary",
    entryId: "entry-write",
    nodeIndex: 1,
    toolName: "write",
    runId: "run-summary",
    params: {
      file_path: path.join(fixture.workspace, "overview.txt"),
      content: "hello"
    }
  });

  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-summary",
    entryId: "entry-exec",
    nodeIndex: 2,
    toolName: "exec",
    runId: "run-summary",
    params: {
      command: `rm ${reportPath}`
    }
  });

  const { checkpoints } = await plugin.methods["steprollback.checkpoints.list"]({
    agentId: "main",
    sessionId: "session-summary"
  });

  assert.equal(checkpoints[0].summary, "before tool write overview.txt");
  assert.equal(checkpoints[1].summary, "before tool exec delete report.pdf");
});

test("skips checkpoints for read-only tools and read-only exec commands", async () => {
  const fixture = await createFixture();
  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: [fixture.workspace],
      checkpointDir: fixture.checkpointDir,
      registryDir: fixture.registryDir,
      runtimeDir: fixture.runtimeDir,
      reportsDir: fixture.reportsDir
    }
  });

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-filtered",
    runId: "run-filtered"
  });

  const readCheckpoint = await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-filtered",
    entryId: "entry-read",
    nodeIndex: 1,
    toolName: "read",
    runId: "run-filtered",
    params: {
      file_path: path.join(fixture.workspace, "notes.txt")
    }
  });

  const listCheckpoint = await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-filtered",
    entryId: "entry-list",
    nodeIndex: 2,
    toolName: "exec",
    runId: "run-filtered",
    params: {
      command: `cd ${fixture.workspace} && git status`
    }
  });

  const findCheckpoint = await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-filtered",
    entryId: "entry-find",
    nodeIndex: 3,
    toolName: "exec",
    runId: "run-filtered",
    params: {
      command: `find ${fixture.workspace} -type f -maxdepth 2`
    }
  });

  await fs.writeFile(path.join(fixture.workspace, "notes.txt"), "v1\n", "utf8");

  const writeCheckpoint = await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-filtered",
    entryId: "entry-write",
    nodeIndex: 4,
    toolName: "write",
    runId: "run-filtered",
    params: {
      file_path: path.join(fixture.workspace, "notes.txt"),
      content: "v2\n"
    }
  });

  assert.equal(readCheckpoint, null);
  assert.equal(listCheckpoint, null);
  assert.equal(findCheckpoint, null);
  assert.ok(writeCheckpoint);

  const { checkpoints } = await plugin.methods["steprollback.checkpoints.list"]({
    agentId: "main",
    sessionId: "session-filtered"
  });

  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].entryId, "entry-write");
  assert.equal(checkpoints[0].summary, "before tool write notes.txt");
});

test("resolves relative paths even when process cwd is unavailable", () => {
  const originalCwd = process.cwd;

  Object.defineProperty(process, "cwd", {
    value() {
      const error = new Error("missing cwd");
      error.code = "ENOENT";
      throw error;
    },
    configurable: true
  });

  try {
    const resolved = resolveAbsolutePath("relative/path");
    assert.equal(resolved, path.join(os.homedir(), "relative/path"));
  } finally {
    Object.defineProperty(process, "cwd", {
      value: originalCwd,
      configurable: true
    });
  }
});

test("repairs placeholder home paths in plugin config", async () => {
  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: ["/Users/you/.openclaw/workspace"],
      checkpointDir: "/Users/you/.openclaw/plugins/step-rollback/checkpoints",
      registryDir: "/Users/you/.openclaw/plugins/step-rollback/registry",
      runtimeDir: "/Users/you/.openclaw/plugins/step-rollback/runtime",
      reportsDir: "/Users/you/.openclaw/plugins/step-rollback/reports"
    }
  });

  assert.equal(plugin.config.workspaceRoots[0], path.join(os.homedir(), ".openclaw", "workspace"));
  assert.equal(
    plugin.config.checkpointDir,
    path.join(os.homedir(), ".openclaw", "plugins", "step-rollback", "checkpoints")
  );
  assert.equal(
    plugin.config.registryDir,
    path.join(os.homedir(), ".openclaw", "plugins", "step-rollback", "registry")
  );
});

test("prunes old checkpoints when maxCheckpointsPerSession is exceeded", async () => {
  const fixture = await createFixture();
  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: [fixture.workspace],
      checkpointDir: fixture.checkpointDir,
      registryDir: fixture.registryDir,
      runtimeDir: fixture.runtimeDir,
      reportsDir: fixture.reportsDir,
      maxCheckpointsPerSession: 2
    }
  });

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-prune",
    runId: "run-prune"
  });

  for (let index = 1; index <= 3; index += 1) {
    await fs.writeFile(path.join(fixture.workspace, "file.txt"), `v${index}\n`, "utf8");
    await plugin.hooks.beforeToolCall({
      agentId: "main",
      sessionId: "session-prune",
      entryId: `entry-${index}`,
      nodeIndex: index,
      toolName: "write",
      runId: "run-prune"
    });
  }

  const listResponse = await plugin.methods["steprollback.checkpoints.list"]({
    agentId: "main",
    sessionId: "session-prune"
  });

  assert.equal(listResponse.checkpoints.length, 2);
  assert.deepEqual(
    listResponse.checkpoints.map((checkpoint) => checkpoint.entryId),
    ["entry-2", "entry-3"]
  );
});

test("checks out a session branch from a checkpoint entry", async () => {
  const fixture = await createFixture();
  const calls = {
    createSession: [],
    continueRun: []
  };

  const plugin = createStepRollbackPlugin({
    config: {
      workspaceRoots: [fixture.workspace],
      checkpointDir: fixture.checkpointDir,
      registryDir: fixture.registryDir,
      runtimeDir: fixture.runtimeDir,
      reportsDir: fixture.reportsDir
    },
    host: {
      async createSession(input) {
        calls.createSession.push(input);
        return { sessionId: "session-branch" };
      },
      async startContinueRun(input) {
        calls.continueRun.push(input);
        return { runId: `run:${input.sessionId}` };
      }
    }
  });

  await plugin.hooks.sessionStart({
    agentId: "main",
    sessionId: "session-source",
    runId: "run-source"
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "base\n", "utf8");
  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-source",
    entryId: "entry-base",
    nodeIndex: 1,
    toolName: "write",
    runId: "run-source"
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "next\n", "utf8");
  await plugin.hooks.beforeToolCall({
    agentId: "main",
    sessionId: "session-source",
    entryId: "entry-next",
    nodeIndex: 2,
    toolName: "write",
    runId: "run-source"
  });

  await fs.writeFile(path.join(fixture.workspace, "app.txt"), "broken\n", "utf8");

  const checkoutResponse = await plugin.methods["steprollback.session.checkout"]({
    agentId: "main",
    sourceSessionId: "session-source",
    sourceEntryId: "entry-base",
    continueAfterCheckout: true,
    prompt: "Continue from the safe checkpoint."
  });

  assert.equal(checkoutResponse.newSessionId, "session-branch");
  assert.equal(checkoutResponse.continued, true);
  assert.equal(checkoutResponse.usedPrompt, true);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "app.txt"), "utf8"), "base\n");
  assert.equal(calls.createSession.length, 1);
  assert.equal(calls.continueRun[0].sessionId, "session-branch");

  const branch = await plugin.methods["steprollback.session.branch.get"]({
    branchId: checkoutResponse.branchId
  });

  assert.equal(branch.sourceSessionId, "session-source");
  assert.equal(branch.sourceEntryId, "entry-base");

  const nodes = await plugin.methods["steprollback.session.nodes.list"]({
    agentId: "main",
    sessionId: "session-source"
  });

  assert.equal(nodes.nodes.length, 2);
  assert.equal(nodes.nodes[0].checkoutAvailable, true);
});

test("registers a native OpenClaw plugin and drives rollback through registered hooks and Gateway methods", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const gatewayCalls = [];
  const subagentCalls = [];
  const logs = [];
  const toolCallId = "chatcmpl-tool-native";
  const transcript = await writeSessionTranscript(fixture.root, "main", "native-session", [
    {
      type: "message",
      id: "entry-native",
      timestamp: "2026-03-17T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "write",
            arguments: {
              file_path: path.join(fixture.workspace, "native.txt"),
              content: "broken\n"
            }
          }
        ]
      }
    }
  ]);
  const nativeSessionStorePath = transcript.sessionStoreTemplate.replace("{agentId}", "main");

  await fs.writeFile(
    nativeSessionStorePath,
    `${JSON.stringify({
      "agent:main:main": {
        sessionId: "native-session",
        label: "Native test session",
        updatedAt: "2026-03-17T00:00:00.000Z"
      }
    }, null, 2)}\n`,
    "utf8"
  );

  await fs.writeFile(path.join(fixture.workspace, "native.txt"), "safe\n", "utf8");

  const api = {
    config: {
      agents: {
        list: [
          {
            id: "main",
            name: "main",
            workspace: fixture.workspace,
            model: "gpt-test"
          }
        ]
      },
      session: {
        storePath: transcript.sessionStoreTemplate
      },
      plugins: {
        entries: {
          "step-rollback": {
            enabled: true,
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info(message) {
        logs.push({ level: "info", message });
      },
      warn(message) {
        logs.push({ level: "warn", message });
      },
      error(message) {
        logs.push({ level: "error", message });
      },
      debug(message) {
        logs.push({ level: "debug", message });
      }
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    },
    runtime: {
      subagent: {
        async run(params) {
          subagentCalls.push(params);
          const currentStore = JSON.parse(await fs.readFile(nativeSessionStorePath, "utf8"));

          if (params.sessionKey && !currentStore[params.sessionKey]) {
            currentStore[params.sessionKey] = {
              sessionId: "native-session-branch",
              label: "Rollback branch",
              updatedAt: "2026-03-17T00:00:01.000Z"
            };
            await fs.writeFile(nativeSessionStorePath, `${JSON.stringify(currentStore, null, 2)}\n`, "utf8");
          }

          return {
            runId: `subagent:${params.sessionKey}:tail`
          };
        }
      },
      gateway: {
        async call(method, params) {
          gatewayCalls.push({ method, params });

          if (method === "agent" && params.message === "/stop") {
            return { runId: "stop-run", acceptedAt: "2026-03-17T00:00:00.000Z" };
          }

          return undefined;
        }
      }
    }
  };

  await writeOpenClawConfig(fixture.configPath, api.config);

  await withTempEnv({
    OPENCLAW_CONFIG_PATH: fixture.configPath,
    OPENCLAW_STATE_DIR: fixture.root
  }, async () => {
    const nativePlugin = createNativeStepRollbackPlugin();
    const engine = await nativePlugin.register(api);

    assert.equal(nativeStepRollbackPlugin.id, "step-rollback");
    assert.equal(engine.manifest.id, "step-rollback");
    assert.equal(registered.methods.has("steprollback.status"), true);
    assert.equal(registered.methods.has("steprollback.rollback"), true);
    assert.equal(registered.hooks.has("session_start"), true);
    assert.equal(registered.hooks.has("before_tool_call"), true);
    assert.equal(typeof registered.hooks.get("before_tool_call").handler, "function");
    assert.equal(registered.services.length, 1);
    assert.equal(registered.clis.length, 1);
    assert.deepEqual(registered.clis[0].meta.commands, ["steprollback"]);

    const serviceStartResult = await registered.services[0].start();
    assert.equal(serviceStartResult.pluginId, "step-rollback");

    await registered.hooks.get("session_start").handler({
      agentId: "main",
      sessionId: "native-session",
      runId: "run-native"
    });

    await registered.hooks.get("before_tool_call").handler({
      agentId: "main",
      sessionId: "native-session",
      toolName: "write",
      toolCallId,
      runId: "run-native"
    });

    await fs.writeFile(path.join(fixture.workspace, "native.txt"), "broken\n", "utf8");

    const checkpointResponses = [];
    await registered.methods.get("steprollback.checkpoints.list")({
      params: {
        agentId: "main",
        sessionId: "native-session"
      },
      respond(ok, payload) {
        checkpointResponses.push({ ok, payload });
      }
    });

    assert.equal(checkpointResponses.length, 1);
    assert.equal(checkpointResponses[0].ok, true);
    assert.equal(checkpointResponses[0].payload.checkpoints.length, 1);

    const checkpointId = checkpointResponses[0].payload.checkpoints[0].checkpointId;

    const rollbackResponse = await registered.methods.get("steprollback.rollback")({
      params: {
        agentId: "main",
        sessionId: "native-session",
        checkpointId,
        restoreWorkspace: true
      }
    });

    assert.equal(rollbackResponse.result, "success");
    assert.equal(rollbackResponse.restoredWorkspace, true);
    assert.equal(await fs.readFile(path.join(fixture.workspace, "native.txt"), "utf8"), "safe\n");
    assert.equal(
      gatewayCalls.some((call) => call.method === "agent" && call.params.message === "/stop"),
      true
    );

    const continueResponse = await registered.methods.get("steprollback.continue")({
      params: {
        agentId: "main",
        sessionId: "native-session",
        checkpointId,
        prompt: "Inspect the checkpoint before changing anything."
      }
    });

    assert.equal(continueResponse.continued, true);
    assert.equal(continueResponse.newAgentId, "main-cp-0001");
    assert.equal(continueResponse.newSessionKey, "agent:main-cp-0001:main");
    assert.equal(await fs.readFile(path.join(continueResponse.newWorkspacePath, "native.txt"), "utf8"), "safe\n");
    assert.equal(
      subagentCalls.some(
        (call) =>
          call.sessionKey === continueResponse.newSessionKey &&
          call.message === "Inspect the checkpoint before changing anything." &&
          call.deliver === false
      ) || logs.some((entry) => entry.message.includes("continue launched via")),
      true
    );

    const childConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    assert.equal(childConfig.agents.list.some((entry) => entry.id === "main-cp-0001"), true);

    const childTranscriptPath = path.join(fixture.root, "agents", "main-cp-0001", "sessions", `${continueResponse.newSessionId}.jsonl`);
    const childTranscript = await fs.readFile(childTranscriptPath, "utf8");
    assert.match(childTranscript, /entry-native/);
    assert.equal(logs.some((entry) => entry.message.includes("registered native OpenClaw plugin surfaces")), true);
    assert.equal(logs.some((entry) => entry.message.includes("resolved config")), false);
    assert.equal(logs.some((entry) => entry.message.includes("resolved tool checkpoint context")), true);
    assert.equal(logs.some((entry) => entry.message.includes("git workspace status")), true);
  });
});

test("returns Gateway-style error payloads for native RPC handlers", async () => {
  const fixture = await createFixture();
  const registered = new Map();

  const api = {
    config: {
      plugins: {
        entries: {
          "step-rollback": {
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod(name, handler) {
      registered.set(name, handler);
    },
    registerHook() {},
    on() {},
    registerService() {},
    registerCli() {}
  };

  await createNativeStepRollbackPlugin().register(api);

  const responses = [];
  await registered.get("steprollback.rollback")({
    params: {
      agentId: "main",
      sessionId: "missing-session",
      checkpointId: "missing-checkpoint"
    },
    respond(ok, payload) {
      responses.push({ ok, payload });
    }
  });

  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, false);
  assert.equal(responses[0].payload.code, "CHECKPOINT_NOT_FOUND");
});

test("setup patches openclaw.json and creates plugin directories", async () => {
  const fixture = await createFixture();
  const registered = {
    clis: []
  };
  const existingConfig = {
    gateway: {
      auth: {
        mode: "token"
      }
    },
    plugins: {
      allow: ["other-plugin"]
    }
  };

  await writeOpenClawConfig(fixture.configPath, existingConfig);

  const api = {
    config: existingConfig,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod() {},
    registerHook() {},
    on() {},
    registerService() {},
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    }
  };

  await withTempEnv({
    OPENCLAW_CONFIG_PATH: fixture.configPath,
    OPENCLAW_STATE_DIR: fixture.root
  }, async () => {
    await createNativeStepRollbackPlugin().register(api);

    const cliHarness = createFakeProgram();
    registered.clis[0].factory({ program: cliHarness.program });

    const output = await captureConsoleLog(async () => {
      await cliHarness.commands.get("steprollback setup").action({});
    });

    assert.match(output, /configPath/);

    const patchedConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    assert.equal(patchedConfig.gateway.auth.mode, "token");
    assert.deepEqual(patchedConfig.plugins.allow, ["other-plugin", "step-rollback"]);
    assert.equal(patchedConfig.plugins.enabled, true);
    assert.equal(patchedConfig.plugins.entries["step-rollback"].enabled, true);
    assert.deepEqual(
      patchedConfig.plugins.entries["step-rollback"].config.workspaceRoots,
      [path.join(fixture.root, "workspace")]
    );
    assert.equal(
      patchedConfig.plugins.entries["step-rollback"].config.checkpointDir,
      path.join(fixture.root, "plugins", "step-rollback", "checkpoints")
    );

    await fs.access(path.join(fixture.root, "workspace"));
    await fs.access(path.join(fixture.root, "plugins", "step-rollback", "checkpoints"));
    await fs.access(path.join(fixture.root, "plugins", "step-rollback", "registry"));
    await fs.access(path.join(fixture.root, "plugins", "step-rollback", "runtime"));
    await fs.access(path.join(fixture.root, "plugins", "step-rollback", "reports"));

    const beforeDryRun = await fs.readFile(fixture.configPath, "utf8");
    await cliHarness.commands.get("steprollback setup").action({
      baseDir: path.join(fixture.root, "dry-run-root"),
      dryRun: true
    });
    const afterDryRun = await fs.readFile(fixture.configPath, "utf8");
    assert.equal(afterDryRun, beforeDryRun);
  });
});

test("offers flag-based CLI commands for agents, sessions, rollback, and continue", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const cliGatewayCalls = [];
  const cliGatewayBehaviors = [];
  const continueCalls = [];
  const sessionStoreTemplate = path.join(fixture.root, "agents", "{agentId}", "sessions", "sessions.json");
  const sessionStorePath = sessionStoreTemplate.replace("{agentId}", "main");
  const toolCallId = "chatcmpl-tool-cli";

  await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
  await fs.writeFile(
    sessionStorePath,
    `${JSON.stringify([
      {
        sessionId: "session-cli",
        title: "CLI test session",
        updatedAt: "2026-03-17T12:00:00.000Z"
      }
    ], null, 2)}\n`,
    "utf8"
  );
  await writeSessionTranscript(fixture.root, "main", "session-cli", [
    {
      type: "message",
      id: "entry-cli",
      timestamp: "2026-03-17T12:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "write",
            arguments: {
              file_path: path.join(fixture.workspace, "cli.txt"),
              content: "broken\n"
            }
          }
        ]
      }
    }
  ]);
  await fs.writeFile(path.join(fixture.workspace, "cli.txt"), "stable\n", "utf8");

  const api = {
    config: {
      agents: {
        list: [
          {
            id: "main",
            name: "main",
            workspace: fixture.workspace,
            model: "gpt-test"
          }
        ]
      },
      session: {
        storePath: sessionStoreTemplate
      },
      plugins: {
        entries: {
          "step-rollback": {
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    }
  };

  await createNativeStepRollbackPlugin({
    host: {
      async stopRun() {
        return { stopped: true, runId: "stop-cli" };
      },
      async forkContinue(input) {
        continueCalls.push(input);
        const resolvedAgentId = input.newAgentId ?? "main-cp-cli";
        return {
          started: true,
          runId: `run:child:${input.branchId}`,
          newAgentId: resolvedAgentId,
          newWorkspacePath: path.join(fixture.root, "forks", resolvedAgentId),
          newAgentDir: path.join(fixture.root, "agents", resolvedAgentId),
          newSessionId: "session-checkout-cli",
          newSessionKey: "agent:main-cp-cli:main",
          createdNewAgent: true
        };
      },
      async createSession() {
        return { sessionId: "session-checkout-cli" };
      }
    },
    cliGatewayInvoker: async (methodName, params, behavior) => {
      cliGatewayCalls.push({ methodName, params });
      cliGatewayBehaviors.push(behavior ?? {});
      const handler = registered.methods.get(methodName);
      return handler ? handler({ params }) : undefined;
    }
  }).register(api);

  const cliHarness = createFakeProgram();
  registered.clis[0].factory({ program: cliHarness.program });
  const rootHelp = cliHarness.commands.get("steprollback").helpTexts.after.join("\n");

  assert.match(rootHelp, /Command overview:/);
  assert.match(rootHelp, /setup \[--base-dir <path>\] \[--dry-run\] \[--json\]/);
  assert.match(rootHelp, /status/);
  assert.match(rootHelp, /continue --agent <agentId> --session <sessionId> --checkpoint <checkpointId> --prompt <text> \[--new-agent <agentId>\] \[--clone-auth <mode>\] \[--log\] \[--json\]/);
  assert.match(rootHelp, /checkout --agent <agentId> --source-session <sessionId> --entry <entryId> \[--continue\] \[--prompt <text>\] \[--json\]/);
  assert.match(rootHelp, /report --rollback <rollbackId> \[--json\]/);
  assert.match(rootHelp, /branch --branch <branchId> \[--json\]/);
  assert.match(rootHelp, /openclaw steprollback <command> --help/);

  await registered.hooks.get("session_start").handler({
    agentId: "main",
    sessionId: "session-cli",
    runId: "run-cli"
  });
  await registered.hooks.get("before_tool_call").handler({
    agentId: "main",
    sessionId: "session-cli",
    toolName: "write",
    toolCallId,
    runId: "run-cli"
  });
  await fs.writeFile(path.join(fixture.workspace, "cli.txt"), "broken\n", "utf8");

  const agentsOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback agents").action({ agent: "main" });
  });
  assert.match(agentsOutput, /Agent/);
  assert.match(agentsOutput, /main/);

  const sessionsOutput = await captureConsoleLog(async () => {
    await withEnv("NO_COLOR", undefined, async () =>
      withEnv("FORCE_COLOR", "1", async () => {
        await cliHarness.commands.get("steprollback sessions").action({ agent: "main" });
      })
    );
  });
  assert.match(sessionsOutput, /Mark/);
  assert.match(sessionsOutput, /latest/);
  assert.match(sessionsOutput, /session-cli/);
  assert.match(sessionsOutput, /CLI test session/);
  assert.match(sessionsOutput, /2026-03-17 \d{2}:\d{2}:\d{2}/);
  assert.match(sessionsOutput, /\u001b\[[0-9;]*mlatest\u001b\[0m/);
  assert.match(sessionsOutput, /\u001b\[[0-9;]*msession-cli\u001b\[0m/);

  const checkpointsOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback checkpoints").action({
      agent: "main",
      session: "session-cli"
    });
  });
  assert.match(checkpointsOutput, /Checkpoint/);
  assert.match(checkpointsOutput, /entry-cli|ckpt_/);

  const checkpointList = await registered.methods.get("steprollback.checkpoints.list")({
    params: {
      agentId: "main",
      sessionId: "session-cli"
    }
  });
  const checkpointId = checkpointList.checkpoints[0].checkpointId;

  const rollbackOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback rollback").action({
      agent: "main",
      session: "session-cli",
      checkpoint: checkpointId,
      restoreWorkspace: true
    });
  });
  assert.match(rollbackOutput, /rollbackId/);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "cli.txt"), "utf8"), "stable\n");
  assert.equal(
    cliGatewayCalls.some(
      (call) =>
        call.methodName === "steprollback.rollback" &&
        call.params.agentId === "main" &&
        call.params.sessionId === "session-cli" &&
        call.params.checkpointId === checkpointId &&
        call.params.restoreWorkspace === true
    ),
    false
  );

  const continueOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback continue").action({
      agent: "main",
      session: "session-cli",
      checkpoint: checkpointId,
      prompt: "Inspect first.",
      log: true
    });
  });
  assert.match(continueOutput, /continued/);
  assert.match(continueOutput, /main-cp-cli/);
  assert.match(continueOutput, /session-checkout-cli/);
  assert.equal(continueCalls.at(-1)?.newAgentId, undefined);
  assert.equal(continueCalls.at(-1)?.log, true);
  assert.equal(
    cliGatewayCalls.some(
      (call) =>
        call.methodName === "steprollback.continue" &&
        call.params.agentId === "main" &&
        call.params.sessionId === "session-cli" &&
        call.params.checkpointId === checkpointId &&
        call.params.prompt === "Inspect first."
    ),
    false
  );

  const namedContinueOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback continue").action({
      agent: "main",
      session: "session-cli",
      checkpoint: checkpointId,
      prompt: "Create a fresh child.",
      newAgent: "main-cp-forced"
    });
  });
  assert.match(namedContinueOutput, /main-cp-forced/);
  assert.equal(continueCalls.at(-1)?.newAgentId, "main-cp-forced");
});

test("falls back to spawned gateway call with auth from config for gateway-delegated CLI commands", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const gatewayCapturePath = path.join(fixture.root, "gateway-capture.json");
  const fakeGatewayPath = path.join(fixture.root, "fake-openclaw");

  await fs.writeFile(
    fakeGatewayPath,
    `#!/usr/bin/env node
const fs = require("node:fs/promises");

(async () => {
  const args = process.argv.slice(2);
  await fs.writeFile(process.env.STEP_ROLLBACK_FAKE_GATEWAY_CAPTURE, JSON.stringify({ args }, null, 2));
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      continued: true,
      newSessionId: "branch-from-cli"
    }
  }));
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
`,
    "utf8"
  );
  await fs.chmod(fakeGatewayPath, 0o755);

  const api = {
    config: {
      gateway: {
        auth: {
          mode: "token",
          token: "token-from-config"
        }
      },
      plugins: {
        entries: {
          "step-rollback": {
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    runtime: {
      gateway: {
        async call() {
          throw new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason");
        }
      }
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    }
  };

  await createNativeStepRollbackPlugin({
    gatewayCommand: fakeGatewayPath
  }).register(api);

  const cliHarness = createFakeProgram();
  registered.clis[0].factory({ program: cliHarness.program });

  const output = await withTempEnv({
    STEP_ROLLBACK_FAKE_GATEWAY_CAPTURE: gatewayCapturePath
  }, async () =>
    captureConsoleLog(async () => {
      await cliHarness.commands.get("steprollback rollback-status").action({
        agent: "main",
        session: "session-auth"
      });
    })
  );

  assert.match(output, /newSessionId/);
  assert.match(output, /branch-from-cli/);

  const capture = JSON.parse(await fs.readFile(gatewayCapturePath, "utf8"));
  assert.equal(capture.args.includes("gateway"), true);
  assert.equal(capture.args.includes("call"), true);
  assert.equal(capture.args.includes("steprollback.rollback.status"), true);
  assert.equal(capture.args.includes("--token"), true);
  assert.equal(capture.args.includes("token-from-config"), true);
  assert.equal(capture.args.includes("--expect-final"), false);
});

test("continues locally by spawning 'openclaw agent' and recording the new branch session", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const subagentCalls = [];
  const fakeAgentCapturePath = path.join(fixture.root, "agent-capture.json");
  const fakeOpenclawPath = path.join(fixture.root, "fake-openclaw-agent");
  const sessionStoreTemplate = path.join(fixture.root, "agents", "{agentId}", "sessions", "sessions.json");

  await fs.writeFile(
    fakeOpenclawPath,
    `#!/usr/bin/env node
const fs = require("node:fs/promises");

(async () => {
  const args = process.argv.slice(2);
  await fs.writeFile(process.env.STEP_ROLLBACK_FAKE_AGENT_CAPTURE, JSON.stringify({ args, cwd: process.cwd() }, null, 2));
  process.stdout.write(JSON.stringify({
    runId: "run-branch-agent"
  }));
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
`,
    "utf8"
  );
  await fs.chmod(fakeOpenclawPath, 0o755);

  const api = {
    config: {
      agents: {
        list: [
          {
            id: "main",
            name: "main",
            workspace: fixture.workspace,
            model: "gpt-test"
          }
        ]
      },
      session: {
        storePath: sessionStoreTemplate
      },
      plugins: {
        entries: {
          "step-rollback": {
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    },
    runtime: {
      subagent: {
        async run(params) {
          subagentCalls.push(params);
          return {
            runId: "run-subagent-should-not-be-used"
          };
        }
      }
    }
  };

  await fs.writeFile(path.join(fixture.workspace, "continue.txt"), "stable\n", "utf8");
  const mainSessionId = "session-continue-cli";
  const mainSessionKey = "agent:main:main";
  const parentAgentDir = path.join(fixture.root, "agents", "main", "agent");

  await fs.mkdir(parentAgentDir, { recursive: true });
  await fs.writeFile(path.join(parentAgentDir, "auth-profiles.json"), `${JSON.stringify({ default: true })}\n`, "utf8");
  await fs.writeFile(path.join(parentAgentDir, "models.json"), `${JSON.stringify({ "gpt-test": {} })}\n`, "utf8");
  await writeOpenClawConfig(fixture.configPath, api.config);
  await writeSessionTranscript(fixture.root, "main", mainSessionId, [
    {
      type: "session",
      version: 3,
      id: mainSessionId,
      timestamp: "2026-03-17T11:59:59.000Z",
      cwd: fixture.workspace
    },
    {
      type: "message",
      id: "entry-continue-cli",
      timestamp: "2026-03-17T12:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolcall-continue-cli",
            name: "write",
            arguments: {
              file_path: path.join(fixture.workspace, "continue.txt"),
              content: "broken\n"
            }
          }
        ]
      }
    }
  ]);
  await writeSessionIndex(fixture.root, "main", {
    [mainSessionKey]: {
      sessionId: mainSessionId,
      updatedAt: Date.parse("2026-03-17T12:00:00.000Z"),
      deliveryContext: {
        channel: "webchat"
      },
      lastChannel: "webchat",
      origin: {
        provider: "webchat",
        surface: "webchat",
        chatType: "direct"
      },
      sessionFile: path.join(fixture.root, "agents", "main", "sessions", `${mainSessionId}.jsonl`),
      modelProvider: "test",
      model: "gpt-test",
      systemPromptReport: {
        sessionId: mainSessionId,
        sessionKey: mainSessionKey,
        workspaceDir: fixture.workspace,
        injectedWorkspaceFiles: [
          {
            name: "AGENTS.md",
            path: path.join(fixture.workspace, "AGENTS.md")
          }
        ]
      }
    }
  });

  await withTempEnv({
    OPENCLAW_CONFIG_PATH: fixture.configPath,
    OPENCLAW_STATE_DIR: fixture.root
  }, async () => {
    await createNativeStepRollbackPlugin({
      gatewayCommand: fakeOpenclawPath
    }).register(api);

    const cliHarness = createFakeProgram();
    registered.clis[0].factory({ program: cliHarness.program });

    await registered.hooks.get("session_start").handler({
      agentId: "main",
      sessionId: mainSessionId,
      runId: "run-continue-cli"
    });
    await registered.hooks.get("before_tool_call").handler({
      agentId: "main",
      sessionId: mainSessionId,
      entryId: "entry-continue-cli",
      nodeIndex: 1,
      toolName: "write",
      params: {
        file_path: path.join(fixture.workspace, "continue.txt"),
        content: "broken\n"
      },
      runId: "run-continue-cli"
    });
    await fs.writeFile(path.join(fixture.workspace, "continue.txt"), "broken\n", "utf8");

    const checkpointList = await registered.methods.get("steprollback.checkpoints.list")({
      params: {
        agentId: "main",
        sessionId: mainSessionId
      }
    });
    const checkpointId = checkpointList.checkpoints[0].checkpointId;

    await registered.methods.get("steprollback.rollback")({
      params: {
        agentId: "main",
        sessionId: mainSessionId,
        checkpointId
      }
    });

    const output = await withTempEnv({
      STEP_ROLLBACK_FAKE_AGENT_CAPTURE: fakeAgentCapturePath
    }, async () =>
      captureConsoleLog(async () => {
        await cliHarness.commands.get("steprollback continue").action({
          agent: "main",
          session: mainSessionId,
          checkpoint: checkpointId,
          prompt: "Check docs, but do not delete files.",
          log: true
        });
      })
    );

    assert.match(output, /continued/);
    assert.match(output, /main-cp-0001/);
    assert.match(output, /logFilePath/);
    assert.equal(await fs.readFile(path.join(fixture.workspace, "continue.txt"), "utf8"), "broken\n");

    const childConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    const childAgent = childConfig.agents.list.find((entry) => entry.id === "main-cp-0001");
    assert.ok(childAgent);
    assert.deepEqual(Object.keys(childAgent).sort(), ["agentDir", "id", "model", "name", "workspace"]);
    assert.equal(childAgent.agentDir, path.join(fixture.root, "agents", "main-cp-0001", "agent"));
    assert.equal(await fs.readFile(path.join(childAgent.workspace, "continue.txt"), "utf8"), "stable\n");
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(childAgent.agentDir, "auth-profiles.json"), "utf8")),
      { default: true }
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(childAgent.agentDir, "models.json"), "utf8")),
      { "gpt-test": {} }
    );

    const childSessionsDir = path.join(fixture.root, "agents", "main-cp-0001", "sessions");
    const childSessionFiles = (await fs.readdir(childSessionsDir))
      .filter((entry) => entry.endsWith(".jsonl"))
      .sort();
    assert.equal(childSessionFiles.length, 1);

    const childSessionId = childSessionFiles[0].replace(/\.jsonl$/, "");
    const childTranscriptEntries = (await fs.readFile(path.join(childSessionsDir, childSessionFiles[0]), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(childTranscriptEntries[0].type, "session");
    assert.equal(childTranscriptEntries[0].id, childSessionId);
    assert.equal(childTranscriptEntries[0].cwd, childAgent.workspace);
    assert.equal(childTranscriptEntries.some((entry) => entry.id === "entry-continue-cli"), true);

    const childSessionIndex = JSON.parse(await fs.readFile(path.join(childSessionsDir, "sessions.json"), "utf8"));
    assert.deepEqual(Object.keys(childSessionIndex), ["agent:main-cp-0001:main"]);

    const childSessionRecord = childSessionIndex["agent:main-cp-0001:main"];
    assert.equal(childSessionRecord.sessionId, childSessionId);
    assert.equal(childSessionRecord.sessionFile, path.join(childSessionsDir, `${childSessionId}.jsonl`));
    assert.equal(childSessionRecord.branchOf, mainSessionId);
    assert.equal(childSessionRecord.deliveryContext.channel, "webchat");
    assert.equal(childSessionRecord.systemPromptReport.sessionId, childSessionId);
    assert.equal(childSessionRecord.systemPromptReport.sessionKey, "agent:main-cp-0001:main");
    assert.equal(childSessionRecord.systemPromptReport.workspaceDir, childAgent.workspace);
    assert.equal(
      childSessionRecord.systemPromptReport.injectedWorkspaceFiles[0].path,
      path.join(childAgent.workspace, "AGENTS.md")
    );

    await waitForFile(fakeAgentCapturePath);
    const capture = JSON.parse(await fs.readFile(fakeAgentCapturePath, "utf8"));
    assert.equal(capture.args[0], "agent");
    assert.equal(await fs.realpath(capture.cwd), await fs.realpath(childAgent.workspace));
    assert.equal(capture.args.includes("--agent"), true);
    assert.equal(capture.args.includes("main-cp-0001"), true);
    assert.equal(capture.args.includes("--session-id"), true);
    assert.equal(capture.args.includes("--message"), true);
    assert.equal(capture.args.includes("Check docs, but do not delete files."), true);
    assert.equal(capture.args.includes("--json"), true);
    assert.equal(capture.args.includes("gateway"), false);
    assert.equal(subagentCalls.length, 0);

    const continueLogsDir = path.join(fixture.runtimeDir, "logs");
    const continueLogFiles = (await fs.readdir(continueLogsDir)).sort();
    assert.deepEqual(continueLogFiles, ["continue-main-cp-0001-br_0001.log"]);
    assert.match(
      await fs.readFile(path.join(continueLogsDir, continueLogFiles[0]), "utf8"),
      /run-branch-agent/
    );
  });
});

test("continue migrates legacy dynamic agent keys into agents.list before launching the child agent", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const fakeAgentCapturePath = path.join(fixture.root, "agent-capture-migrate.json");
  const fakeOpenclawPath = path.join(fixture.root, "fake-openclaw-agent-migrate");
  const sessionStoreTemplate = path.join(fixture.root, "agents", "{agentId}", "sessions", "sessions.json");

  await fs.writeFile(
    fakeOpenclawPath,
    `#!/usr/bin/env node
const fs = require("node:fs/promises");

(async () => {
  const args = process.argv.slice(2);
  await fs.writeFile(process.env.STEP_ROLLBACK_FAKE_AGENT_CAPTURE, JSON.stringify({ args }, null, 2));
  process.stdout.write(JSON.stringify({ runId: "run-migrated-child" }));
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
`,
    "utf8"
  );
  await fs.chmod(fakeOpenclawPath, 0o755);

  const baseConfig = {
    agents: {
      defaults: {
        model: {
          primary: "vllm/Intern-S1-Pro"
        },
        workspace: fixture.workspace
      },
      "main-cp-0002": {
        workspace: path.join(fixture.root, "legacy", "main-cp-0002")
      }
    },
    session: {
      storePath: sessionStoreTemplate
    },
    plugins: {
      entries: {
        "step-rollback": {
          config: {
            workspaceRoots: [fixture.workspace],
            checkpointDir: fixture.checkpointDir,
            registryDir: fixture.registryDir,
            runtimeDir: fixture.runtimeDir,
            reportsDir: fixture.reportsDir
          }
        }
      }
    }
  };

  const api = {
    config: structuredClone(baseConfig),
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    }
  };

  await fs.writeFile(path.join(fixture.workspace, "migrate.txt"), "stable\n", "utf8");
  await writeOpenClawConfig(fixture.configPath, baseConfig);
  await writeSessionTranscript(fixture.root, "main", "session-migrate", [
    {
      type: "message",
      id: "entry-migrate",
      timestamp: "2026-03-17T12:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolcall-migrate",
            name: "write",
            arguments: {
              file_path: path.join(fixture.workspace, "migrate.txt"),
              content: "broken\n"
            }
          }
        ]
      }
    }
  ]);

  await withTempEnv({
    OPENCLAW_CONFIG_PATH: fixture.configPath,
    OPENCLAW_STATE_DIR: fixture.root,
    STEP_ROLLBACK_FAKE_AGENT_CAPTURE: fakeAgentCapturePath
  }, async () => {
    await createNativeStepRollbackPlugin({
      gatewayCommand: fakeOpenclawPath
    }).register(api);

    const cliHarness = createFakeProgram();
    registered.clis[0].factory({ program: cliHarness.program });

    await registered.hooks.get("session_start").handler({
      agentId: "main",
      sessionId: "session-migrate",
      runId: "run-migrate"
    });
    await registered.hooks.get("before_tool_call").handler({
      agentId: "main",
      sessionId: "session-migrate",
      entryId: "entry-migrate",
      nodeIndex: 1,
      toolName: "write",
      params: {
        file_path: path.join(fixture.workspace, "migrate.txt"),
        content: "broken\n"
      },
      runId: "run-migrate"
    });

    const checkpointList = await registered.methods.get("steprollback.checkpoints.list")({
      params: {
        agentId: "main",
        sessionId: "session-migrate"
      }
    });

    await cliHarness.commands.get("steprollback continue").action({
      agent: "main",
      session: "session-migrate",
      checkpoint: checkpointList.checkpoints[0].checkpointId,
      prompt: "Write the script."
    });

    const migratedConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    assert.equal("main-cp-0002" in migratedConfig.agents, false);
    assert.ok(Array.isArray(migratedConfig.agents.list));
    assert.equal(migratedConfig.agents.list.some((entry) => entry.id === "main-cp-0002"), true);
    assert.equal(migratedConfig.agents.list.some((entry) => entry.id === "main-cp-0001"), true);
    const migratedLegacyChild = migratedConfig.agents.list.find((entry) => entry.id === "main-cp-0002");
    const newChild = migratedConfig.agents.list.find((entry) => entry.id === "main-cp-0001");
    assert.equal(migratedLegacyChild.id, "main-cp-0002");
    assert.equal(migratedLegacyChild.name, "main-cp-0002");
    assert.ok(migratedLegacyChild.workspace);
    assert.equal("workspaceRoot" in migratedLegacyChild, false);
    assert.equal("cwd" in migratedLegacyChild, false);
    assert.equal("root" in migratedLegacyChild, false);
    assert.equal("models" in migratedLegacyChild, false);
    assert.equal("compaction" in migratedLegacyChild, false);
    assert.equal("maxConcurrent" in migratedLegacyChild, false);
    assert.equal(newChild.id, "main-cp-0001");
    assert.equal(newChild.name, "main-cp-0001");
    assert.ok(newChild.workspace);
    assert.equal("workspaceRoot" in newChild, false);
    assert.equal("cwd" in newChild, false);
    assert.equal("root" in newChild, false);
    assert.equal("models" in newChild, false);
    assert.equal("compaction" in newChild, false);
    assert.equal("maxConcurrent" in newChild, false);

    await waitForFile(fakeAgentCapturePath);
    const capture = JSON.parse(await fs.readFile(fakeAgentCapturePath, "utf8"));
    assert.equal(capture.args.includes("main-cp-0001"), true);
  });
});

test("continue repairs stale plugin-managed fork entries in agents.list before launching the child agent", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const fakeAgentCapturePath = path.join(fixture.root, "agent-capture-repair.json");
  const fakeOpenclawPath = path.join(fixture.root, "fake-openclaw-agent-repair");
  const sessionStoreTemplate = path.join(fixture.root, "agents", "{agentId}", "sessions", "sessions.json");
  const legacyWorkspace = path.join(fixture.root, "legacy-fork", "main-cp-0003");
  const legacyAgentDir = path.join(fixture.root, "agents", "main-cp-0003");

  await fs.writeFile(
    fakeOpenclawPath,
    `#!/usr/bin/env node
const fs = require("node:fs/promises");

(async () => {
  const args = process.argv.slice(2);
  await fs.writeFile(process.env.STEP_ROLLBACK_FAKE_AGENT_CAPTURE, JSON.stringify({ args }, null, 2));
  process.stdout.write(JSON.stringify({ runId: "run-repaired-child" }));
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
`,
    "utf8"
  );
  await fs.chmod(fakeOpenclawPath, 0o755);

  const baseConfig = {
    agents: {
      defaults: {
        model: {
          primary: "vllm/Intern-S1-Pro"
        },
        models: {
          "vllm/Intern-S1-Pro": {}
        },
        workspace: fixture.workspace,
        compaction: {
          mode: "safeguard"
        }
      },
      list: [
        {
          model: {
            primary: "vllm/Intern-S1-Pro"
          },
          models: {
            "vllm/Intern-S1-Pro": {}
          },
          compaction: {
            mode: "safeguard"
          },
          maxConcurrent: 4,
          subagents: {
            maxConcurrent: 8
          },
          id: "main-cp-0003",
          name: "main-cp-0003",
          workspace: legacyWorkspace,
          workspaceRoot: legacyWorkspace,
          cwd: legacyWorkspace,
          root: legacyWorkspace,
          agentDir: legacyAgentDir
        }
      ]
    },
    session: {
      storePath: sessionStoreTemplate
    },
    plugins: {
      entries: {
        "step-rollback": {
          config: {
            workspaceRoots: [fixture.workspace],
            checkpointDir: fixture.checkpointDir,
            registryDir: fixture.registryDir,
            runtimeDir: fixture.runtimeDir,
            reportsDir: fixture.reportsDir
          }
        }
      }
    }
  };

  const api = {
    config: structuredClone(baseConfig),
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    }
  };

  await fs.mkdir(legacyWorkspace, { recursive: true });
  await fs.mkdir(path.join(legacyAgentDir, "sessions"), { recursive: true });
  await fs.writeFile(path.join(fixture.workspace, "repair.txt"), "stable\n", "utf8");
  await writeOpenClawConfig(fixture.configPath, baseConfig);
  await writeSessionTranscript(fixture.root, "main", "session-repair", [
    {
      type: "message",
      id: "entry-repair",
      timestamp: "2026-03-17T12:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolcall-repair",
            name: "write",
            arguments: {
              file_path: path.join(fixture.workspace, "repair.txt"),
              content: "broken\n"
            }
          }
        ]
      }
    }
  ]);

  await withTempEnv({
    OPENCLAW_CONFIG_PATH: fixture.configPath,
    OPENCLAW_STATE_DIR: fixture.root,
    STEP_ROLLBACK_FAKE_AGENT_CAPTURE: fakeAgentCapturePath
  }, async () => {
    await createNativeStepRollbackPlugin({
      gatewayCommand: fakeOpenclawPath
    }).register(api);

    const cliHarness = createFakeProgram();
    registered.clis[0].factory({ program: cliHarness.program });

    await registered.hooks.get("session_start").handler({
      agentId: "main",
      sessionId: "session-repair",
      runId: "run-repair"
    });
    await registered.hooks.get("before_tool_call").handler({
      agentId: "main",
      sessionId: "session-repair",
      entryId: "entry-repair",
      nodeIndex: 1,
      toolName: "write",
      params: {
        file_path: path.join(fixture.workspace, "repair.txt"),
        content: "broken\n"
      },
      runId: "run-repair"
    });

    const checkpointList = await registered.methods.get("steprollback.checkpoints.list")({
      params: {
        agentId: "main",
        sessionId: "session-repair"
      }
    });

    await cliHarness.commands.get("steprollback continue").action({
      agent: "main",
      session: "session-repair",
      checkpoint: checkpointList.checkpoints[0].checkpointId,
      prompt: "Resume from the repaired checkpoint."
    });

    const repairedConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    const repairedLegacyChild = repairedConfig.agents.list.find((entry) => entry.id === "main-cp-0003");
    const newChild = repairedConfig.agents.list.find((entry) => entry.id === "main-cp-0001");

    assert.ok(repairedLegacyChild);
    assert.equal(repairedLegacyChild.workspace, legacyWorkspace);
    assert.equal("workspaceRoot" in repairedLegacyChild, false);
    assert.equal("cwd" in repairedLegacyChild, false);
    assert.equal("root" in repairedLegacyChild, false);
    assert.equal("models" in repairedLegacyChild, false);
    assert.equal("compaction" in repairedLegacyChild, false);
    assert.equal("maxConcurrent" in repairedLegacyChild, false);
    assert.equal("subagents" in repairedLegacyChild, false);

    assert.ok(newChild);
    assert.equal("workspaceRoot" in newChild, false);
    assert.equal("cwd" in newChild, false);
    assert.equal("root" in newChild, false);
    assert.equal("models" in newChild, false);
    assert.equal("compaction" in newChild, false);
    assert.equal("maxConcurrent" in newChild, false);
    assert.ok(newChild.workspace);

    assert.equal(repairedConfig.agents.defaults.maxConcurrent, 4);
    assert.deepEqual(repairedConfig.agents.defaults.models, {
      "vllm/Intern-S1-Pro": {}
    });

    await waitForFile(fakeAgentCapturePath);
    const capture = JSON.parse(await fs.readFile(fakeAgentCapturePath, "utf8"));
    assert.equal(capture.args.includes("main-cp-0001"), true);
  });
});

test("maps agents.defaults to main and accepts default aliases in CLI and Gateway methods", async () => {
  const fixture = await createFixture();
  const registered = {
    methods: new Map(),
    hooks: new Map(),
    services: [],
    clis: []
  };
  const sessionStoreTemplate = path.join(fixture.root, "agents", "{agentId}", "sessions", "sessions.json");
  const sessionStorePath = sessionStoreTemplate.replace("{agentId}", "main");

  await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
  await fs.writeFile(
    sessionStorePath,
    `${JSON.stringify({
      "agent:main:main": {
        sessionId: "session-defaults",
        updatedAt: "2026-03-17T18:27:25.000Z",
        label: "Defaults-backed session"
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const api = {
    config: {
      agents: {
        defaults: {
          workspace: fixture.workspace,
          model: {
            primary: "vllm/Intern-S1-Pro"
          }
        },
        list: [
          {
            id: "main-cp-0001",
            name: "main-cp-0001",
            workspace: path.join(fixture.root, "forks", "main-cp-0001")
          }
        ]
      },
      session: {
        storePath: sessionStoreTemplate
      },
      plugins: {
        entries: {
          "step-rollback": {
            config: {
              workspaceRoots: [fixture.workspace],
              checkpointDir: fixture.checkpointDir,
              registryDir: fixture.registryDir,
              runtimeDir: fixture.runtimeDir,
              reportsDir: fixture.reportsDir
            }
          }
        }
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    registerGatewayMethod(name, handler) {
      registered.methods.set(name, handler);
    },
    registerHook(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    on(name, handler, options) {
      registered.hooks.set(name, { handler, options });
    },
    registerService(service) {
      registered.services.push(service);
    },
    registerCli(factory, meta) {
      registered.clis.push({ factory, meta });
    }
  };

  await createNativeStepRollbackPlugin().register(api);

  const cliHarness = createFakeProgram();
  registered.clis[0].factory({ program: cliHarness.program });

  const agentsOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback agents").action({});
  });
  assert.match(agentsOutput, /\bmain\b/);
  assert.match(agentsOutput, /\bmain-cp-0001\b/);
  assert.match(agentsOutput, /main-cp-0001\s+main-cp-0001\s+.*\{"primary":"vllm\/Intern-S1-Pro"\}/);
  assert.doesNotMatch(agentsOutput, /\bdefaults\b/);

  const sessionsOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback sessions").action({ agent: "default" });
  });
  assert.match(sessionsOutput, /session-defaults/);

  const rollbackStatus = await registered.methods.get("steprollback.rollback.status")({
    params: {
      agentId: "defaults",
      sessionId: "session-defaults"
    }
  });
  assert.equal(rollbackStatus.agentId, "main");
});
