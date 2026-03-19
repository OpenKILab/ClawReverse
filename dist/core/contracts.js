export const defaultConfig = {
  enabled: true,
  workspaceRoots: ["~/.openclaw/workspace"],
  checkpointDir: "~/.openclaw/plugins/clawreverse/checkpoints",
  registryDir: "~/.openclaw/plugins/clawreverse/registry",
  runtimeDir: "~/.openclaw/plugins/clawreverse/runtime",
  reportsDir: "~/.openclaw/plugins/clawreverse/reports",
  maxCheckpointsPerSession: 100,
  allowContinuePrompt: true,
  stopRunBeforeRollback: true
};

export const CONFIG_DIRECTORY_KEYS = [
  "checkpointDir",
  "registryDir",
  "runtimeDir",
  "reportsDir"
];

export const manifest = {
  id: "clawreverse",
  name: "ClawReverse",
  version: "0.1.0",
  description: "Checkpoint, rollback, and branch continuation plugin for OpenClaw.",
  runtime: {
    entry: "./dist/index.js"
  },
  configSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: defaultConfig.enabled },
      workspaceRoots: {
        type: "array",
        items: { type: "string" },
        default: defaultConfig.workspaceRoots
      },
      checkpointDir: {
        type: "string",
        default: defaultConfig.checkpointDir
      },
      registryDir: {
        type: "string",
        default: defaultConfig.registryDir
      },
      runtimeDir: {
        type: "string",
        default: defaultConfig.runtimeDir
      },
      reportsDir: {
        type: "string",
        default: defaultConfig.reportsDir
      },
      maxCheckpointsPerSession: {
        type: "number",
        default: defaultConfig.maxCheckpointsPerSession
      },
      allowContinuePrompt: {
        type: "boolean",
        default: defaultConfig.allowContinuePrompt
      },
      stopRunBeforeRollback: {
        type: "boolean",
        default: defaultConfig.stopRunBeforeRollback
      }
    },
    additionalProperties: false
  }
};

export const METHOD_NAMES = {
  status: "clawreverse.status",
  checkpointsList: "clawreverse.checkpoints.list",
  checkpointsGet: "clawreverse.checkpoints.get",
  rollback: "clawreverse.rollback",
  continue: "clawreverse.continue",
  rollbackStatus: "clawreverse.rollback.status",
  reportsGet: "clawreverse.reports.get",
  sessionNodesList: "clawreverse.session.nodes.list",
  sessionTree: "clawreverse.session.tree",
  sessionCheckout: "clawreverse.session.checkout",
  sessionBranchGet: "clawreverse.session.branch.get"
};

export const GATEWAY_METHOD_NAMES = Object.values(METHOD_NAMES);

export const HOOK_BINDINGS = [
  { hookName: "session_start", handlerName: "sessionStart", kind: "session" },
  { hookName: "session_end", handlerName: "sessionEnd", kind: "session" },
  { hookName: "before_tool_call", handlerName: "beforeToolCall", kind: "tool" },
  { hookName: "after_tool_call", handlerName: "afterToolCall", kind: "tool" }
];
