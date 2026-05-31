"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { readWorkspaceConfig } = require("../daemon/project");
const { TOOL_DEFINITIONS, listTools } = require("../daemon/mcp-tools");
const { startStdioMcpServer, textContent } = require("../daemon/mcp-stdio");

const MCP_LOCAL_RELATIVE_PATH = path.join(".amarillo", "mcp-local.json");

// Module-level mutable state for token auto-refresh on auth failures.
let currentWorkspaceRoot = "";
let currentBridgeToken: string | null = null;

function readCurrentBridgeTokenFromFile(workspaceRoot) {
  try {
    const localStatePath = path.join(workspaceRoot, MCP_LOCAL_RELATIVE_PATH);
    const raw = fs.readFileSync(localStatePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.bridgeToken === "string" && parsed.bridgeToken.trim().length > 0
      ? parsed.bridgeToken.trim()
      : null;
  } catch (_error) {
    return null;
  }
}

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd(),
    host: null,
    port: null,
    bridgeToken: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace" && argv[index + 1]) {
      options.workspaceRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--host" && argv[index + 1]) {
      options.host = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--port" && argv[index + 1]) {
      options.port = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--bridge-token" && argv[index + 1]) {
      options.bridgeToken = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return options;
}

function resolveBridgeOptions(options) {
  const config = readWorkspaceConfig(options.workspaceRoot);
  return {
    workspaceRoot: options.workspaceRoot,
    host: options.host || config.argon.host || "127.0.0.1",
    port: Number(options.port || config.plugin.daemonPort || config.argon.port || 8323),
    bridgeToken: options.bridgeToken || null
  };
}

// OPT-007: Persistent HTTP agent with keepAlive for reduced latency
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function requestJson(baseUrl, method, route, body, options: any = {}) {
  const url = new URL(route, `${baseUrl}/`);
  const timeoutMs = options.timeoutMs || 130000;
  const headers = {
    "Content-Type": "application/json",
    "X-Amarillo-MCP-Proxy": "1"
  };
  if (options.bridgeToken) {
    headers["X-Amarillo-Bridge-Token"] = options.bridgeToken;
  }

  return new Promise((resolve, reject) => {
    const request = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      timeout: timeoutMs,
      agent: keepAliveAgent,
      headers
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${responseBody}`));
          return;
        }

        try {
          resolve(responseBody ? JSON.parse(responseBody) : {});
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", reject);

    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }

    request.end();
  });
}

function sessionRoute(sessionId, action, query = "") {
  const encodedSessionId = encodeURIComponent(String(sessionId));
  return `/session/${encodedSessionId}/${action}${query}`;
}

function isAuthError(error) {
  const message = String(error?.message || "");
  return message.includes("HTTP 401") || message.includes("HTTP 403");
}

async function requestJsonWithTokenRefresh(baseUrl, method, route, body, bridgeToken) {
  try {
    return await requestJson(baseUrl, method, route, body, { bridgeToken });
  } catch (error) {
    if (isAuthError(error) && currentWorkspaceRoot) {
      const freshToken = readCurrentBridgeTokenFromFile(currentWorkspaceRoot);
      if (freshToken && freshToken !== bridgeToken) {
        currentBridgeToken = freshToken;
        return await requestJson(baseUrl, method, route, body, { bridgeToken: freshToken });
      }
    }
    throw error;
  }
}

async function healthPayload(baseUrl, bridgeToken) {
  const response: any = await requestJsonWithTokenRefresh(baseUrl, "POST", "/mcp/call", {
    name: "health",
    arguments: {}
  }, bridgeToken);
  return response.result || textContent(response.parsed || {});
}

const SUPPORTED_TOOLS = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

async function callProxyTool(baseUrl, bridgeToken, name, args) {
  if (!SUPPORTED_TOOLS.has(name)) {
    throw new Error(`Unsupported MCP tool: ${name}`);
  }
  if (name === "health") {
    return healthPayload(baseUrl, bridgeToken);
  }
  const response: any = await requestJsonWithTokenRefresh(baseUrl, "POST", "/mcp/call", {
    name,
    arguments: args || {}
  }, bridgeToken);
  return response.result || textContent(response.parsed || {});
}

async function main() {
  const options = resolveBridgeOptions(parseArgs(process.argv.slice(2)));
  const baseUrl = `http://${options.host}:${options.port}`;
  currentWorkspaceRoot = options.workspaceRoot;
  currentBridgeToken = options.bridgeToken;

  await startStdioMcpServer({
    serverInfo: {
      name: "amarillo-mcp-proxy",
      version: "0.1.0"
    },
    listTools,
    handleTool: (name, args) => callProxyTool(baseUrl, currentBridgeToken, name, args)
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});

