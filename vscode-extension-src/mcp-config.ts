"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const MCP_FILE_NAME = "mcp.json";

function buildWorkspaceMcpConfig(options) {
  const args = [
    options.proxyEntry,
    "--workspace",
    options.workspaceRoot,
    "--host",
    options.host,
    "--port",
    String(options.port)
  ];
  if (options.bridgeToken) {
    args.push("--bridge-token", options.bridgeToken);
  }
  return {
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        args
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

async function ensureGitignore(workspaceRoot) {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const entry = ".vscode/mcp.json";
  
  try {
    let content = "";
    if (fs.existsSync(gitignorePath)) {
      content = await fsp.readFile(gitignorePath, "utf8");
      if (content.includes(entry)) {
        return;
      }
      content = content.endsWith("\n") || content === "" ? content : content + "\n";
    }
    await fsp.writeFile(gitignorePath, content + entry + "\n", "utf8");
  } catch (_error) {
    // Ignore errors, .gitignore update is best-effort
  }
}

async function ensureWorkspaceMcpConfig(workspaceRoot, options) {
  const vscodeDir = path.join(workspaceRoot, ".vscode");
  const mcpPath = path.join(vscodeDir, MCP_FILE_NAME);
  const config = buildWorkspaceMcpConfig({
    workspaceRoot,
    proxyEntry: options.proxyEntry,
    host: options.host,
    port: options.port,
    bridgeToken: options.bridgeToken
  });
  const fileContents = `${JSON.stringify(config, null, 2)}\n`;

  await ensureGitignore(workspaceRoot);

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
