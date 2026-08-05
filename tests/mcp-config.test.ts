"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MCP_BOOTSTRAP_FILE_NAME,
  MCP_LOCAL_FILE_NAME,
  MCP_VISIBILITY_FILE_NAME,
  isLoopbackHost,
  buildMcpBootstrapScript,
  buildMcpCodexVisibilityMarkdown,
  buildMcpLocalState,
  buildWorkspaceMcpConfig,
  ensureWorkspaceMcpConfig,
  repairExistingWorkspaceMcpConfig
} = require("../vscode-extension/mcp-config");

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-mcp-config-"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFakeExtensionInstall(root, version) {
  const extensionPath = path.join(root, ".vscode", "extensions", `amarillo.amarillo-vscode-${version}`);
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");
  fs.mkdirSync(path.dirname(proxyEntry), { recursive: true });
  fs.writeFileSync(proxyEntry, [
    "\"use strict\";",
    "process.stdout.write(JSON.stringify({",
    "  proxy: __filename,",
    "  cwd: process.cwd(),",
    "  argv: process.argv.slice(2)",
    "}) + \"\\n\");"
  ].join("\n"), "utf8");
  return {
    extensionPath,
    proxyEntry,
    version
  };
}

function runBootstrap(workspace, env = {}) {
  const bootstrapPath = path.join(workspace, ".vscode", MCP_BOOTSTRAP_FILE_NAME);
  return spawnSync(process.execPath, [bootstrapPath, "--workspace", workspace], {
    cwd: workspace,
    env: {
      ...process.env,
      ...env
    },
    encoding: "utf8"
  });
}

function readLocalState(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME), "utf8"));
}

function legacyBootstrapScript() {
  return [
    "\"use strict\";",
    "const fs = require(\"node:fs\");",
    "const path = require(\"node:path\");",
    "const extensionPath = \"\";",
    "const bridgeToken = \"\";",
    "const proxyEntry = path.join(extensionPath, \"runtime\", \"mcp-proxy\", \"index.js\");",
    "if (!fs.existsSync(proxyEntry)) { process.exit(1); }",
    "void bridgeToken;"
  ].join("\n");
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

test("loopback detection accepts localhost, IPv4 loopback, and IPv6 loopback only", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
});

test("loopback bootstrap starts without bridgeToken in local state", async () => {
  const workspace = createTempWorkspace();
  const fake = createFakeExtensionInstall(workspace, "1.2.3");
  await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry: fake.proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    extensionPath: fake.extensionPath,
    extensionVersion: fake.version
  });
  const state = readLocalState(workspace);
  delete state.bridgeToken;
  writeJson(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME), state);

  const result = runBootstrap(workspace);
  assert.equal(result.status, 0, result.stderr);
  const launched = JSON.parse(result.stdout.trim());
  assert.equal(launched.argv.includes("--bridge-token"), false);
});

test("external bootstrap refuses local state without bridgeToken", async () => {
  const workspace = createTempWorkspace();
  const fake = createFakeExtensionInstall(workspace, "1.2.3");
  await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry: fake.proxyEntry,
    host: "0.0.0.0",
    port: 8323,
    extensionPath: fake.extensionPath,
    extensionVersion: fake.version
  });
  const state = readLocalState(workspace);
  delete state.bridgeToken;
  writeJson(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME), state);

  const result = runBootstrap(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not contain bridgeToken/);
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
  assert.match(markdown, /codex mcp list/);
  assert.match(markdown, /Amarillo: Configure Codex MCP/);
  assert.match(markdown, /register this server in Codex CLI/);
  assert.match(markdown, /codex mcp add amarillo -- node "\$\{workspaceFolder\}\/\.vscode\/amarillo-mcp-bootstrap\.cjs" --workspace "\$\{workspaceFolder\}"/);
  assert.match(markdown, /restart or reopen the Codex\/AI session/);
  assert.match(markdown, /`health`/);
  assert.match(markdown, /`list_projects`/);
  assert.match(markdown, /`connect_session`/);
  assert.match(markdown, /`get_tree`/);
  assert.match(markdown, /`get_services`/);
  assert.match(markdown, /`run_code`/);
  assert.doesNotMatch(markdown, /test-token|bridgeToken|extensionPath|proxyEntry|C:[\\/]|amarillo\.amarillo-vscode-/);
});

test("buildMcpLocalState records the installed proxy entry", () => {
  const extensionPath = path.join("C:", "Users", "Example", ".vscode", "extensions", "amarillo.amarillo-vscode-1.2.3");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");

  assert.deepEqual(buildMcpLocalState({
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath,
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:00.000Z"
  }), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath: path.resolve(extensionPath),
    extensionVersion: "1.2.3",
    proxyEntry: path.resolve(proxyEntry),
    updatedAt: "2026-05-13T00:00:00.000Z"
  });
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
    proxyEntry,
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const visibility = fs.readFileSync(visibilityPath, "utf8");
  assert.match(visibility, /MCP do Amarillo no Codex/);
  assert.match(visibility, /empty `list_mcp_resources` result can be normal/);
  assert.match(visibility, /\$\{workspaceFolder\}\/\.vscode\/amarillo-mcp-bootstrap\.cjs/);
  assert.match(visibility, /restart or reopen the Codex\/AI session/);
  assert.doesNotMatch(visibility, /test-token|bridgeToken|extensionPath|proxyEntry|C:[\\/]|amarillo\.amarillo-vscode-/);

  const gitignore = fs.readFileSync(path.join(workspace, ".gitignore"), "utf8");
  assert.match(gitignore, /\.amarillo\//);
  assert.doesNotMatch(gitignore, /\.vscode\/mcp\.json/);
});

test("ensureWorkspaceMcpConfig replaces an old bootstrap and records proxyEntry", async () => {
  const workspace = createTempWorkspace();
  const extensionPath = path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.3");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");
  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  const bootstrapPath = path.join(workspace, ".vscode", MCP_BOOTSTRAP_FILE_NAME);
  const localStatePath = path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME);

  fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
  fs.writeFileSync(bootstrapPath, legacyBootstrapScript(), "utf8");
  writeJson(localStatePath, {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "old-token",
    extensionPath,
    extensionVersion: "1.2.2",
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const result = await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "new-token",
    extensionPath,
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:01.000Z"
  });

  assert.equal(result.status, "created");
  assert.equal(result.bootstrapChanged, true);
  assert.equal(result.localStateChanged, true);
  assert.equal(result.mcpConfigChanged, true);
  const bootstrap = fs.readFileSync(bootstrapPath, "utf8");
  assert.equal(bootstrap, buildMcpBootstrapScript());
  assert.match(bootstrap, /findNewestInstalledExtension/);
  assert.equal(bootstrap.includes("old-token"), false);
  assert.equal(bootstrap.includes("new-token"), false);
  assert.equal(bootstrap.includes(extensionPath), false);
  assert.equal(bootstrap.includes(proxyEntry), false);

  const sharedMcpConfig = fs.readFileSync(mcpPath, "utf8");
  assert.equal(sharedMcpConfig.includes("old-token"), false);
  assert.equal(sharedMcpConfig.includes("new-token"), false);
  assert.equal(sharedMcpConfig.includes(extensionPath), false);
  assert.equal(sharedMcpConfig.includes(proxyEntry), false);

  assert.deepEqual(readLocalState(workspace), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "new-token",
    extensionPath,
    extensionVersion: "1.2.3",
    proxyEntry,
    updatedAt: "2026-05-13T00:00:01.000Z"
  });
});

test("bootstrap uses a valid saved proxyEntry", async () => {
  const workspace = createTempWorkspace();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-profile-"));
  const install = createFakeExtensionInstall(profile, "1.2.3");

  await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry: install.proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath: install.extensionPath,
    extensionVersion: "1.2.3"
  });

  const result = runBootstrap(workspace, {
    USERPROFILE: profile,
    HOME: profile
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.proxy, install.proxyEntry);
  assert.deepEqual(payload.argv, [
    "--workspace", workspace,
    "--host", "127.0.0.1",
    "--port", "8323"
  ]);
});

test("bootstrap derives proxyEntry from extensionPath for older local state", async () => {
  const workspace = createTempWorkspace();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-profile-"));
  const install = createFakeExtensionInstall(profile, "1.2.3");

  await ensureWorkspaceMcpConfig(workspace, {
    proxyEntry: install.proxyEntry,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath: install.extensionPath,
    extensionVersion: "1.2.3"
  });
  const localStatePath = path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME);
  const localState = readLocalState(workspace);
  delete localState.proxyEntry;
  writeJson(localStatePath, localState);

  const result = runBootstrap(workspace, {
    USERPROFILE: profile,
    HOME: profile
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).proxy, install.proxyEntry);
  assert.equal(readLocalState(workspace).proxyEntry, install.proxyEntry);
});

test("bootstrap recovers stale extension paths from the newest installed Amarillo extension", () => {
  const workspace = createTempWorkspace();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-profile-"));
  createFakeExtensionInstall(profile, "1.2.4");
  const newest = createFakeExtensionInstall(profile, "1.10.0");
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".vscode", MCP_BOOTSTRAP_FILE_NAME), buildMcpBootstrapScript(), "utf8");
  writeJson(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath: path.join(profile, ".vscode", "extensions", "amarillo.amarillo-vscode-1.2.3"),
    extensionVersion: "1.2.3",
    proxyEntry: path.join(profile, ".vscode", "extensions", "amarillo.amarillo-vscode-1.2.3", "runtime", "mcp-proxy", "index.js"),
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const result = runBootstrap(workspace, {
    USERPROFILE: profile,
    HOME: profile
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).proxy, newest.proxyEntry);

  const repairedState = readLocalState(workspace);
  assert.equal(repairedState.extensionPath, newest.extensionPath);
  assert.equal(repairedState.extensionVersion, "1.10.0");
  assert.equal(repairedState.proxyEntry, newest.proxyEntry);
  assert.equal(repairedState.bridgeToken, "test-token");
});

test("bootstrap fails clearly when no saved or installed proxy exists", () => {
  const workspace = createTempWorkspace();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-profile-"));
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".vscode", MCP_BOOTSTRAP_FILE_NAME), buildMcpBootstrapScript(), "utf8");
  writeJson(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "test-token",
    extensionPath: path.join(profile, ".vscode", "extensions", "amarillo.amarillo-vscode-1.2.3"),
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const result = runBootstrap(workspace, {
    USERPROFILE: profile,
    HOME: profile
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Amarillo MCP proxy was not found/);
  assert.match(result.stderr, /Amarillo: Configure MCP for Workspace/);
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

test("repairExistingWorkspaceMcpConfig prefers a current bridge token while repairing local state", async () => {
  const workspace = createTempWorkspace();
  const extensionPath = path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.4");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");
  writeJson(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "old-token",
    extensionPath: path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.3"),
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const result = await repairExistingWorkspaceMcpConfig(workspace, {
    proxyEntry,
    bridgeToken: "new-token",
    extensionPath,
    extensionVersion: "1.2.4",
    updatedAt: "2026-05-13T00:00:01.000Z"
  });

  assert.equal(result.status, "created");
  assert.deepEqual(readLocalState(workspace), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "new-token",
    extensionPath,
    extensionVersion: "1.2.4",
    proxyEntry,
    updatedAt: "2026-05-13T00:00:01.000Z"
  });
});

test("repairExistingWorkspaceMcpConfig preserves a local bridge token while repairing the extension path", async () => {
  const workspace = createTempWorkspace();
  const extensionPath = path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.4");
  const proxyEntry = path.join(extensionPath, "runtime", "mcp-proxy", "index.js");
  writeJson(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "old-token",
    extensionPath: path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.3"),
    extensionVersion: "1.2.3",
    updatedAt: "2026-05-13T00:00:00.000Z"
  });

  const result = await repairExistingWorkspaceMcpConfig(workspace, {
    proxyEntry,
    extensionPath,
    extensionVersion: "1.2.4",
    updatedAt: "2026-05-13T00:00:01.000Z"
  });

  assert.equal(result.status, "created");
  assert.deepEqual(readLocalState(workspace), {
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "old-token",
    extensionPath,
    extensionVersion: "1.2.4",
    proxyEntry,
    updatedAt: "2026-05-13T00:00:01.000Z"
  });
});

test("repairExistingWorkspaceMcpConfig does not create MCP files in a new workspace", async () => {
  const workspace = createTempWorkspace();
  const result = await repairExistingWorkspaceMcpConfig(workspace, {
    extensionPath: path.join(workspace, "extensions", "amarillo.amarillo-vscode-1.2.4"),
    extensionVersion: "1.2.4"
  });

  assert.equal(result.status, "not_configured");
  assert.equal(fs.existsSync(path.join(workspace, ".vscode", "mcp.json")), false);
  assert.equal(fs.existsSync(path.join(workspace, ".amarillo", MCP_LOCAL_FILE_NAME)), false);
});

test("VS Code activation schedules repair for existing MCP workspaces", () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, "..", "vscode-extension-src", "extension.ts"), "utf8");

  assert.match(extensionSource, /repairExistingWorkspaceMcpOnActivate/);
  assert.match(extensionSource, /repairExistingWorkspaceMcpConfig/);
  assert.match(extensionSource, /void repairExistingWorkspaceMcpOnActivate\(context\)/);
});

test("VS Code MCP flow verifies local state after writing", () => {
  const extensionSource = fs.readFileSync(path.join(__dirname, "..", "vscode-extension-src", "extension.ts"), "utf8");

  assert.match(extensionSource, /verifyWorkspaceMcpLocalState/);
  assert.match(extensionSource, /MCP local state verified/);
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
