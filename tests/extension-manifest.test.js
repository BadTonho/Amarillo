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
