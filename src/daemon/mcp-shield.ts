"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TOOL_DEFINITIONS, listTools } = require("./mcp-tools");

const MCP_CONFIG_RELATIVE_PATH = path.join(".vscode", "mcp.json");
const MCP_LOCAL_RELATIVE_PATH = path.join(".amarillo", "mcp-local.json");

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

function readJsonIfPossible(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function inspectMcpLocalState(workspaceRoot) {
  const localStatePath = path.join(workspaceRoot, MCP_LOCAL_RELATIVE_PATH);
  const base = {
    path: localStatePath,
    relativePath: MCP_LOCAL_RELATIVE_PATH.replace(/\\/g, "/"),
    exists: false,
    validJson: false,
    hasBridgeToken: false,
    hasExtensionPath: false,
    proxyExists: false,
    status: "missing",
    message: "Local MCP state was not found. Run Amarillo: Configure MCP for Workspace.",
    host: null,
    port: null,
    extensionPath: null,
    extensionVersion: null,
    updatedAt: null
  };

  if (!fs.existsSync(localStatePath)) {
    return base;
  }

  const parsed = readJsonIfPossible(localStatePath);
  if (!parsed) {
    return {
      ...base,
      exists: true,
      status: "invalid_json",
      message: "Local MCP state exists but is not valid JSON."
    };
  }

  const extensionPath = typeof parsed.extensionPath === "string" ? parsed.extensionPath : "";
  const bridgeToken = typeof parsed.bridgeToken === "string" ? parsed.bridgeToken : "";
  const proxyEntry = extensionPath ? path.join(extensionPath, "runtime", "mcp-proxy", "index.js") : "";
  const parsedPort = Number(parsed.port);
  const state = {
    ...base,
    exists: true,
    validJson: true,
    hasBridgeToken: bridgeToken.length > 0,
    hasExtensionPath: extensionPath.length > 0,
    proxyExists: proxyEntry.length > 0 && fs.existsSync(proxyEntry),
    host: typeof parsed.host === "string" ? parsed.host : null,
    port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null,
    extensionPath: extensionPath || null,
    extensionVersion: typeof parsed.extensionVersion === "string" ? parsed.extensionVersion : null,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
  };

  if (!state.hasExtensionPath) {
    return {
      ...state,
      status: "missing_extension_path",
      message: "Local MCP state does not contain the installed Amarillo extension path."
    };
  }
  if (!state.proxyExists) {
    return {
      ...state,
      status: "missing_proxy",
      message: "Local MCP state points to an Amarillo extension without runtime/mcp-proxy/index.js."
    };
  }
  if (!state.hasBridgeToken) {
    return {
      ...state,
      status: "missing_bridge_token",
      message: "Local MCP state does not contain a bridge token."
    };
  }

  return {
    ...state,
    status: "ready",
    message: "Local MCP state is ready."
  };
}

function inspectWorkspaceMcpConfig(workspaceRoot) {
  const mcpPath = path.join(workspaceRoot, MCP_CONFIG_RELATIVE_PATH);
  const localState = inspectMcpLocalState(workspaceRoot);
  const base = {
    path: mcpPath,
    relativePath: MCP_CONFIG_RELATIVE_PATH.replace(/\\/g, "/"),
    exists: false,
    validJson: false,
    usesCurrentVsCodeShape: false,
    usesLegacyShape: false,
    status: "missing",
    message: "Workspace MCP config was not found. Run Amarillo: Configure MCP for Workspace.",
    server: null,
    localState
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
  const cwd = typeof server.cwd === "string" ? server.cwd : "";
  const type = typeof server.type === "string" ? server.type : "";
  const hasProxyEntry = args.some((arg) => /mcp-proxy[\\/]index\.js$/i.test(arg.replace(/\\/g, "/")));
  const hasBootstrapEntry = args.some((arg) => /amarillo-mcp-bootstrap\.cjs$/i.test(arg.replace(/\\/g, "/")));
  const hasWorkspaceArg = args.includes("--workspace");
  const hasPortArg = args.includes("--port");
  const isPortableBootstrap = hasBootstrapEntry && hasWorkspaceArg;
  const isDirectProxy = hasProxyEntry && hasWorkspaceArg && hasPortArg;

  const serverSummary = {
    type,
    command,
    cwd,
    args,
    hasBootstrapEntry,
    hasProxyEntry,
    hasWorkspaceArg,
    hasPortArg,
    localState
  };

  if (type !== "stdio" || !command || (!isPortableBootstrap && !isDirectProxy)) {
    return {
      ...base,
      status: "incomplete",
      message: "Workspace MCP config exists, but the Amarillo stdio proxy entry looks incomplete.",
      server: serverSummary
    };
  }

  if (isPortableBootstrap && localState.status !== "ready") {
    return {
      ...base,
      status: localState.status,
      message: `${localState.message} Portable MCP config is present, but this machine still needs local Amarillo state.`,
      server: serverSummary
    };
  }

  return {
    ...base,
    status: "ready",
    message: isPortableBootstrap
      ? "Workspace MCP config is portable and local Amarillo state is ready."
      : "Workspace MCP config is present and points directly to the Amarillo stdio proxy.",
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
      "For shared workspaces, commit .vscode/mcp.json and .vscode/amarillo-mcp-bootstrap.cjs, but never commit .amarillo/mcp-local.json.",
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
  inspectMcpLocalState,
  inspectWorkspaceMcpConfig,
  listTools,
  mcpShieldSummary,
  mcpToolResultToHttpPayload
};
