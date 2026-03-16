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

  await fs.mkdir(workspace, { recursive: true });

  return {
    root,
    workspace,
    checkpointDir: path.join(pluginRoot, "checkpoints"),
    registryDir: path.join(pluginRoot, "registry"),
    runtimeDir: path.join(pluginRoot, "runtime"),
    reportsDir: path.join(pluginRoot, "reports")
  };
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

function createFakeProgram() {
  const commands = new Map();

  function createCommand(pathParts) {
    const record = {
      path: pathParts.join(" "),
      action: null
    };

    if (record.path) {
      commands.set(record.path, record);
    }

    return {
      command(name) {
        return createCommand([...pathParts, name]);
      },
      description() {
        return this;
      },
      option() {
        return this;
      },
      requiredOption() {
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

test("creates checkpoints, rolls back workspace state, and continues from the checkpoint", async () => {
  const fixture = await createFixture();
  const calls = {
    stopRun: [],
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
      async stopRun(input) {
        calls.stopRun.push(input);
        return { stopped: true };
      },
      async createSession(input) {
        calls.createSession.push(input);
        return {
          sessionId: "session-branch-1",
          sessionKey: "agent:main:direct:step-rollback-br_0001"
        };
      },
      async startContinueRun(input) {
        calls.continueRun.push(input);
        return {
          runId: `continued:${input.sessionId}:${input.entryId}`,
          sessionId: input.sessionId,
          sessionKey: input.sessionKey
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
  assert.equal(rollbackResponse.awaitingContinue, true);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "app.txt"), "utf8"), "v1\n");
  assert.equal(calls.stopRun.length, 1);

  const rollbackStatus = await plugin.methods["steprollback.rollback.status"]({
    agentId: "main",
    sessionId: "session-1"
  });

  assert.equal(rollbackStatus.awaitingContinue, true);
  assert.equal(rollbackStatus.activeHeadEntryId, "entry-1");

  const continueResponse = await plugin.methods["steprollback.continue"]({
    agentId: "main",
    sessionId: "session-1",
    prompt: "Retry, but inspect dependencies first."
  });

  assert.equal(continueResponse.continued, true);
  assert.equal(continueResponse.usedPrompt, true);
  assert.equal(continueResponse.newSessionId, "session-branch-1");
  assert.equal(continueResponse.newSessionKey, "agent:main:direct:step-rollback-br_0001");
  assert.equal(calls.createSession.length, 1);
  assert.equal(calls.continueRun.length, 1);
  assert.equal(calls.continueRun[0].entryId, "entry-1");
  assert.equal(calls.continueRun[0].sessionId, "session-branch-1");
  assert.equal(calls.continueRun[0].sessionKey, "agent:main:direct:step-rollback-br_0001");

  const report = await plugin.methods["steprollback.reports.get"]({
    rollbackId: rollbackResponse.rollbackId
  });

  assert.equal(report.result, "success");
  assert.match(report.message, /waiting for continue/);

  const finalState = await plugin.services.runtimeCursorManager.get("main", "session-1");
  assert.equal(finalState.awaitingContinue, false);
  assert.equal(finalState.currentRunId, null);
  assert.equal(finalState.lastContinueSessionId, "session-branch-1");

  const branchedState = await plugin.services.runtimeCursorManager.get("main", "session-branch-1");
  assert.equal(branchedState.currentRunId, "continued:session-branch-1:entry-1");

  const branch = await plugin.methods["steprollback.session.branch.get"]({
    branchId: continueResponse.branchId
  });
  assert.equal(branch.sourceSessionId, "session-1");
  assert.equal(branch.newSessionId, "session-branch-1");
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
      checkpointId
    }
  });

  assert.equal(rollbackResponse.result, "success");
  assert.equal(await fs.readFile(path.join(fixture.workspace, "native.txt"), "utf8"), "safe\n");
  assert.equal(
    gatewayCalls.some((call) => call.method === "agent" && call.params.message === "/stop"),
    true
  );

  const continueResponse = await registered.methods.get("steprollback.continue")({
    params: {
      agentId: "main",
      sessionId: "native-session"
    }
  });

  assert.equal(continueResponse.continued, true);
  assert.equal(continueResponse.newSessionId, "native-session-branch");
  assert.match(continueResponse.newSessionKey, /^agent:main:direct:step-rollback-br_0001$/);
  assert.equal(
    subagentCalls.some(
      (call) =>
        call.sessionKey === continueResponse.newSessionKey &&
        call.message === "Continue from the restored checkpoint." &&
        call.deliver === false
    ),
    true
  );
  assert.equal(logs.some((entry) => entry.message.includes("registered native OpenClaw plugin surfaces")), true);
  assert.equal(logs.some((entry) => entry.message.includes("resolved config")), false);
  assert.equal(logs.some((entry) => entry.message.includes("resolved tool checkpoint context")), true);
  assert.equal(logs.some((entry) => entry.message.includes("git workspace status")), true);
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
      async startContinueRun({ sessionId, entryId }) {
        return { started: true, runId: `run:${sessionId}:${entryId}` };
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
      checkpoint: checkpointId
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
        call.params.checkpointId === checkpointId
    ),
    false
  );

  const continueOutput = await captureConsoleLog(async () => {
    await cliHarness.commands.get("steprollback continue").action({
      agent: "main",
      session: "session-cli",
      prompt: "Inspect first."
    });
  });
  assert.match(continueOutput, /continued/);
  assert.match(continueOutput, /usedPrompt/);
  assert.match(continueOutput, /session-checkout-cli/);
  assert.equal(
    cliGatewayCalls.some(
      (call) =>
        call.methodName === "steprollback.continue" &&
        call.params.agentId === "main" &&
        call.params.sessionId === "session-cli" &&
        call.params.prompt === "Inspect first."
    ),
    false
  );
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
  const fakeAgentCapturePath = path.join(fixture.root, "agent-capture.json");
  const fakeOpenclawPath = path.join(fixture.root, "fake-openclaw-agent");
  const sessionStoreTemplate = path.join(fixture.root, "agents", "{agentId}", "sessions", "sessions.json");

  await fs.writeFile(
    fakeOpenclawPath,
    `#!/usr/bin/env node
const fs = require("node:fs/promises");

(async () => {
  const args = process.argv.slice(2);
  await fs.writeFile(process.env.STEP_ROLLBACK_FAKE_AGENT_CAPTURE, JSON.stringify({ args }, null, 2));
  process.stdout.write(JSON.stringify({
    sessionId: "branch-from-agent",
    sessionKey: "agent:main:direct:branch-from-agent",
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
    }
  };

  await fs.writeFile(path.join(fixture.workspace, "continue.txt"), "stable\n", "utf8");

  await createNativeStepRollbackPlugin({
    gatewayCommand: fakeOpenclawPath
  }).register(api);

  const cliHarness = createFakeProgram();
  registered.clis[0].factory({ program: cliHarness.program });

  await registered.hooks.get("session_start").handler({
    agentId: "main",
    sessionId: "session-continue-cli",
    runId: "run-continue-cli"
  });
  await registered.hooks.get("before_tool_call").handler({
    agentId: "main",
    sessionId: "session-continue-cli",
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
      sessionId: "session-continue-cli"
    }
  });
  const checkpointId = checkpointList.checkpoints[0].checkpointId;

  await registered.methods.get("steprollback.rollback")({
    params: {
      agentId: "main",
      sessionId: "session-continue-cli",
      checkpointId
    }
  });

  const output = await withTempEnv({
    STEP_ROLLBACK_FAKE_AGENT_CAPTURE: fakeAgentCapturePath
  }, async () =>
    captureConsoleLog(async () => {
      await cliHarness.commands.get("steprollback continue").action({
        agent: "main",
        session: "session-continue-cli",
        prompt: "Check docs, but do not delete files."
      });
    })
  );

  assert.match(output, /continued/);
  assert.match(output, /branch-from-agent/);
  assert.equal(await fs.readFile(path.join(fixture.workspace, "continue.txt"), "utf8"), "stable\n");

  const capture = JSON.parse(await fs.readFile(fakeAgentCapturePath, "utf8"));
  assert.equal(capture.args[0], "agent");
  assert.equal(capture.args.includes("--agent"), true);
  assert.equal(capture.args.includes("main"), true);
  assert.equal(capture.args.includes("--message"), true);
  assert.equal(capture.args.includes("Check docs, but do not delete files."), true);
  assert.equal(capture.args.includes("--json"), true);
  assert.equal(capture.args.includes("gateway"), false);
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
