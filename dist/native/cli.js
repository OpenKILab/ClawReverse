import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { StepRollbackError, toStepRollbackError } from "../core/errors.js";
import { resolveAbsolutePath } from "../core/utils.js";
import { manifest } from "../plugin.js";
import { annotateBranchSessionRecord, buildBranchSessionLabel, extractAgentRunMetadata, findContinuationSessionRecord, getConfiguredAgents, listSessionsForAgent, normalizeAgentIdInput, normalizeExternalParams, readSessionIndexState, resolveSessionRecordEventually } from "./sessions.js";
import { callGatewayMethod, parseJsonOutput, pickNonEmptyString, unwrapRpcResult } from "./shared.js";

const execFileAsync = promisify(execFile);
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_YELLOW = "\u001b[33m";

function formatValue(value) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function resolveGatewayCliConnectionOptions(api, options = {}) {
  const remoteUrl = pickNonEmptyString(options.url, api?.config?.gateway?.remote?.url);
  const authMode = pickNonEmptyString(api?.config?.gateway?.auth?.mode).toLowerCase();
  const useRemoteAuth = Boolean(remoteUrl);
  let token = pickNonEmptyString(
    options.token,
    useRemoteAuth ? api?.config?.gateway?.remote?.token : api?.config?.gateway?.auth?.token,
    process.env.OPENCLAW_GATEWAY_TOKEN
  );
  let password = pickNonEmptyString(
    options.password,
    useRemoteAuth ? api?.config?.gateway?.remote?.password : api?.config?.gateway?.auth?.password,
    process.env.OPENCLAW_GATEWAY_PASSWORD
  );

  if (authMode === "password" && password) {
    token = "";
  } else if (authMode === "token" && token) {
    password = "";
  }

  return {
    url: remoteUrl || undefined,
    token: token || undefined,
    password: password || undefined
  };
}

function isGatewayConnectionFailureMessage(message) {
  return /gateway closed|ECONN|ENOTFOUND|EAI_AGAIN|timed out|timeout|refused|reset by peer|socket hang up|unauthorized|401|403|no close reason/i.test(message);
}

function buildGatewayCliFailureMessage(methodName, error) {
  const normalized = toStepRollbackError(error);
  const baseMessage = normalized.message;

  if (isGatewayConnectionFailureMessage(baseMessage)) {
    return `Command '${methodName}' could not reach the OpenClaw Gateway. Verify the Gateway is running and that the CLI can authenticate with the configured token/password. ${baseMessage}`;
  }

  return `Command '${methodName}' failed through the OpenClaw Gateway. ${baseMessage}`;
}

function buildExecFailureMessage(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
  return stderr || stdout || (error instanceof Error ? error.message : String(error));
}

async function runCliCommand(command, args, cwd) {
  return execFileAsync(command, args, {
    cwd,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
}

function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}

function visibleWidth(value) {
  return stripAnsi(formatValue(value)).length;
}

function padVisibleValue(value, width) {
  const text = formatValue(value);
  return `${text}${" ".repeat(Math.max(0, width - stripAnsi(text).length))}`;
}

function supportsAnsiColor() {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }

  return Boolean(process.stdout?.isTTY);
}

function colorize(value, ...codes) {
  const text = String(value ?? "");

  if (!text || !supportsAnsiColor() || !codes.length) {
    return text;
  }

  return `${codes.join("")}${text}${ANSI_RESET}`;
}

function highlightSessionRow(row) {
  if (!supportsAnsiColor()) {
    return row;
  }

  const isLatest = row?.marker === "latest";

  return {
    ...row,
    marker: isLatest ? colorize(row.marker, ANSI_BOLD, ANSI_GREEN) : row.marker,
    sessionId: colorize(row.sessionId, isLatest ? ANSI_BOLD : ANSI_DIM, ANSI_CYAN),
    title: isLatest ? colorize(row.title, ANSI_BOLD) : row.title
  };
}

function highlightCheckpointRow(row) {
  if (!supportsAnsiColor()) {
    return row;
  }

  const statusColors = {
    ready: [ANSI_CYAN],
    restored: [ANSI_BOLD, ANSI_GREEN],
    restoring: [ANSI_YELLOW],
    failed: [ANSI_BOLD, ANSI_YELLOW]
  };
  const codes = statusColors[row?.status];

  if (!codes) {
    return row;
  }

  return {
    ...row,
    status: colorize(row.status, ...codes)
  };
}

function renderTable(rows, columns) {
  const widths = columns.map((column) => {
    const headerWidth = column.label.length;
    const valueWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row[column.key])), 0);
    return Math.max(headerWidth, valueWidth);
  });

  const header = columns
    .map((column, index) => column.label.padEnd(widths[index], " "))
    .join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const lines = rows.map((row) =>
    columns
      .map((column, index) => padVisibleValue(row[column.key], widths[index]))
      .join("  ")
  );

  return [header, divider, ...lines].join("\n");
}

function printRows(rows, columns, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (!rows.length) {
    console.log(options.emptyMessage ?? "No records found.");
    return;
  }

  const printableRows = typeof options.transformRow === "function"
    ? rows.map((row, index) => options.transformRow(row, index, rows))
    : rows;

  console.log(renderTable(printableRows, columns));
}

function printObject(value, options = {}) {
  if (options.json || !value || typeof value !== "object" || Array.isArray(value)) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  const rows = Object.entries(value).map(([key, entryValue]) => ({
    field: key,
    value: formatValue(entryValue)
  }));
  console.log(renderTable(rows, [
    { key: "field", label: "Field" },
    { key: "value", label: "Value" }
  ]));
}

async function invokeGatewayViaCli(methodName, params, options = {}) {
  const command = options.openclawCommand ?? options.gatewayCommand ?? process.env.OPENCLAW_BIN ?? "openclaw";
  const cwd = resolveAbsolutePath("~", options.cliCwd);
  const connection = resolveGatewayCliConnectionOptions(options.api, options);
  const args = [
    "gateway",
    "call",
    methodName,
    "--json",
    "--params",
    JSON.stringify(params ?? {})
  ];

  if (connection.url) {
    args.push("--url", connection.url);
  }

  if (connection.token) {
    args.push("--token", connection.token);
  }

  if (connection.password) {
    args.push("--password", connection.password);
  }

  if (options.expectFinal) {
    args.push("--expect-final");
  }

  try {
    const result = await runCliCommand(command, args, cwd);
    return unwrapRpcResult(parseJsonOutput(result.stdout));
  } catch (error) {
    throw new StepRollbackError(
      "GATEWAY_CALL_FAILED",
      `Failed to call Gateway method '${methodName}' from the CLI. ${buildExecFailureMessage(error)}`,
      { methodName, params }
    );
  }
}

export async function invokeAgentViaCli(api, logger, options = {}) {
  const command = options.openclawCommand ?? options.agentCommand ?? options.gatewayCommand ?? process.env.OPENCLAW_BIN ?? "openclaw";
  const cwd = resolveAbsolutePath("~", options.cliCwd);
  const agentId = normalizeAgentIdInput(api, options.agentId);
  const sourceSessionId = pickNonEmptyString(options.sourceSessionId);
  const branchLabel = pickNonEmptyString(options.label) || buildBranchSessionLabel(sourceSessionId || agentId, options.branchId ?? "continue");
  const message = pickNonEmptyString(options.prompt) || "Continue from the restored checkpoint.";
  const beforeState = await readSessionIndexState(api, agentId);
  const startedAtMs = Date.now();
  const args = [
    "agent",
    "--agent",
    agentId,
    "--message",
    message,
    "--json"
  ];

  logger.info?.(
    `[${manifest.id}] continuing with 'openclaw agent' agent='${agentId}' sourceSession='${sourceSessionId || "-"}'`
  );

  try {
    const result = await runCliCommand(command, args, cwd);
    const extracted = extractAgentRunMetadata(parseJsonOutput(result.stdout, "CONTINUE_START_FAILED"));
    const resolvedSession = extracted.sessionId || extracted.sessionKey
      ? await resolveSessionRecordEventually(api, agentId, {
        sessionId: extracted.sessionId,
        sessionKey: extracted.sessionKey
      }, {
        attempts: 10,
        delayMs: 100
      })
      : await findContinuationSessionRecord(api, agentId, beforeState.records, {
        excludeSessionId: sourceSessionId,
        startedAtMs
      });
    const sessionId = resolvedSession?.sessionId ?? extracted.sessionId ?? null;
    const sessionKey = resolvedSession?.sessionKey ?? extracted.sessionKey ?? null;

    await annotateBranchSessionRecord(api, agentId, {
      sessionId,
      sessionKey
    }, {
      sourceSessionId,
      label: branchLabel
    }, logger);

    logger.info?.(
      `[${manifest.id}] continue launched via 'openclaw agent' newSession='${sessionId || "-"}' sessionKey='${sessionKey || "-"}'`
    );

    return {
      started: true,
      runId: extracted.runId ?? null,
      sessionId,
      sessionKey,
      label: branchLabel,
      via: "openclaw-agent-cli",
      raw: extracted.raw
    };
  } catch (error) {
    throw new StepRollbackError(
      "CONTINUE_START_FAILED",
      `Failed to continue with 'openclaw agent'. ${buildExecFailureMessage(error)}`,
      {
        agentId,
        sourceSessionId,
        args
      }
    );
  }
}

export function createCliMethodInvoker(api, engine, logger, options = {}) {
  const externalGatewayInvoker = typeof options.cliGatewayInvoker === "function"
    ? options.cliGatewayInvoker
    : null;
  const gatewayCaller = typeof options.callGatewayMethod === "function"
    ? options.callGatewayMethod
    : callGatewayMethod;

  return async (methodName, params, behavior = {}) => {
    const normalizedParams = normalizeExternalParams(api, params);
    const {
      preferGateway = true,
      fallbackToLocal = false,
      expectFinal = false
    } = behavior;

    if (preferGateway) {
      const gatewayErrors = [];

      try {
        const rpcResult = await gatewayCaller(api, methodName, normalizedParams);

        if (rpcResult !== undefined) {
          logger.debug?.(`[${manifest.id}] CLI delegated '${methodName}' through an exposed Gateway caller`);
          return unwrapRpcResult(rpcResult);
        }
      } catch (error) {
        gatewayErrors.push(error);
        logger.warn?.(
          `[${manifest.id}] Exposed Gateway caller failed for '${methodName}': ${toStepRollbackError(error).message}`
        );
      }

      if (externalGatewayInvoker) {
        try {
          logger.debug?.(`[${manifest.id}] CLI delegated '${methodName}' through the configured Gateway invoker`);
          return await externalGatewayInvoker(methodName, normalizedParams, { expectFinal });
        } catch (error) {
          gatewayErrors.push(error);
          logger.warn?.(
            `[${manifest.id}] Configured Gateway invoker failed for '${methodName}': ${toStepRollbackError(error).message}`
          );
        }
      }

      try {
        logger.debug?.(`[${manifest.id}] CLI delegated '${methodName}' through 'openclaw gateway call'`);
        return await invokeGatewayViaCli(methodName, normalizedParams, {
          api,
          expectFinal,
          gatewayCommand: options.gatewayCommand,
          openclawCommand: options.openclawCommand,
          cliCwd: options.cliCwd
        });
      } catch (error) {
        gatewayErrors.push(error);

        if (!fallbackToLocal) {
          throw new StepRollbackError(
            "GATEWAY_CALL_FAILED",
            buildGatewayCliFailureMessage(methodName, gatewayErrors[gatewayErrors.length - 1]),
            { methodName, params: normalizedParams }
          );
        }

        logger.warn?.(
          `[${manifest.id}] CLI Gateway delegation for '${methodName}' failed, falling back to local engine: ${toStepRollbackError(gatewayErrors[gatewayErrors.length - 1]).message}`
        );
      }
    }

    const localMethod = engine?.methods?.[methodName];

    if (typeof localMethod !== "function") {
      throw new StepRollbackError(
        "GATEWAY_CALL_FAILED",
        `Step Rollback could not resolve a handler for '${methodName}'.`,
        { methodName, params: normalizedParams }
      );
    }

    return localMethod(normalizedParams);
  };
}

export function registerCli(api, engine, cliMethodInvoker) {
  if (typeof api?.registerCli !== "function") {
    return;
  }

  const readBehavior = {
    preferGateway: true,
    fallbackToLocal: true
  };
  const mutateBehavior = {
    preferGateway: false,
    fallbackToLocal: true
  };

  api.registerCli(
    ({ program }) => {
      const command = program.command("steprollback").description("Inspect the Step Rollback native plugin.");

      command.command("status").action(async () => {
        const result = await engine.status();
        console.log(JSON.stringify(result, null, 2));
      });

      command
        .command("agents")
        .description("List configured OpenClaw agents.")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const agents = getConfiguredAgents(api);
          printRows(
            agents,
            [
              { key: "id", label: "Agent" },
              { key: "name", label: "Name" },
              { key: "workspace", label: "Workspace" },
              { key: "model", label: "Model" }
            ],
            {
              json: options.json,
              emptyMessage: "No agents were found in the OpenClaw config."
            }
          );
        });

      command
        .command("sessions")
        .description("List sessions for an agent without passing JSON.")
        .requiredOption("--agent <agentId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const sessions = await listSessionsForAgent(api, options.agent);
          printRows(
            sessions,
            [
              { key: "marker", label: "Mark" },
              { key: "sessionId", label: "Session" },
              { key: "title", label: "Title" },
              { key: "updatedAt", label: "Updated" },
              { key: "createdAt", label: "Created" },
              { key: "branchOf", label: "Branch Of" }
            ],
            {
              json: options.json,
              transformRow: highlightSessionRow,
              emptyMessage: `No sessions were found for agent '${options.agent}'.`
            }
          );
        });

      command
        .command("checkpoints")
        .description("List checkpoints for a session.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.checkpoints.list", {
            agentId: options.agent,
            sessionId: options.session
          }, readBehavior);
          printRows(
            result.checkpoints,
            [
              { key: "checkpointId", label: "Checkpoint" },
              { key: "nodeIndex", label: "Node" },
              { key: "toolName", label: "Tool" },
              { key: "status", label: "Status" },
              { key: "createdAt", label: "Created" },
              { key: "summary", label: "Summary" }
            ],
            {
              json: options.json,
              transformRow: highlightCheckpointRow,
              emptyMessage: `No checkpoints were found for session '${options.session}'.`
            }
          );
        });

      command
        .command("checkpoint")
        .description("Show one checkpoint by id.")
        .requiredOption("--checkpoint <checkpointId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.checkpoints.get", {
            checkpointId: options.checkpoint
          }, readBehavior);
          printObject(result.checkpoint, options);
        });

      command
        .command("rollback-status")
        .description("Show rollback state for a session.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.rollback.status", {
            agentId: options.agent,
            sessionId: options.session
          }, readBehavior);
          printObject(result, options);
        });

      command
        .command("rollback")
        .description("Rollback a session to a checkpoint.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .requiredOption("--checkpoint <checkpointId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.rollback", {
            agentId: options.agent,
            sessionId: options.session,
            checkpointId: options.checkpoint
          }, mutateBehavior);
          printObject(result, options);
        });

      command
        .command("continue")
        .description("Continue a rolled back session, with an optional prompt.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .option("--prompt <text>", "Optional continuation prompt.")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.continue", {
            agentId: options.agent,
            sessionId: options.session,
            prompt: options.prompt
          }, mutateBehavior);
          printObject(result, options);
        });

      command
        .command("nodes")
        .description("List checkpoint-backed nodes for checkout.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--session <sessionId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.session.nodes.list", {
            agentId: options.agent,
            sessionId: options.session
          }, readBehavior);
          printRows(
            result.nodes,
            [
              { key: "entryId", label: "Entry" },
              { key: "nodeIndex", label: "Node" },
              { key: "toolName", label: "Tool" },
              { key: "checkoutAvailable", label: "Checkout" },
              { key: "createdAt", label: "Created" }
            ],
            {
              json: options.json,
              emptyMessage: `No checkpoint-backed nodes were found for session '${options.session}'.`
            }
          );
        });

      command
        .command("checkout")
        .description("Create a new session from a checkpoint-backed entry.")
        .requiredOption("--agent <agentId>")
        .requiredOption("--source-session <sessionId>")
        .requiredOption("--entry <entryId>")
        .option("--continue", "Continue immediately after checkout.")
        .option("--prompt <text>", "Optional prompt used when continuing after checkout.")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.session.checkout", {
            agentId: options.agent,
            sourceSessionId: options.sourceSession,
            sourceEntryId: options.entry,
            continueAfterCheckout: Boolean(options.continue),
            prompt: options.prompt
          }, options.continue ? mutateBehavior : readBehavior);
          printObject(result, options);
        });

      command
        .command("report")
        .description("Show a rollback report.")
        .requiredOption("--rollback <rollbackId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.reports.get", {
            rollbackId: options.rollback
          }, readBehavior);
          printObject(result, options);
        });

      command
        .command("branch")
        .description("Show a checkout branch record.")
        .requiredOption("--branch <branchId>")
        .option("--json", "Output raw JSON.")
        .action(async (options) => {
          const result = await cliMethodInvoker("steprollback.session.branch.get", {
            branchId: options.branch
          }, readBehavior);
          printObject(result, options);
        });
    },
    { commands: ["steprollback"] }
  );
}
