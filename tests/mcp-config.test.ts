"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MCP_BOOTSTRAP_FILE_NAME,
  MCP_LOCAL_FILE_NAME,
  MCP_VISIBILITY_FILE_NAME,
  buildMcpCodexVisibilityMarkdown,
  buildWorkspaceMcpConfig,
  ensureWorkspaceMcpConfig
} = require("../vscode-extension/mcp-config");

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-mcp-config-"));
}

test("buildWorkspaceMcpConfig creates the portable stdio bootstrap shape", () => {
  const config = buildWorkspaceMcpConfig({});

  assert.deepEqual(config, {
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        cwd: "${workspaceFolder}",
        args: [
          "${workspaceFolder}/.vscode/amarillo-mcp-bootstrap.cjs",
          "--workspace",
          "${workspaceFolder}"
        ]
      }
    }
  });
  assert.doesNotMatch(JSON.stringify(config), /C:[\\/]/);
  assert.doesNotMatch(JSON.stringify(config), /bridge-token/);
  assert.doesNotMatch(JSON.stringify(config), /amarillo\.amarillo-vscode-/);
  assert.equal(Object.prototype.hasOwnProperty.call(config, "mcpServers"), false);
});

test("buildMcpCodexVisibilityMarkdown describes native tool visibility without local secrets", () => {
  const markdown = buildMcpCodexVisibilityMarkdown();

  assert.match(markdown, /`tools`/);
  assert.match(markdown, /`resources`/);
  assert.match(markdown, /empty `list_mcp_resources` result can be normal/);
  assert.match(
    markdown,
    /node \$\{workspaceFolder\}\/\.vscode\/amarillo-mcp-bootstrap\.cjs --workspace \$\{workspaceFolder\}/
  );
  assert.match(markdown, /restart or reopen the Codex\/AI session/);
  assert.match(markdown, /`health`/);
  assert.match(markdown, /`list_projects`/);
  assert.match(markdown, /`connect_session`/);
  assert.match(markdown, /`get_tree`/);
  assert.match(markdown, /`get_services`/);
  assert.match(markdown, /`run_code`/);
  assert.doesNotMatch(markdown, /test-token|bridgeToken|extensionPath|C:[\\/]|amarillo\.amarillo-vscode-/);
});

test("ensureWorkspaceMcpConfig creates portable MCP files and local secret state", async () => {
  const workspace = createTempWorkspace();
  const extensionPath = path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.3");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");

  const result = await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath,
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  const bootstrapPath = path.join(workspace, ".vscode", MCP_BOOTSTRAP_FILE_NAME);
  const localStatePath = path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME);
  const visibilityPath = path.join(workspace, MCP_VISIBILITY_FILE_NAME);
  assert.equal(result.status, "created");
  assert.equal(result.mcpPath, mcpPath);
  assert.equal(result.bootstrapPath, bootstrapPath);
  assert.equal(result.localStatePath, localStatePath);
  assert.equal(result.visibilityPath, visibilityPath);
  assert.equal(result.visibilityChanged, true);

  const writtenMcp = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  assert.deepEqual(writtenMcp, buildWorkspaceMcpConfig({}));
  assert.doesNotMatch(fs.readFileSync(mcpPath, "utf8"), /test-token|C:[\\/]|amarillo\.amarillo-vscode-/);

  const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
  assert.match(bootstrap, /mcp-local\.json/);
  assert.match(bootstrap, /runtime", "mcp-proxy", "index\.js"/);

  assert.deepEqual(JSON.parse(fs.readFileSync(localStatePath, "utf8")), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath,
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const visibility = fs.readFileSync(visibilityPath, "utf8");
  assert.match(visibility, /MCP do Amarillo no Codex/);
  assert.match(visibility, /empty `list_mcp_resources` result can be normal/);
  assert.match(visibility, /\$\{workspaceFolder\}\/\.vscode\/amarillo-mcp-bootstrap\.cjs/);
  assert.match(visibility, /restart or reopen the Codex\/AI session/);
  assert.doesNotMatch(visibility, /test-token|bridgeToken|extensionPath|C:[\\/]|amarillo\.amarillo-vscode-/);

  const gitignore = fs.readFileSync(path.join(workspace, ".gitignore"), "utf8");
  assert.match(gitignore, /\.amarillo\//);
  assert.doesNotMatch(gitignore, /\.vscode\/mcp\.json/);
});

test("ensureWorkspaceMcpConfig replaces stale direct runtime config with portable config", async () => {
  const workspace = createTempWorkspace();
  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  const extensionPath = path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.3");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");

  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".gitignore"), ".vscode/mcp.json\nnode_modules/\n", "utf8");
  fs.writeFileSync(mcpPath, `${JSON.stringify({
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        args: [
          path.join(workspace, "old-runtime", "mcp-proxy", "index.js"),
          "--workspace",
          path.join(workspace, "old-workspace"),
          "--host",
          "127.0.0.1",
          "--port",
          "8123",
          "--bridge-token",
          "old-token"
        ]
      }
    }
  }, null, 2)}\n`, "utf8");

  const result = await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath,
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  assert.equal(result.status, "updated");
  assert.equal(result.visibilityChanged, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(mcpPath, "utf8")), buildWorkspaceMcpConfig({}));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME), "utf8")).bridgeToken,
    "test-token"
  );
  const gitignore = fs.readFileSync(path.join(workspace, ".gitignore"), "utf8");
  assert.doesNotMatch(gitignore, /\.vscode\/mcp\.json/);
  assert.match(gitignore, /\.amarillo\//);
  assert.match(gitignore, /node_modules\//);
});

test("ensureWorkspaceMcpConfig returns unchanged when config already matches", async () => {
  const workspace = createTempWorkspace();
  const extensionPath = path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.3");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");

  await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath,
    extensionVersion: "1.2.3"
  });

  const result = await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath,
    extensionVersion: "1.2.3"
  });

  assert.equal(result.status, "unchanged");
  assert.equal(result.visibilityChanged, false);
});

test("ensureWorkspaceMcpConfig recreates visibility note without changing MCP status", async () => {
  const workspace = createTempWorkspace();
  const extensionPath = path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.3");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");

  await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath,
    extensionVersion: "1.2.3"
  });

  const visibilityPath = path.join(workspace, MCP_VISIBILITY_FILE_NAME);
  fs.writeFileSync(visibilityPath, "stale visibility note\n", "utf8");

  const result = await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath,
    extensionVersion: "1.2.3"
  });

  assert.equal(result.status, "unchanged");
  assert.equal(result.visibilityPath, visibilityPath);
  assert.equal(result.visibilityChanged, true);
  assert.match(fs.readFileSync(visibilityPath, "utf8"), /Make the tools appear natively/);
});
