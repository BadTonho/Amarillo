"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const daemonDiscovery = require("../src/daemon/project-discovery");
const extensionDiscovery = require("../vscode-extension/project-discovery");

function readText(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), "utf8");
}

test("daemon and VS Code extension use the same project discovery ignore list", () => {
  assert.deepEqual(
    extensionDiscovery.PROJECT_DISCOVERY_IGNORED_DIRECTORIES,
    daemonDiscovery.PROJECT_DISCOVERY_IGNORED_DIRECTORIES
  );
  assert.deepEqual(
    daemonDiscovery.PROJECT_DISCOVERY_IGNORED_DIRECTORIES,
    [".git", "node_modules", ".agent", ".amarillo", ".vscode", "dist", "build"]
  );

  for (const ignoredDir of daemonDiscovery.PROJECT_DISCOVERY_IGNORED_DIRECTORIES) {
    assert.equal(daemonDiscovery.isIgnoredProjectDiscoveryDirectoryName(ignoredDir), true);
    assert.equal(extensionDiscovery.isIgnoredProjectDiscoveryDirectoryName(ignoredDir), true);
    assert.equal(daemonDiscovery.shouldIgnoreProjectDiscoveryPath(`nested/${ignoredDir}/Ignored.project.json`), true);
    assert.equal(extensionDiscovery.shouldIgnoreProjectDiscoveryPath(`nested/${ignoredDir}/Ignored.project.json`), true);
  }

  assert.equal(daemonDiscovery.shouldIgnoreProjectDiscoveryPath("nested/Test.project.json"), false);
  assert.equal(extensionDiscovery.shouldIgnoreProjectDiscoveryPath("nested/Test.project.json"), false);
});

test("project discovery file event and extension paths use shared helpers", () => {
  const appSource = readText("src", "daemon", "app.ts");
  const resolverSource = readText("src", "daemon", "project-resolver.ts");
  const extensionSource = readText("vscode-extension-src", "extension.ts");

  assert.match(appSource, /shouldIgnoreProjectDiscoveryPath\(normalized\)/);
  assert.match(resolverSource, /isIgnoredProjectDiscoveryDirectoryName\(entry\.name\)/);
  assert.match(extensionSource, /isIgnoredProjectDiscoveryDirectoryName\(entry\.name\)/);
  assert.match(extensionSource, /shouldIgnoreProjectDiscoveryPath\(relativePath\)/);
  assert.doesNotMatch(appSource, /normalized\.startsWith\("dist\/"\)/);
  assert.doesNotMatch(extensionSource, /entry\.name === "\.git"/);
});
