"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildWorkspaceMcpConfig,
  ensureWorkspaceMcpConfig
} = require("../vscode-extension/mcp-config");

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-mcp-config-"));
}

test("buildWorkspaceMcpConfig creates the stdio proxy shape", () => {
  const proxyEntry = path.join("C:", "amarillo", "runtime", "mcp-proxy", "index.js");
  const workspaceRoot = path.join("C:", "workspace", "Game");
  const config = buildWorkspaceMcpConfig({
    workspaceRoot,
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token"
  });

  assert.deepEqual(config, {
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        args: [
          proxyEntry,
          "--workspace",
          workspaceRoot,
          "--host",
          "127.0.0.1",
          "--port",
          "8323",
          "--bridge-token",
          "test-token"
        ]
      }
    }
  });
  assert.equal(Object.prototype.hasOwnProperty.call(config, "mcpServers"), false);
});

test("ensureWorkspaceMcpConfig creates .vscode/mcp.json when missing", async () => {
  const workspace = createTempWorkspace();
  const proxyEntry = path.join(workspace, "runtime", "mcp-proxy", "index.js");

  const result = await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token"
  });

  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  assert.equal(result.status, "created");
  assert.equal(result.mcpPath, mcpPath);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(mcpPath, "utf8")),
    buildWorkspaceMcpConfig({
      workspaceRoot: workspace,
      proxyEntry,
      host: "127.0.0.1",
      port: 8323,
      bridgeToken: "test-token"
    })
  );
});

test("ensureWorkspaceMcpConfig updates stale config when host, port or workspace args change", async () => {
  const workspace = createTempWorkspace();
  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  const proxyEntry = path.join(workspace, "runtime", "mcp-proxy", "index.js");

  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify(buildWorkspaceMcpConfig({
    workspaceRoot: path.join(workspace, "old-workspace"),
    proxyEntry: path.join(workspace, "old-runtime", "mcp-proxy", "index.js"),
    host: "127.0.0.1",
    port: 8123,
    bridgeToken: "old-token"
  }), null, 2)}\n`, "utf8");

  const result = await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token"
  });

  assert.equal(result.status, "updated");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(mcpPath, "utf8")),
    buildWorkspaceMcpConfig({
      workspaceRoot: workspace,
      proxyEntry,
      host: "127.0.0.1",
      port: 8323,
      bridgeToken: "test-token"
    })
  );
});

test("ensureWorkspaceMcpConfig returns unchanged when config already matches", async () => {
  const workspace = createTempWorkspace();
  const proxyEntry = path.join(workspace, "runtime", "mcp-proxy", "index.js");

  await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token"
  });

  const result = await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token"
  });

  assert.equal(result.status, "unchanged");
});
