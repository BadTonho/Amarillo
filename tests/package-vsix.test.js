"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "package-vsix.ps1");
const packageScript = fs.readFileSync(scriptPath, "utf8");

test("package-vsix copies the daemon runtime recursively", () => {
  assert.match(
    packageScript,
    /Copy-Item -Path \(Join-Path \$repoRoot "src\\\\daemon\\\\\*"\) -Destination \$runtimeDaemon -Recurse -Force/
  );
});
