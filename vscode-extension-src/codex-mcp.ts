"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_CODEX_MCP_SERVER_NAME = "amarillo";
const DEFAULT_CODEX_MCP_TIMEOUT_MS = 3000;
const CODEX_MCP_BOOTSTRAP_RELATIVE_PATH = path.join(".vscode", "amarillo-mcp-bootstrap.cjs");

function quoteCliArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildCodexMcpAddCommand(workspaceRoot, options: any = {}) {
  const serverName = options.serverName || DEFAULT_CODEX_MCP_SERVER_NAME;
  const workspacePath = path.resolve(workspaceRoot);
  const bootstrapPath = path.join(workspacePath, CODEX_MCP_BOOTSTRAP_RELATIVE_PATH);
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
        message: "Codex CLI was not found on PATH, so Amarillo could not verify native MCP registration."
      };
    }
    return {
      status: "error",
      serverName,
      suggestedCommand,
      message: `Codex MCP check failed: ${error?.message || String(error)}`
    };
  }

  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  const combinedOutput = `${stdout}\n${stderr}`.trim();
  if (result?.timedOut) {
    return {
      status: "timeout",
      serverName,
      suggestedCommand,
      message: `Codex MCP check timed out after ${timeoutMs}ms.`
    };
  }
  if (result?.exitCode !== 0) {
    return {
      status: "error",
      serverName,
      suggestedCommand,
      message: `Codex MCP check exited with code ${result?.exitCode}: ${combinedOutput || "no output"}`
    };
  }
  if (codexMcpListContainsServer(combinedOutput, serverName)) {
    return {
      status: "configured",
      serverName,
      suggestedCommand,
      message: `Codex CLI has an MCP server named '${serverName}' configured.`
    };
  }

  return {
    status: "not_configured",
    serverName,
    suggestedCommand,
    message: `Codex CLI is available, but no MCP server named '${serverName}' was found.`
  };
}

module.exports = {
  DEFAULT_CODEX_MCP_SERVER_NAME,
  buildCodexMcpAddCommand,
  codexMcpListContainsServer,
  inspectCodexMcpRegistration
};
