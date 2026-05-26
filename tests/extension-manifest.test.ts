"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionPackagePath = path.join(__dirname, "..", "vscode-extension", "package.json");
const packageJson = JSON.parse(fs.readFileSync(extensionPackagePath, "utf8"));

test("sidebar view is declared as a webview", () => {
  const views = packageJson.contributes?.views?.amarillo;
  assert.ok(Array.isArray(views), "Expected contributes.views.amarillo to exist.");

  const sidebarView = views.find((view) => view.id === "amarillo.sidebar");
  assert.ok(sidebarView, "Expected amarillo.sidebar to be contributed.");
  assert.equal(sidebarView.type, "webview");
});

test("MCP healthcheck command is declared", () => {
  const commands = packageJson.contributes?.commands || [];
  assert.ok(
    commands.some((command) => command.command === "amarillo.mcpHealthcheck"),
    "Expected amarillo.mcpHealthcheck to be contributed."
  );
});

test("Codex MCP configure command is declared", () => {
  const commands = packageJson.contributes?.commands || [];
  assert.ok(
    commands.some((command) => command.command === "amarillo.configureCodexMcp"),
    "Expected amarillo.configureCodexMcp to be contributed."
  );
});

test("Doctor command is declared", () => {
  const commands = packageJson.contributes?.commands || [];
  assert.ok(
    commands.some((command) => command.command === "amarillo.doctor"),
    "Expected amarillo.doctor to be contributed."
  );
});

test("Configure Place Sync command is declared", () => {
  const commands = packageJson.contributes?.commands || [];
  assert.ok(
    commands.some((command) => command.command === "amarillo.configurePlaceSync"),
    "Expected amarillo.configurePlaceSync to be contributed."
  );
});
