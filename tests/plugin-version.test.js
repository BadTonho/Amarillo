"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
