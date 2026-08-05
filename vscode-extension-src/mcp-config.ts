"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const MCP_FILE_NAME = "mcp.json";
const MCP_BOOTSTRAP_FILE_NAME = "amarillo-mcp-bootstrap.cjs";
const MCP_LOCAL_FILE_NAME = "mcp-local.json";
const MCP_VISIBILITY_FILE_NAME = "mcp-codex-visibility.md";
const MCP_WORKSPACE_VARIABLE = "${workspaceFolder}";
const MCP_BOOTSTRAP_RELATIVE_PATH = `.vscode/${MCP_BOOTSTRAP_FILE_NAME}`;
const MCP_LOCAL_RELATIVE_PATH = `.amarillo/${MCP_LOCAL_FILE_NAME}`;
const EXTENSION_FOLDER_PREFIXES = [
  "TonhoStudios.amarillo-vscode-",
  "amarillo.amarillo-vscode-"
];

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function mcpProxyEntryForExtensionPath(extensionPath) {
  return extensionPath ? path.join(extensionPath, "runtime", "mcp-proxy", "index.js") : "";
}

function normalizeForMcpJson(filePath) {
  return String(filePath).replace(/\\/g, "/");
}

function buildWorkspaceMcpConfig(options) {
  const bootstrapEntry = options?.bootstrapEntry
    || `${MCP_WORKSPACE_VARIABLE}/${MCP_BOOTSTRAP_RELATIVE_PATH}`;
  return {
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        cwd: MCP_WORKSPACE_VARIABLE,
        args: [
          normalizeForMcpJson(bootstrapEntry),
          "--workspace",
          MCP_WORKSPACE_VARIABLE
        ]
      }
    }
  };
}

function buildMcpBootstrapScript() {
  return `"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const LOCAL_STATE_RELATIVE_PATH = path.join(".amarillo", "mcp-local.json");
const EXTENSION_FOLDER_PREFIXES = [
  "TonhoStudios.amarillo-vscode-",
  "amarillo.amarillo-vscode-"
];

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().replace(/^\\[|\\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseArgs(argv) {
  const options = {
    workspaceRoot: process.cwd()
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace" && argv[index + 1]) {
      options.workspaceRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(\`Unknown or incomplete argument: \${arg}\`);
  }

  return options;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(\`Unable to read \${filePath}: \${error.message}\`);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\\n", "utf8");
}

function fail(message) {
  process.stderr.write(\`[amarillo-mcp-bootstrap] \${message}\\n\`);
  process.stderr.write("[amarillo-mcp-bootstrap] Install the Amarillo VSIX, open this workspace in VS Code, run Amarillo: Start Bridge or Amarillo: Configure MCP for Workspace, then restart the MCP/Codex session.\\n");
  process.exit(1);
}

function mcpProxyEntryForExtensionPath(extensionPath) {
  return extensionPath ? path.join(extensionPath, "runtime", "mcp-proxy", "index.js") : "";
}

function extensionVersionFromPath(extensionPath) {
  const folderName = path.basename(String(extensionPath || ""));
  const prefix = EXTENSION_FOLDER_PREFIXES.find((candidate) => folderName.startsWith(candidate));
  return prefix
    ? folderName.slice(prefix.length)
    : "unknown";
}

function compareVersions(left, right) {
  const leftParts = String(left || "0").split(".").map((part) => Number(part) || 0);
  const rightParts = String(right || "0").split(".").map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function defaultExtensionSearchRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) {
    return [];
  }
  return [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".windsurf", "extensions")
  ];
}

function findNewestInstalledExtension() {
  let best = null;
  for (const root of defaultExtensionSearchRoots()) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const prefix = EXTENSION_FOLDER_PREFIXES.find((candidate) => entry.name.startsWith(candidate));
      if (!entry.isDirectory() || !prefix) {
        continue;
      }
      const extensionPath = path.join(root, entry.name);
      const proxyEntry = mcpProxyEntryForExtensionPath(extensionPath);
      if (!fs.existsSync(proxyEntry)) {
        continue;
      }
      const extensionVersion = entry.name.slice(prefix.length);
      if (!best || compareVersions(extensionVersion, best.extensionVersion) > 0) {
        best = {
          extensionPath,
          extensionVersion,
          proxyEntry
        };
      }
    }
  }
  return best;
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function resolveMcpProxy(state, localStatePath) {
  const extensionPath = typeof state.extensionPath === "string" ? state.extensionPath : "";
  const proxyEntry = typeof state.proxyEntry === "string" ? state.proxyEntry : "";
  const candidates = uniqueValues([
    proxyEntry,
    mcpProxyEntryForExtensionPath(extensionPath)
  ]);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const resolvedExtensionPath = extensionPath || path.resolve(path.dirname(candidate), "..", "..");
      const resolvedExtensionVersion = state.extensionVersion || extensionVersionFromPath(resolvedExtensionPath);
      if (state.proxyEntry !== candidate || state.extensionPath !== resolvedExtensionPath) {
        try {
          writeJson(localStatePath, {
            ...state,
            extensionPath: resolvedExtensionPath,
            extensionVersion: resolvedExtensionVersion,
            proxyEntry: candidate,
            updatedAt: new Date().toISOString()
          });
        } catch (error) {
          process.stderr.write("[amarillo-mcp-bootstrap] Could not update local MCP state: " + error.message + "\\n");
        }
      }
      return {
        extensionPath: resolvedExtensionPath,
        extensionVersion: resolvedExtensionVersion,
        proxyEntry: candidate,
        recovered: false
      };
    }
  }

  const recovered = findNewestInstalledExtension();
  if (!recovered) {
    return null;
  }

  const nextState = {
    ...state,
    extensionPath: recovered.extensionPath,
    extensionVersion: recovered.extensionVersion,
    proxyEntry: recovered.proxyEntry,
    updatedAt: new Date().toISOString()
  };
  try {
    writeJson(localStatePath, nextState);
  } catch (error) {
    process.stderr.write("[amarillo-mcp-bootstrap] Could not update local MCP state after recovery: " + error.message + "\\n");
  }

  return {
    ...recovered,
    recovered: true
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const localStatePath = path.join(options.workspaceRoot, LOCAL_STATE_RELATIVE_PATH);
  if (!fs.existsSync(localStatePath)) {
    fail(\`Missing local MCP state at \${localStatePath}.\`);
  }

  let state;
  try {
    state = readJson(localStatePath);
  } catch (error) {
    fail(error.message);
  }

  const extensionPath = typeof state.extensionPath === "string" ? state.extensionPath : "";
  const host = typeof state.host === "string" && state.host ? state.host : "127.0.0.1";
  const port = Number(state.port || 8323);
  const bridgeToken = typeof state.bridgeToken === "string" ? state.bridgeToken : "";
  const bridgeAuthRequired = !isLoopbackHost(host);

  if (bridgeAuthRequired && !bridgeToken) {
    fail("Local MCP state does not contain bridgeToken.");
  }
  const resolved = resolveMcpProxy(state, localStatePath);
  if (!resolved) {
    fail("Amarillo MCP proxy was not found in the saved local state or installed extension folders.");
  }

  const args = [
    resolved.proxyEntry,
    "--workspace", options.workspaceRoot,
    "--host", host,
    "--port", String(port)
  ];
  if (bridgeAuthRequired) {
    args.push("--bridge-token", bridgeToken);
  }

  const child = spawn(process.execPath, args, {
    cwd: options.workspaceRoot,
    stdio: "inherit",
    windowsHide: true
  });

  child.on("error", (error) => {
    fail(\`Failed to start Amarillo MCP proxy: \${error.message}\`);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
`;
}

function buildMcpCodexVisibilityMarkdown() {
  const bootstrapCommand = `node ${MCP_WORKSPACE_VARIABLE}/${MCP_BOOTSTRAP_RELATIVE_PATH} --workspace ${MCP_WORKSPACE_VARIABLE}`;
  const codexListCommand = "codex mcp list";
  const codexAddCommand = `codex mcp add amarillo -- node "${MCP_WORKSPACE_VARIABLE}/${MCP_BOOTSTRAP_RELATIVE_PATH}" --workspace "${MCP_WORKSPACE_VARIABLE}"`;
  const config = buildWorkspaceMcpConfig({});
  return [
    "# MCP do Amarillo no Codex",
    "",
    "> Generated automatically by Amarillo. This is an operational visibility note for AI/MCP hosts, not general plugin documentation.",
    "",
    "## Why `list_mcp_resources` can be empty",
    "",
    "MCP has separate channels:",
    "",
    "- `tools`: callable actions such as `health`, `list_projects`, `connect_session`, `get_tree`, `get_services`, and privileged `run_code`.",
    "- `resources`: URI-addressable data returned by `resources/list` and read with `resources/read`.",
    "",
    "Amarillo exposes Studio operations as MCP tools. It does not need to expose resources for native tool calling, so an empty `list_mcp_resources` result can be normal even when the MCP server is working.",
    "",
    "## Make the tools appear natively",
    "",
    "The server must be registered in the host that starts Codex or the AI agent session. `.vscode/mcp.json` is useful for VS Code, but not every host loads that file automatically.",
    "",
    "Register the workspace server with this portable bootstrap command:",
    "",
    "```text",
    bootstrapCommand,
    "```",
    "",
    "Equivalent MCP server config:",
    "",
    "```json",
    JSON.stringify(config, null, 2),
    "```",
    "",
    "After registration, restart or reopen the Codex/AI session so the host reloads the MCP server list.",
    "",
    "## Codex CLI native registration",
    "",
    "Some Codex sessions do not load `.vscode/mcp.json` automatically. Run `Amarillo: Configure Codex MCP` or `Amarillo: Configure MCP for Workspace` in VS Code to generate the workspace files and register this server in Codex CLI when possible.",
    "",
    "Check Codex's own MCP registry with:",
    "",
    "```text",
    codexListCommand,
    "```",
    "",
    "If the Codex CLI is unavailable or registration fails, register the workspace bootstrap manually:",
    "",
    "```text",
    codexAddCommand,
    "```",
    "",
    "This command registers only the portable bootstrap path. It does not copy the local bridge token or installed extension path into shared config. Loopback bridges do not require a bridge token; external bridges still do.",
    "",
    "## Expected native tools",
    "",
    "The exact names depend on the host, but Amarillo tools should appear with names based on:",
    "",
    "- `health`",
    "- `list_projects`",
    "- `connect_session`",
    "- `get_tree`",
    "- `get_services`",
    "- `run_code`",
    "",
    "Do not copy values from `.amarillo/mcp-local.json` into shared configs. That local state contains the installed extension path and may contain a compatibility bridge token for this machine; loopback mode ignores it."
  ].join("\n");
}

function valueOrFallback(value, fallback, defaultValue = "") {
  if (value !== undefined && value !== null && value !== "") {
    return value;
  }
  if (fallback !== undefined && fallback !== null && fallback !== "") {
    return fallback;
  }
  return defaultValue;
}

function buildMcpLocalState(options, existingState = null) {
  const extensionPath = valueOrFallback(
    options.extensionPath || inferExtensionPath(options.proxyEntry),
    existingState?.extensionPath
  );
  const proxyEntry = valueOrFallback(
    options.proxyEntry || mcpProxyEntryForExtensionPath(extensionPath),
    existingState?.proxyEntry
  );
  return {
    host: String(valueOrFallback(options.host, existingState?.host, "127.0.0.1")),
    port: Number(valueOrFallback(options.port, existingState?.port, "8323")),
    bridgeToken: String(valueOrFallback(options.bridgeToken, existingState?.bridgeToken)),
    extensionPath: extensionPath ? path.resolve(extensionPath) : "",
    extensionVersion: String(valueOrFallback(options.extensionVersion, existingState?.extensionVersion, "unknown")),
    proxyEntry: proxyEntry ? path.resolve(proxyEntry) : "",
    updatedAt: options.updatedAt || new Date().toISOString()
  };
}

function inferExtensionPath(proxyEntry) {
  if (!proxyEntry) {
    return "";
  }
  return path.resolve(path.dirname(proxyEntry), "..", "..");
}

function readJsonIfPossible(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

async function ensureGitignore(workspaceRoot) {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const entry = ".amarillo/";
  const obsoleteEntries = new Set([".vscode/mcp.json", "/.vscode/mcp.json"]);
  
  try {
    let lines = [];
    let hadTrailingNewline = true;
    if (fs.existsSync(gitignorePath)) {
      const content = await fsp.readFile(gitignorePath, "utf8");
      hadTrailingNewline = content.endsWith("\n") || content === "";
      lines = content.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
    }
    const filteredLines = lines.filter((line) => !obsoleteEntries.has(line.trim()));
    if (!filteredLines.some((line) => line.trim() === entry)) {
      filteredLines.push(entry);
    }
    const nextContent = `${filteredLines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
    await fsp.writeFile(gitignorePath, nextContent, "utf8");
  } catch (_error) {
    // Ignore errors, .gitignore update is best-effort
  }
}

async function ensureWorkspaceMcpConfig(workspaceRoot, options) {
  const vscodeDir = path.join(workspaceRoot, ".vscode");
  const amarilloDir = path.join(workspaceRoot, ".amarillo");
  const mcpPath = path.join(vscodeDir, MCP_FILE_NAME);
  const bootstrapPath = path.join(vscodeDir, MCP_BOOTSTRAP_FILE_NAME);
  const localStatePath = path.join(amarilloDir, MCP_LOCAL_FILE_NAME);
  const visibilityPath = path.join(workspaceRoot, MCP_VISIBILITY_FILE_NAME);
  const config = buildWorkspaceMcpConfig({});
  const bootstrapContents = buildMcpBootstrapScript();
  const visibilityContents = `${buildMcpCodexVisibilityMarkdown()}\n`;
  const currentLocalState = readJsonIfPossible(localStatePath);
  const localState = buildMcpLocalState(options, currentLocalState);
  const fileContents = `${JSON.stringify(config, null, 2)}\n`;
  const localStateContents = `${JSON.stringify(localState, null, 2)}\n`;
  let wroteBootstrap = false;
  let wroteLocalState = false;
  let visibilityChanged = false;

  await ensureGitignore(workspaceRoot);
  await fsp.mkdir(vscodeDir, { recursive: true });
  await fsp.mkdir(amarilloDir, { recursive: true });

  if (!fs.existsSync(bootstrapPath) || await fsp.readFile(bootstrapPath, "utf8") !== bootstrapContents) {
    await fsp.writeFile(bootstrapPath, bootstrapContents, "utf8");
    wroteBootstrap = true;
  }

  if (!fs.existsSync(visibilityPath) || await fsp.readFile(visibilityPath, "utf8") !== visibilityContents) {
    await fsp.writeFile(visibilityPath, visibilityContents, "utf8");
    visibilityChanged = true;
  }

  const comparableLocalState = currentLocalState?.updatedAt
    ? { ...currentLocalState, updatedAt: localState.updatedAt }
    : currentLocalState;
  if (!comparableLocalState || !isDeepStrictEqual(comparableLocalState, localState)) {
    await fsp.writeFile(localStatePath, localStateContents, "utf8");
    wroteLocalState = true;
  }

  if (fs.existsSync(mcpPath)) {
    const currentConfig = readJsonIfPossible(mcpPath);
    if (currentConfig && isDeepStrictEqual(currentConfig, config)) {
      return {
        status: wroteBootstrap || wroteLocalState ? "updated" : "unchanged",
        mcpPath,
        bootstrapPath,
        localStatePath,
        visibilityPath,
        bootstrapChanged: wroteBootstrap,
        localStateChanged: wroteLocalState,
        mcpConfigChanged: false,
        visibilityChanged,
        config,
        localState
      };
    }

    await fsp.writeFile(mcpPath, fileContents, "utf8");
    return {
      status: "updated",
      mcpPath,
      bootstrapPath,
      localStatePath,
      visibilityPath,
      bootstrapChanged: wroteBootstrap,
      localStateChanged: wroteLocalState,
      mcpConfigChanged: true,
      visibilityChanged,
      config,
      localState
    };
  }

  await fsp.writeFile(mcpPath, fileContents, "utf8");
  return {
    status: "created",
    mcpPath,
    bootstrapPath,
    localStatePath,
    visibilityPath,
    bootstrapChanged: wroteBootstrap,
    localStateChanged: wroteLocalState,
    mcpConfigChanged: true,
    visibilityChanged,
    config,
    localState
  };
}

async function repairExistingWorkspaceMcpConfig(workspaceRoot, options) {
  const bootstrapPath = path.join(workspaceRoot, ".vscode", MCP_BOOTSTRAP_FILE_NAME);
  const localStatePath = path.join(workspaceRoot, ".amarillo", MCP_LOCAL_FILE_NAME);
  const currentLocalState = readJsonIfPossible(localStatePath);
  const hasExistingMcpSetup = Boolean(currentLocalState) || fs.existsSync(bootstrapPath);

  if (!hasExistingMcpSetup) {
    return {
      status: "not_configured",
      bootstrapPath,
      localStatePath
    };
  }

  const host = valueOrFallback(options.host, currentLocalState?.host, "127.0.0.1");
  const bridgeToken = valueOrFallback(options.bridgeToken, currentLocalState?.bridgeToken);
  if (!bridgeToken && !isLoopbackHost(host)) {
    return {
      status: "skipped",
      reason: "missing_bridge_token",
      bootstrapPath,
      localStatePath
    };
  }

  return ensureWorkspaceMcpConfig(workspaceRoot, {
    ...currentLocalState,
    ...options,
    bridgeToken,
    host,
    port: valueOrFallback(options.port, currentLocalState?.port, "8323"),
    extensionPath: valueOrFallback(options.extensionPath, currentLocalState?.extensionPath),
    extensionVersion: valueOrFallback(options.extensionVersion, currentLocalState?.extensionVersion, "unknown"),
    proxyEntry: valueOrFallback(options.proxyEntry, currentLocalState?.proxyEntry)
  });
}

module.exports = {
  MCP_BOOTSTRAP_FILE_NAME,
  MCP_FILE_NAME,
  MCP_LOCAL_FILE_NAME,
  MCP_LOCAL_RELATIVE_PATH,
  MCP_VISIBILITY_FILE_NAME,
  isLoopbackHost,
  buildMcpCodexVisibilityMarkdown,
  buildWorkspaceMcpConfig,
  buildMcpBootstrapScript,
  buildMcpLocalState,
  ensureWorkspaceMcpConfig,
  repairExistingWorkspaceMcpConfig
};
