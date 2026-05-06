"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const versionPath = path.join(repoRoot, "amarillo-version.json");
const version = JSON.parse(fs.readFileSync(versionPath, "utf8"));

function updateJson(filePath, updater) {
  const absolutePath = path.join(repoRoot, filePath);
  const data = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  updater(data);
  fs.writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function replaceInFile(filePath, replacements) {
  const absolutePath = path.join(repoRoot, filePath);
  let source = fs.readFileSync(absolutePath, "utf8");
  for (const [pattern, replacement] of replacements) {
    source = source.replace(pattern, replacement);
  }
  fs.writeFileSync(absolutePath, source, "utf8");
}

updateJson("vscode-extension/package.json", (manifest) => {
  manifest.version = version.extensionVersion;
});

replaceInFile("src/daemon/version.js", [
  [/const DAEMON_VERSION = "[^"]+";/, `const DAEMON_VERSION = "${version.daemonVersion}";`],
  [/const AMARILLO_PROTOCOL_VERSION = \d+;/, `const AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion};`]
]);

replaceInFile("src/plugin/Amarillo.lua", [
  [/local PLUGIN_VERSION = "[^"]+"/, `local PLUGIN_VERSION = "${version.pluginVersion}"`],
  [/local AMARILLO_PROTOCOL_VERSION = \d+/, `local AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion}`]
]);

replaceInFile("vscode-extension/extension.js", [
  [/const AMARILLO_PROTOCOL_VERSION = \d+;/, `const AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion};`]
]);

process.stdout.write(`[sync-version] Amarillo versions synced from ${path.basename(versionPath)}\n`);
