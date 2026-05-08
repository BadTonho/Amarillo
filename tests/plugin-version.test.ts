"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const version = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "amarillo-version.json"),
  "utf8"
));
const pluginSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "plugin", "Amarillo.lua"),
  "utf8"
);

test("Roblox plugin declares Amarillo version and protocol constants", () => {
  assert.match(pluginSource, /local PLUGIN_VERSION = "\d+\.\d+\.\d+"/);
  assert.match(pluginSource, /local AMARILLO_PROTOCOL_VERSION = 1/);
});

test("Roblox plugin sends version metadata in handshake, polling, snapshots, and command results", () => {
  assert.match(pluginSource, /pluginVersion = PLUGIN_VERSION/);
  assert.match(pluginSource, /pluginProtocolVersion = AMARILLO_PROTOCOL_VERSION/);
  assert.match(pluginSource, /addVersionPayload\(body\)/);
  assert.match(pluginSource, /addVersionPayload\(bodyTable\)/);
  assert.match(pluginSource, /pluginVersionQuery\(\)/);
});

test("Roblox plugin stores and sends the daemon session token", () => {
  assert.match(pluginSource, /sessionToken = nil/);
  assert.match(pluginSource, /state\.sessionToken = response\.session and response\.session\.sessionToken or nil/);
  assert.match(pluginSource, /X-Amarillo-Session-Token/);
});

test("Roblox plugin retries the initial Studio source-of-truth snapshot", () => {
  assert.match(pluginSource, /awaitingInitialStudioSync = false/);
  assert.match(pluginSource, /local function attemptInitialStudioSync/);
  assert.match(pluginSource, /syncSnapshot\("initial_accept"\)/);
  assert.match(pluginSource, /Initial Studio sync still pending/);
  assert.match(pluginSource, /attemptInitialStudioSync\("retry", false\)/);
});

test("Roblox plugin surfaces sync diagnostics and sends placeId with connection diff", () => {
  assert.match(pluginSource, /warn\("\[Amarillo\] " \.\. tostring\(message\)\)/);
  assert.match(pluginSource, /request\("POST", "\/connection\/diff", \{\s+placeId = game\.PlaceId,/);
});

test("Roblox plugin UI construction keeps local registers below Studio limits", () => {
  assert.match(pluginSource, /-- Keep UI construction in a short-lived scope/);
  assert.match(pluginSource, /do\s+local homeHero = makeCard/);
  assert.match(pluginSource, /do\s+local settingsHeader = makeCard/);
  assert.match(pluginSource, /do\s+local advancedHeader = makeCard/);
  assert.match(pluginSource, /-- ===== Diff Confirmation Overlay =====\s+do\s+state\.ui\.diffOverlay = Instance\.new\("Frame"\)/);
});

test("Amarillo component versions stay synchronized from amarillo-version.json", () => {
  const extensionManifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "package.json"),
    "utf8"
  ));
  const rootPackage = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "package.json"),
    "utf8"
  ));
  const daemonVersionSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "daemon", "version.js"),
    "utf8"
  );
  const extensionSource = fs.readFileSync(
    path.join(__dirname, "..", "vscode-extension", "extension.js"),
    "utf8"
  );

  assert.equal(extensionManifest.version, version.extensionVersion);
  assert.equal(rootPackage.version, version.extensionVersion);
  assert.match(daemonVersionSource, new RegExp(`const DAEMON_VERSION = "${version.daemonVersion}"`));
  assert.match(daemonVersionSource, new RegExp(`const AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion}`));
  assert.match(pluginSource, new RegExp(`local PLUGIN_VERSION = "${version.pluginVersion}"`));
  assert.match(pluginSource, new RegExp(`local AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion}`));
  assert.match(extensionSource, new RegExp(`const AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion}`));
});
