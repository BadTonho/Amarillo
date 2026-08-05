"use strict";

const vscode = require("vscode");
const syncFs = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  ensureCodexMcpRegistration,
  inspectCodexMcpRegistration
} = require("./codex-mcp");
const {
  ensureWorkspaceMcpConfig,
  repairExistingWorkspaceMcpConfig
} = require("./mcp-config");
const {
  isIgnoredProjectDiscoveryDirectoryName,
  shouldIgnoreProjectDiscoveryPath
} = require("./project-discovery");
const { ensureWorkspaceProjectFile } = require("./project-bootstrap");
const { ensureWorkspaceSourcemap } = require("./sourcemap");
const {
  sidebarTone,
  createSidebarFact,
  createSidebarAction,
  sidebarErrorMessage,
  escapeHtml,
  formatElapsedMs: sidebarFormatElapsedMs,
  buildSidebarLoadingState,
  buildSidebarErrorState,
  renderSidebarHtml,
  renderSidebarFatalHtml
} = require("./sidebar");
const { bridgeState } = require("./bridge-state");

let outputChannel = null;
let statusBar = null;
let sidebarProvider = null;
let extensionContext = null;
// Handshake, token, refresh, and degraded state now managed by bridgeState
const projectFileCache = new Map();
const activityDiffDocuments = new Map<string, string>();
const AMARILLO_PROTOCOL_VERSION = 2;
const SIDEBAR_HEALTH_TIMEOUT_MS = 1200;
const SIDEBAR_STATE_TIMEOUT_MS = 4500;
const DEFAULT_MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;
const SOURCEMAP_ACTIVATION_DELAY_MS = 3000;
const PLACE_SYNC_MOUNT_OPTIONS = [
  { id: "Workspace", label: "Workspace", path: "Workspace" },
  { id: "ReplicatedStorage", label: "ReplicatedStorage", path: "ReplicatedStorage" },
  { id: "ServerScriptService", label: "ServerScriptService", path: "ServerScriptService" },
  { id: "ServerStorage", label: "ServerStorage", path: "ServerStorage" },
  { id: "StarterGui", label: "StarterGui", path: "StarterGui" },
  { id: "StarterPlayer.StarterCharacterScripts", label: "StarterCharacterScripts", path: "StarterPlayer.StarterCharacterScripts" },
  { id: "StarterPlayer.StarterPlayerScripts", label: "StarterPlayerScripts", path: "StarterPlayer.StarterPlayerScripts" }
];
const PLACE_SYNC_DEFAULT_BASE_MOUNT_IDS = PLACE_SYNC_MOUNT_OPTIONS.map((mount) => mount.id);
const PLACE_SYNC_DEFAULT_EXCLUSIVE_MOUNT_IDS = PLACE_SYNC_MOUNT_OPTIONS
  .filter((mount) => mount.id !== "Workspace")
  .map((mount) => mount.id);

// Shared API types — single source of truth for daemon ↔ extension contracts
import type {
  BridgeSessionPayload,
  ConnectionOfferPayload,
  BridgeHealthPayload,
  DoctorReportPayload,
  McpShieldPayload,
  McpStatusPayload,
  McpProbePayload,
  ConnectionRequestResponse,
  WorkspaceFilesChangedResponse,
  ActivityDetailPayload,
  ActivityEntryPayload,
  ActivityListResponse,
  ActivityEntryResponse,
  SessionCommandResponse
} from "./api-types";

type ExtensionJsonObject = Record<string, unknown>;

interface RequestJsonOptions {
  timeout?: number;
  bridgeToken?: string | null;
  forceBridgeToken?: boolean;
  maxResponseBytes?: number;
}

interface ProjectStateHint {
  projectFilePath?: string | null;
  projectFiles?: string[];
}

interface SourcemapEnsureOptions {
  silent?: boolean;
}

interface ExtensionErrorOptions {
  severity?: string;
  code?: string;
  context?: ExtensionJsonObject | null;
}

interface BridgeStartOptions {
  requestedBy?: string;
  [key: string]: unknown;
}

interface SidebarRuntimeState {
  settings?: any;
  settingsError?: string | null;
  health?: BridgeHealthPayload | null;
  healthError?: string | null;
  healthDurationMs?: number;
  projectsPayload?: any;
  projectsError?: string | null;
  activity?: ActivityEntryPayload[];
  activityError?: string | null;
}

// ===== Logger with notification levels (Argon pattern) =====
function getNotificationLevel() {
  const level = vscode.workspace.getConfiguration("amarillo").get("notificationLevel", "Info");
  switch (level) {
    case "Info": return 3;
    case "Warning": return 2;
    case "Error": return 1;
    default: return 0;
  }
}

function log(message) {
  if (!outputChannel) {
    return;
  }
  const timestamp = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function logInfo(message, silent = false) {
  log(message);
  if (silent || getNotificationLevel() < 3) {
    return;
  }
  vscode.window.showInformationMessage(`Amarillo: ${message}`);
}

function logWarn(message, silent = false) {
  log(`WARN: ${message}`);
  if (silent || getNotificationLevel() < 2) {
    return;
  }
  vscode.window.showWarningMessage(`Amarillo: ${message}`);
}

function logError(message, silent = false) {
  log(`ERROR: ${message}`);
  reportExtensionError(message, { code: "EXTENSION" });
  if (silent || getNotificationLevel() < 1) {
    return;
  }
  vscode.window.showErrorMessage(`Amarillo: ${message}`, "Show Output").then((action) => {
    if (action === "Show Output" && outputChannel) {
      outputChannel.show();
    }
  });
}

function runtimePath(context, ...segments) {
  return path.join(context.extensionPath, "runtime", ...segments);
}

function extensionVersion(context = extensionContext) {
  return String(context?.extension?.packageJSON?.version || "unknown");
}

function recoverBridgeTokenFromLocalState() {
  try {
    const workspaceRoot = resolveWorkspaceRoot();
    const localStatePath = path.join(workspaceRoot, ".amarillo", "mcp-local.json");
    if (!syncFs.existsSync(localStatePath)) {
      return null;
    }
    const raw = syncFs.readFileSync(localStatePath, "utf8");
    const parsed = JSON.parse(raw);
    const token = typeof parsed?.bridgeToken === "string" ? parsed.bridgeToken.trim() : "";
    return token.length > 0 ? token : null;
  } catch (_error) {
    return null;
  }
}

function getOrCreateBridgeToken(context = extensionContext) {
  if (bridgeState.bridgeToken) {
    return bridgeState.bridgeToken;
  }
  const existing = context?.workspaceState.get("amarillo.bridgeToken");
  if (typeof existing === "string" && existing.length > 0) {
    bridgeState.bridgeToken = existing;
    return bridgeState.bridgeToken;
  }
  // Fallback: recover from mcp-local.json before generating a new token.
  // This prevents token churn when workspaceState is cleared (e.g. VS Code reinstall,
  // workspace opened from different location, or corrupted state).
  const recovered = recoverBridgeTokenFromLocalState();
  if (recovered) {
    bridgeState.bridgeToken = recovered;
    if (context) {
      void context.workspaceState.update("amarillo.bridgeToken", recovered);
    }
    return bridgeState.bridgeToken;
  }
  bridgeState.bridgeToken = crypto.randomBytes(24).toString("hex");
  if (context) {
    void context.workspaceState.update("amarillo.bridgeToken", bridgeState.bridgeToken);
  }
  return bridgeState.bridgeToken;
}

async function fileSha1(filePath) {
  return crypto.createHash("sha1").update(await fs.readFile(filePath)).digest("hex");
}

async function filesMatch(leftPath, rightPath) {
  try {
    const [leftHash, rightHash] = await Promise.all([
      fileSha1(leftPath),
      fileSha1(rightPath)
    ]);
    return leftHash === rightHash;
  } catch (_error) {
    return false;
  }
}

function getActiveSessionId() {
  return extensionContext?.workspaceState.get("amarillo.activeSessionId") || null;
}

async function setActiveSessionId(sessionId) {
  if (!extensionContext) {
    return;
  }
  await extensionContext.workspaceState.update("amarillo.activeSessionId", sessionId || null);
}

function getWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("Open your Roblox project folder in VS Code before using Amarillo.");
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document?.uri) {
    const activeWorkspace = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (activeWorkspace?.uri?.fsPath) {
      return activeWorkspace.uri.fsPath;
    }
  }

  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }

  throw new Error("Multiple workspace folders are open. Open a file from the Roblox project you want Amarillo to use, then run the command again.");
}

function resolveWorkspaceRoot() {
  // Use the workspace selected by the active editor when VS Code has multiple roots.
  return getWorkspaceFolder();
}

function getExplicitConfigValue(config, key) {
  const inspected = config.inspect(key);
  if (!inspected) {
    return undefined;
  }

  return inspected.workspaceFolderLanguageValue
    ?? inspected.workspaceLanguageValue
    ?? inspected.globalLanguageValue
    ?? inspected.workspaceFolderValue
    ?? inspected.workspaceValue
    ?? inspected.globalValue;
}

function readWorkspacePluginConfig(workspaceRoot) {
  const configPath = path.join(workspaceRoot, ".pluginroblox.json");
  try {
    const raw = syncFs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function resolveBridgePort(config, workspaceRoot) {
  const configuredPort = Number(getExplicitConfigValue(config, "port"));
  if (Number.isInteger(configuredPort) && configuredPort > 0) {
    return configuredPort;
  }

  const workspaceConfig = readWorkspacePluginConfig(workspaceRoot);
  const workspacePort = Number(workspaceConfig.daemonPort);
  if (Number.isInteger(workspacePort) && workspacePort > 0) {
    return workspacePort;
  }

  return 8323;
}

function resolveAutoSyncToStudio(config, workspaceRoot) {
  const configuredAutoSync = getExplicitConfigValue(config, "autoSyncToStudio");
  if (configuredAutoSync !== undefined) {
    return configuredAutoSync !== false;
  }

  const workspaceConfig = readWorkspacePluginConfig(workspaceRoot);
  return workspaceConfig.autoSyncToStudio !== false;
}

function resolvePrivilegedActionConfirmation(config) {
  const configuredConfirmation = getExplicitConfigValue(config, "privilegedActionConfirmation");
  return configuredConfirmation !== false;
}

function workspaceDisplayName(workspaceRoot) {
  if (!workspaceRoot) {
    return "";
  }
  return path.basename(path.resolve(workspaceRoot)) || workspaceRoot;
}

function collectProjectFilesUncached(rootDir, results = [], depth = 0) {
  if (depth > 8) {
    return results;
  }

  let entries = [];
  try {
    entries = syncFs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_error) {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredProjectDiscoveryDirectoryName(entry.name)) {
        continue;
      }
      collectProjectFilesUncached(fullPath, results, depth + 1);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".project.json")) {
      results.push(fullPath);
    }
  }

  return results;
}

function collectProjectFiles(rootDir) {
  const cacheKey = path.resolve(rootDir);
  const cached = projectFileCache.get(cacheKey);
  if (cached) {
    return cached.slice();
  }
  const results = collectProjectFilesUncached(cacheKey);
  projectFileCache.set(cacheKey, results.slice());
  return results;
}

function invalidateProjectFileCache(workspaceRoot = null) {
  if (!workspaceRoot) {
    projectFileCache.clear();
    return;
  }
  projectFileCache.delete(path.resolve(workspaceRoot));
}

function invalidateProjectFileCacheForEvents(events) {
  if (!Array.isArray(events)) {
    return;
  }
  const touchesProjectFile = events.some((event) => {
    const candidates = [event?.path, event?.oldPath, event?.newPath, event?.uri, event?.oldUri, event?.newUri]
      .filter((value) => typeof value === "string");
    return candidates.some((filePath) => filePath.endsWith(".project.json"));
  });
  if (touchesProjectFile) {
    try {
      invalidateProjectFileCache(resolveWorkspaceRoot());
    } catch (_error) {
      invalidateProjectFileCache();
    }
  }
}

async function ensureWorkspaceHasProjects(workspaceRoot) {
  const result = await ensureWorkspaceProjectFile(workspaceRoot, collectProjectFiles);
  if (result.created) {
    invalidateProjectFileCache(workspaceRoot);
  }
  return result;
}

async function ensurePluginConfig(workspaceRoot) {
  const configPath = path.join(workspaceRoot, ".pluginroblox.json");
  if (syncFs.existsSync(configPath)) {
    return false; // File already exists.
  }
  
  // File is missing, create defaults.
  const defaultConfig = {
    daemonPort: 8323,
    autoConnect: false,
    autoSyncToStudio: true
  };
  
  try {
    await fs.writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
    return true; // File was created.
  } catch (error) {
    log(`Error creating .pluginroblox.json: ${error.message}`);
    throw error;
  }
}

async function ensureWorkspaceLuauSourcemap(workspaceRoot, projectState: ProjectStateHint, options: SourcemapEnsureOptions = {}) {
  const result = await ensureWorkspaceSourcemap(workspaceRoot, {
    projectFilePath: projectState?.projectFilePath || null,
    projectFiles: projectState?.projectFiles || collectProjectFiles(workspaceRoot),
    userProfile: process.env.USERPROFILE,
    ...options
  });

  const silent = options.silent === true;
  if (!silent && result.settingsUpdated) {
    log(`Updated Luau configuration to use ${path.basename(result.projectFilePath)}.`);
  }
  if (!silent && result.sourcemapGenerated) {
    log(`Generated sourcemap.json for ${path.basename(result.projectFilePath)}.`);
  }
  if (!silent && result.settingsError) {
    log(result.settingsError);
  }

  return result;
}

function getBridgeSettings() {
  const config = vscode.workspace.getConfiguration("amarillo");
  const workspaceRoot = resolveWorkspaceRoot();
  return {
    workspaceRoot,
    host: String(config.get("host", "127.0.0.1") || "127.0.0.1"),
    port: resolveBridgePort(config, workspaceRoot),
    nodePath: String(config.get("nodePath", "node") || "node"),
    autoSyncToStudio: resolveAutoSyncToStudio(config, workspaceRoot),
    privilegedActionConfirmation: resolvePrivilegedActionConfirmation(config)
  };
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function hostForUrl(host) {
  const value = String(host || "").trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value;
  }
  return value.includes(":") ? `[${value}]` : value;
}

function bridgeAuthRequiredForHost(host) {
  return !isLoopbackHost(host);
}

function workspaceRelativePath(workspaceRoot, targetPath) {
  const relativePath = path.relative(workspaceRoot, targetPath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("..")) {
    return targetPath;
  }
  return relativePath;
}

function describeMcpConfigResult(mcpConfigResult, workspaceRoot) {
  const displayPath = workspaceRelativePath(workspaceRoot, mcpConfigResult.mcpPath);
  const localStateDetail = mcpConfigResult.localStatePath
    ? `; local state ${workspaceRelativePath(workspaceRoot, mcpConfigResult.localStatePath)}`
    : "";
  const visibilityDetail = mcpConfigResult.visibilityChanged && mcpConfigResult.visibilityPath
    ? `; Codex visibility note updated at ${workspaceRelativePath(workspaceRoot, mcpConfigResult.visibilityPath)}`
    : "";
  const changedFiles = [
    mcpConfigResult.mcpConfigChanged ? "mcp.json" : null,
    mcpConfigResult.bootstrapChanged ? "bootstrap" : null,
    mcpConfigResult.localStateChanged ? "local state" : null
  ].filter(Boolean);
  const changedDetail = changedFiles.length > 0
    ? `; refreshed ${changedFiles.join(", ")}`
    : "";
  const workspaceLabel = workspaceDisplayName(workspaceRoot);
  switch (mcpConfigResult.status) {
    case "created":
      return `MCP configured for ${workspaceLabel} at ${displayPath}${localStateDetail}${visibilityDetail}${changedDetail}`;
    case "updated":
      return `MCP updated for ${workspaceLabel} at ${displayPath}${localStateDetail}${visibilityDetail}${changedDetail}`;
    default:
      return `MCP ready for ${workspaceLabel} at ${displayPath}${localStateDetail}${visibilityDetail}`;
  }
}

function verifyWorkspaceMcpLocalState(workspaceRoot, mcpConfigResult) {
  const localStatePath = mcpConfigResult.localStatePath;
  const localStateLabel = workspaceRelativePath(workspaceRoot, localStatePath);
  let localState;
  try {
    localState = JSON.parse(syncFs.readFileSync(localStatePath, "utf8"));
  } catch (error) {
    throw new Error(`MCP local state could not be read at ${localStateLabel}: ${error.message}`);
  }

  const localHost = localState?.host || mcpConfigResult.localState?.host || "127.0.0.1";
  const requiredFields = ["extensionPath", "extensionVersion", "proxyEntry"];
  if (bridgeAuthRequiredForHost(localHost)) {
    requiredFields.unshift("bridgeToken");
  }
  const missingFields = requiredFields.filter((field) => {
    const value = localState?.[field];
    return typeof value !== "string" || value.length === 0;
  });
  if (missingFields.length > 0) {
    throw new Error(`MCP local state at ${localStateLabel} is incomplete: missing ${missingFields.join(", ")}.`);
  }

  const expected = mcpConfigResult.localState || {};
  const mismatchedFields = ["bridgeToken", "extensionPath", "extensionVersion", "proxyEntry", "host", "port"]
    .filter((field) => expected[field] !== undefined && expected[field] !== null && expected[field] !== "")
    .filter((field) => String(localState[field]) !== String(expected[field]));
  if (mismatchedFields.length > 0) {
    throw new Error(`MCP local state at ${localStateLabel} did not persist expected ${mismatchedFields.join(", ")}.`);
  }

  return localState;
}

function mcpReloadHint(mcpConfigResult) {
  if (mcpConfigResult.status === "unchanged") {
    return "";
  }
  return " If your AI/MCP client was already open, reopen the session to reload the server.";
}

function mcpStateLabel(mcpShield) {
  switch (mcpShield?.state) {
    case "ready":
      return "Ready";
    case "fallback_ready":
      return "Native missing; fallback ready";
    case "degraded":
      return "Needs attention";
    default:
      return "Unknown";
  }
}

function mcpStateTone(mcpShield) {
  switch (mcpShield?.state) {
    case "ready":
      return "success";
    case "fallback_ready":
      return "warning";
    case "degraded":
      return "danger";
    default:
      return "neutral";
  }
}

function codexMcpStateLabel(codexMcp) {
  switch (codexMcp?.status) {
    case "configured":
    case "registered":
    case "updated":
      return "registered";
    case "needs_update":
      return "needs update";
    case "update_declined":
      return "update skipped";
    case "not_configured":
      return "not registered";
    case "unavailable":
      return "CLI unavailable";
    case "timeout":
      return "check timed out";
    case "error":
      return "check failed";
    default:
      return "unknown";
  }
}

function shouldWarnAboutCodexMcp(codexMcp) {
  return codexMcp?.status === "not_configured"
    || codexMcp?.status === "needs_update"
    || codexMcp?.status === "update_declined"
    || codexMcp?.status === "unavailable"
    || codexMcp?.status === "timeout"
    || codexMcp?.status === "error";
}

function shouldOfferCodexMcpManualCommand(codexMcp) {
  return Boolean(codexMcp?.suggestedCommand) && shouldWarnAboutCodexMcp(codexMcp);
}

function logCodexMcpDiagnostics(codexMcp) {
  log(`Codex MCP: ${codexMcpStateLabel(codexMcp)}. ${codexMcp?.message || "No Codex MCP diagnostic message."}`);
  if (shouldOfferCodexMcpManualCommand(codexMcp)) {
    log(`Codex MCP registration command: ${codexMcp.suggestedCommand}`);
    log("Codex MCP note: this command only registers the portable bootstrap; it does not copy bridge tokens into shared config.");
  }
}

function codexMcpConfigureSummary(codexMcp) {
  const label = codexMcpStateLabel(codexMcp);
  if (codexMcp?.restartRequired) {
    return ` Codex MCP: ${label}. Restart or reopen the Codex session so the MCP tools are loaded.`;
  }
  if (shouldOfferCodexMcpManualCommand(codexMcp)) {
    return ` Codex MCP: ${label}. Use Copy Command or see the Amarillo output for the manual registration command.`;
  }
  return ` Codex MCP: ${label}.`;
}

async function confirmCodexMcpUpdate(codexMcp) {
  const choice = await vscode.window.showWarningMessage(
    `${codexMcp?.message || "Codex MCP already has an amarillo server."} Update it to this workspace?`,
    "Update Codex MCP",
    "Keep Existing"
  );
  return choice === "Update Codex MCP";
}

async function showConfigureMcpMessage(message, codexMcp) {
  const actions = shouldOfferCodexMcpManualCommand(codexMcp) ? ["Copy Command"] : [];
  const choice = shouldWarnAboutCodexMcp(codexMcp)
    ? await vscode.window.showWarningMessage(message, ...actions)
    : await vscode.window.showInformationMessage(message, ...actions);
  if (choice === "Copy Command" && codexMcp?.suggestedCommand) {
    await vscode.env.clipboard.writeText(codexMcp.suggestedCommand);
    vscode.window.showInformationMessage("Codex MCP command copied. Run it, then restart or reopen the Codex session.");
  }
}

// formatElapsedMs is imported from sidebar.ts as sidebarFormatElapsedMs
const formatElapsedMs = sidebarFormatElapsedMs;

function studioContactTone(session) {
  switch (session?.studioContactState) {
    case "critical":
      return "danger";
    case "stale":
      return "warning";
    case "fresh":
      return "success";
    default:
      return "neutral";
  }
}

function studioContactLabel(session) {
  const ageLabel = session?.studioContactAgeMs === null || session?.studioContactAgeMs === undefined
    ? "unknown"
    : formatElapsedMs(session.studioContactAgeMs);
  switch (session?.studioContactState) {
    case "critical":
      return `No contact for ${ageLabel}`;
    case "stale":
      return `Delayed ${ageLabel}`;
    case "fresh":
      return `Fresh ${ageLabel}`;
    default:
      return "Unknown";
  }
}

function describePluginHealth(health) {
  const sessions = Array.isArray(health?.sessions) ? health.sessions : [];
  const activeSession = resolveActiveSessionFromHealth({ sessions })
    || sessions[0]
    || null;
  const offer = health?.connectionOffer || null;

  if (!activeSession) {
    if (offer?.status === "pending") {
      return {
        tone: "warning",
        headline: "Plugin: waiting for Roblox Studio",
        message: `Plugin: no active Studio session yet. Handshake is ${handshakeStatusLabel(offer)}.`,
        details: [
          `Offer ${offer.offerId || "-"} requested by ${offer.requestedBy || "unknown"}.`,
          "Open the Amarillo plugin in Roblox Studio and accept the connection."
        ]
      };
    }
    if (offer?.status === "declined") {
      return {
        tone: "warning",
        headline: "Plugin: connection declined",
        message: "Plugin: Roblox Studio declined the last connection offer.",
        details: [
          "Run Start Bridge again and accept the new connection in Studio."
        ]
      };
    }
    if (offer?.status === "accepted" && offer.sessionId) {
      return {
        tone: "warning",
        headline: "Plugin: accepted but no session",
        message: `Plugin: Studio accepted the offer, but session ${offer.sessionId} is not active.`,
        details: [
          "Reload the Roblox Studio plugin and run Start Bridge again if the session does not appear."
        ]
      };
    }
    return {
      tone: "warning",
      headline: "Plugin: not connected",
      message: "Plugin: no active Roblox Studio session is connected.",
      details: [
        "Start Bridge, open the Amarillo plugin in Roblox Studio, click Connect, then choose the source of truth."
      ]
    };
  }

  const projectName = activeSession.projectName || activeSession.projectId || "unknown";
  const sessionState = activeSession.connectionState || "ready";
  const syncState = activeSession.syncState || "unknown";
  const contactLabel = studioContactLabel(activeSession);
  const versionState = activeSession.versionState || "unknown";
  const details = [
    `Project=${projectName}; session=${activeSession.id || "-"}; state=${sessionState}; sync=${syncState}; Studio contact=${contactLabel}.`,
    `Plugin version=${activeSession.pluginVersion || "unknown"}; protocol=${activeSession.pluginProtocolVersion ?? "unknown"}; compatibility=${versionState}.`
  ];

  if (activeSession.lastCommandError) {
    details.push(`Last command error: ${activeSession.lastCommandError}`);
  }
  if (activeSession.lastSyncError) {
    details.push(`Last sync error: ${activeSession.lastSyncError}`);
  }

  if (activeSession.requiresPluginUpdate) {
    return {
      tone: "danger",
      headline: "Plugin: update required",
      message: `Plugin: connected to ${projectName}, but the Studio plugin must be updated.`,
      details: [
        activeSession.versionMessage || "Plugin update required before sync can continue.",
        ...details
      ]
    };
  }
  if (activeSession.pluginUpdateAvailable) {
    return {
      tone: "warning",
      headline: "Plugin: update available",
      message: `Plugin: connected to ${projectName}, but Roblox Studio is running an older Amarillo plugin.`,
      details: [
        activeSession.versionMessage || "Reload or reopen Roblox Studio so it runs the latest local plugin file.",
        ...details
      ]
    };
  }
  if (activeSession.requiresManualResync) {
    return {
      tone: "warning",
      headline: "Plugin: sync paused",
      message: `Plugin: connected to ${projectName}, but sync is paused.`,
      details: [
        activeSession.syncMessage || "Manual resync is required before automatic sync continues.",
        ...details
      ]
    };
  }
  if (activeSession.studioContactState === "critical") {
    return {
      tone: "danger",
      headline: "Plugin: Studio contact lost",
      message: `Plugin: connected to ${projectName}, but Studio has not polled recently.`,
      details: [
        activeSession.studioContactMessage || "Studio contact is critical.",
        ...details
      ]
    };
  }
  if (activeSession.studioContactState === "stale") {
    return {
      tone: "warning",
      headline: "Plugin: Studio contact delayed",
      message: `Plugin: connected to ${projectName}, but Studio contact is delayed.`,
      details: [
        activeSession.studioContactMessage || "Studio contact is stale.",
        ...details
      ]
    };
  }
  if (sessionState !== "ready") {
    return {
      tone: "warning",
      headline: `Plugin: session ${sessionState}`,
      message: `Plugin: session for ${projectName} is ${sessionState}.`,
      details
    };
  }

  return {
    tone: "success",
    headline: "Plugin: connected",
    message: `Plugin: connected to ${projectName}.`,
    details
  };
}

function samePath(left, right) {
  if (!left || !right) {
    return false;
  }
  return path.resolve(left) === path.resolve(right);
}

function buildWorkspaceTooltip(settings, health) {
  if (!settings && !health?.workspaceRoot) {
    return "Open a folder in VS Code to use Amarillo.";
  }

  const lines = [];
  if (settings) {
    lines.push(`Configured workspace: ${workspaceDisplayName(settings.workspaceRoot)}`);
  }
  if (health?.workspaceRoot) {
    if (settings && !samePath(settings.workspaceRoot, health.workspaceRoot)) {
      lines.push("Daemon workspace: another workspace is active on this port.");
      lines.push("Stop the old bridge or start the bridge from this folder.");
    } else {
      lines.push(`Daemon workspace: ${workspaceDisplayName(health.workspaceRoot)}`);
    }
  }
  return lines.join("\n");
}

function daemonMatchesWorkspace(settings, health) {
  if (!settings || !health?.workspaceRoot) {
    return true;
  }
  return samePath(settings.workspaceRoot, health.workspaceRoot);
}

function connectionHandshakeKey(settings) {
  if (!settings?.workspaceRoot) {
    return null;
  }
  return `${path.resolve(settings.workspaceRoot)}|${settings.host}|${settings.port}`;
}

function resetSidebarHandshakeCycle() {
  bridgeState.resetHandshakeCycle();
}

function beginSidebarHandshakeCycle(settings) {
  const nextKey = connectionHandshakeKey(settings);
  bridgeState.beginHandshakeCycle(nextKey);
}

function readySessionsFromHealth(health) {
  const sessions = Array.isArray(health?.sessions) ? health.sessions : [];
  return sessions.filter((session) => (session.connectionState || "ready") === "ready");
}

function resolveActiveSessionFromHealth(health) {
  const readySessions = readySessionsFromHealth(health);
  const activeSessionId = getActiveSessionId();
  return readySessions.find((session) => session.id === activeSessionId)
    || readySessions[0]
    || null;
}

function effectiveSourcemapProjectFileFromHealth(workspaceRoot, health) {
  const activeSession = resolveActiveSessionFromHealth(health);
  const projectPath = activeSession?.projectPath || health?.defaultProjectPath || null;
  if (!projectPath) {
    return null;
  }
  return path.resolve(workspaceRoot, projectPath);
}

async function syncLuauSourcemapToDaemonState(workspaceRoot, health: BridgeHealthPayload, options: SourcemapEnsureOptions = {}) {
  const projectFiles = collectProjectFiles(workspaceRoot);
  if (projectFiles.length === 0) {
    return null;
  }

  return ensureWorkspaceLuauSourcemap(workspaceRoot, {
    projectFilePath: effectiveSourcemapProjectFileFromHealth(workspaceRoot, health),
    projectFiles
  }, options);
}

function handshakeStatusLabel(offer) {
  switch (offer?.status) {
    case "pending":
      return "waiting for Studio";
    case "declined":
      return "recusado";
    case "accepted":
      return "aceito";
    case "ready":
      return "connected";
    default:
      return "no offer";
  }
}

function isFallbackProjectSelection(session) {
  return Boolean(session?.projectSelectionReason)
    && session.projectSelectionReason !== "place_match"
    && session.projectSelectionReason !== "preferred_project";
}

function describeProjectSelection(session) {
  switch (session?.projectSelectionReason) {
    case "configured_default":
      return "configured default";
    case "no_place_filter":
      return "fallback without place_id";
    case "first_available":
      return "first available project";
    case "preferred_project":
      return "manual selection";
    case "place_match":
      return "matched by place_id";
    default:
      return "automatic resolution";
  }
}

// sidebarTone, createSidebarFact, createSidebarAction imported from sidebar.ts

// sidebarErrorMessage imported from sidebar.ts

// buildSidebarLoadingState imported from sidebar.ts

// buildSidebarErrorState imported from sidebar.ts

function withSidebarTimeout(promise, timeoutMs, label) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout])
    .finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
}

async function readSidebarRuntimeState(): Promise<SidebarRuntimeState> {
  const runtimeState: SidebarRuntimeState = {
    settings: null,
    settingsError: null,
    health: null,
    healthError: null,
    healthDurationMs: 0,
    projectsPayload: null,
    projectsError: null,
    activity: [],
    activityError: null
  };

  let settings;
  try {
    settings = getBridgeSettings();
    runtimeState.settings = settings;
  } catch (error) {
    runtimeState.settingsError = sidebarErrorMessage(error);
    return runtimeState;
  }

  const healthStartedAt = Date.now();
  try {
    runtimeState.health = await fetchDaemonHealth({ timeout: SIDEBAR_HEALTH_TIMEOUT_MS });
    runtimeState.healthDurationMs = Date.now() - healthStartedAt;
    log(`Sidebar health check OK in ${runtimeState.healthDurationMs}ms.`);
  } catch (error) {
    runtimeState.healthDurationMs = Date.now() - healthStartedAt;
    runtimeState.healthError = sidebarErrorMessage(error);
    log(`Sidebar health check failed after ${runtimeState.healthDurationMs}ms: ${runtimeState.healthError}`);
  }

  if (runtimeState.health?.ok && daemonMatchesWorkspace(settings, runtimeState.health)) {
    try {
      runtimeState.projectsPayload = await requestJson<Record<string, any>>("GET", "/projects", undefined, { timeout: 2500 });
    } catch (error) {
      runtimeState.projectsError = sidebarErrorMessage(error);
      log(`Sidebar projects failed: ${runtimeState.projectsError}`);
    }

    try {
      runtimeState.activity = await fetchRecentActivity(10);
    } catch (error) {
      runtimeState.activityError = sidebarErrorMessage(error);
      log(`Sidebar activity history failed: ${runtimeState.activityError}`);
    }
  }

  return runtimeState;
}

async function getSidebarState(runtimeState: SidebarRuntimeState | null = null) {
  const sidebarRuntime = runtimeState || await readSidebarRuntimeState();
  const settings = sidebarRuntime.settings || null;
  const health = sidebarRuntime.health || null;
  const healthError = sidebarRuntime.healthError || null;
  const settingsError = sidebarRuntime.settingsError || null;

  const running = Boolean(health?.ok);
  const workspaceMatches = daemonMatchesWorkspace(settings, health);
  const sessions = workspaceMatches && Array.isArray(health?.sessions) ? health.sessions : [];
  const readySessions = readySessionsFromHealth({ sessions });
  const activeSession = resolveActiveSessionFromHealth({ sessions })
    || sessions[0]
    || null;
  const pendingPlaceSetup: any = workspaceMatches ? (health?.pendingPlaceSetup || null) : null;
  const connectionOffer = workspaceMatches ? (health?.connectionOffer || null) : null;
  const visibleWorkspaceRoot = workspaceMatches
    ? (health?.workspaceRoot || settings?.workspaceRoot || null)
    : (settings?.workspaceRoot || null);
  const autoSyncToStudio = workspaceMatches
    ? (health?.autoSyncToStudio ?? settings?.autoSyncToStudio ?? true)
    : (settings?.autoSyncToStudio ?? true);
  const privilegedActionConfirmation = settings?.privilegedActionConfirmation ?? health?.privilegedActionConfirmation ?? true;
  const mcpShield = workspaceMatches ? (health?.mcpShield || null) : null;
  const workspaceTooltip = buildWorkspaceTooltip(settings, health);
  const workspaceNotes = workspaceTooltip
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (settingsError) {
    workspaceNotes.push(`Workspace settings failed: ${settingsError}`);
  }
  if (healthError) {
    workspaceNotes.push(`Bridge health check failed: ${healthError}`);
  }
  if (sidebarRuntime.activityError) {
    workspaceNotes.push(`Sync history failed: ${sidebarRuntime.activityError}`);
  }
  if (sidebarRuntime.projectsError) {
    workspaceNotes.push(`Project list failed: ${sidebarRuntime.projectsError}`);
  }
  const activityEntries = Array.isArray(sidebarRuntime.activity) ? sidebarRuntime.activity : [];
  const projectsPayload = sidebarRuntime.projectsPayload || {};
  const projects = workspaceMatches && Array.isArray(projectsPayload.projects) ? projectsPayload.projects : [];

  let statusTone = "neutral";
  if (running && activeSession && workspaceMatches) {
    statusTone = activeSession.requiresPluginUpdate
      ? "danger"
      : (activeSession.pluginUpdateAvailable || activeSession.requiresManualResync
        ? "warning"
        : (activeSession.studioContactState === "critical"
          ? "danger"
          : (activeSession.studioContactState === "stale" ? "warning" : "success")));
  } else if (!running) {
    statusTone = "danger";
  } else if (!workspaceMatches || connectionOffer?.status === "declined") {
    statusTone = "warning";
  } else if (running) {
    statusTone = "info";
  }

  const sessionFacts = [];
  const sessionActions = [createSidebarAction("Refresh Sidebar", "amarillo.refreshSidebar")];
  let sessionTitle = "Studio Session";
  let sessionTone = "neutral";
  let sessionBadge = "No session";
  let sessionMessage = "No session connected in Studio.";

  if (activeSession) {
    const sessionReady = (activeSession.connectionState || "ready") === "ready";
    sessionTone = activeSession.requiresPluginUpdate
      ? "danger"
      : (activeSession.pluginUpdateAvailable
        ? "warning"
        : (activeSession.requiresManualResync
        ? "warning"
        : (activeSession.studioContactState === "critical"
          ? "danger"
          : (activeSession.studioContactState === "stale"
            ? "warning"
            : (sessionReady ? "success" : "warning")))));
    sessionBadge = activeSession.requiresPluginUpdate
      ? "Plugin update required"
      : (activeSession.pluginUpdateAvailable
        ? "Plugin update available"
        : (activeSession.requiresManualResync
        ? "sync paused"
        : (activeSession.studioContactState === "critical"
          ? "Plugin stale"
          : (activeSession.studioContactState === "stale"
            ? "Contact delayed"
            : (activeSession.connectionState || "ready")))));
    if (activeSession.requiresPluginUpdate) {
      sessionMessage = activeSession.versionMessage || "Plugin update required before sync can continue.";
    } else if (activeSession.pluginUpdateAvailable) {
      sessionMessage = activeSession.versionMessage || "A newer Amarillo Studio plugin is installed locally. Reload or reopen Roblox Studio to use it.";
    } else if (activeSession.requiresManualResync) {
      sessionMessage = activeSession.syncMessage || "Sync paused until a manual resync is completed.";
    } else if (activeSession.studioContactState === "critical") {
      sessionMessage = `${activeSession.studioContactMessage || "Plugin contact is stale."} Destructive MCP actions are blocked until Studio polls the daemon again.`;
    } else if (activeSession.studioContactState === "stale") {
      sessionMessage = `${activeSession.studioContactMessage || "Plugin contact is delayed."} HTTP fallback is available, but destructive MCP actions wait for a fresh Studio poll.`;
    } else if (mcpShield?.state === "fallback_ready") {
      sessionMessage = "Native MCP not detected. HTTP fallback is available while the daemon stays online.";
    } else if (mcpShield?.state === "degraded") {
      sessionMessage = `MCP needs attention. ${mcpShield.message || "Check the MCP healthcheck for details."}`;
    } else {
      sessionMessage = activeSession.syncMessage || activeSession.projectSelectionMessage || "Session ready to sync with Studio.";
    }
    sessionFacts.push(
      createSidebarFact(
        "Project",
        activeSession.projectName,
        isFallbackProjectSelection(activeSession) ? "warning" : "success"
      ),
      createSidebarFact("State", activeSession.connectionState || "ready", sessionTone),
      createSidebarFact("Version", activeSession.versionState || "unknown", activeSession.requiresPluginUpdate ? "danger" : (activeSession.pluginUpdateAvailable ? "warning" : "success")),
      createSidebarFact("Sync", activeSession.syncState || "ready", activeSession.requiresManualResync || activeSession.requiresPluginUpdate ? "warning" : "success"),
      createSidebarFact("Place", String(activeSession.placeId || 0)),
      createSidebarFact("Session", activeSession.id),
      createSidebarFact("Ready sessions", String(readySessions.length), readySessions.length > 0 ? "success" : "neutral")
    );
    if (activeSession.studioContactState && activeSession.studioContactState !== "fresh") {
      sessionFacts.push(
        createSidebarFact("Studio", studioContactLabel(activeSession), studioContactTone(activeSession))
      );
    }
    if (visibleWorkspaceRoot) {
      sessionFacts.push(createSidebarFact("Workspace", workspaceDisplayName(visibleWorkspaceRoot)));
    }
    if (isFallbackProjectSelection(activeSession)) {
      sessionFacts.push(
        createSidebarFact(
          "Routing",
          describeProjectSelection(activeSession),
          "warning"
        )
      );
    }
    sessionActions.unshift(createSidebarAction("Select Session", "amarillo.selectSession", "primary"));
  } else if (!workspaceMatches && health?.workspaceRoot) {
    sessionTone = "warning";
    sessionBadge = "Conflict";
    sessionMessage = "There is an active daemon in another folder on this port. Stop the old bridge or start the bridge from this folder.";
    sessionFacts.push(
      createSidebarFact("Status", "Daemon from another workspace", "warning"),
      createSidebarFact("Daemon", workspaceDisplayName(health.workspaceRoot), "warning")
    );
    if (visibleWorkspaceRoot) {
      sessionFacts.push(createSidebarFact("Current workspace", workspaceDisplayName(visibleWorkspaceRoot)));
    }
  } else if (pendingPlaceSetup) {
    sessionTone = "warning";
    sessionBadge = "Place setup";
    sessionMessage = String(pendingPlaceSetup.message || "Create a place project before syncing this Roblox place.");
    sessionFacts.push(
      createSidebarFact("Place", `${pendingPlaceSetup.placeName || "Unknown"} (${pendingPlaceSetup.placeId || 0})`, "warning"),
      createSidebarFact("Project", String(pendingPlaceSetup.suggestedProjectId || "-"), "warning")
    );
  } else if (connectionOffer) {
    sessionTone = connectionOffer.status === "declined" ? "warning" : "info";
    sessionBadge = handshakeStatusLabel(connectionOffer);
    sessionMessage = `Handshake ${handshakeStatusLabel(connectionOffer)}.`;
    sessionFacts.push(
      createSidebarFact("Status", handshakeStatusLabel(connectionOffer), sessionTone)
    );
    if (visibleWorkspaceRoot) {
      sessionFacts.push(createSidebarFact("Workspace", workspaceDisplayName(visibleWorkspaceRoot)));
    }
  } else {
    sessionTone = running ? "warning" : "danger";
    sessionBadge = running ? "No session" : "Offline";
    if (!running) {
      sessionMessage = healthError
        ? `Bridge health check failed: ${healthError}.`
        : "Bridge offline. Start the bridge to connect Roblox Studio.";
      sessionFacts.push(createSidebarFact("Bridge", "Offline", "danger"));
      sessionActions.unshift(createSidebarAction("Start Bridge", "amarillo.startBridge", "primary"));
    }
    if (visibleWorkspaceRoot) {
      sessionFacts.push(createSidebarFact("Workspace", workspaceDisplayName(visibleWorkspaceRoot)));
    }
  }

  if (settings || health?.ok) {
    if (mcpShield) {
      sessionFacts.push(
        createSidebarFact("MCP", mcpStateLabel(mcpShield), mcpStateTone(mcpShield))
      );
    }
    sessionFacts.push(
      createSidebarFact(
        "VS Code -> Studio",
        autoSyncToStudio ? "Auto" : "Manual",
        autoSyncToStudio ? "success" : "warning"
      ),
      createSidebarFact(
        "Confirm actions",
        privilegedActionConfirmation ? "On" : "Off",
        privilegedActionConfirmation ? "success" : "warning"
      )
    );
  }

  // Proactive degradation notification
  if (activeSession && activeSession.requiresManualResync && bridgeState.lastDegradedNotifiedSessionId !== activeSession.id) {
    bridgeState.lastDegradedNotifiedSessionId = activeSession.id;
    const degradedMessage = activeSession.syncMessage || "Sync paused. A manual resync is required.";
    vscode.window.showWarningMessage(
      `Amarillo: ${degradedMessage}`,
      "Resync",
      "Dismiss"
    ).then((action) => {
      if (action === "Resync") {
        vscode.commands.executeCommand("amarillo.sendFilesToStudio");
      }
    });
  } else if (activeSession && !activeSession.requiresManualResync && bridgeState.lastDegradedNotifiedSessionId === activeSession.id) {
    bridgeState.lastDegradedNotifiedSessionId = null;
  }

  return {
    status: {
      title: running ? "Bridge online" : "Bridge offline",
      version: extensionVersion(),
      tone: sidebarTone(statusTone),
      endpoint: settings ? `${settings.host}:${settings.port}` : "no workspace",
      workspace: visibleWorkspaceRoot ? workspaceDisplayName(visibleWorkspaceRoot) : "no workspace",
      notes: workspaceNotes
    },
    session: {
      title: sessionTitle,
      tone: sidebarTone(sessionTone),
      badge: sessionBadge,
      message: sessionMessage,
      facts: sessionFacts,
      actions: sessionActions
    },
    placeSync: buildSidebarPlaceSyncState({
      running,
      workspaceMatches,
      pendingPlaceSetup,
      projects,
      projectsPayload,
      projectsError: sidebarRuntime.projectsError || null,
      health
    }),
    sections: [
      {
        title: "Places",
        description: pendingPlaceSetup
          ? `Setup required for ${pendingPlaceSetup.placeName || "this place"} (${pendingPlaceSetup.placeId || 0}).`
          : (activeSession
            ? `Current place ${activeSession.placeName || activeSession.projectName || "Studio"} (${activeSession.placeId || 0}).`
            : "Create and edit place project mappings."),
        actions: [
          createSidebarAction("Create Place Project", "amarillo.createPlaceProject", "primary"),
          createSidebarAction("Edit Place IDs", "amarillo.editPlaceIds")
        ]
      },
      {
        title: "Sync",
        description: "Send and receive files for the active session.",
        actions: [
          createSidebarAction(autoSyncToStudio ? "Auto Sync: On" : "Auto Sync: Off", "amarillo.toggleAutoSyncToStudio", autoSyncToStudio ? "primary" : "secondary"),
          createSidebarAction("Send Files to Studio", "amarillo.sendFilesToStudio", "primary"),
          createSidebarAction("Receive Files from Studio", "amarillo.receiveFilesFromStudio", "primary"),
          createSidebarAction("Select Session", "amarillo.selectSession")
        ]
      },
      {
        title: "Safety",
        description: "Control privileged Studio actions.",
        actions: [
          createSidebarAction(privilegedActionConfirmation ? "Confirm Actions: On" : "Confirm Actions: Off", "amarillo.togglePrivilegedActionConfirmation", privilegedActionConfirmation ? "primary" : "secondary")
        ]
      },
      {
        title: "Bridge",
        description: "Daemon control and quick diagnostics.",
        actions: [
          createSidebarAction("Start Bridge", "amarillo.startBridge", "primary"),
          createSidebarAction("Stop Bridge", "amarillo.stopBridge"),
          createSidebarAction("Healthcheck", "amarillo.healthcheck"),
          createSidebarAction("Doctor", "amarillo.doctor"),
          createSidebarAction("Open Output", "amarillo.openOutput")
        ]
      },
      {
        title: "Setup",
        description: "Initial setup and integrations.",
        actions: [
          createSidebarAction("Install Roblox Plugin", "amarillo.installRobloxPlugin"),
          createSidebarAction("Configure MCP", "amarillo.configureMcp"),
          createSidebarAction("MCP Healthcheck", "amarillo.mcpHealthcheck")
        ]
      }
    ],
    history: {
      entries: activityEntries,
      error: sidebarRuntime.activityError || null
    }
  };
}

// escapeHtml, renderSidebarFact, renderSidebarAction, renderSidebarSection imported from sidebar.ts

// Activity renderers, renderSidebarHtml, renderSidebarFatalHtml imported from sidebar.ts



async function ensurePathExists(targetPath, label) {
  try {
    await fs.access(targetPath);
  } catch (error) {
    throw new Error(`${label} not found at: ${targetPath}`);
  }
}

function resolveRobloxPluginInstallPaths(context) {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not available on this system.");
  }

  const pluginsDir = path.join(localAppData, "Roblox", "Plugins");
  const targetPath = path.join(pluginsDir, "Amarillo.lua");

  let sourcePath = null;
  try {
    const workspaceRoot = resolveWorkspaceRoot();
    const workspaceSource = path.join(workspaceRoot, "src", "plugin", "Amarillo.lua");
    if (syncFs.existsSync(workspaceSource)) {
      sourcePath = workspaceSource;
    }
  } catch (_error) {
    // No workspace open, try runtime.
  }

  if (!sourcePath) {
    sourcePath = runtimePath(context, "plugin", "Amarillo.lua");
  }

  return { pluginsDir, sourcePath, targetPath };
}

async function copyBundledRobloxPlugin(context, options: { force?: boolean } = {}) {
  const { pluginsDir, sourcePath, targetPath } = resolveRobloxPluginInstallPaths(context);
  await ensurePathExists(sourcePath, "Plugin Amarillo");
  const targetExists = syncFs.existsSync(targetPath);
  if (!options.force && targetExists && await filesMatch(sourcePath, targetPath)) {
    return {
      ok: true,
      status: "up_to_date",
      sourcePath,
      targetPath
    };
  }

  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return {
    ok: true,
    status: targetExists ? "updated" : "installed",
    sourcePath,
    targetPath
  };
}

function updateStatusBar(sessionCount = null) {
  if (!statusBar) {
    return;
  }

  const info = bridgeState.statusBarInfo(sessionCount || 0);
  statusBar.text = info.text;
  statusBar.tooltip = info.tooltip;
  statusBar.command = "amarillo.openMenu";
  statusBar.show();
}

function refreshSidebar() {
  if (!sidebarProvider) {
    return;
  }
  bridgeState.clearSidebarRefreshTimer();
  bridgeState.sidebarRefreshTimer = setTimeout(() => {
    bridgeState.sidebarRefreshTimer = null;
    if (!bridgeState.sidebarRefreshInFlight) {
      bridgeState.sidebarRefreshInFlight = sidebarProvider.refresh()
        .catch((error) => log(`Sidebar refresh failed unexpectedly: ${sidebarErrorMessage(error)}`))
        .finally(() => {
          bridgeState.sidebarRefreshInFlight = null;
        });
    }
  }, 75);
}

function bridgeBaseUrl() {
  const { host, port } = getBridgeSettings();
  return `http://${hostForUrl(host)}:${port}`;
}

function requestJson<TResponse = ExtensionJsonObject>(
  method,
  route,
  body: unknown = undefined,
  options: RequestJsonOptions = {}
): Promise<TResponse> {
  const settings = getBridgeSettings();
  const url = new URL(route, `http://${hostForUrl(settings.host)}:${settings.port}/`);
  const timeout = options.timeout ?? 5000;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  const token = bridgeAuthRequiredForHost(settings.host) || options.forceBridgeToken === true
    ? (options.bridgeToken || getOrCreateBridgeToken())
    : null;
  if (token) {
    headers["X-Amarillo-Bridge-Token"] = token;
  }

  return new Promise((resolve, reject) => {
    const maxResponseBytes = Number(options.maxResponseBytes) > 0
      ? Number(options.maxResponseBytes)
      : DEFAULT_MAX_JSON_RESPONSE_BYTES;
    const request = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      timeout,
      headers
    }, (response) => {
      const contentLength = Number(response.headers["content-length"] || 0);
      if (contentLength > maxResponseBytes) {
        response.resume();
        reject(new Error(`HTTP response exceeds ${maxResponseBytes} bytes.`));
        return;
      }
      const responseChunks: string[] = [];
      let responseBytes = 0;
      let responseTooLarge = false;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        if (responseTooLarge) {
          return;
        }
        responseBytes += Buffer.byteLength(chunk, "utf8");
        if (responseBytes > maxResponseBytes) {
          responseTooLarge = true;
          response.destroy(new Error(`HTTP response exceeds ${maxResponseBytes} bytes.`));
          reject(new Error(`HTTP response exceeds ${maxResponseBytes} bytes.`));
          return;
        }
        responseChunks.push(chunk);
      });
      response.on("end", () => {
        if (responseTooLarge) {
          return;
        }
        const responseBody = responseChunks.join("");
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}: ${responseBody}`));
          return;
        }
        try {
          resolve(responseBody ? JSON.parse(responseBody) : {});
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });

    request.on("error", reject);

    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }

    request.end();
  });
}

function reportExtensionError(message, options: ExtensionErrorOptions = {}) {
  if (!message) {
    return;
  }
  try {
    void requestJson("POST", "/errors/add", {
      component: "extension",
      severity: options.severity || "error",
      code: options.code || "EXTENSION",
      message: String(message),
      context: options.context || null
    }, { timeout: 1000 }).catch(() => {});
  } catch (_error) {
    // Reporting must never interrupt the user-facing error path.
  }
}

function workspaceFileOperationPath(uri) {
  if (!uri || (uri.scheme && uri.scheme !== "file") || !uri.fsPath) {
    return null;
  }

  let workspaceRoot;
  try {
    workspaceRoot = resolveWorkspaceRoot();
  } catch (_error) {
    return null;
  }

  const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }

  if (shouldIgnoreProjectDiscoveryPath(relativePath)) {
    return null;
  }

  return uri.fsPath;
}

async function notifyWorkspaceFileOperation(source, events) {
  const filteredEvents = events.filter(Boolean);
  if (filteredEvents.length === 0) {
    return;
  }
  invalidateProjectFileCacheForEvents(filteredEvents);

  try {
    const settings = getBridgeSettings();
    const health = await fetchDaemonHealth();
    if (!daemonMatchesWorkspace(settings, health)) {
      return;
    }

    const response = await requestJson<WorkspaceFilesChangedResponse>("POST", "/workspace/files-changed", {
      source,
      events: filteredEvents
    }, { timeout: 3000 });

    if (response.accepted > 0) {
      log(`Forwarded ${response.accepted} VS Code file operation path(s) to the daemon.`);
    }
  } catch (error) {
    if (bridgeState.hasLiveProcess) {
      log(`Failed to forward VS Code file operation: ${error.message}`);
    }
  }
}

function registerWorkspaceFileOperationWatchers(context) {
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((event) => {
      const events = event.files
        .map((file) => {
          const oldPath = workspaceFileOperationPath(file.oldUri);
          const newPath = workspaceFileOperationPath(file.newUri);
          if (!oldPath && !newPath) {
            return null;
          }
          return {
            type: "vscode_rename",
            oldPath,
            newPath
          };
        });
      void notifyWorkspaceFileOperation("vscode_rename", events);
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      const events = event.files
        .map((uri) => {
          const filePath = workspaceFileOperationPath(uri);
          return filePath
            ? { type: "vscode_create", path: filePath }
            : null;
        });
      void notifyWorkspaceFileOperation("vscode_create", events);
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      const events = event.files
        .map((uri) => {
          const filePath = workspaceFileOperationPath(uri);
          return filePath
            ? { type: "vscode_delete", path: filePath }
            : null;
        });
      void notifyWorkspaceFileOperation("vscode_delete", events);
    })
  );
}

async function fetchDaemonHealth(options: RequestJsonOptions = {}): Promise<BridgeHealthPayload> {
  return requestJson<BridgeHealthPayload>("GET", "/health", undefined, options);
}

async function fetchRecentActivity(limit = 10): Promise<ActivityEntryPayload[]> {
  const response = await requestJson<ActivityListResponse>(
    "GET",
    `/activity?limit=${encodeURIComponent(String(limit))}&includeDetails=true`,
    undefined,
    { timeout: 1500 }
  );
  return Array.isArray(response.entries) ? response.entries : [];
}

function buildHealthcheckRouteProbes(health) {
  const probes = [
    { label: "Daemon health", method: "GET", route: "/health" },
    { label: "Doctor report", method: "GET", route: "/doctor", timeout: 10000 },
    { label: "Project catalog", method: "GET", route: "/projects" },
    { label: "Studio offer poll", method: "GET", route: "/studio/poll" },
    { label: "Sync state", method: "GET", route: "/debug/sync-state" },
    { label: "Activity summary", method: "GET", route: "/activity/summary" },
    { label: "Recent activity", method: "GET", route: "/activity?limit=1" },
    { label: "Errors summary", method: "GET", route: "/errors/summary" },
    { label: "Recent errors", method: "GET", route: "/errors?limit=1" },
    { label: "MCP auth help", method: "GET", route: "/mcp/auth-help" },
    { label: "MCP status", method: "GET", route: "/mcp/status" },
    { label: "MCP tools", method: "GET", route: "/mcp/tools" },
    { label: "MCP health probe", method: "POST", route: "/mcp/probe", body: {}, timeout: 10000 }
  ];

  for (const session of Array.isArray(health?.sessions) ? health.sessions : []) {
    if (!session?.id) {
      continue;
    }
    probes.push({
      label: `Session status: ${session.projectName || session.projectId || session.id}`,
      method: "GET",
      route: `/session/${encodeURIComponent(session.id)}/status`
    });
  }

  return probes;
}

async function runHealthcheckRouteProbe(probe) {
  const startedAt = Date.now();
  try {
    await requestJson(probe.method, probe.route, probe.body, { timeout: probe.timeout ?? 5000 });
    return {
      ...probe,
      ok: true,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ...probe,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runHealthcheckRouteProbes(health) {
  const probes = buildHealthcheckRouteProbes(health);
  return Promise.all(probes.map((probe) => runHealthcheckRouteProbe(probe)));
}

function logHealthcheckRouteResults(results) {
  const passed = results.filter((result) => result.ok).length;
  log(`Healthcheck routes: ${passed}/${results.length} OK.`);
  for (const result of results) {
    const status = result.ok ? "OK" : "FAIL";
    const error = result.error ? ` error=${result.error}` : "";
    log(`Healthcheck route ${status}: ${result.method} ${result.route} (${result.durationMs}ms) ${result.label}${error}`);
  }
}

async function waitForDaemonOnline(timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetchDaemonHealth();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error("Timed out waiting for the Amarillo daemon to come online.");
}

async function waitForDaemonOffline(timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetchDaemonHealth({ timeout: 1000 });
    } catch (_error) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function requestConnectionOffer(requestedBy = "vscode") {
  const response = await requestJson<ConnectionRequestResponse>("POST", "/connection/request", { requestedBy });
  log(`Connection offer created: ${response.offer?.offerId || "no-id"} (${handshakeStatusLabel(response.offer)})`);
  refreshSidebar();
  return response.offer || null;
}

function sessionQuickPickItem(session, activeSessionId) {
  return {
    label: session.projectName,
    description: `Place ${session.placeId || 0}${session.id === activeSessionId ? " - active" : ""}`,
    detail: `Session ${session.id} - pending ${session.pendingCommands} - last Studio ${session.lastStudioSeenAt || "never"}`,
    session
  };
}

async function chooseSession(forcePick = false) {
  const health = await fetchDaemonHealth();
  const settings = getBridgeSettings();
  if (!daemonMatchesWorkspace(settings, health)) {
    throw new Error("The active daemon on this port belongs to another workspace. Stop the old bridge or start the bridge from this folder.");
  }
  const sessions = readySessionsFromHealth(health);
  if (sessions.length === 0) {
    const pendingSession = Array.isArray(health.sessions)
      ? health.sessions.find((session) => (session.connectionState || "ready") !== "ready")
      : null;
    if (pendingSession) {
      if ((pendingSession.connectionState || "ready") === "error") {
        const detail = pendingSession.lastCommandError
          ? ` ${pendingSession.lastCommandError}`
          : "";
        throw new Error(`The Studio session failed the initial sync.${detail}`);
      }
      throw new Error("The Studio session is still syncing the initial source of truth.");
    }
    if (health.connectionOffer?.status === "pending") {
      throw new Error("Waiting for the Roblox Studio plugin to accept the connection.");
    }
    if (health.connectionOffer?.status === "declined") {
      throw new Error("The connection offer was declined in Roblox Studio. Run Start Bridge to try again.");
    }
    throw new Error("No Studio session connected. Open the Amarillo plugin in Roblox Studio and accept the connection.");
  }

  const activeSessionId = getActiveSessionId();
  if (!forcePick && activeSessionId) {
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    if (activeSession) {
      return activeSession;
    }
  }

  if (!forcePick && sessions.length === 1) {
    await setActiveSessionId(sessions[0].id);
    try {
      await syncLuauSourcemapToDaemonState(settings.workspaceRoot, health);
    } catch (error) {
      log(`Failed to align sourcemap with the active session: ${error.message}`);
    }
    return sessions[0];
  }

  const picked = await vscode.window.showQuickPick(
    sessions.map((session) => sessionQuickPickItem(session, activeSessionId)),
    {
      placeHolder: "Choose the Roblox Studio session connected to Amarillo"
    }
  );

  if (!picked) {
    throw new Error("Session selection canceled.");
  }

  await setActiveSessionId(picked.session.id);
  try {
    await syncLuauSourcemapToDaemonState(settings.workspaceRoot, health);
  } catch (error) {
    log(`Failed to align sourcemap with the active session: ${error.message}`);
  }
  refreshSidebar();
  return picked.session;
}

async function toggleAutoSyncToStudio() {
  const settings = getBridgeSettings();
  let health: BridgeHealthPayload | null = null;
  try {
    health = await fetchDaemonHealth({ timeout: 1500 });
  } catch (_error) {
    health = null;
  }

  const current = health?.ok && daemonMatchesWorkspace(settings, health)
    ? (health.autoSyncToStudio !== false)
    : (settings.autoSyncToStudio !== false);
  const next = !current;
  await vscode.workspace
    .getConfiguration("amarillo")
    .update("autoSyncToStudio", next, vscode.ConfigurationTarget.Workspace);

  if (health?.ok && daemonMatchesWorkspace(settings, health)) {
    await requestJson("POST", "/settings/auto-sync-to-studio", { enabled: next }, { timeout: 3000 });
  }

  refreshSidebar();
  vscode.window.showInformationMessage(`Amarillo Auto Sync ${next ? "enabled" : "disabled"}.`);
}

async function togglePrivilegedActionConfirmation() {
  const settings = getBridgeSettings();
  let health: BridgeHealthPayload | null = null;
  try {
    health = await fetchDaemonHealth({ timeout: 1500 });
  } catch (_error) {
    health = null;
  }

  const current = settings.privilegedActionConfirmation !== false;
  const next = !current;
  await vscode.workspace
    .getConfiguration("amarillo")
    .update("privilegedActionConfirmation", next, vscode.ConfigurationTarget.Workspace);

  if (health?.ok && daemonMatchesWorkspace(settings, health)) {
    await requestJson("POST", "/settings/privileged-action-confirmation", { enabled: next }, { timeout: 3000 });
  }

  refreshSidebar();
  vscode.window.showInformationMessage(`Amarillo privileged action confirmation ${next ? "enabled" : "disabled"}.`);
}

async function fetchActivityEntry(id): Promise<ActivityEntryPayload> {
  const response = await requestJson<ActivityEntryResponse>(
    "GET",
    `/activity/${encodeURIComponent(id)}`,
    undefined,
    { timeout: 3000 }
  );
  if (!response.entry) {
    throw new Error("Activity entry not found.");
  }
  return response.entry;
}

function activityDiffUri(entryId, side, filePathLabel) {
  const extension = path.extname(String(filePathLabel || "")).replace(/[^A-Za-z0-9.]/g, "") || ".txt";
  return vscode.Uri.from({
    scheme: "amarillo-activity",
    path: `/${encodeURIComponent(entryId)}-${side}${extension}`,
    query: `side=${encodeURIComponent(side)}`
  });
}

async function openActivityDiff(id) {
  if (!id) {
    return;
  }
  const entry = await fetchActivityEntry(id);
  const detail = entry.detail || {};
  const hasOld = typeof detail.oldText === "string";
  const hasNew = typeof detail.newText === "string";
  if (!hasOld && !hasNew) {
    vscode.window.showWarningMessage("This history entry only has metadata, so there is no text diff to open.");
    return;
  }

  const label = entry.relativePath || entry.path || id;
  const oldUri = activityDiffUri(id, "before", label);
  const newUri = activityDiffUri(id, "after", label);
  activityDiffDocuments.set(oldUri.toString(), hasOld ? String(detail.oldText) : "");
  activityDiffDocuments.set(newUri.toString(), hasNew ? String(detail.newText) : "");
  await vscode.commands.executeCommand(
    "vscode.diff",
    oldUri,
    newUri,
    `Amarillo Sync: ${label}`
  );
}

function errorMessageFromHttp(error) {
  const message = sidebarErrorMessage(error);
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart));
      if (parsed?.error) {
        return String(parsed.error);
      }
    } catch (_parseError) {
      return message;
    }
  }
  return message;
}

async function revertActivity(id) {
  if (!id) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "Revert this Amarillo sync history entry?",
    { modal: true },
    "Revert"
  );
  if (choice !== "Revert") {
    return;
  }
  await requestJson("POST", `/activity/${encodeURIComponent(id)}/revert`, {}, { timeout: 5000 });
  refreshSidebar();
  vscode.window.showInformationMessage("Amarillo sync history entry reverted.");
}

class AmarilloSidebarProvider {
  [key: string]: any;

  constructor(context) {
    this.context = context;
    this.view = null;
    this.hasRendered = false;
    this.visibleRefreshInFlight = null;
  }

  async resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = renderSidebarHtml(buildSidebarLoadingState());
    this.hasRendered = true;

    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = null;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (!this.view) {
        return;
      }
      if (!webviewView.visible) {
        resetSidebarHandshakeCycle();
        refreshSidebar();
        return;
      }
      this.refreshThenHandleVisible(webviewView);
    });

    if (webviewView.visible) {
      this.refreshThenHandleVisible(webviewView);
    } else {
      void this.refresh();
    }
  }

  refreshThenHandleVisible(webviewView) {
    if (this.visibleRefreshInFlight) {
      return;
    }
    this.visibleRefreshInFlight = this.doRefreshThenHandleVisible(webviewView)
      .catch((error) => log(`Sidebar visible refresh failed: ${sidebarErrorMessage(error)}`))
      .finally(() => {
        this.visibleRefreshInFlight = null;
      });
  }

  async doRefreshThenHandleVisible(webviewView) {
    if (!webviewView.visible || this.view !== webviewView) {
      return;
    }
    const runtimeState = await this.refresh();
    if (!runtimeState) {
      return;
    }
    if (!webviewView.visible || this.view !== webviewView) {
      return;
    }
    await handleSidebarVisible(this.context, runtimeState);
  }

  async refresh(runtimeState: SidebarRuntimeState | null = null) {
    if (!this.view) {
      return null;
    }
    const startedAt = Date.now();
    if (!this.hasRendered) {
      this.view.webview.html = renderSidebarHtml(buildSidebarLoadingState());
      this.hasRendered = true;
    }

    try {
      const effectiveRuntimeState = runtimeState
        || await withSidebarTimeout(readSidebarRuntimeState(), SIDEBAR_STATE_TIMEOUT_MS, "Sidebar state");
      const state = await getSidebarState(effectiveRuntimeState);
      this.view.webview.html = renderSidebarHtml(state);
      this.hasRendered = true;
      log(`Sidebar refresh completed in ${Date.now() - startedAt}ms.`);
      return effectiveRuntimeState;
    } catch (error) {
      const reason = sidebarErrorMessage(error);
      log(`Sidebar refresh failed after ${Date.now() - startedAt}ms: ${reason}`);
      try {
        this.view.webview.html = renderSidebarHtml(buildSidebarErrorState(error));
      } catch (renderError) {
        this.view.webview.html = renderSidebarFatalHtml(renderError);
      }
      this.hasRendered = true;
      return null;
    }
  }

  async handleMessage(message) {
    if (!message) {
      return;
    }

    try {
      if (message.type === "activity" && typeof message.action === "string" && typeof message.id === "string") {
        if (message.action === "openDiff") {
          await openActivityDiff(message.id);
        } else if (message.action === "revert") {
          await revertActivity(message.id);
        }
        return;
      }
      if (message.type === "placeSyncApply") {
        await applyPlaceSyncFromSidebarMessage(message);
        return;
      }
      if (message.type !== "command" || typeof message.command !== "string") {
        return;
      }
      await vscode.commands.executeCommand(message.command);
    } catch (error) {
      const reason = errorMessageFromHttp(error);
      log(`Failed to execute sidebar command: ${reason}`);
      vscode.window.showErrorMessage(reason);
    } finally {
      void this.refresh();
    }
  }
}

async function handleSidebarVisible(context, runtimeState: SidebarRuntimeState | null = null) {
  const sidebarRuntime = runtimeState || await readSidebarRuntimeState();
  const settings = sidebarRuntime.settings || null;
  if (!settings) {
    return;
  }

  beginSidebarHandshakeCycle(settings);

  const health = sidebarRuntime.health || null;

  const workspaceMatches = daemonMatchesWorkspace(settings, health);
  if (health?.ok && !workspaceMatches) {
    return;
  }

  if (!health?.ok) {
    if (bridgeState.startPromptShown) {
      return;
    }
    bridgeState.startPromptShown = true;
    const choice = await vscode.window.showInformationMessage(
      "The Amarillo bridge is offline. Start it now and request a connection from Roblox Studio?",
      "Iniciar"
    );
    if (choice === "Iniciar") {
      try {
        await startBridge(context, { requestedBy: "sidebar" });
      } catch (error) {
        log(`Failed to start bridge from the sidebar: ${error.message}`);
        vscode.window.showErrorMessage(error.message);
      }
    }
    return;
  }

  if (readySessionsFromHealth(health).length > 0) {
    return;
  }
  if (health.connectionOffer?.status === "pending" || health.connectionOffer?.status === "accepted") {
    return;
  }
  if (bridgeState.offerRequested || bridgeState.offerRequestInFlight) {
    return;
  }

  bridgeState.offerRequestInFlight = true;
  try {
    await requestConnectionOffer("sidebar");
    bridgeState.offerRequested = true;
  } catch (error) {
    log(`Failed to create a connection offer from the sidebar: ${error.message}`);
  } finally {
    bridgeState.offerRequestInFlight = false;
  }
}

async function ensureExistingWorkspaceSourcemapOnActivate() {
  const autoGenerateSourcemap = vscode.workspace.getConfiguration("amarillo").get("autoGenerateSourcemap", true);
  if (!autoGenerateSourcemap) {
    log("Skipping activation sourcemap check because amarillo.autoGenerateSourcemap is disabled.");
    return;
  }

  const startedAt = Date.now();
  let workspaceRoot;
  try {
    workspaceRoot = resolveWorkspaceRoot();
  } catch (_error) {
    return;
  }

  const projectFiles = collectProjectFiles(workspaceRoot);
  if (projectFiles.length === 0) {
    log(`Activation sourcemap check skipped in ${Date.now() - startedAt}ms: no .project.json files found.`);
    return;
  }

  try {
    const health = await fetchDaemonHealth({ timeout: SIDEBAR_HEALTH_TIMEOUT_MS });
    const settings = getBridgeSettings();
    if (health?.ok && daemonMatchesWorkspace(settings, health)) {
      await syncLuauSourcemapToDaemonState(workspaceRoot, health, { silent: true });
      log(`Activation sourcemap check completed from daemon state in ${Date.now() - startedAt}ms.`);
      return;
    }
  } catch (error) {
    log(`Activation sourcemap daemon check failed after ${Date.now() - startedAt}ms: ${sidebarErrorMessage(error)}`);
    // Fall back to local resolution below when the daemon is unavailable.
  }

  try {
    await ensureWorkspaceLuauSourcemap(workspaceRoot, {
      projectFilePath: null,
      projectFiles
    });
    log(`Activation sourcemap check completed locally in ${Date.now() - startedAt}ms.`);
  } catch (error) {
    log(`Failed to verify sourcemap on activation after ${Date.now() - startedAt}ms: ${sidebarErrorMessage(error)}`);
  }
}

function scheduleExistingWorkspaceSourcemapOnActivate(context) {
  const autoGenerateSourcemap = vscode.workspace.getConfiguration("amarillo").get("autoGenerateSourcemap", true);
  if (!autoGenerateSourcemap) {
    log("Skipping activation sourcemap check because amarillo.autoGenerateSourcemap is disabled.");
    return;
  }

  log(`Scheduling activation sourcemap check in ${SOURCEMAP_ACTIVATION_DELAY_MS}ms.`);
  const timer = setTimeout(() => {
    void ensureExistingWorkspaceSourcemapOnActivate();
  }, SOURCEMAP_ACTIVATION_DELAY_MS);
  context.subscriptions.push({
    dispose: () => clearTimeout(timer)
  });
}

async function installRobloxPlugin(context) {
  const result = await copyBundledRobloxPlugin(context, { force: true });
  log(`Plugin copiado para ${result.targetPath} (source: ${path.basename(path.dirname(result.sourcePath))})`);
  refreshSidebar();
  vscode.window.showInformationMessage(`Amarillo installed in Roblox Studio: ${result.targetPath}. Reload or reopen Roblox Studio if it was already open.`);
}

async function ensureBridgeStarted(context, options: BridgeStartOptions = {}) {
  const { workspaceRoot, host, port, nodePath, autoSyncToStudio, privilegedActionConfirmation } = getBridgeSettings();
  const daemonEntry = runtimePath(context, "daemon", "index.js");
  const bridgeAuthRequired = bridgeAuthRequiredForHost(host);
  const token = bridgeAuthRequired ? getOrCreateBridgeToken(context) : null;
  const reuseResult = (extra = {}): any => ({
    alreadyRunning: true,
    started: false,
    workspaceRoot,
    host,
    port,
    autoSyncToStudio,
    privilegedActionConfirmation,
    configCreated: false,
    projectState: { created: false, projectFilePath: null },
    ...extra
  });

  if (bridgeState.hasLiveProcess) {
    let liveHealth = null;
    try {
      liveHealth = await fetchDaemonHealth({ timeout: 1500 });
    } catch (_error) {
      // Keep an owned process when its health endpoint is temporarily unavailable.
    }
    const sameWorkspace = liveHealth?.workspaceRoot
      ? samePath(workspaceRoot, liveHealth.workspaceRoot)
      : false;
    if (liveHealth?.ok && sameWorkspace && liveHealth.bridgeAuthRequired !== bridgeAuthRequired) {
      log(`Restarting the current workspace bridge because authentication mode is incompatible (expected ${bridgeAuthRequired ? "token" : "loopback/no-token"}, daemon reported ${liveHealth.bridgeAuthRequired === true ? "token" : "legacy/unknown"}).`);
      bridgeState.killProcess();
      await waitForDaemonOffline();
    } else {
      if (liveHealth?.ok && !sameWorkspace) {
        log("Keeping the running bridge because it belongs to another workspace.");
      }
      return reuseResult(liveHealth?.ok && !sameWorkspace ? { workspaceConflict: true } : {});
    }
  } else {
    let existingHealth = null;
    try {
      existingHealth = await fetchDaemonHealth({ timeout: 1500 });
    } catch (_error) {
      // No daemon is listening yet; continue with the normal start path.
    }
    if (existingHealth?.ok) {
      const sameWorkspace = samePath(workspaceRoot, existingHealth.workspaceRoot);
      if (!sameWorkspace) {
        log("Found a running bridge for another workspace; it will not be stopped or replaced.");
        return reuseResult({ workspaceConflict: true });
      }
      if (existingHealth.bridgeAuthRequired === bridgeAuthRequired) {
        return reuseResult();
      }

      log(`Existing bridge authentication is incompatible for this workspace; requesting a controlled restart (expected ${bridgeAuthRequired ? "token" : "loopback/no-token"}, daemon reported ${existingHealth.bridgeAuthRequired === true ? "token" : "legacy/unknown"}).`);
      try {
        await requestJson("POST", "/bridge/shutdown", { workspaceRoot }, {
          timeout: 2000,
          forceBridgeToken: true
        });
        if (!await waitForDaemonOffline()) {
          log("The incompatible bridge did not go offline after the restart request.");
          return reuseResult({ authenticationMismatch: true });
        }
      } catch (error) {
        log(`Could not restart the incompatible bridge safely: ${error.message}`);
        return reuseResult({ authenticationMismatch: true });
      }
    }
  }

  await ensurePathExists(workspaceRoot, "Roblox workspace");
  await ensurePathExists(daemonEntry, "Amarillo daemon");
  const configCreated = await ensurePluginConfig(workspaceRoot);
  const projectState = await ensureWorkspaceHasProjects(workspaceRoot);
  let sourcemapResult = null;
  try {
    sourcemapResult = await ensureWorkspaceLuauSourcemap(workspaceRoot, projectState);
  } catch (error) {
    log(`Failed to ensure the Luau sourcemap: ${error.message}`);
    sourcemapResult = {
      projectFilePath: projectState.projectFilePath || (projectState.projectFiles && projectState.projectFiles[0]) || null,
      sourcemapPath: path.join(workspaceRoot, "sourcemap.json"),
      sourcemapGenerated: false,
      settingsUpdated: false,
      settingsError: error.message
    };
  }

  const configPath = path.join(workspaceRoot, ".pluginroblox.json");
  const projectPath = projectState.projectFilePath || path.join(workspaceRoot, `${path.basename(path.resolve(workspaceRoot))}.project.json`);

  log(`[DEBUG] workspaceRoot: ${workspaceRoot}`);
  log(`[DEBUG] configPath exists: ${syncFs.existsSync(configPath)}`);
  log(`[DEBUG] projectPath exists: ${syncFs.existsSync(projectPath)}`);
  log(`[DEBUG] projectState.created: ${projectState.created}`);
  log(`[DEBUG] projectState.projectFilePath: ${projectState.projectFilePath}`);

  const args = [
    daemonEntry,
    "--workspace", workspaceRoot,
    "--host", host,
    "--port", String(port),
    "--extension-version", extensionVersion(context),
    "--extension-protocol", String(AMARILLO_PROTOCOL_VERSION),
  ];
  if (token) {
    args.push("--bridge-token", token);
  }
  args.push(
    "--strict-port",
    "--no-mcp",
    autoSyncToStudio ? "--auto-sync-to-studio" : "--no-auto-sync-to-studio",
    privilegedActionConfirmation ? "--privileged-action-confirmation" : "--no-privileged-action-confirmation"
  );

  const daemonProcess = spawn(nodePath, args, {
    cwd: workspaceRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  bridgeState.attachProcess(daemonProcess);

  daemonProcess.stdout.on("data", (chunk) => {
    log(String(chunk).trimEnd());
  });

  daemonProcess.stderr.on("data", (chunk) => {
    log(String(chunk).trimEnd());
  });

  daemonProcess.on("error", (error) => {
    log(`Failed to start daemon: ${error.message}`);
    if (bridgeState.daemonProcess === daemonProcess) {
      bridgeState.markProcessClosed("error");
    }
    refreshSidebar();
    vscode.window.showErrorMessage(`Failed to start Amarillo: ${error.message}`);
  });

  daemonProcess.on("close", (code, signal) => {
    log(`Bridge stopped. code=${code ?? "null"} signal=${signal ?? "null"}`);
    if (bridgeState.daemonProcess === daemonProcess) {
      bridgeState.markProcessClosed("stopped");
    }
    updateStatusBar();
    refreshSidebar();
    resetSidebarHandshakeCycle();
  });

  if (configCreated) {
    log("Created .pluginroblox.json with default values.");
  }
  if (projectState.created && projectState.projectFilePath) {
    const relativeProjectPath = path.relative(workspaceRoot, projectState.projectFilePath).replace(/\\/g, "/");
    log(`No .project.json found. Created a default project at ${relativeProjectPath}`);
  }
  log(`Starting bridge at http://${host}:${port} for ${workspaceDisplayName(workspaceRoot)}; bridge authentication ${bridgeAuthRequired ? "required" : "disabled for loopback"}.`);
  log(`Auto-sync VS Code -> Studio: ${autoSyncToStudio ? "enabled" : "disabled"}`);
  log(`Privileged action confirmation: ${privilegedActionConfirmation ? "enabled" : "disabled"}`);
  updateStatusBar();
  refreshSidebar();
  outputChannel.show(true);
  return {
    alreadyRunning: false,
    started: true,
    workspaceRoot,
    host,
    port,
    autoSyncToStudio,
    privilegedActionConfirmation,
    configCreated,
    projectState,
    sourcemapResult
  };
}

function bridgeStartMessage(startResult) {
  let message = `Amarillo started at http://${startResult.host}:${startResult.port}`;
  if (
    startResult.configCreated
    || (startResult.projectState.created && startResult.projectState.projectFilePath)
    || startResult.sourcemapResult?.sourcemapGenerated
  ) {
    const details = [];
    if (startResult.configCreated) {
      details.push(".pluginroblox.json created");
    }
    if (startResult.projectState.created && startResult.projectState.projectFilePath) {
      details.push(`default project at ${path.relative(startResult.workspaceRoot, startResult.projectState.projectFilePath).replace(/\\/g, "/")}`);
    }
    if (startResult.sourcemapResult?.sourcemapGenerated) {
      details.push("sourcemap.json created");
    }
    message += ` with ${details.join(" and ")}`;
  }
  return message;
}

async function ensureWorkspaceMcp(context) {
  const { workspaceRoot, host, port } = getBridgeSettings();
  const proxyEntry = runtimePath(context, "mcp-proxy", "index.js");
  const bridgeAuthRequired = bridgeAuthRequiredForHost(host);
  const token = bridgeAuthRequired ? getOrCreateBridgeToken(context) : null;

  await ensurePathExists(workspaceRoot, "Roblox workspace");
  await ensurePathExists(proxyEntry, "Amarillo MCP proxy");

  const mcpConfigResult = await ensureWorkspaceMcpConfig(workspaceRoot, {
    proxyEntry,
    host,
    port,
    bridgeToken: token,
    extensionPath: context.extensionPath,
    extensionVersion: extensionVersion(context)
  });
  const verifiedLocalState = verifyWorkspaceMcpLocalState(workspaceRoot, mcpConfigResult);
  const message = describeMcpConfigResult(mcpConfigResult, workspaceRoot);
  log(message);
  log(`MCP local state verified for ${workspaceDisplayName(workspaceRoot)} at ${workspaceRelativePath(workspaceRoot, mcpConfigResult.localStatePath)}: extension ${verifiedLocalState.extensionVersion}; bridge authentication ${bridgeAuthRequired ? "required" : "disabled for loopback"}; proxy entry present.`);
  if (mcpConfigResult.status !== "unchanged") {
    log("If your AI/MCP client was already open, reopen the session to reload the server.");
  }

  return {
    workspaceRoot,
    host,
    port,
    mcpConfigResult,
    localState: verifiedLocalState,
    message
  };
}

async function repairExistingWorkspaceMcpOnActivate(context) {
  let settings;
  try {
    settings = getBridgeSettings();
  } catch (_error) {
    return;
  }

  const proxyEntry = runtimePath(context, "mcp-proxy", "index.js");
  if (!syncFs.existsSync(proxyEntry)) {
    return;
  }

  try {
    const currentBridgeToken = bridgeAuthRequiredForHost(settings.host)
      ? getOrCreateBridgeToken(context)
      : null;
    const result = await repairExistingWorkspaceMcpConfig(settings.workspaceRoot, {
      proxyEntry,
      host: settings.host,
      port: settings.port,
      bridgeToken: currentBridgeToken,
      extensionPath: context.extensionPath,
      extensionVersion: extensionVersion(context)
    });
    if (result.status === "updated" || result.status === "created") {
      log(`MCP local state repaired for ${workspaceDisplayName(settings.workspaceRoot)} using extension ${extensionVersion(context)}.`);
    } else if (result.status === "skipped") {
      log(`MCP local state repair skipped: ${result.reason}.`);
    }
  } catch (error) {
    log(`MCP local state repair failed: ${error.message}`);
  }
}

async function startBridge(context, options: BridgeStartOptions = {}) {
  // Auto-install the plugin before starting the bridge
  await silentPluginInstall(context);

  // Synchronize the workspace MCP state BEFORE starting the daemon. A token is
  // required only for non-loopback bridges; local state may retain an older
  // token for compatibility, but the local proxy will ignore it.
  const mcpSetup = await ensureWorkspaceMcp(context);

  const startResult = await ensureBridgeStarted(context, options);
  let daemonHealth = null;
  if (!startResult.alreadyRunning) {
    daemonHealth = await waitForDaemonOnline();
  } else {
    try {
      daemonHealth = await fetchDaemonHealth();
    } catch (_error) {
      daemonHealth = null;
    }
  }
  if (startResult.workspaceConflict || startResult.authenticationMismatch) {
    const warning = startResult.workspaceConflict
      ? "Another workspace owns the daemon on this port; it was left untouched."
      : "The daemon authentication mode is incompatible and could not be restarted automatically.";
    log(warning);
    vscode.window.showWarningMessage(`Amarillo bridge not reused. ${warning}`, "Show Output").then((action) => {
      if (action === "Show Output") {
        outputChannel.show(true);
      }
    });
    return;
  }
  if (daemonHealth?.ok && samePath(daemonHealth.workspaceRoot, startResult.workspaceRoot)) {
    try {
      const effectiveSourcemapResult = await syncLuauSourcemapToDaemonState(startResult.workspaceRoot, daemonHealth);
      if (effectiveSourcemapResult) {
        startResult.sourcemapResult = effectiveSourcemapResult;
      }
    } catch (error) {
      log(`Failed to align sourcemap with the active project: ${error.message}`);
      startResult.sourcemapResult = {
        ...(startResult.sourcemapResult || {}),
        settingsError: error.message
      };
    }
  }
  await saveSessionConfig();
  const offer = await requestConnectionOffer(options.requestedBy || "vscode_command");
  bridgeState.offerRequested = true;
  const handshakeLabel = handshakeStatusLabel(offer);
  const sourcemapWarning = startResult.sourcemapResult?.settingsError
    ? ` Sourcemap warning: ${startResult.sourcemapResult.settingsError}`
    : "";
  const reloadHint = mcpReloadHint(mcpSetup.mcpConfigResult);

  if (!startResult.alreadyRunning) {
    vscode.window.showInformationMessage(`${bridgeStartMessage(startResult)}. ${mcpSetup.message}. Connection offer ${handshakeLabel}.${sourcemapWarning}${reloadHint}`);
    return;
  }

  outputChannel.show(true);
  vscode.window.showInformationMessage(`The Amarillo bridge was already running. ${mcpSetup.message}. New connection offer ${handshakeLabel}.${sourcemapWarning}${reloadHint}`);
}

async function stopBridge() {
  if (!bridgeState.hasLiveProcess) {
    vscode.window.showInformationMessage("The Amarillo bridge is not running.");
    bridgeState.markProcessClosed("stopped");
    updateStatusBar();
    refreshSidebar();
    return;
  }

  bridgeState.killProcess();
  log("Bridge shutdown requested.");
  resetSidebarHandshakeCycle();
  updateStatusBar();
  refreshSidebar();
  vscode.window.showInformationMessage("Amarillo bridge stopped.");
}

async function runHealthcheck() {
  const payload = await fetchDaemonHealth();
  const routeResults = await runHealthcheckRouteProbes(payload);
  const settings = getBridgeSettings();
  const pluginHealth = describePluginHealth(payload);
  const failedRoutes = routeResults.filter((result) => !result.ok);
  const routeSummary = ` Routes: ${routeResults.length - failedRoutes.length}/${routeResults.length} OK.`;
  const workspaceMatches = daemonMatchesWorkspace(settings, payload);
  const authMismatch = workspaceMatches && payload.bridgeAuthRequired !== bridgeAuthRequiredForHost(settings.host);
  const workspaceWarning = workspaceMatches
    ? ""
    : " Warning: another workspace has an active daemon on this port.";
  const daemonWorkspaceLabel = workspaceMatches
    ? workspaceDisplayName(payload.workspaceRoot)
    : "another workspace is active on this port";
  const projectWarning = Number(payload.projectCount || 0) === 0
    ? " No .project.json was found in this folder."
    : "";
  const offerInfo = payload.connectionOffer
    ? ` Handshake: ${handshakeStatusLabel(payload.connectionOffer)}.`
    : "";
  const autoSyncInfo = ` Auto-sync VS Code -> Studio: ${payload.autoSyncToStudio === false ? "manual" : "auto"}.`;
  const confirmationInfo = ` Confirm actions: ${payload.privilegedActionConfirmation === false ? "off" : "on"}.`;
  const mcpInfo = payload.mcpShield
    ? ` MCP: ${mcpStateLabel(payload.mcpShield)}.`
    : "";
  const authInfo = authMismatch
    ? ` Bridge authentication mismatch: expected ${bridgeAuthRequiredForHost(settings.host) ? "token" : "loopback/no-token"}, daemon reported ${payload.bridgeAuthRequired === true ? "token" : "legacy/unknown"}.`
    : ` Bridge authentication: ${payload.bridgeAuthRequired === true ? "required" : "disabled"}.`;
  const studioInfo = Array.isArray(payload.sessions) && payload.sessions.length === 0
    ? " Studio session: absent."
    : "";

  log(`Healthcheck OK: workspace=${daemonWorkspaceLabel} projects=${payload.projectCount ?? 0} sessions=${payload.sessions?.length ?? 0} plugin=${pluginHealth.headline} mcp=${payload.mcpShield?.state || "unknown"}${authMismatch ? " auth-mismatch" : ""}`);
  if (authMismatch) {
    log(`Healthcheck authentication mismatch: expected ${bridgeAuthRequiredForHost(settings.host) ? "token" : "loopback/no-token"}, daemon reported ${payload.bridgeAuthRequired === true ? "token" : "legacy/unknown"}. Restart the bridge from this workspace.`);
  }
  log(`Healthcheck plugin: ${pluginHealth.message}`);
  for (const detail of pluginHealth.details || []) {
    log(`Healthcheck plugin detail: ${detail}`);
  }
  logHealthcheckRouteResults(routeResults);
  refreshSidebar();
  outputChannel.show(true);
  const failedRouteInfo = failedRoutes.length > 0
    ? ` Failed route(s): ${failedRoutes.map((result) => `${result.method} ${result.route}`).join(", ")}.`
    : "";
  const message = `Amarillo healthcheck. ${pluginHealth.message} Daemon workspace: ${daemonWorkspaceLabel}. Projects: ${payload.projectCount ?? 0}. Sessions: ${payload.sessions?.length ?? 0}.${routeSummary}${autoSyncInfo}${confirmationInfo}${mcpInfo}${authInfo}${studioInfo}${projectWarning}${offerInfo}${workspaceWarning}${failedRouteInfo}`;
  if (pluginHealth.tone === "success" && failedRoutes.length === 0 && !authMismatch) {
    vscode.window.showInformationMessage(message);
  } else {
    vscode.window.showWarningMessage(message, "Show Output").then((action) => {
      if (action === "Show Output") {
        outputChannel.show(true);
      }
    });
  }
}

function doctorValue(value) {
  return value === undefined || value === null || value === "" ? "-" : String(value);
}

function logDoctorSessions(report) {
  const sessions = Array.isArray(report.sessions) ? report.sessions : [];
  if (sessions.length === 0) {
    log("Doctor sessions: none");
    return;
  }
  for (const session of sessions) {
    log(
      `Doctor session ${doctorValue(session.projectName)} (${doctorValue(session.id)}): ` +
      `state=${doctorValue(session.connectionState)} truth=${doctorValue(session.truthSource)} ` +
      `version=${doctorValue(session.versionState)} requiresPluginUpdate=${session.requiresPluginUpdate === true ? "yes" : "no"} pluginUpdateAvailable=${session.pluginUpdateAvailable === true ? "yes" : "no"} ` +
      `sync=${doctorValue(session.syncState)} studio=${doctorValue(session.studioContactState)}`
    );
    log(
      `Doctor session detail ${doctorValue(session.projectName)}: ` +
      `versionMessage=${doctorValue(session.versionMessage)} ` +
      `studioContact=${doctorValue(session.studioContactMessage)} ` +
      `lastCommandError=${doctorValue(session.lastCommandError)} ` +
      `lastSyncError=${doctorValue(session.lastSyncError)}`
    );
    if ((session.connectionState || "ready") !== "ready" && session.truthSource === "studio" && !session.lastAppliedAt) {
      log(`WARNING: ${doctorValue(session.projectName)} initial Studio sync is still accepted but no Studio snapshot has been applied. Check the Roblox plugin Advanced log for the first snapshot failure.`);
    }
  }
}

function diagnosticContextLabel(entry) {
  const context = entry?.context || {};
  const parts = [];
  if (context.route) parts.push(`route=${context.route}`);
  if (context.statusCode) parts.push(`status=${context.statusCode}`);
  if (context.reason) parts.push(`reason=${context.reason}`);
  if (context.hasSessionToken !== undefined) parts.push(`sessionToken=${context.hasSessionToken ? "present" : "missing"}`);
  if (context.truthSource) parts.push(`truth=${context.truthSource}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function logDoctorErrors(report) {
  const errors = report.errors || {};
  const recentUnresolved = Array.isArray(errors.recentUnresolved)
    ? errors.recentUnresolved
    : (Array.isArray(errors.recent) ? errors.recent.filter((entry) => entry && entry.resolved !== true).slice(0, 5) : []);
  if (recentUnresolved.length === 0) {
    return;
  }
  log("Recent unresolved diagnostic errors:");
  for (const entry of recentUnresolved) {
    log(
      `Diagnostic ${doctorValue(entry.code)} ${doctorValue(entry.component)}/${doctorValue(entry.severity)}: ` +
      `${doctorValue(entry.message)} session=${doctorValue(entry.sessionId)} project=${doctorValue(entry.projectId)}${diagnosticContextLabel(entry)}`
    );
  }
}

async function runDoctor() {
  const report = await requestJson<DoctorReportPayload>("GET", "/doctor", undefined, { timeout: 10000 });
  const { workspaceRoot } = getBridgeSettings();
  const codexMcp = await inspectCodexMcpRegistration(workspaceRoot);
  const status = report.status || "unknown";
  log(`Doctor status: ${status}`);
  log(`Doctor summary: ${report.summary?.message || "No summary message."}`);
  log(`Versions: daemon=${report.versions?.daemon?.version || "unknown"} protocol=${report.versions?.daemon?.protocolVersion ?? "unknown"} extension=${report.versions?.extension?.version || "unknown"}`);
  log(`Workspace: ${report.workspace?.root || "unknown"} projects=${report.workspace?.projectCount ?? 0} sessions=${report.summary?.sessionCount ?? 0}`);
  logCodexMcpDiagnostics(codexMcp);
  logDoctorSessions(report);
  logDoctorErrors(report);
  for (const reason of report.summary?.blockedReasons || []) {
    log(`BLOCKED: ${reason}`);
  }
  for (const warning of report.summary?.warnings || []) {
    log(`WARNING: ${warning}`);
  }
  for (const recommendation of report.recommendations || []) {
    log(`Recommendation: ${recommendation}`);
  }
  if (codexMcp.status === "not_configured") {
    log(`Recommendation: Register native Codex MCP manually with: ${codexMcp.suggestedCommand}`);
  }
  refreshSidebar();
  outputChannel.show(true);

  const message = `Amarillo Doctor: ${status}. ${report.summary?.message || ""}`.trim();
  if (status === "blocked") {
    vscode.window.showErrorMessage(message, "Show Output").then((action) => {
      if (action === "Show Output") {
        outputChannel.show();
      }
    });
  } else if (status === "warning") {
    vscode.window.showWarningMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
  }
}

async function runMcpHealthcheck() {
  const { workspaceRoot } = getBridgeSettings();
  const statusPayload = await requestJson<McpStatusPayload>("GET", "/mcp/status", undefined, { timeout: 5000 });
  const codexMcp = await inspectCodexMcpRegistration(workspaceRoot);
  let probePayload: McpProbePayload | null = null;
  try {
    probePayload = await requestJson<McpProbePayload>("POST", "/mcp/probe", {}, { timeout: 10000 });
  } catch (error) {
    log(`MCP probe failed: ${error.message}`);
  }

  const mcp = probePayload?.mcp || statusPayload.mcp;
  const fallbackUrl = mcp?.fallback?.callUrl || `${bridgeBaseUrl()}/mcp/call`;
  const configStatus = mcp?.config?.status || "unknown";
  const stateLabel = mcpStateLabel(mcp);
  log(`MCP Shield: state=${mcp?.state || "unknown"} config=${configStatus} tools=${mcp?.toolCount ?? 0}`);
  log(`MCP message: ${mcp?.message || "No MCP diagnostic message."}`);
  log(`MCP HTTP fallback endpoint: ${fallbackUrl}`);
  logCodexMcpDiagnostics(codexMcp);
  if (probePayload?.parsed?.workspaceRoot) {
    log(`MCP probe health: workspace=${workspaceDisplayName(probePayload.parsed.workspaceRoot)} sessions=${probePayload.parsed.sessions?.length ?? 0}`);
  }
  refreshSidebar();
  outputChannel.show(true);

  const codexMcpInfo = ` Codex MCP: ${codexMcpStateLabel(codexMcp)}.`;
  const message = `Amarillo MCP ${stateLabel}. Native config: ${configStatus}. HTTP fallback: ${fallbackUrl}.${codexMcpInfo}`;
  if (mcp?.state === "ready" && !shouldWarnAboutCodexMcp(codexMcp)) {
    vscode.window.showInformationMessage(message);
  } else {
    vscode.window.showWarningMessage(message);
  }
}

async function configureMcp(context) {
  const { workspaceRoot } = getBridgeSettings();
  const projectFiles = collectProjectFiles(workspaceRoot);
  let sourcemapWarning = "";
  try {
    const sourcemapResult = await ensureWorkspaceLuauSourcemap(workspaceRoot, {
      projectFilePath: null,
      projectFiles
    });
    if (sourcemapResult.settingsError) {
      sourcemapWarning = ` Sourcemap warning: ${sourcemapResult.settingsError}`;
    }
  } catch (error) {
    log(`Failed to ensure the Luau sourcemap during Configure MCP: ${error.message}`);
    sourcemapWarning = ` Sourcemap warning: ${error.message}`;
  }
  const mcpSetup = await ensureWorkspaceMcp(context);
  const codexMcp = await ensureCodexMcpRegistration(workspaceRoot, {
    confirmUpdate: confirmCodexMcpUpdate
  });
  logCodexMcpDiagnostics(codexMcp);
  refreshSidebar();
  await showConfigureMcpMessage(
    `${mcpSetup.message} to use the bridge at ${mcpSetup.host}:${mcpSetup.port}.${sourcemapWarning}${mcpReloadHint(mcpSetup.mcpConfigResult)}${codexMcpConfigureSummary(codexMcp)}`,
    codexMcp
  );
}

async function sendFilesToStudio() {
  const session = await chooseSession();
  log(`Sending files from disk to Studio for session ${session.id}`);
  const response = await requestJson<SessionCommandResponse>("POST", `/session/${session.id}/pull`, {}, { timeout: 130000 });
  if (!response.ok) {
    throw new Error(response.error || "Failed to send files to Studio.");
  }
  refreshSidebar();
  vscode.window.showInformationMessage(`Files sent to Studio in ${session.projectName}.`);
}

async function receiveFilesFromStudio() {
  const session = await chooseSession();
  log(`Receiving files from Studio to disk for session ${session.id}`);
  const response = await requestJson<SessionCommandResponse>("POST", `/session/${session.id}/push`, {}, { timeout: 130000 });
  if (!response.ok) {
    throw new Error(response.error || "Failed to receive files from Studio.");
  }
  refreshSidebar();
  vscode.window.showInformationMessage(`Files received from Studio in ${session.projectName}.`);
}

async function selectSession() {
  const session = await chooseSession(true);
  log(`Active session selected: ${session.id} (${session.projectName})`);
  refreshSidebar();
  vscode.window.showInformationMessage(`Active session: ${session.projectName} / Place ${session.placeId || 0}`);
}

function placeSyncMountState(project) {
  const payloadMounts = Array.isArray(project?.placeSync?.mounts) ? project.placeSync.mounts : [];
  if (payloadMounts.length > 0) {
    return PLACE_SYNC_MOUNT_OPTIONS.map((option) => {
      const mount = payloadMounts.find((candidate) => candidate.id === option.id) || {};
      return {
        ...option,
        baseEnabled: mount.baseEnabled === true,
        baseRelativePath: mount.baseRelativePath || null,
        exclusiveEnabled: mount.exclusiveEnabled === true,
        exclusiveRelativePath: mount.exclusiveRelativePath || null,
        keepUnknowns: mount.keepUnknowns === true
      };
    });
  }

  const mounts = Array.isArray(project?.mounts) ? project.mounts : [];
  return PLACE_SYNC_MOUNT_OPTIONS.map((option) => {
    const exactMount = mounts.find((mount) => mount.path === option.path || mount.id === option.id) || null;
    const exclusiveMount = mounts.find((mount) => (
      typeof mount.path === "string"
      && mount.path.startsWith(`${option.path}.Exclusivo`)
    )) || null;
    const directExclusiveMount = !exclusiveMount
      && exactMount
      && typeof exactMount.relativePath === "string"
      && (
        exactMount.relativePath.replace(/\\/g, "/").endsWith(`/exclusive/${option.path.split(".").slice(-1)[0]}`)
        || exactMount.relativePath.replace(/\\/g, "/") === `exclusive/${option.path.split(".").slice(-1)[0]}`
      )
      ? exactMount
      : null;
    const baseMount = directExclusiveMount ? null : exactMount;
    return {
      ...option,
      baseEnabled: Boolean(baseMount),
      baseRelativePath: baseMount?.relativePath || null,
      exclusiveEnabled: Boolean(exclusiveMount || directExclusiveMount),
      exclusiveRelativePath: exclusiveMount?.relativePath || directExclusiveMount?.relativePath || null,
      keepUnknowns: baseMount?.keepUnknowns === true || exclusiveMount?.keepUnknowns === true || directExclusiveMount?.keepUnknowns === true
    };
  });
}

function placeSyncProjectLabel(project) {
  if (!project) {
    return "No project";
  }
  const placeIds = Array.isArray(project.placeIds) && project.placeIds.length > 0
    ? ` - Place ${project.placeIds.join(", ")}`
    : "";
  return `${project.name || project.id}${placeIds}`;
}

function placeSyncSameIds(left = [], right = []) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && Array.from(leftSet).every((id) => rightSet.has(id));
}

function selectedPlaceSyncMountIds(states, key) {
  return (Array.isArray(states) ? states : [])
    .filter((mount) => mount[key] === true)
    .map((mount) => mount.id);
}

function buildPlaceSyncProjectContext(project) {
  const states = placeSyncMountState(project);
  const baseMountIds = selectedPlaceSyncMountIds(states, "baseEnabled");
  const exclusiveMountIds = selectedPlaceSyncMountIds(states, "exclusiveEnabled");
  return {
    id: project?.id || "",
    name: project?.name || project?.id || "Project",
    label: placeSyncProjectLabel(project),
    placeIds: Array.isArray(project?.placeIds) ? project.placeIds : [],
    baseMountIds,
    exclusiveMountIds,
    defaultBaseMountIds: PLACE_SYNC_DEFAULT_BASE_MOUNT_IDS,
    defaultExclusiveMountIds: PLACE_SYNC_DEFAULT_EXCLUSIVE_MOUNT_IDS,
    baseUseDefault: placeSyncSameIds(baseMountIds, PLACE_SYNC_DEFAULT_BASE_MOUNT_IDS),
    exclusiveUseDefault: placeSyncSameIds(exclusiveMountIds, PLACE_SYNC_DEFAULT_EXCLUSIVE_MOUNT_IDS),
    keepUnknowns: states.some((mount) => mount.keepUnknowns),
    mounts: states
  };
}

function buildPlaceSyncCreateContext(pendingPlaceSetup, sourceProject) {
  const sourceStates = placeSyncMountState(sourceProject);
  const sourceBaseMountIds = selectedPlaceSyncMountIds(sourceStates, "baseEnabled");
  return {
    placeId: Number(pendingPlaceSetup?.placeId || 0),
    placeName: String(pendingPlaceSetup?.placeName || `Place ${pendingPlaceSetup?.placeId || 0}`),
    sourceProjectLabel: sourceProject ? placeSyncProjectLabel(sourceProject) : "Default mount layout",
    baseMountIds: sourceBaseMountIds.length > 0 ? sourceBaseMountIds : PLACE_SYNC_DEFAULT_BASE_MOUNT_IDS,
    exclusiveMountIds: PLACE_SYNC_DEFAULT_EXCLUSIVE_MOUNT_IDS,
    defaultBaseMountIds: PLACE_SYNC_DEFAULT_BASE_MOUNT_IDS,
    defaultExclusiveMountIds: PLACE_SYNC_DEFAULT_EXCLUSIVE_MOUNT_IDS,
    baseUseDefault: true,
    exclusiveUseDefault: true,
    keepUnknowns: true,
    mounts: sourceStates
  };
}

function buildSidebarPlaceSyncState({ running, workspaceMatches, pendingPlaceSetup, projects, projectsPayload, projectsError, health }) {
  if (!running || !workspaceMatches) {
    return {
      enabled: false,
      title: "Place Sync",
      description: "Start the bridge for this workspace to configure place sync."
    };
  }

  const projectList = Array.isArray(projects) ? projects : [];
  if (pendingPlaceSetup?.placeId) {
    const sourceProject = sourceProjectForPlaceSync(projectList, projectsPayload?.defaultProjectId || null);
    return {
      enabled: true,
      mode: "create",
      title: "Place Sync",
      description: `Setup ${pendingPlaceSetup.placeName || "this place"} (${pendingPlaceSetup.placeId}).`,
      mountOptions: PLACE_SYNC_MOUNT_OPTIONS,
      create: buildPlaceSyncCreateContext(pendingPlaceSetup, sourceProject),
      projects: projectList.map(buildPlaceSyncProjectContext),
      projectsError: projectsError || null
    };
  }

  if (projectList.length === 0) {
    return {
      enabled: true,
      mode: "create",
      title: "Place Sync",
      description: "Create a place project mapping to configure place sync.",
      mountOptions: PLACE_SYNC_MOUNT_OPTIONS,
      create: buildPlaceSyncCreateContext(null, null),
      projects: [],
      projectsError: projectsError || null
    };
  }

  const activeProject = activeProjectFromHealth(projectList, health)
    || projectList.find((project) => Array.isArray(project.placeIds) && project.placeIds.length > 0)
    || projectList[0];
  return {
    enabled: true,
    mode: "edit",
    title: "Place Sync",
    description: "Choose shared and exclusive folders for the selected place project.",
    mountOptions: PLACE_SYNC_MOUNT_OPTIONS,
    selectedProjectId: activeProject?.id || projectList[0]?.id || "",
    projects: projectList.map(buildPlaceSyncProjectContext),
    projectsError: projectsError || null
  };
}

function defaultMountIdsFromProject(project, key, fallbackIds = null) {
  const states = placeSyncMountState(project);
  const selected = states
    .filter((mount) => mount[key] === true)
    .map((mount) => mount.id);
  if (selected.length > 0) {
    return selected;
  }
  return fallbackIds || PLACE_SYNC_MOUNT_OPTIONS
    .filter((mount) => mount.id !== "Workspace")
    .map((mount) => mount.id);
}

function mountPathDescription(mount, mode) {
  if (mode === "base") {
    return mount.baseRelativePath || "will use the default shared path";
  }
  return mount.exclusiveRelativePath || "will use this place's exclusive folder";
}

async function pickPlaceSyncMountIds(title, placeHolder, defaultIds, mode, mountStates = null) {
  const selected = new Set(defaultIds || []);
  const stateById = new Map((Array.isArray(mountStates) ? mountStates : []).map((mount) => [mount.id, mount]));
  const items = PLACE_SYNC_MOUNT_OPTIONS.map((mount) => ({
    ...mount,
    ...(stateById.get(mount.id) || {})
  })).map((mount) => ({
    label: mount.label,
    description: mount.path,
    detail: mountPathDescription(mount, mode),
    picked: selected.has(mount.id),
    mountId: mount.id
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder,
    canPickMany: true
  });
  if (picked === undefined) {
    return null;
  }
  return picked.map((item) => item.mountId);
}

async function pickKeepUnknowns(defaultValue, title) {
  const enabled = defaultValue !== false;
  const choices = enabled
    ? [
      { label: "Yes (Recommended)", description: "Keep Studio-only instances that do not exist on disk.", value: true },
      { label: "No", description: "Delete Studio instances that do not exist on disk.", value: false }
    ]
    : [
      { label: "No (Current)", description: "Delete Studio instances that do not exist on disk.", value: false },
      { label: "Yes", description: "Keep Studio-only instances that do not exist on disk.", value: true }
    ];
  const picked = await vscode.window.showQuickPick(choices, {
    title,
    placeHolder: "Keep Studio-only unmapped instances?"
  });
  return picked ? picked.value : null;
}

function sourceProjectForPlaceSync(projects, defaultProjectId = null) {
  const defaultProject = defaultProjectId
    ? projects.find((project) => project.id === defaultProjectId)
    : null;
  if (defaultProject && (!Array.isArray(defaultProject.placeIds) || defaultProject.placeIds.length === 0)) {
    return defaultProject;
  }
  return projects.find((project) => !Array.isArray(project.placeIds) || project.placeIds.length === 0)
    || defaultProject
    || projects[0]
    || null;
}

function activeProjectFromHealth(projects, health) {
  const activeSession = resolveActiveSessionFromHealth({
    sessions: Array.isArray(health?.sessions) ? health.sessions : []
  });
  return activeSession?.projectId
    ? projects.find((project) => project.id === activeSession.projectId) || null
    : null;
}

async function chooseProjectForPlaceSync(projects, health) {
  const activeProject = activeProjectFromHealth(projects, health);
  if (activeProject) {
    return activeProject;
  }
  if (projects.length === 1) {
    return projects[0];
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.name || project.id,
      description: project.id,
      detail: `Place IDs: ${(project.placeIds || []).join(", ") || "none"}`,
      project
    })),
    { placeHolder: "Choose the place project to configure" }
  );
  return picked?.project || null;
}

async function configurePlaceSyncFromSidebar(options: { requirePendingSetup?: boolean } = {}) {
  const settings = getBridgeSettings();
  const health = await fetchDaemonHealth({ timeout: 2000 });
  if (!daemonMatchesWorkspace(settings, health)) {
    throw new Error("The active daemon on this port belongs to another workspace.");
  }
  const projectsPayload = await requestJson<Record<string, any>>("GET", "/projects", undefined, { timeout: 5000 });
  const projects = Array.isArray(projectsPayload.projects) ? projectsPayload.projects : [];
  const pending = health.pendingPlaceSetup as any;
  const isCreatingNew = (pending && pending.placeId) || options.requirePendingSetup;

  if (isCreatingNew) {
    const placeName = await vscode.window.showInputBox({
      title: "Configure Place Sync: Project Name",
      prompt: "Choose a name for this place project.",
      value: pending?.placeName || ""
    });
    if (placeName === undefined) return;

    const placeIdInput = await vscode.window.showInputBox({
      title: "Configure Place Sync: Place ID",
      prompt: "Roblox Place ID for this project.",
      value: pending?.placeId ? String(pending.placeId) : "",
      validateInput(value) {
        const id = Number(value);
        if (!value.trim() || !Number.isInteger(id) || id <= 0) {
          return "Please enter a valid positive Roblox Place ID.";
        }
        return null;
      }
    });
    if (placeIdInput === undefined) return;
    const placeId = Number(placeIdInput);
    const sourceProject = sourceProjectForPlaceSync(projects, projectsPayload.defaultProjectId || null);
    const sourceStates = placeSyncMountState(sourceProject);
    const baseDefaults = defaultMountIdsFromProject(sourceProject, "baseEnabled");
    const exclusiveDefaults = defaultMountIdsFromProject(sourceProject, "exclusiveEnabled");
    const baseMountIds = await pickPlaceSyncMountIds(
      "Configure Place Sync: Shared Base Folders",
      "Select shared sync/src folders to keep active for this place",
      baseDefaults,
      "base",
      sourceStates
    );
    if (baseMountIds === null) return;
    const exclusiveMountIds = await pickPlaceSyncMountIds(
      "Configure Place Sync: Exclusive Folders",
      "Select exclusive folders to create and sync for this place",
      exclusiveDefaults,
      "exclusive",
      sourceStates
    );
    if (exclusiveMountIds === null) return;
    const keepUnknowns = await pickKeepUnknowns(true, "Configure Place Sync: Keep Unmapped Instances");
    if (keepUnknowns === null) return;

    const response = await requestJson<Record<string, any>>("POST", "/projects/place-setup", {
      placeId,
      placeName,
      baseMountIds,
      exclusiveMountIds,
      keepUnknowns
    }, { timeout: 10000 });

    log(`Configured place sync by creating ${response.projectId || response.projectPath || "unknown"} for place ${placeId}.`);
    refreshSidebar();
    vscode.window.showInformationMessage(`Configured Amarillo place sync for ${placeName}. Reconnect the Roblox Studio plugin to sync.`);
    return;
  }

  if (projects.length === 0) {
    vscode.window.showWarningMessage("No Amarillo projects were found in this workspace.");
    return;
  }
  const project = await chooseProjectForPlaceSync(projects, health);
  if (!project) return;
  const states = placeSyncMountState(project);
  const baseMountIds = await pickPlaceSyncMountIds(
    "Configure Place Sync: Shared Base Folders",
    "Select shared sync/src folders to keep active",
    states.filter((mount) => mount.baseEnabled).map((mount) => mount.id),
    "base",
    states
  );
  if (baseMountIds === null) return;
  const exclusiveMountIds = await pickPlaceSyncMountIds(
    "Configure Place Sync: Exclusive Folders",
    "Select exclusive folders to sync for this place",
    states.filter((mount) => mount.exclusiveEnabled).map((mount) => mount.id),
    "exclusive",
    states
  );
  if (exclusiveMountIds === null) return;
  const keepUnknowns = await pickKeepUnknowns(
    states.some((mount) => mount.keepUnknowns),
    "Configure Place Sync: Keep Unmapped Instances"
  );
  if (keepUnknowns === null) return;

  await requestJson<Record<string, any>>("PATCH", `/projects/${encodeURIComponent(project.id)}/place-sync`, {
    baseMountIds,
    exclusiveMountIds,
    keepUnknowns
  }, { timeout: 10000 });

  log(`Configured place sync for ${project.id}.`);
  refreshSidebar();
  vscode.window.showInformationMessage(`Configured place sync for ${project.name || project.id}.`);
}

async function createPlaceProjectFromSidebar() {
  await configurePlaceSyncFromSidebar({ requirePendingSetup: true });
}

function normalizePlaceSyncMessageMountIds(value) {
  const validIds = new Set(PLACE_SYNC_MOUNT_OPTIONS.map((mount) => mount.id));
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item || "")).filter((id) => validIds.has(id))))
    : [];
}

async function applyPlaceSyncFromSidebarMessage(message) {
  const baseMountIds = normalizePlaceSyncMessageMountIds(message.baseMountIds);
  const exclusiveMountIds = normalizePlaceSyncMessageMountIds(message.exclusiveMountIds);
  const keepUnknowns = message.keepUnknowns === true;

  if (message.mode === "create") {
    const placeId = Number(message.placeId || 0);
    const placeName = String(message.placeName || "").trim() || `Place ${placeId}`;
    if (!Number.isInteger(placeId) || placeId <= 0) {
      throw new Error("Enter a valid positive Roblox Place ID.");
    }
    const response = await requestJson<Record<string, any>>("POST", "/projects/place-setup", {
      placeId,
      placeName,
      baseMountIds,
      exclusiveMountIds,
      keepUnknowns
    }, { timeout: 10000 });
    log(`Configured inline place sync by creating ${response.projectId || response.projectPath || "unknown"} for place ${placeId}.`);
    refreshSidebar();
    vscode.window.showInformationMessage(`Configured Amarillo place sync for ${placeName}. Reconnect the Roblox Studio plugin to sync.`);
    return;
  }

  const projectId = String(message.projectId || "").trim();
  if (!projectId) {
    throw new Error("Choose a place project before applying place sync.");
  }
  await requestJson<Record<string, any>>("PATCH", `/projects/${encodeURIComponent(projectId)}/place-sync`, {
    baseMountIds,
    exclusiveMountIds,
    keepUnknowns
  }, { timeout: 10000 });
  log(`Configured inline place sync for ${projectId}.`);
  refreshSidebar();
  vscode.window.showInformationMessage("Configured place sync.");
}

function parsePlaceIdsInput(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) {
    return [];
  }
  const parts = trimmed.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean);
  const ids = parts.map((part) => Number(part));
  if (ids.some((id) => !Number.isFinite(id) || id <= 0)) {
    throw new Error("Place IDs must be positive numbers separated by commas.");
  }
  return Array.from(new Set(ids.map((id) => Math.trunc(id))));
}

async function editPlaceIdsFromSidebar() {
  const payload = await requestJson<Record<string, any>>("GET", "/projects", undefined, { timeout: 5000 });
  const projects = Array.isArray(payload.projects) ? payload.projects : [];
  if (projects.length === 0) {
    vscode.window.showWarningMessage("No Amarillo projects were found in this workspace.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.name || project.id,
      description: project.id,
      detail: `Place IDs: ${(project.placeIds || []).join(", ") || "none"}`,
      project
    })),
    { placeHolder: "Choose the project whose Roblox place IDs should change" }
  );
  if (!picked) {
    return;
  }
  const current = Array.isArray(picked.project.placeIds) ? picked.project.placeIds.join(", ") : "";
  const input = await vscode.window.showInputBox({
    title: "Edit Place IDs",
    prompt: "Enter Roblox place IDs separated by commas.",
    value: current,
    validateInput(value) {
      try {
        parsePlaceIdsInput(value);
        return null;
      } catch (error) {
        return error.message;
      }
    }
  });
  if (input === undefined) {
    return;
  }
  const placeIds = parsePlaceIdsInput(input);
  const route = `/projects/${encodeURIComponent(picked.project.id)}/place-ids`;
  await requestJson("PATCH", route, { placeIds }, { timeout: 10000 });
  log(`Updated place IDs for ${picked.project.id}: ${placeIds.join(", ") || "none"}.`);
  refreshSidebar();
  vscode.window.showInformationMessage(`Updated place IDs for ${picked.project.name || picked.project.id}.`);
}

// ===== Execute Code in Studio (Argon exec pattern) =====
async function executeCodeInStudio() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor. Open a .lua or .luau file first.");
    return;
  }

  const selection = editor.document.getText(editor.selection);
  const code = selection || editor.document.getText();

  if (!code.trim()) {
    vscode.window.showWarningMessage("No code to execute.");
    return;
  }

  const session = await chooseSession();
  log(`Executing code in Studio (session ${session.id}, ${code.length} chars)`);

  const response = await requestJson<SessionCommandResponse>("POST", `/session/${session.id}/exec`, {
    code,
    source: selection ? "selection" : editor.document.uri.fsPath
  }, { timeout: 30000 });

  if (response.ok) {
    const resultText = response.result ? `: ${JSON.stringify(response.result)}` : "";
    logInfo(`Code executed successfully${resultText}`, true);
    log(`Execution result: ${JSON.stringify(response)}`);
  } else {
    logError(`Execution failed: ${response.error || "unknown error"}`);
  }
}

// ===== Silent plugin install on activation =====
async function silentPluginInstall(context) {
  try {
    const result = await copyBundledRobloxPlugin(context);
    if (result.status === "up_to_date") {
      log(`Plugin Amarillo auto-install: up_to_date at ${result.targetPath}`);
      return result;
    }
    log(`Plugin Amarillo auto-install: ${result.status} at ${result.targetPath} (source: ${path.basename(path.dirname(result.sourcePath))})`);
    return result;
  } catch (error) {
    log(`Plugin auto-install failed: ${error.message}`);
    return {
      ok: false,
      status: "failed",
      error: error.message
    };
  }
}

// ===== Session restore on activation (Argon pattern) =====
async function restoreLastSession(context) {
  const lastConfig = context.workspaceState.get("amarillo.lastSessionConfig");
  if (!lastConfig || !lastConfig.workspaceRoot) {
    return;
  }

  // Only restore if the workspace matches
  let currentWorkspace;
  try {
    currentWorkspace = resolveWorkspaceRoot();
  } catch (_error) {
    return;
  }

  if (path.resolve(lastConfig.workspaceRoot) !== path.resolve(currentWorkspace)) {
    return;
  }

  // Wait a bit for VS Code to settle before trying to reconnect
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    // Check if daemon is already running
    const health = await fetchDaemonHealth();
    if (health?.ok) {
      try {
        await ensureWorkspaceMcp(context);
      } catch (error) {
        log(`Session restore: failed to ensure MCP: ${error.message}`);
      }
      log("Session restore: daemon already online, checking sessions...");
      const sessions = readySessionsFromHealth(health);
      if (sessions.length > 0) {
        log(`Session restore: found ${sessions.length} active session(s).`);
        refreshSidebar();
        return;
      }
      // Daemon is running but no sessions - request connection.
      await requestConnectionOffer("session_restore");
      bridgeState.offerRequested = true;
      log("Session restore: connection offer created automatically.");
      refreshSidebar();
      return;
    }
  } catch (_error) {
    // Daemon not running - try to start it.
  }

  try {
    log("Session restore: iniciando bridge automaticamente...");
    await startBridge(context, { requestedBy: "session_restore" });
  } catch (error) {
    log(`Session restore: failed to start bridge: ${error.message}`);
  }
}

// Save session config for restore
async function saveSessionConfig() {
  if (!extensionContext) {
    return;
  }
  try {
    const settings = getBridgeSettings();
    await extensionContext.workspaceState.update("amarillo.lastSessionConfig", {
      workspaceRoot: settings.workspaceRoot,
      host: settings.host,
      port: settings.port,
      bridgeToken: getOrCreateBridgeToken(),
      savedAt: new Date().toISOString()
    });
  } catch (_error) {
    // Ignore save errors
  }
}

function activate(context) {
  const activationStartedAt = Date.now();
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Amarillo");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sidebarProvider = new AmarilloSidebarProvider(context);

  context.subscriptions.push(
    outputChannel,
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider("amarillo-activity", {
      provideTextDocumentContent(uri) {
        return activityDiffDocuments.get(uri.toString()) || "";
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === "amarillo-activity") {
        activityDiffDocuments.delete(document.uri.toString());
      }
    }),
    vscode.window.registerWebviewViewProvider("amarillo.sidebar", sidebarProvider),
    vscode.commands.registerCommand("amarillo.installRobloxPlugin", () => installRobloxPlugin(context)),
    vscode.commands.registerCommand("amarillo.startBridge", () => startBridge(context)),
    vscode.commands.registerCommand("amarillo.stopBridge", () => stopBridge()),
    vscode.commands.registerCommand("amarillo.healthcheck", () => runHealthcheck()),
    vscode.commands.registerCommand("amarillo.doctor", () => runDoctor()),
    vscode.commands.registerCommand("amarillo.mcpHealthcheck", () => runMcpHealthcheck()),
    vscode.commands.registerCommand("amarillo.configureMcp", () => configureMcp(context)),
    vscode.commands.registerCommand("amarillo.configureCodexMcp", () => configureMcp(context)),
    vscode.commands.registerCommand("amarillo.openOutput", () => outputChannel.show(true)),
    vscode.commands.registerCommand("amarillo.refreshSidebar", () => refreshSidebar()),
    vscode.commands.registerCommand("amarillo.configurePlaceSync", async () => {
      try {
        await configurePlaceSyncFromSidebar();
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
      }
    }),
    vscode.commands.registerCommand("amarillo.createPlaceProject", async () => {
      try {
        await createPlaceProjectFromSidebar();
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
      }
    }),
    vscode.commands.registerCommand("amarillo.editPlaceIds", async () => {
      try {
        await editPlaceIdsFromSidebar();
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
      }
    }),
    vscode.commands.registerCommand("amarillo.toggleAutoSyncToStudio", async () => {
      try {
        await toggleAutoSyncToStudio();
      } catch (error) {
        const reason = errorMessageFromHttp(error);
        log(`Failed to toggle Auto Sync: ${reason}`);
        vscode.window.showErrorMessage(reason);
      }
    }),
    vscode.commands.registerCommand("amarillo.togglePrivilegedActionConfirmation", async () => {
      try {
        await togglePrivilegedActionConfirmation();
      } catch (error) {
        const reason = errorMessageFromHttp(error);
        log(`Failed to toggle privileged action confirmation: ${reason}`);
        vscode.window.showErrorMessage(reason);
      }
    }),
    vscode.commands.registerCommand("amarillo.sendFilesToStudio", async () => {
      try {
        await sendFilesToStudio();
      } catch (error) {
        log(`Failed to send to Studio: ${error.message}`);
        vscode.window.showErrorMessage(error.message);
      }
    }),
    vscode.commands.registerCommand("amarillo.receiveFilesFromStudio", async () => {
      try {
        await receiveFilesFromStudio();
      } catch (error) {
        log(`Failed to receive from Studio: ${error.message}`);
        vscode.window.showErrorMessage(error.message);
      }
    }),
    vscode.commands.registerCommand("amarillo.selectSession", async () => {
      try {
        await selectSession();
      } catch (error) {
        log(`Failed to select session: ${error.message}`);
        vscode.window.showErrorMessage(error.message);
      }
    }),
    {
      dispose: () => {
        bridgeState.dispose();
        activityDiffDocuments.clear();
        sidebarProvider = null;
        extensionContext = null;
      }
    }
  );

  // ===== QuickPick Menu command (Argon pattern) =====
  context.subscriptions.push(
    vscode.commands.registerCommand("amarillo.openMenu", async () => {
      const menuItems = [
        { label: "$(separator)", kind: vscode.QuickPickItemKind.Separator, description: "General" },
        { label: "$(radio-tower) Start Bridge", description: "Start sync daemon and request connection", action: "startBridge" },
        { label: "$(debug-stop) Stop Bridge", description: "Stop the sync daemon", action: "stopBridge" },
        { label: "$(plug) Select Session", description: "Choose active Studio session", action: "selectSession" },
        { label: "$(settings-gear) Configure Place Sync", description: "Choose shared and exclusive folders for a place", action: "configurePlaceSync" },
        { label: "$(folder-library) Create Place Project", description: "Create a project for the pending Roblox place", action: "createPlaceProject" },
        { label: "$(list-ordered) Edit Place IDs", description: "Change place IDs mapped to a project", action: "editPlaceIds" },
        { label: "$(separator)", kind: vscode.QuickPickItemKind.Separator, description: "Sync" },
        { label: "$(sync) Toggle Auto Sync", description: "Enable or disable VS Code to Studio autosync", action: "toggleAutoSync" },
        { label: "$(shield) Toggle Action Confirmation", description: "Enable or disable Studio prompts for privileged actions", action: "togglePrivilegedActionConfirmation" },
        { label: "$(arrow-up) Send Files to Studio", description: "Push local files to Roblox Studio", action: "sendFilesToStudio" },
        { label: "$(arrow-down) Receive Files from Studio", description: "Pull Studio state to local files", action: "receiveFilesFromStudio" },
        { label: "$(run-all) Execute Code", description: "Run selected code or file in Studio", action: "execCode" },
        { label: "$(separator)", kind: vscode.QuickPickItemKind.Separator, description: "Setup" },
        { label: "$(cloud-download) Install Plugin", description: "Install Amarillo plugin in Roblox Studio", action: "installRobloxPlugin" },
        { label: "$(hubot) Configure MCP", description: "Setup MCP integration for AI tools", action: "configureMcp" },
        { label: "$(shield) MCP Healthcheck", description: "Check native MCP config and HTTP fallback", action: "mcpHealthcheck" },
        { label: "$(beaker) Doctor", description: "Run full Amarillo diagnostics", action: "doctor" },
        { label: "$(pulse) Healthcheck", description: "Check daemon status", action: "healthcheck" },
        { label: "$(separator)", kind: vscode.QuickPickItemKind.Separator, description: "Misc" },
        { label: "$(output) Open Output", description: "Show Amarillo output channel", action: "openOutput" },
        { label: "$(gear) Settings", description: "Open Amarillo settings", action: "settings" }
      ];

      const picked = await vscode.window.showQuickPick(menuItems, {
        title: `Amarillo v${extensionVersion(context)}`,
        placeHolder: "Select an action..."
      });

      if (!picked || !picked.action) {
        return;
      }

      try {
        switch (picked.action) {
          case "startBridge": await startBridge(context); break;
          case "stopBridge": await stopBridge(); break;
          case "selectSession": await selectSession(); break;
          case "configurePlaceSync": await configurePlaceSyncFromSidebar(); break;
          case "createPlaceProject": await createPlaceProjectFromSidebar(); break;
          case "editPlaceIds": await editPlaceIdsFromSidebar(); break;
          case "toggleAutoSync": await toggleAutoSyncToStudio(); break;
          case "togglePrivilegedActionConfirmation": await togglePrivilegedActionConfirmation(); break;
          case "sendFilesToStudio": await sendFilesToStudio(); break;
          case "receiveFilesFromStudio": await receiveFilesFromStudio(); break;
          case "execCode": await executeCodeInStudio(); break;
          case "installRobloxPlugin": await installRobloxPlugin(context); break;
          case "configureMcp": await configureMcp(context); break;
          case "mcpHealthcheck": await runMcpHealthcheck(); break;
          case "doctor": await runDoctor(); break;
          case "healthcheck": await runHealthcheck(); break;
          case "openOutput": outputChannel.show(true); break;
          case "settings": vscode.commands.executeCommand("workbench.action.openSettings", "amarillo"); break;
        }
      } catch (error) {
        if (error && error.message) {
          logError(error.message);
        }
      }
    })
  );

  // ===== Execute Code in Studio command =====
  context.subscriptions.push(
    vscode.commands.registerCommand("amarillo.execCode", async () => {
      try {
        await executeCodeInStudio();
      } catch (error) {
        log(`Failed to execute code: ${error.message}`);
        vscode.window.showErrorMessage(error.message);
      }
    })
  );

  // ===== TOML Autocomplete for argon.toml (Argon pattern) =====
  const tomlSelector = [
    { language: "toml", scheme: "file", pattern: "**/argon.toml" },
    { language: "toml", scheme: "file", pattern: "**/.argon/config.toml" }
  ];

  const TOML_SETTINGS = [
    { field: "host", value: '"${1:localhost}"', doc: "Default server host name" },
    { field: "port", value: "${1:8000}", doc: "Default server port number" },
    { field: "template", value: '"${1|place,plugin,package,model,quick|}"', doc: "Default project template" },
    { field: "include_docs", value: "${1|true,false|}", doc: "Include documentation in the project" },
    { field: "use_git", value: "${1|true,false|}", doc: "Use git for source control" },
    { field: "run_async", value: "${1|false,true|}", doc: "Run Argon asynchronously" },
    { field: "scan_ports", value: "${1|true,false|}", doc: "Scan for available port if default is in use" },
    { field: "detect_project", value: "${1|true,false|}", doc: "Automatically detect project type" },
    { field: "with_sourcemap", value: "${1|false,true|}", doc: "Always generate sourcemap" },
    { field: "check_updates", value: "${1|true,false|}", doc: "Check for new releases on startup" },
    { field: "install_plugin", value: "${1|true,false|}", doc: "Install Roblox plugin locally" },
    { field: "rojo_mode", value: "${1|true,false|}", doc: "Use Rojo namespace by default" },
    { field: "rename_instances", value: "${1|true,false|}", doc: "Rename corrupted instances when syncing" },
    { field: "changes_threshold", value: "${1:5}", doc: "Number of changes before prompting user" },
    { field: "lua_extension", value: "${1|false,true|}", doc: "Use .lua instead of .luau" },
    { field: "ignore_line_endings", value: "${1|true,false|}", doc: "Ignore line endings when reading files" }
  ];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(tomlSelector, {
      provideCompletionItems(document) {
        const text = document.getText();
        return TOML_SETTINGS.flatMap((setting) => {
          // Don't suggest if already present
          if (text.includes(setting.field)) {
            for (const line of text.split("\n")) {
              if (line.includes(setting.field) && !line.trimStart().startsWith("#")) {
                return [];
              }
            }
          }
          const item = new vscode.CompletionItem(setting.field, vscode.CompletionItemKind.Field);
          item.insertText = new vscode.SnippetString(`${setting.field} = ${setting.value}`);
          item.documentation = new vscode.MarkdownString(setting.doc);
          return [item];
        });
      }
    })
  );

  // ===== Plugin auto-install on activation =====
  void repairExistingWorkspaceMcpOnActivate(context);

  const autoInstall = vscode.workspace.getConfiguration("amarillo").get("autoInstallPlugin", true);
  if (autoInstall) {
    void silentPluginInstall(context);
  }

  // ===== Session restore on activation =====
  const autoConnect = vscode.workspace.getConfiguration("amarillo").get("autoConnect", false);
  if (autoConnect) {
    void restoreLastSession(context);
  }

  registerWorkspaceFileOperationWatchers(context);
  updateStatusBar();
  refreshSidebar();
  log(`Amarillo extension activated in ${Date.now() - activationStartedAt}ms on VS Code ${vscode.version}; extension ${extensionVersion(context)}.`);
  scheduleExistingWorkspaceSourcemapOnActivate(context);
}

function deactivate() {
  bridgeState.dispose();
  activityDiffDocuments.clear();
}

module.exports = {
  activate,
  deactivate
};

