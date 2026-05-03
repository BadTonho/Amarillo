"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const MCP_FILE_NAME = "mcp.json";

function buildWorkspaceMcpConfig(options) {
  return {
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        args: [
          options.proxyEntry,
          "--workspace",
          options.workspaceRoot,
          "--host",
          options.host,
          "--port",
          String(options.port)
        ]
      }
    }
  };
}

function readJsonIfPossible(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

async function ensureWorkspaceMcpConfig(workspaceRoot, options) {
  const vscodeDir = path.join(workspaceRoot, ".vscode");
  const mcpPath = path.join(vscodeDir, MCP_FILE_NAME);
  const config = buildWorkspaceMcpConfig({
    workspaceRoot,
    proxyEntry: options.proxyEntry,
    host: options.host,
    port: options.port
  });
  const fileContents = `${JSON.stringify(config, null, 2)}\n`;

  if (fs.existsSync(mcpPath)) {
    const currentConfig = readJsonIfPossible(mcpPath);
    if (currentConfig && isDeepStrictEqual(currentConfig, config)) {
      return {
        status: "unchanged",
        mcpPath,
        config
      };
    }

    await fsp.mkdir(vscodeDir, { recursive: true });
    await fsp.writeFile(mcpPath, fileContents, "utf8");
    return {
      status: "updated",
      mcpPath,
      config
    };
  }

  await fsp.mkdir(vscodeDir, { recursive: true });
  await fsp.writeFile(mcpPath, fileContents, "utf8");
  return {
    status: "created",
    mcpPath,
    config
  };
}

module.exports = {
  MCP_FILE_NAME,
  buildWorkspaceMcpConfig,
  ensureWorkspaceMcpConfig
};
