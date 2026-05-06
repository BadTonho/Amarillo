"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const versionPath = path.join(repoRoot, "amarillo-version.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, filePath), "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(path.join(repoRoot, filePath), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function usage() {
  return [
    "Usage:",
    "  node scripts/sync-version.js",
    "  node scripts/sync-version.js 1.0.18",
    "  node scripts/sync-version.js 1.0.18 --protocol 1"
  ].join("\n");
}

function parseArgs(argv) {
  let nextVersion = null;
  let nextProtocolVersion = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--protocol") {
      const rawProtocol = argv[index + 1];
      index += 1;
      const parsed = Number(rawProtocol);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid protocol version: ${rawProtocol}`);
      }
      nextProtocolVersion = parsed;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (nextVersion) {
      throw new Error(`Unexpected extra version: ${arg}`);
    }
    nextVersion = arg;
  }

  return { nextProtocolVersion, nextVersion };
}

function validateVersion(value, label) {
  if (!/^\d+\.\d+\.\d+$/.test(String(value || ""))) {
    throw new Error(`${label} must use x.y.z format. Received: ${value}`);
  }
}

function validateManifest(version) {
  validateVersion(version.extensionVersion, "extensionVersion");
  validateVersion(version.daemonVersion, "daemonVersion");
  validateVersion(version.pluginVersion, "pluginVersion");
  if (!Number.isInteger(version.protocolVersion) || version.protocolVersion <= 0) {
    throw new Error(`protocolVersion must be a positive integer. Received: ${version.protocolVersion}`);
  }
}

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
    pattern.lastIndex = 0;
    if (!pattern.test(source)) {
      throw new Error(`Could not find version pattern ${pattern} in ${filePath}`);
    }
    pattern.lastIndex = 0;
    source = source.replace(pattern, replacement);
  }
  fs.writeFileSync(absolutePath, source, "utf8");
}

const { nextProtocolVersion, nextVersion } = parseArgs(process.argv.slice(2));
const version = readJson("amarillo-version.json");

if (nextVersion) {
  validateVersion(nextVersion, "version");
  version.extensionVersion = nextVersion;
  version.daemonVersion = nextVersion;
  version.pluginVersion = nextVersion;
}

if (nextProtocolVersion !== null) {
  version.protocolVersion = nextProtocolVersion;
}

validateManifest(version);
writeJson("amarillo-version.json", version);

updateJson("vscode-extension/package.json", (manifest) => {
  manifest.version = version.extensionVersion;
});

replaceInFile("src-ts/daemon/version.ts", [
  [/const DAEMON_VERSION = "[^"]+";/, `const DAEMON_VERSION = "${version.daemonVersion}";`],
  [/const AMARILLO_PROTOCOL_VERSION = \d+;/, `const AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion};`]
]);

replaceInFile("src/plugin/Amarillo.lua", [
  [/local PLUGIN_VERSION = "[^"]+"/, `local PLUGIN_VERSION = "${version.pluginVersion}"`],
  [/local AMARILLO_PROTOCOL_VERSION = \d+/, `local AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion}`]
]);

replaceInFile("vscode-extension-src/extension.ts", [
  [/const AMARILLO_PROTOCOL_VERSION = \d+;/, `const AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion};`]
]);

process.stdout.write(
  `[sync-version] Synced ${path.basename(versionPath)} ` +
  `(extension=${version.extensionVersion}, daemon=${version.daemonVersion}, plugin=${version.pluginVersion}, protocol=${version.protocolVersion}); generated JavaScript updates on build\n`
);
