"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const extensionRoot = path.join(repoRoot, "vscode-extension");
const pluginManifestPath = path.join(extensionRoot, ".codex-plugin", "plugin.json");
const mcpConfigPath = path.join(extensionRoot, ".mcp.json");

test("Codex plugin manifest points to the bundled Amarillo MCP server", () => {
  const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
  const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
  const amarilloServer = mcpConfig.mcpServers?.amarillo;

  assert.equal(pluginManifest.name, "amarillo");
  assert.equal(pluginManifest.mcpServers, "./.mcp.json");
  assert.equal(amarilloServer.command, "node");
  assert.deepEqual(amarilloServer.args, ["./mcp/server.js"]);
  assert.equal(amarilloServer.cwd, ".");
  assert.ok(fs.existsSync(path.join(extensionRoot, "mcp", "server.js")));
});
