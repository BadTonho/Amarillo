"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_CODEX_MCP_SERVER_NAME = "amarillo";
const DEFAULT_CODEX_MCP_TIMEOUT_MS = 3000;
const CODEX_MCP_BOOTSTRAP_RELATIVE_PATH = path.join(".vscode", "amarillo-mcp-bootstrap.cjs");
const CODEX_MCP_RESTART_HINT = "Restart or reopen the Codex session so the MCP tools are loaded.";

function quoteCliArg(value) {
  return `"${String(value).replace(/`/g, "``").replace(/"/g, "`\"")}"`;
}

function resolveCodexMcpPaths(workspaceRoot) {
  const workspacePath = path.resolve(workspaceRoot);
  return {
    workspacePath,
    bootstrapPath: path.join(workspacePath, CODEX_MCP_BOOTSTRAP_RELATIVE_PATH)
  };
}

function buildCodexMcpAddArgs(workspaceRoot, options: any = {}) {
  const serverName = options.serverName || DEFAULT_CODEX_MCP_SERVER_NAME;
  const { workspacePath, bootstrapPath } = resolveCodexMcpPaths(workspaceRoot);
  return ["mcp", "add", serverName, "--", "node", bootstrapPath, "--workspace", workspacePath];
}

function buildCodexMcpRemoveArgs(options: any = {}) {
  const serverName = options.serverName || DEFAULT_CODEX_MCP_SERVER_NAME;
  return ["mcp", "remove", serverName];
}

function buildCodexMcpAddCommand(workspaceRoot, options: any = {}) {
  const serverName = options.serverName || DEFAULT_CODEX_MCP_SERVER_NAME;
  const { workspacePath, bootstrapPath } = resolveCodexMcpPaths(workspaceRoot);
  return `codex mcp add ${serverName} -- node ${quoteCliArg(bootstrapPath)} --workspace ${quoteCliArg(workspacePath)}`;
}

function codexMcpListContainsServer(output, serverName = DEFAULT_CODEX_MCP_SERVER_NAME) {
  const escapedServerName = String(serverName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const serverPattern = new RegExp(`(^|\\s)${escapedServerName}(\\s|$)`, "i");
  return String(output || "")
    .split(/\r?\n/)
    .some((line) => serverPattern.test(line.trim()));
}

function defaultRunCommand(command, args, options: any = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_CODEX_MCP_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      windowsHide: true
    });
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill();
      } catch (_error) {
        // Best-effort cleanup after timeout.
      }
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut: false
      });
    });
  });
}

function commandOutput(result) {
  return `${String(result?.stdout || "")}\n${String(result?.stderr || "")}`.trim();
}

function comparablePath(value) {
  return path.normalize(String(value || "")).replace(/\\/g, "/").toLowerCase();
}

function isAbsoluteFilePath(value) {
  const rawValue = String(value || "");
  return path.isAbsolute(rawValue) || /^[A-Za-z]:[\\/]/.test(rawValue);
}

function collectStringValues(value, results = []) {
  if (typeof value === "string") {
    results.push(value);
    return results;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, results);
    }
    return results;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStringValues(item, results);
    }
  }
  return results;
}

function collectArgsArrays(value, results = []) {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      results.push(value);
    }
    for (const item of value) {
      collectArgsArrays(item, results);
    }
    return results;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "args" && Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
        results.push(item);
      }
      collectArgsArrays(item, results);
    }
  }
  return results;
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(String(output || ""));
  } catch (_error) {
    return null;
  }
}

function resolvesToPath(workspaceRoot, value, targetPath) {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const candidate = isAbsoluteFilePath(value)
    ? value
    : path.resolve(workspaceRoot, value);
  return comparablePath(candidate) === comparablePath(targetPath);
}

function codexMcpConfigMatchesWorkspace(output, workspaceRoot) {
  const parsed = parseJsonOutput(output);
  if (!parsed) {
    return false;
  }
  const { workspacePath, bootstrapPath } = resolveCodexMcpPaths(workspaceRoot);
  const strings = collectStringValues(parsed);
  const hasBootstrap = strings.some((value) => resolvesToPath(workspacePath, value, bootstrapPath));
  const argsArrays = collectArgsArrays(parsed);
  const hasWorkspaceArg = argsArrays.some((args) => {
    const index = args.indexOf("--workspace");
    return index >= 0 && resolvesToPath(workspacePath, args[index + 1], workspacePath);
  });
  const hasWorkspaceValue = strings.some((value) => resolvesToPath(workspacePath, value, workspacePath));
  return hasBootstrap && (hasWorkspaceArg || hasWorkspaceValue);
}

function codexMcpConfigAppearsDifferentWorkspace(output, workspaceRoot) {
  const parsed = parseJsonOutput(output);
  if (!parsed) {
    return false;
  }
  const { workspacePath, bootstrapPath } = resolveCodexMcpPaths(workspaceRoot);
  const strings = collectStringValues(parsed);
  const hasOtherAbsoluteBootstrap = strings.some((value) => (
    typeof value === "string"
    && /amarillo-mcp-bootstrap\.cjs$/i.test(value.replace(/\\/g, "/"))
    && isAbsoluteFilePath(value)
    && comparablePath(value) !== comparablePath(bootstrapPath)
  ));
  const hasOtherAbsoluteWorkspaceArg = collectArgsArrays(parsed).some((args) => {
    const index = args.indexOf("--workspace");
    const workspaceArg = index >= 0 ? args[index + 1] : "";
    return isAbsoluteFilePath(workspaceArg) && comparablePath(workspaceArg) !== comparablePath(workspacePath);
  });
  return hasOtherAbsoluteBootstrap || hasOtherAbsoluteWorkspaceArg;
}

async function inspectCodexMcpRegistration(workspaceRoot, options: any = {}) {
  const serverName = options.serverName || DEFAULT_CODEX_MCP_SERVER_NAME;
  const runCommand = options.runCommand || defaultRunCommand;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_CODEX_MCP_TIMEOUT_MS);
  const suggestedCommand = buildCodexMcpAddCommand(workspaceRoot, { serverName });

  let result;
  try {
    result = await runCommand("codex", ["mcp", "list"], {
      cwd: workspaceRoot,
      timeoutMs
    });
  } catch (error) {
    const errorCode = error && typeof error.code === "string" ? error.code : "";
    if (errorCode === "ENOENT") {
      return {
        status: "unavailable",
        serverName,
        suggestedCommand,
        restartRequired: false,
        message: "Codex CLI was not found on PATH, so Amarillo could not verify native MCP registration."
      };
    }
    return {
      status: "error",
      serverName,
      suggestedCommand,
      restartRequired: false,
      message: `Codex MCP check failed: ${error?.message || String(error)}`
    };
  }

  const combinedOutput = commandOutput(result);
  if (result?.timedOut) {
    return {
      status: "timeout",
      serverName,
      suggestedCommand,
      restartRequired: false,
      message: `Codex MCP check timed out after ${timeoutMs}ms.`
    };
  }
  if (result?.exitCode !== 0) {
    return {
      status: "error",
      serverName,
      suggestedCommand,
      restartRequired: false,
      message: `Codex MCP check exited with code ${result?.exitCode}: ${combinedOutput || "no output"}`
    };
  }
  if (codexMcpListContainsServer(combinedOutput, serverName)) {
    try {
      const getResult = await runCommand("codex", ["mcp", "get", serverName, "--json"], {
        cwd: workspaceRoot,
        timeoutMs
      });
      const getOutput = commandOutput(getResult);
      if (!getResult?.timedOut && getResult?.exitCode === 0) {
        if (codexMcpConfigMatchesWorkspace(getOutput, workspaceRoot)) {
          return {
            status: "configured",
            serverName,
            suggestedCommand,
            restartRequired: false,
            message: `Codex CLI has an MCP server named '${serverName}' configured for this workspace.`
          };
        }
        if (codexMcpConfigAppearsDifferentWorkspace(getOutput, workspaceRoot)) {
          return {
            status: "needs_update",
            serverName,
            suggestedCommand,
            restartRequired: false,
            message: `Codex CLI already has an MCP server named '${serverName}', but it appears to point to another workspace.`
          };
        }
      }
    } catch (_error) {
      // A listed server is still usable even if this Codex version cannot inspect it as JSON.
    }
    return {
      status: "configured",
      serverName,
      suggestedCommand,
      restartRequired: false,
      message: `Codex CLI has an MCP server named '${serverName}' configured.`
    };
  }

  return {
    status: "not_configured",
    serverName,
    suggestedCommand,
    restartRequired: false,
    message: `Codex CLI is available, but no MCP server named '${serverName}' was found.`
  };
}

function failedCommandResult(status, serverName, suggestedCommand, action, result) {
  const output = commandOutput(result);
  if (result?.timedOut) {
    return {
      status,
      serverName,
      suggestedCommand,
      restartRequired: false,
      message: `Codex MCP ${action} timed out. Use the manual command instead: ${suggestedCommand}`
    };
  }
  return {
    status,
    serverName,
    suggestedCommand,
    restartRequired: false,
    message: `Codex MCP ${action} failed with code ${result?.exitCode}: ${output || "no output"}. Manual command: ${suggestedCommand}`
  };
}

async function runCodexMcpAdd(workspaceRoot, options: any = {}) {
  const serverName = options.serverName || DEFAULT_CODEX_MCP_SERVER_NAME;
  const runCommand = options.runCommand || defaultRunCommand;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_CODEX_MCP_TIMEOUT_MS);
  return runCommand("codex", buildCodexMcpAddArgs(workspaceRoot, { serverName }), {
    cwd: workspaceRoot,
    timeoutMs
  });
}

async function ensureCodexMcpRegistration(workspaceRoot, options: any = {}) {
  const serverName = options.serverName || DEFAULT_CODEX_MCP_SERVER_NAME;
  const runCommand = options.runCommand || defaultRunCommand;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_CODEX_MCP_TIMEOUT_MS);
  const suggestedCommand = buildCodexMcpAddCommand(workspaceRoot, { serverName });
  const inspectOptions = { serverName, runCommand, timeoutMs };
  const current = await inspectCodexMcpRegistration(workspaceRoot, inspectOptions);

  if (current.status === "configured") {
    return current;
  }

  if (current.status === "needs_update") {
    const confirmUpdate = typeof options.confirmUpdate === "function"
      ? await options.confirmUpdate(current)
      : false;
    if (!confirmUpdate) {
      return {
        ...current,
        status: "update_declined",
        restartRequired: false,
        message: `Codex MCP server '${serverName}' was not changed. Manual command for this workspace: ${suggestedCommand}`
      };
    }

    const removeResult = await runCommand("codex", buildCodexMcpRemoveArgs({ serverName }), {
      cwd: workspaceRoot,
      timeoutMs
    });
    if (removeResult?.timedOut || removeResult?.exitCode !== 0) {
      return failedCommandResult("error", serverName, suggestedCommand, "update", removeResult);
    }
  } else if (current.status !== "not_configured") {
    return current;
  }

  let addResult;
  try {
    addResult = await runCodexMcpAdd(workspaceRoot, { serverName, runCommand, timeoutMs });
  } catch (error) {
    const errorCode = error && typeof error.code === "string" ? error.code : "";
    if (errorCode === "ENOENT") {
      return {
        status: "unavailable",
        serverName,
        suggestedCommand,
        restartRequired: false,
        message: `Codex CLI was not found on PATH. Manual command: ${suggestedCommand}`
      };
    }
    return {
      status: "error",
      serverName,
      suggestedCommand,
      restartRequired: false,
      message: `Codex MCP registration failed: ${error?.message || String(error)}. Manual command: ${suggestedCommand}`
    };
  }

  if (addResult?.timedOut || addResult?.exitCode !== 0) {
    return failedCommandResult("error", serverName, suggestedCommand, "registration", addResult);
  }

  const verified = await inspectCodexMcpRegistration(workspaceRoot, inspectOptions);
  if (verified.status !== "configured") {
    return {
      ...verified,
      status: "error",
      restartRequired: false,
      message: `Codex MCP registration ran, but verification did not find a ready '${serverName}' server. Manual command: ${suggestedCommand}`
    };
  }

  const status = current.status === "needs_update" ? "updated" : "registered";
  return {
    ...verified,
    status,
    restartRequired: true,
    message: `Codex MCP server '${serverName}' ${status}. ${CODEX_MCP_RESTART_HINT}`
  };
}

module.exports = {
  DEFAULT_CODEX_MCP_SERVER_NAME,
  buildCodexMcpAddArgs,
  buildCodexMcpAddCommand,
  codexMcpListContainsServer,
  ensureCodexMcpRegistration,
  inspectCodexMcpRegistration
};
