"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

function readText(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), "utf8");
}

test("generated JavaScript cleanup is available through npm", () => {
  const packageJson = JSON.parse(readText("package.json"));
  const cleanSource = readText("scripts", "clean-generated.ts");
  const diagnoseMcpSource = readText("scripts", "diagnose-mcp.ts");

  assert.match(packageJson.scripts["clean:generated"], /npm run build:scripts && node scripts\/clean-generated\.js/);
  assert.match(packageJson.scripts["diagnose:mcp"], /npm run build:scripts && node scripts\/diagnose-mcp\.js/);
  assert.match(cleanSource, /generatedRoots/);
  assert.match(cleanSource, /Refusing to remove outside generated roots/);
  assert.match(cleanSource, /src", "daemon"/);
  assert.match(cleanSource, /vscode-extension/);
  assert.match(diagnoseMcpSource, /X-Amarillo-Bridge-Token/);
  assert.match(diagnoseMcpSource, /Authorization/);
});

test("PowerShell entrypoints build generated runtime when missing", () => {
  const startDaemon = readText("scripts", "start-daemon.ps1");
  const runMcp = readText("scripts", "run-mcp.ps1");

  assert.match(startDaemon, /npm\.cmd run build:runtime/);
  assert.match(startDaemon, /Daemon not found after build/);
  assert.match(runMcp, /npm\.cmd run build:runtime/);
  assert.match(runMcp, /MCP proxy not found after build/);
  assert.match(runMcp, /\[string\]\$DaemonHost/);
  assert.doesNotMatch(runMcp, /\[string\]\$Host/);
});

test("root package version is synchronized with Amarillo product version", () => {
  const packageJson = JSON.parse(readText("package.json"));
  const packageLock = JSON.parse(readText("package-lock.json"));
  const version = JSON.parse(readText("amarillo-version.json"));
  const syncVersionSource = readText("scripts", "sync-version.ts");

  assert.equal(packageJson.version, version.extensionVersion);
  assert.equal(packageLock.version, version.extensionVersion);
  assert.equal(packageLock.packages[""].version, version.extensionVersion);
  assert.match(syncVersionSource, /updateJson\("package\.json"/);
  assert.match(syncVersionSource, /updateJson\("package-lock\.json"/);
  assert.match(syncVersionSource, /syncLegacyWorkspaceMcpRuntime/);
  assert.match(syncVersionSource, /updated legacy MCP runtime/);
  assert.match(syncVersionSource, /amarillo\\.amarillo-vscode-/);
  assert.match(syncVersionSource, /\.vscode", "mcp\.json"/);
});

test("runtime and extension participate in npm typecheck", () => {
  const packageJson = JSON.parse(readText("package.json"));
  const baseTsconfig = JSON.parse(readText("tsconfig.base.json"));
  const daemonTsconfig = JSON.parse(readText("tsconfig.daemon.json"));

  assert.equal(baseTsconfig.compilerOptions.noCheck, false);
  assert.deepEqual(daemonTsconfig.include, ["src/daemon/**/*.ts", "src/mcp-proxy/**/*.ts"]);
  assert.doesNotMatch(JSON.stringify(daemonTsconfig), /src-ts/);
  assert.match(packageJson.scripts.typecheck, /typecheck:runtime/);
  assert.match(packageJson.scripts.typecheck, /typecheck:extension/);
});

test("daemon HTTP dispatch no longer keeps duplicate legacy route implementations", () => {
  const appSource = readText("src", "daemon", "app.ts");
  const handleHttpSource = appSource.slice(appSource.indexOf("async handleHttp"));

  assert.match(appSource, /handleDiagnosticsRoutes/);
  assert.match(appSource, /handleMcpRoutes/);
  assert.doesNotMatch(handleHttpSource, /requestUrl\.pathname === "\/health"/);
  assert.doesNotMatch(handleHttpSource, /requestUrl\.pathname === "\/connection\/accept"/);
  assert.doesNotMatch(handleHttpSource, /requestUrl\.pathname === "\/studio\/snapshot"/);
});

test("P1 source files do not contain common mojibake markers", () => {
  const files = [
    ["vscode-extension-src", "extension.ts"],
    ["src", "daemon", "project.ts"],
    ["src", "daemon", "lib", "error-tracker.ts"],
    ["scripts", "diagnose.ps1"]
  ];
  const mojibakePattern = /[\u00c3\u00c2\u00c6\u0192\u00e2\ufffd]/;

  for (const segments of files) {
    assert.doesNotMatch(readText(...segments), mojibakePattern, segments.join("/"));
  }
});

test("VS Code extension resolves multi-root workspaces from the active editor first", () => {
  const extensionSource = readText("vscode-extension-src", "extension.ts");
  const start = extensionSource.indexOf("function getWorkspaceFolder()");
  const end = extensionSource.indexOf("function resolveWorkspaceRoot()", start);
  const getWorkspaceFolderSource = extensionSource.slice(start, end);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(getWorkspaceFolderSource, /activeTextEditor/);
  assert.match(getWorkspaceFolderSource, /vscode\.workspace\.getWorkspaceFolder\(activeEditor\.document\.uri\)/);
  assert.match(getWorkspaceFolderSource, /folders\.length === 1/);
  assert.match(getWorkspaceFolderSource, /Multiple workspace folders are open/);
  assert.ok(
    getWorkspaceFolderSource.indexOf("activeTextEditor") < getWorkspaceFolderSource.indexOf("folders.length === 1")
  );
  assert.doesNotMatch(getWorkspaceFolderSource, /workspaceFolders\s*\[0\]/);
});

test("P3 typing guardrails keep central contracts away from broad any", () => {
  const appSource = readText("src", "daemon", "app.ts");
  const mcpToolsSource = readText("src", "daemon", "mcp-tools.ts");
  const extensionSource = readText("vscode-extension-src", "extension.ts");

  assert.match(appSource, /contracts\/runtime/);
  assert.match(mcpToolsSource, /contracts\/mcp/);
  assert.doesNotMatch(appSource, /class PluginRobloxApp\s*{\s*\[key: string\]: any;/);
  assert.doesNotMatch(extensionSource, /function requestJson\([^)]*\): Promise<any>/);
  assert.doesNotMatch(mcpToolsSource, /function validateToolArguments\(name,\s*args: any/);
  assert.doesNotMatch(mcpToolsSource, /Object\.entries\(properties\) as any/);
});
