"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TOOL_DEFINITIONS, listTools } = require("./mcp-tools");

const MCP_CONFIG_RELATIVE_PATH = path.join(".vscode", "mcp.json");

function createMcpShieldState() {
  return {
    state: "ready",
    lastNativeCallAt: null,
    lastProxyContactAt: null,
    lastHttpFallbackCallAt: null,
    lastProbeAt: null,
    lastTool: null,
    lastFailure: null,
    callCount: 0,
    failureCount: 0
  };
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function inspectWorkspaceMcpConfig(workspaceRoot) {
  const mcpPath = path.join(workspaceRoot, MCP_CONFIG_RELATIVE_PATH);
  const base = {
    path: mcpPath,
    relativePath: MCP_CONFIG_RELATIVE_PATH.replace(/\\/g, "/"),
    exists: false,
    validJson: false,
    usesCurrentVsCodeShape: false,
    usesLegacyShape: false,
    status: "missing",
    message: "Workspace MCP config was not found. Run Amarillo: Configure MCP for Workspace.",
    server: null
  };

  if (!fs.existsSync(mcpPath)) {
    return base;
  }

  base.exists = true;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  } catch (error) {
    return {
      ...base,
      status: "invalid_json",
      message: `Workspace MCP config exists but is not valid JSON: ${error.message}`
    };
  }

  base.validJson = true;
  const root = safeObject(parsed);
  const servers = safeObject(root.servers);
  const legacyServers = safeObject(root.mcpServers);
  base.usesCurrentVsCodeShape = Object.keys(servers).length > 0;
  base.usesLegacyShape = Object.keys(legacyServers).length > 0;

  if (!base.usesCurrentVsCodeShape && base.usesLegacyShape) {
    return {
      ...base,
      status: "legacy_shape",
      message: "Workspace MCP config uses mcpServers. Current VS Code MCP expects servers."
    };
  }

  const server = safeObject(servers.amarillo);
  if (Object.keys(server).length === 0) {
    return {
      ...base,
      status: "missing_amarillo_server",
      message: "Workspace MCP config does not contain servers.amarillo."
    };
  }

  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  const command = typeof server.command === "string" ? server.command : "";
  const type = typeof server.type === "string" ? server.type : "";
  const hasProxyEntry = args.some((arg) => /mcp-proxy[\\/]index\.js$/i.test(arg.replace(/\\/g, "/")));
  const hasWorkspaceArg = args.includes("--workspace");
  const hasPortArg = args.includes("--port");

  const serverSummary = {
    type,
    command,
    args,
    hasProxyEntry,
    hasWorkspaceArg,
    hasPortArg
  };

  if (type !== "stdio" || !command || !hasProxyEntry || !hasWorkspaceArg || !hasPortArg) {
    return {
      ...base,
      status: "incomplete",
      message: "Workspace MCP config exists, but the Amarillo stdio proxy entry looks incomplete.",
      server: serverSummary
    };
  }

  return {
    ...base,
    status: "ready",
    message: "Workspace MCP config is present and points to the Amarillo stdio proxy.",
    server: serverSummary
  };
}

function mcpFallbackExample(baseUrl) {
  return {
    method: "POST",
    url: `${baseUrl}/mcp/call`,
    headers: {
      "X-Amarillo-Bridge-Token": "<bridge token>"
    },
    alternativeAuthorizationHeader: "Authorization: Bearer <bridge token>",
    body: {
      name: "health",
      arguments: {}
    }
  };
}

function mcpShieldSummary(app) {
  const runtime = app.mcpShield || createMcpShieldState();
  const config = inspectWorkspaceMcpConfig(app.workspaceRoot);
  const baseUrl = `http://${app.host}:${app.port}`;
  const toolCount = TOOL_DEFINITIONS.length;
  const configNeedsAttention = config.status !== "ready";
  const runtimeFailed = runtime.state === "degraded";
  const state = runtimeFailed ? "degraded" : (configNeedsAttention ? "fallback_ready" : "ready");
  const message = runtimeFailed
    ? `MCP fallback is available, but the last MCP call failed: ${runtime.lastFailure?.message || "unknown error"}`
    : (configNeedsAttention
      ? `${config.message} HTTP fallback is ready while the daemon is online.`
      : "MCP config is ready and HTTP fallback is available.");

  return {
    state,
    message,
    toolCount,
    config,
    runtime: {
      state: runtime.state,
      lastNativeCallAt: runtime.lastNativeCallAt,
      lastProxyContactAt: runtime.lastProxyContactAt,
      lastHttpFallbackCallAt: runtime.lastHttpFallbackCallAt,
      lastProbeAt: runtime.lastProbeAt,
      lastTool: runtime.lastTool,
      lastFailure: runtime.lastFailure,
      callCount: runtime.callCount,
      failureCount: runtime.failureCount
    },
    fallback: {
      available: true,
      authHelpUrl: `${baseUrl}/mcp/auth-help`,
      statusUrl: `${baseUrl}/mcp/status`,
      toolsUrl: `${baseUrl}/mcp/tools`,
      probeUrl: `${baseUrl}/mcp/probe`,
      callUrl: `${baseUrl}/mcp/call`,
      example: mcpFallbackExample(baseUrl)
    },
    suggestedActions: [
      "Run Amarillo: Configure MCP for Workspace.",
      "If the AI client was already open, reopen its chat/session so it reloads .vscode/mcp.json.",
      "If native MCP is unavailable, call POST /mcp/call with a tool name and arguments as the HTTP fallback."
    ]
  };
}

function mcpToolResultToHttpPayload(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const firstText = content.find((item) => item && item.type === "text" && typeof item.text === "string")?.text || "";
  let parsed = null;
  if (firstText) {
    try {
      parsed = JSON.parse(firstText);
    } catch (_error) {
      parsed = null;
    }
  }
  return {
    result,
    text: firstText,
    parsed
  };
}

module.exports = {
  createMcpShieldState,
  inspectWorkspaceMcpConfig,
  listTools,
  mcpShieldSummary,
  mcpToolResultToHttpPayload
};
