"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildPlugin } = require("./build-plugin");

const repoRoot = path.join(__dirname, "..");
const versionPath = path.join(repoRoot, "amarillo-version.json");
const workspaceMcpCandidates = [
  path.join(repoRoot, ".vscode", "mcp.json"),
  path.join(repoRoot, "..", ".vscode", "mcp.json")
];

function readJson(filePath) {
  return parseJsonFile(path.join(repoRoot, filePath));
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
  const data = parseJsonFile(absolutePath);
  updater(data);
  fs.writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseJsonFile(absolutePath) {
  const source = fs.readFileSync(absolutePath, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    const relativePath = path.relative(repoRoot, absolutePath);
    const reason = source.includes("\0")
      ? "file contains NUL bytes"
      : error.message;
    throw new Error(`Could not parse ${relativePath}: ${reason}`);
  }
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

function uniquePaths(paths) {
  return Array.from(new Set(paths.map((entry) => path.resolve(entry))));
}

function syncLegacyWorkspaceMcpRuntime(extensionVersion) {
  const updatedPaths = [];
  const warnings = [];
  const runtimeVersionPattern = /(amarillo\.amarillo-vscode-)(\d+\.\d+\.\d+)([\\/]runtime[\\/]mcp-proxy[\\/]index\.js)$/i;

  for (const mcpPath of uniquePaths(workspaceMcpCandidates)) {
    if (!fs.existsSync(mcpPath)) {
      continue;
    }

    let config;
    try {
      config = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    } catch (_error) {
      continue;
    }

    const server = config?.servers?.amarillo || config?.mcpServers?.amarillo;
    const args = Array.isArray(server?.args) ? server.args : null;
    if (!args || typeof args[0] !== "string") {
      continue;
    }

    const nextProxyPath = args[0].replace(
      runtimeVersionPattern,
      (_match, prefix, _oldVersion, suffix) => `${prefix}${extensionVersion}${suffix}`
    );
    if (nextProxyPath === args[0]) {
      continue;
    }

    args[0] = nextProxyPath;
    try {
      fs.writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      updatedPaths.push(mcpPath);
    } catch (error) {
      warnings.push(`${mcpPath}: ${error.message}`);
    }
  }

  return { updatedPaths, warnings };
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

updateJson("package.json", (manifest) => {
  manifest.version = version.extensionVersion;
});

if (fs.existsSync(path.join(repoRoot, "package-lock.json"))) {
  updateJson("package-lock.json", (lockfile) => {
    lockfile.version = version.extensionVersion;
    if (lockfile.packages && lockfile.packages[""]) {
      lockfile.packages[""].version = version.extensionVersion;
    }
  });
}

replaceInFile("src/daemon/version.ts", [
  [/const DAEMON_VERSION = "[^"]+";/, `const DAEMON_VERSION = "${version.daemonVersion}";`],
  [/const CURRENT_PLUGIN_VERSION = "[^"]+";/, `const CURRENT_PLUGIN_VERSION = "${version.pluginVersion}";`],
  [/const AMARILLO_PROTOCOL_VERSION = \d+;/, `const AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion};`]
]);

replaceInFile("src/plugin-src/00_bootstrap.lua", [
  [/local PLUGIN_VERSION = "[^"]+"/, `local PLUGIN_VERSION = "${version.pluginVersion}"`],
  [/local AMARILLO_PROTOCOL_VERSION = \d+/, `local AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion}`]
]);
buildPlugin();

replaceInFile("vscode-extension-src/extension.ts", [
  [/const AMARILLO_PROTOCOL_VERSION = \d+;/, `const AMARILLO_PROTOCOL_VERSION = ${version.protocolVersion};`]
]);

const legacyMcpRuntimeSync = syncLegacyWorkspaceMcpRuntime(version.extensionVersion);

process.stdout.write(
  `[sync-version] Synced ${path.basename(versionPath)} ` +
  `(extension=${version.extensionVersion}, daemon=${version.daemonVersion}, plugin=${version.pluginVersion}, protocol=${version.protocolVersion}); ` +
  (legacyMcpRuntimeSync.updatedPaths.length > 0 ? `updated legacy MCP runtime in ${legacyMcpRuntimeSync.updatedPaths.map((entry) => path.relative(repoRoot, entry)).join(", ")}; ` : "") +
  "generated JavaScript updates on build\n"
);

for (const warning of legacyMcpRuntimeSync.warnings) {
  process.stderr.write(`[sync-version] Could not update workspace MCP runtime: ${warning}\n`);
}
