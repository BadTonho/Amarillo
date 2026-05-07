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

  assert.match(packageJson.scripts["clean:generated"], /npm run build:scripts && node scripts\/clean-generated\.js/);
  assert.match(cleanSource, /generatedRoots/);
  assert.match(cleanSource, /Refusing to remove outside generated roots/);
  assert.match(cleanSource, /src", "daemon"/);
  assert.match(cleanSource, /vscode-extension/);
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
});

test("runtime and extension participate in npm typecheck", () => {
  const packageJson = JSON.parse(readText("package.json"));
  const baseTsconfig = JSON.parse(readText("tsconfig.base.json"));

  assert.equal(baseTsconfig.compilerOptions.noCheck, false);
  assert.match(packageJson.scripts.typecheck, /typecheck:runtime/);
  assert.match(packageJson.scripts.typecheck, /typecheck:extension/);
});

test("daemon HTTP dispatch no longer keeps duplicate legacy route implementations", () => {
  const appSource = readText("src-ts", "daemon", "app.ts");
  const handleHttpSource = appSource.slice(appSource.indexOf("async handleHttp"));

  assert.match(appSource, /handleDiagnosticsRoutes/);
  assert.match(appSource, /handleMcpRoutes/);
  assert.doesNotMatch(handleHttpSource, /requestUrl\.pathname === "\/health"/);
  assert.doesNotMatch(handleHttpSource, /requestUrl\.pathname === "\/connection\/accept"/);
  assert.doesNotMatch(handleHttpSource, /requestUrl\.pathname === "\/studio\/snapshot"/);
});
