"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

type DiagnoseOptions = {
  bridgeToken: string | null;
  host: string;
  json: boolean;
  port: number;
  workspaceRoot: string;
};

type RequestResult = {
  body: string;
  json: any;
  ok: boolean;
  statusCode: number;
};

function usage() {
  return [
    "Usage:",
    "  node scripts/diagnose-mcp.js [--workspace .] [--host 127.0.0.1] [--port 8323] [--bridge-token TOKEN] [--json]",
    "",
    "Checks Amarillo daemon health, MCP fallback auth, tools, and probe endpoints."
  ].join("\n");
}

function parseArgs(argv): DiagnoseOptions {
  const options: DiagnoseOptions = {
    bridgeToken: null,
    host: "",
    json: false,
    port: 0,
    workspaceRoot: process.cwd()
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
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
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  options.workspaceRoot = path.resolve(options.workspaceRoot);
  const localState = resolveMcpLocalState(options.workspaceRoot);
  options.host = options.host || localState?.host || "127.0.0.1";
  options.port = options.port || resolvePort(options.workspaceRoot, localState);
  options.bridgeToken = options.bridgeToken || resolveBridgeToken(options.workspaceRoot, localState);
  return options;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function resolveMcpLocalState(workspaceRoot) {
  return readJsonIfExists(path.join(workspaceRoot, ".amarillo", "mcp-local.json"));
}

function resolvePort(workspaceRoot, localState: any = null) {
  const localPort = Number(localState?.port);
  if (Number.isInteger(localPort) && localPort > 0) {
    return localPort;
  }
  const config = readJsonIfExists(path.join(workspaceRoot, ".pluginroblox.json")) || {};
  return Number(config.daemonPort || config.plugin?.daemonPort || config.argon?.port || 8323);
}

function resolveBridgeToken(workspaceRoot, localState: any = null) {
  if (process.env.AMARILLO_BRIDGE_TOKEN) {
    return process.env.AMARILLO_BRIDGE_TOKEN;
  }
  if (typeof localState?.bridgeToken === "string" && localState.bridgeToken) {
    return localState.bridgeToken;
  }
  const mcpConfig = readJsonIfExists(path.join(workspaceRoot, ".vscode", "mcp.json"));
  const server = mcpConfig?.servers?.amarillo || mcpConfig?.mcpServers?.amarillo || {};
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  const tokenIndex = args.indexOf("--bridge-token");
  if (tokenIndex >= 0 && args[tokenIndex + 1]) {
    return args[tokenIndex + 1];
  }
  return null;
}

function requestJson(options: DiagnoseOptions, method, route, headers: Record<string, string> = {}, body: any = undefined): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: options.host,
      port: options.port,
      method,
      path: route,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers
      }
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        let parsed = null;
        try {
          parsed = responseBody ? JSON.parse(responseBody) : {};
        } catch (_error) {
          parsed = null;
        }
        const statusCode = Number(response.statusCode || 0);
        resolve({
          body: responseBody,
          json: parsed,
          ok: statusCode >= 200 && statusCode < 300,
          statusCode
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

function statusMatches(statusCode, expectedStatus) {
  const expected = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return expected.includes(statusCode);
}

function statusLabel(result: RequestResult, expectedStatus = 200) {
  return statusMatches(result.statusCode, expectedStatus) ? "OK" : "FAIL";
}

function printLine(options: DiagnoseOptions, line) {
  if (!options.json) {
    process.stdout.write(`${line}\n`);
  }
}

async function checkStep(options: DiagnoseOptions, label, method, route, headers: Record<string, string> = {}, body: any = undefined, expectedStatus: any = 200) {
  try {
    const result = await requestJson(options, method, route, headers, body);
    printLine(options, `[${statusLabel(result, expectedStatus)}] ${label}: HTTP ${result.statusCode}`);
    return { label, result };
  } catch (error) {
    printLine(options, `[FAIL] ${label}: ${error.message}`);
    return { label, error: error.message, result: null };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = `http://${options.host}:${options.port}`;
  const results: any[] = [];

  printLine(options, `[diagnose:mcp] Target: ${baseUrl}`);
  printLine(options, `[diagnose:mcp] Workspace: ${options.workspaceRoot}`);
  printLine(options, `[diagnose:mcp] Bridge token: ${options.bridgeToken ? "found" : "missing"}`);

  results.push(await checkStep(options, "Public daemon health", "GET", "/health"));
  results.push(await checkStep(options, "Public MCP auth help", "GET", "/mcp/auth-help"));
  results.push(await checkStep(options, "Protected MCP status without token", "GET", "/mcp/status", {}, undefined, [200, 401]));

  if (!options.bridgeToken) {
    printLine(options, "[WARN] No bridge token found. Pass --bridge-token TOKEN or run Amarillo: Configure MCP for Workspace to generate .amarillo/mcp-local.json.");
  } else {
    const bridgeHeaders = { "X-Amarillo-Bridge-Token": options.bridgeToken };
    const bearerHeaders = { Authorization: `Bearer ${options.bridgeToken}` };
    results.push(await checkStep(options, "MCP status with X-Amarillo-Bridge-Token", "GET", "/mcp/status", bridgeHeaders));
    results.push(await checkStep(options, "MCP status with Authorization Bearer", "GET", "/mcp/status", bearerHeaders));
    results.push(await checkStep(options, "MCP tools", "GET", "/mcp/tools", bridgeHeaders));
    results.push(await checkStep(options, "MCP health probe", "POST", "/mcp/probe", bridgeHeaders, {}));
  }

  const failures = results.filter((entry) => entry.error || (entry.result && entry.result.statusCode >= 500));
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: failures.length === 0, baseUrl, workspaceRoot: options.workspaceRoot, hasBridgeToken: Boolean(options.bridgeToken), results }, null, 2)}\n`);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[diagnose:mcp] ${error.stack || error.message}\n`);
  process.exit(1);
});
