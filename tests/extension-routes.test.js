"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("VS Code execute code command uses the daemon exec route", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /\/session\/\$\{session\.id\}\/exec/);
  assert.doesNotMatch(extensionSource, /\/session\/\$\{session\.id\}\/run-code/);
});

test("VS Code MCP healthcheck uses shield status and probe endpoints", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /\/mcp\/status/);
  assert.match(extensionSource, /\/mcp\/probe/);
  assert.match(extensionSource, /amarillo\.mcpHealthcheck/);
});

test("VS Code Doctor command calls /doctor and daemon receives extension protocol args", () => {
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.match(extensionSource, /\/doctor/);
  assert.match(extensionSource, /amarillo\.doctor/);
  assert.match(extensionSource, /--extension-version/);
  assert.match(extensionSource, /--extension-protocol/);
});
