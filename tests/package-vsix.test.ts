"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const wrapperPath = path.join(repoRoot, "scripts", "package-vsix.ps1");
const cliPath = path.join(repoRoot, "scripts", "package-vsix.ts");
const wrapperScript = fs.readFileSync(wrapperPath, "utf8");
const packageCli = fs.readFileSync(cliPath, "utf8");
const packageJson = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "package.json"),
  "utf8"
));

test("package:vsix synchronizes shared Amarillo versions before building", () => {
  assert.match(packageJson.scripts["package:vsix"], /npm run version:sync && npm run build && node scripts\/package-vsix\.js/);
});

test("package-vsix copies the daemon runtime recursively", () => {
  assert.match(
    packageCli,
    /copyRuntimeDirectory\(path\.join\(repoRoot, "src", "daemon"\), runtimeDaemon\)/
  );
});

test("package-vsix keeps packaged runtime portable", () => {
  assert.match(packageCli, /assertPortablePackage\(stagingExtension\)/);
  assert.match(packageCli, /VSIX runtime must not include TypeScript source/);
  assert.match(packageCli, /Local machine reference found in VSIX payload/);
  assert.match(packageCli, /\\b\[A-Za-z\]:\[\\\\\/\]Users\[\\\\\/\]/);
  assert.match(packageCli, /rbx-studio-mcp\\\.exe/);
});

test("package-vsix includes the shared Amarillo version manifest", () => {
  assert.match(
    packageCli,
    /copyFile\(path\.join\(repoRoot, "amarillo-version\.json"\), path\.join\(stagingExtension, "amarillo-version\.json"\)\)/
  );
});

test("package-vsix PowerShell entrypoint is a thin TypeScript CLI wrapper", () => {
  assert.match(wrapperScript, /scripts\\package-vsix\.js/);
  assert.match(wrapperScript, /npm\.cmd run build:scripts/);
  assert.doesNotMatch(wrapperScript, /Compress-Archive/);
  assert.match(packageCli, /Compress-Archive/);
});
