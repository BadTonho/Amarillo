"use strict";

import type { Server as HttpServer } from "node:http";
import type { FSWatcher } from "node:fs";
import type { ConnectionOfferStatus } from "./contracts/connection";
import type {
  ActivityChangeInput,
  ActivityDefaults,
  ActivityFileInfo,
  ActivityLogLike,
  AppOptions,
  CommandDeferred,
  ConnectionOfferResolutionDetails,
  ConnectionOfferRuntime,
  DaemonConfig,
  DestructiveCommandResult,
  ErrorInput,
  ErrorTrackerLike,
  McpAuditLogLike,
  McpShieldState,
  PendingStudioWrite,
  ProjectCatalogIssue,
  ProjectSelection,
  RateLimiterLike,
  RuntimeProject,
  RuntimeSession,
  SessionOpenOptions,
  SyncCommand,
  SyncDegradedDetails
} from "./contracts/runtime";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { performance } = require("node:perf_hooks");
const {
  loadWorkspaceProjectCatalog,
  findDuplicateMountRootPathIssue,
  moveOrphanScriptMetaForFile,
  readLocalProjectState,
  readLocalProjectStateAsync,
  readWorkspaceConfig,
  resolveProjectSelectionForPlace,
  validateProjectSnapshotMounts,
  validateProjectTreeFiles,
  writeStudioProjectState
} = require("./project");
const { ErrorTracker } = require("./lib/error-tracker");
const { ActivityLog, getFileInfo } = require("./lib/activity-log");
const { McpAuditLog } = require("./lib/mcp-audit-log");
const { RateLimiter } = require("./lib/rate-limiter");
const { PerfTracker } = require("./lib/perf-tracker");
const { diffSnapshots, hashSnapshot, normalizeAndHashSnapshot, stringifySorted } = require("./lib/snapshot-hash");
const { ensurePluginInstructionsFile } = require("./lib/instructions");
const { DoctorService } = require("./services/doctor-service");
const { SessionRegistry } = require("./services/session-registry");
const { StudioSnapshotWriter } = require("./services/studio-snapshot-writer");
const { SyncCoordinator } = require("./services/sync-coordinator");
const { WorkspaceWatcher } = require("./services/workspace-watcher");
const {
  DEFAULT_SYNC_TARGETS,
  filterProjectBySyncTargets,
  filterSnapshotBySyncTargets,
  isMountSyncEnabled,
  isWorkspaceMount,
  normalizeSyncTargets
} = require("./sync-targets");
const { handleConnectionRoutes } = require("./routes/connection");
const { handleDiagnosticsRoutes } = require("./routes/diagnostics");
const { handleMcpRoutes } = require("./routes/mcp");
const { handleSessionRoutes } = require("./routes/session");
const { handleStudioRoutes } = require("./routes/studio");
const {
  AUTHORIZATION_HEADER,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_TOKEN_HEADER_DISPLAY,
  HttpError,
  MCP_AUTH_HELP_PATH,
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_HEADER_DISPLAY,
  authHelpPayload,
  bridgeTokenFromHeaders,
  errorResponse,
  isCorsOriginAllowed,
  jsonResponse,
  normalizeToken,
  readJsonBody,
  timingSafeEqualString
} = require("./http-utils");
const { handleTool: handleMcpTool } = require("./mcp");
const {
  pathInsideProjectRoot,
  projectRootFromRelativePath,
  resolveWorkspaceProjectRoot
} = require("./project-roots");
const {
  createMcpShieldState,
  listTools,
  mcpToolResultToHttpPayload
} = require("./mcp-shield");
const {
  AMARILLO_PROTOCOL_VERSION,
  CURRENT_PLUGIN_VERSION,
  DAEMON_VERSION,
  MIN_PLUGIN_VERSION,
  isVersionAtLeast,
  normalizeProtocolVersion,
  normalizeVersion
} = require("./version");

// OPT-001/002: Simplified hash — direct JSON.stringify with sorted keys
function createDeferred(): CommandDeferred {
  let resolve: (value?: unknown) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function logSync(event, details: Record<string, unknown> = {}) {
  if (process.env.AMARILLO_DEBUG !== "1") {
    return;
  }
  const timestamp = new Date().toISOString();
  const msg = {
    timestamp,
    event,
    ...details
  };
  process.stderr.write(`[SYNC] ${JSON.stringify(msg)}\n`);
}

function isLoopbackHost(host) {
  const normalized = String(host || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1";
}

const SCRIPT_PATCH_DEBOUNCE_MS = 75;
const SCRIPT_PATCH_BURST_LIMIT = 25;
const PROJECT_TREE_DEBOUNCE_MS = 250;
const WORKSPACE_WATCHER_EVENT_DEBOUNCE_MS = 50;
const STUDIO_DISK_WRITE_EVENT_SUPPRESSION_MS = 1500;
const COMMAND_RESULT_TIMEOUT_MS = 120000;
const SYNC_COMMAND_PICKUP_TIMEOUT_MS = 30000;
const SYNC_COMMAND_COMPLETION_TIMEOUT_MS = 180000;
const SYNC_COMMAND_WAIT_TIMEOUT_MS = SYNC_COMMAND_PICKUP_TIMEOUT_MS + SYNC_COMMAND_COMPLETION_TIMEOUT_MS;
const INITIAL_STUDIO_SYNC_REASON = "initial_accept";
const INITIAL_PC_SYNC_REASON = "initial_pc_truth";
const INITIAL_STUDIO_CONTACT_GRACE_MS = 5000;
const STUDIO_SESSION_STALE_MS = 30000;
const STUDIO_CONTACT_STALE_WARNING_MS = 35000;
const STUDIO_CONTACT_CRITICAL_MS = 65000;
const DEFAULT_AUTO_SYNC_TO_STUDIO = true;
const DEFAULT_PRIVILEGED_ACTION_CONFIRMATION = true;
const PRIVILEGED_ACTION_RATE_LIMIT = 20;
const PRIVILEGED_ACTION_RATE_WINDOW_MS = 1000;
const HTTP_SHUTDOWN_TIMEOUT_MS = 5000;
const ACTIVITY_STATE_MAX_TEXT_BYTES = 8 * 1024 * 1024;
const SYNC_COMMAND_TYPES = new Set(["apply_project_tree", "apply_file_patch"]);
const DESTRUCTIVE_ACTION_TYPES = new Set(["modify_property", "create_instance", "delete_instance", "insert_model"]);
const PLACE_SYNC_BASE_DISABLED_PATH_KEY = "$amarilloDisabledPath";
const PLACE_SYNC_EXCLUSIVE_DISABLED_PATH_KEY = "$amarilloDisabledExclusivePath";
const PLACE_SYNC_MOUNTS = [
  { id: "Workspace", label: "Workspace", segments: ["Workspace"], sharedPath: "sync/Workspace", exclusivePath: "Workspace" },
  { id: "ReplicatedStorage", label: "ReplicatedStorage", segments: ["ReplicatedStorage"], sharedPath: "sync/ReplicatedStorage", exclusivePath: "ReplicatedStorage" },
  { id: "ServerScriptService", label: "ServerScriptService", segments: ["ServerScriptService"], sharedPath: "sync/ServerScriptService", exclusivePath: "ServerScriptService" },
  { id: "ServerStorage", label: "ServerStorage", segments: ["ServerStorage"], sharedPath: "sync/ServerStorage", exclusivePath: "ServerStorage" },
  { id: "StarterGui", label: "StarterGui", segments: ["StarterGui"], sharedPath: "sync/StarterGui", exclusivePath: "StarterGui" },
  { id: "StarterPlayer.StarterCharacterScripts", label: "StarterCharacterScripts", segments: ["StarterPlayer", "StarterCharacterScripts"], sharedPath: "sync/StarterPlayer/StarterCharacterScripts", exclusivePath: "StarterPlayer/StarterCharacterScripts" },
  { id: "StarterPlayer.StarterPlayerScripts", label: "StarterPlayerScripts", segments: ["StarterPlayer", "StarterPlayerScripts"], sharedPath: "sync/StarterPlayer/StarterPlayerScripts", exclusivePath: "StarterPlayer/StarterPlayerScripts" }
];
const STANDARD_PLACE_EXCLUSIVE_MOUNTS = PLACE_SYNC_MOUNTS;

function sharedPathForPlaceMount(mount, projectRoot = "sync") {
  return pathInsideProjectRoot(projectRoot, mount.exclusivePath);
}

function buildDefaultPlaceProjectTree(projectRoot = "sync") {
  return {
    "$className": "DataModel",
    Workspace: { "$path": sharedPathForPlaceMount(PLACE_SYNC_MOUNTS[0], projectRoot) },
    ReplicatedStorage: { "$path": sharedPathForPlaceMount(PLACE_SYNC_MOUNTS[1], projectRoot) },
    ServerScriptService: { "$path": sharedPathForPlaceMount(PLACE_SYNC_MOUNTS[2], projectRoot) },
    ServerStorage: { "$path": sharedPathForPlaceMount(PLACE_SYNC_MOUNTS[3], projectRoot) },
    StarterGui: { "$path": sharedPathForPlaceMount(PLACE_SYNC_MOUNTS[4], projectRoot) },
    StarterPlayer: {
      StarterCharacterScripts: { "$path": sharedPathForPlaceMount(PLACE_SYNC_MOUNTS[5], projectRoot) },
      StarterPlayerScripts: { "$path": sharedPathForPlaceMount(PLACE_SYNC_MOUNTS[6], projectRoot) }
    }
  };
}

function cloneJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = cloneJson(item);
    }
    return output;
  }
  return value;
}

function normalizePlaceName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function placeSlugFromName(value, fallback = "Place") {
  const normalized = String(value || fallback)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
  const slug = normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return slug || fallback;
}

function normalizePlaceIds(value) {
  const source = Array.isArray(value) ? value : [value];
  const ids = [];
  const seen = new Set();
  for (const item of source) {
    const id = Number(item);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }
    const normalized = Math.trunc(id);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      ids.push(normalized);
    }
  }
  return ids;
}

function objectHasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function allPlaceSyncMountIds() {
  return new Set(PLACE_SYNC_MOUNTS.map((mount) => mount.id));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function placeSyncMountIdSetFromArray(value) {
  const values = normalizeStringArray(value);
  if (!values) {
    return null;
  }
  const ids = new Set();
  for (const rawValue of values) {
    for (const mount of PLACE_SYNC_MOUNTS) {
      const aliases = [
        mount.id,
        mount.label,
        mount.segments[0],
        mount.exclusivePath
      ];
      if (aliases.includes(rawValue)) {
        ids.add(mount.id);
      }
    }
  }
  return ids;
}

function resolveExclusiveMountIds(options: Record<string, unknown> = {}) {
  if (objectHasOwn(options, "exclusiveMountIds")) {
    return placeSyncMountIdSetFromArray(options.exclusiveMountIds) || new Set();
  }
  if (objectHasOwn(options, "exclusiveServices")) {
    return placeSyncMountIdSetFromArray(options.exclusiveServices) || new Set();
  }
  return allPlaceSyncMountIds();
}

function resolveBaseMountIds(options: Record<string, unknown> = {}) {
  if (objectHasOwn(options, "baseMountIds")) {
    return placeSyncMountIdSetFromArray(options.baseMountIds) || new Set();
  }
  if (options.includeBase === false) {
    return new Set();
  }
  return allPlaceSyncMountIds();
}

function getTreeNode(root, segments, create = false) {
  let node = root;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return null;
    }
    if (!node[segment] || typeof node[segment] !== "object" || Array.isArray(node[segment])) {
      if (!create) {
        return null;
      }
      node[segment] = {};
    }
    node = node[segment];
  }
  return node;
}

function ensureTreeNode(root, segments, sharedPath = null) {
  const node = getTreeNode(root, segments, true);
  if (node && typeof sharedPath === "string" && typeof node.$path !== "string") {
    node.$path = sharedPath;
  }
  return node;
}

function findExistingExclusiveNodeNameForLeaf(leaf) {
  if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) {
    return null;
  }
  return Object.keys(leaf).find((key) => (
    key.startsWith("Exclusivo")
    && leaf[key]
    && typeof leaf[key] === "object"
    && !Array.isArray(leaf[key])
  )) || null;
}

function removeGeneratedExclusiveChildren(leaf) {
  if (!leaf || typeof leaf !== "object") {
    return;
  }
  for (const key of Object.keys(leaf)) {
    if (key.startsWith("Exclusivo")) {
      delete leaf[key];
    }
  }
}

function normalizeProjectRelativePath(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\\/g, "/")
    : null;
}

function addProjectRootCount(counts, relativePath) {
  const root = projectRootFromRelativePath(relativePath);
  if (!root) {
    return counts;
  }
  counts.set(root, (counts.get(root) || 0) + 1);
  return counts;
}

function collectProjectRootCountsFromTree(node, counts = new Map()) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return counts;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$") && typeof value === "string") {
      addProjectRootCount(counts, value);
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      collectProjectRootCountsFromTree(value, counts);
    }
  }
  return counts;
}

function dominantProjectRootFromCounts(counts) {
  let selectedRoot = null;
  let selectedCount = 0;
  for (const [root, count] of counts.entries()) {
    if (count > selectedCount) {
      selectedRoot = root;
      selectedCount = count;
    } else if (count === selectedCount) {
      selectedRoot = null;
    }
  }
  return selectedRoot;
}

function inferProjectRootFromTree(tree) {
  return dominantProjectRootFromCounts(collectProjectRootCountsFromTree(tree));
}

function inferProjectRootFromProject(project) {
  const counts = new Map();
  collectProjectRootCountsFromTree(project?.tree || project?.raw?.tree || {}, counts);
  for (const mount of project?.mounts || []) {
    addProjectRootCount(counts, mount.relativePath);
  }
  return dominantProjectRootFromCounts(counts);
}

function resolvePlaceProjectRoot(workspaceRoot, project = null, fallback = "sync") {
  return inferProjectRootFromProject(project)
    || resolveWorkspaceProjectRoot(workspaceRoot, { fallback });
}

function placeSyncExclusiveRelativePath(placeSlug, mount) {
  return `${placeSlug}/exclusive/${mount.exclusivePath}`;
}

function placeSyncExclusivePathSuffix(mount) {
  return `/exclusive/${mount.exclusivePath}`;
}

function isPlaceSyncExclusiveRelativePath(value, mount) {
  const normalized = normalizeProjectRelativePath(value);
  if (!normalized) {
    return false;
  }
  return normalized.endsWith(placeSyncExclusivePathSuffix(mount))
    || normalized === `exclusive/${mount.exclusivePath}`;
}

function exclusiveNodeNameForMount(mount, placeSlug) {
  return `Exclusivo${placeSlugFromName(mount.label || mount.id || "Pasta", "Pasta")}${placeSlug}`;
}

function pruneEmptyTreeNodes(node, isRoot = true) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return false;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$") || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    if (pruneEmptyTreeNodes(value, false)) {
      delete node[key];
    }
  }
  if (isRoot) {
    return false;
  }
  return Object.keys(node).length === 0;
}

function configurePlaceSyncTree(tree, placeSlug, options: Record<string, unknown> = {}) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    tree = {};
  }
  const defaultSharedRoot = projectRootFromRelativePath(options.defaultSharedRoot) || "sync";
  const exclusiveMountIds = resolveExclusiveMountIds(options);
  const baseMountIds = resolveBaseMountIds(options);
  if (!tree.$className) {
    tree.$className = "DataModel";
  }

  for (const mount of STANDARD_PLACE_EXCLUSIVE_MOUNTS) {
    const wantsBase = baseMountIds.has(mount.id);
    const wantsExclusive = exclusiveMountIds.has(mount.id);
    const leaf = getTreeNode(tree, mount.segments, wantsBase || wantsExclusive);
    if (!leaf) {
      continue;
    }

    const existingExclusiveName = findExistingExclusiveNodeNameForLeaf(leaf);
    const existingExclusiveNode = existingExclusiveName ? leaf[existingExclusiveName] : null;
    const currentPath = normalizeProjectRelativePath(leaf.$path);
    const disabledBasePath = normalizeProjectRelativePath(leaf[PLACE_SYNC_BASE_DISABLED_PATH_KEY]);
    const disabledExclusivePath = normalizeProjectRelativePath(leaf[PLACE_SYNC_EXCLUSIVE_DISABLED_PATH_KEY]);
    const childExclusivePath = normalizeProjectRelativePath(existingExclusiveNode?.$path);
    const currentPathIsExclusive = isPlaceSyncExclusiveRelativePath(currentPath, mount)
      || (disabledBasePath !== null && currentPath !== null && childExclusivePath === null);
    const basePath = disabledBasePath
      || (currentPath && !currentPathIsExclusive ? currentPath : null)
      || sharedPathForPlaceMount(mount, defaultSharedRoot);
    const exclusivePath = childExclusivePath
      || disabledExclusivePath
      || (currentPathIsExclusive ? currentPath : null)
      || placeSyncExclusiveRelativePath(placeSlug, mount);

    if (wantsBase) {
      leaf.$path = basePath;
      delete leaf[PLACE_SYNC_BASE_DISABLED_PATH_KEY];
    } else {
      leaf[PLACE_SYNC_BASE_DISABLED_PATH_KEY] = basePath;
      if (!wantsExclusive) {
        delete leaf.$path;
      }
    }

    if (wantsExclusive && wantsBase) {
      const targetExclusiveName = existingExclusiveName || exclusiveNodeNameForMount(mount, placeSlug);
      for (const key of Object.keys(leaf)) {
        if (key.startsWith("Exclusivo") && key !== targetExclusiveName) {
          delete leaf[key];
        }
      }
      if (!leaf[targetExclusiveName] || typeof leaf[targetExclusiveName] !== "object" || Array.isArray(leaf[targetExclusiveName])) {
        leaf[targetExclusiveName] = {};
      }
      if (exclusivePath) {
        leaf[targetExclusiveName].$path = exclusivePath;
      }
      delete leaf[PLACE_SYNC_EXCLUSIVE_DISABLED_PATH_KEY];
    } else if (wantsExclusive) {
      if (exclusivePath) {
        leaf.$path = exclusivePath;
      }
      delete leaf[PLACE_SYNC_EXCLUSIVE_DISABLED_PATH_KEY];
      removeGeneratedExclusiveChildren(leaf);
    } else {
      if (childExclusivePath || currentPathIsExclusive || disabledExclusivePath) {
        leaf[PLACE_SYNC_EXCLUSIVE_DISABLED_PATH_KEY] = exclusivePath;
      }
      removeGeneratedExclusiveChildren(leaf);
    }
  }
  pruneEmptyTreeNodes(tree);
  return tree;
}

function addExclusivePlaceMounts(tree, placeSlug, exclusiveServices = null) {
  return configurePlaceSyncTree(tree, placeSlug, { exclusiveServices });
}

function stripBaseSyncPaths(tree: any) {
  for (const mount of STANDARD_PLACE_EXCLUSIVE_MOUNTS) {
    const leaf = getTreeNode(tree, mount.segments, false);
    if (leaf && typeof leaf.$path === "string") {
      leaf[PLACE_SYNC_BASE_DISABLED_PATH_KEY] = leaf.$path;
      delete leaf.$path;
    }
  }
  pruneEmptyTreeNodes(tree);
  return tree;
}

function setKeepUnknowns(tree: any, enabled) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    return tree;
  }
  if (enabled && typeof tree.$path === "string") {
    tree.$keepUnknowns = true;
  } else if (!enabled && objectHasOwn(tree, "$keepUnknowns")) {
    delete tree.$keepUnknowns;
  }
  for (const value of Object.values(tree)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      setKeepUnknowns(value, enabled);
    }
  }
  return tree;
}

function applyKeepUnknowns(tree: any) {
  return setKeepUnknowns(tree, true);
}

function segmentsEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((segment, index) => segment === right[index]);
}

function segmentsStartWith(value, prefix) {
  return Array.isArray(value)
    && Array.isArray(prefix)
    && value.length >= prefix.length
    && prefix.every((segment, index) => value[index] === segment);
}

function buildProjectPlaceSyncPayload(project) {
  const mounts = Array.isArray(project?.mounts) ? project.mounts : [];
  const sharedRoot = inferProjectRootFromProject(project) || "sync";
  return {
    mounts: STANDARD_PLACE_EXCLUSIVE_MOUNTS.map((config) => {
      const leaf = getTreeNode(project?.tree || project?.raw?.tree || {}, config.segments, false);
      const exactMount = mounts.find((mount) => segmentsEqual(mount.segments, config.segments)) || null;
      const exclusiveMount = mounts.find((mount) => (
        segmentsStartWith(mount.segments, config.segments)
        && mount.segments.length === config.segments.length + 1
        && String(mount.segments[mount.segments.length - 1] || "").startsWith("Exclusivo")
      )) || null;
      const directExclusiveMount = !exclusiveMount
        && exactMount
        && (
          isPlaceSyncExclusiveRelativePath(exactMount.relativePath, config)
          || (leaf && typeof leaf[PLACE_SYNC_BASE_DISABLED_PATH_KEY] === "string")
        )
        ? exactMount
        : null;
      const baseMount = directExclusiveMount ? null : exactMount;
      return {
        id: config.id,
        label: config.label,
        path: config.segments.join("."),
        sharedPath: sharedPathForPlaceMount(config, sharedRoot),
        exclusivePath: config.exclusivePath,
        baseEnabled: Boolean(baseMount),
        baseRelativePath: baseMount?.relativePath || normalizeProjectRelativePath(leaf?.[PLACE_SYNC_BASE_DISABLED_PATH_KEY]) || null,
        exclusiveEnabled: Boolean(exclusiveMount || directExclusiveMount),
        exclusiveRelativePath: exclusiveMount?.relativePath
          || directExclusiveMount?.relativePath
          || normalizeProjectRelativePath(leaf?.[PLACE_SYNC_EXCLUSIVE_DISABLED_PATH_KEY])
          || null,
        keepUnknowns: baseMount?.keepUnknowns || exclusiveMount?.keepUnknowns || directExclusiveMount?.keepUnknowns || false
      };
    })
  };
}

function createSyncState() {
  return {
    state: "ready",
    lastAckAt: null,
    lastVerifiedAt: null,
    lastFailure: null,
    lastExpectedHash: null,
    lastObservedHash: null,
    degradedReason: null
  };
}

function isSyncCommandType(type) {
  return SYNC_COMMAND_TYPES.has(type);
}

function isDestructiveActionType(type) {
  return DESTRUCTIVE_ACTION_TYPES.has(type);
}

function coerceQueryBoolean(value) {
  if (typeof value !== "string") {
    return false;
  }
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeFsPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function isPathInside(childPath, parentPath) {
  const child = normalizeFsPath(childPath);
  const parent = normalizeFsPath(parentPath).replace(/\/+$/, "");
  return child === parent || child.startsWith(`${parent}/`);
}

function parseTimestampMs(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function coerceBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function formatElapsedMs(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "0s";
  }
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function segmentsHavePrefix(segments, prefix) {
  if (!Array.isArray(segments) || !Array.isArray(prefix) || prefix.length > segments.length) {
    return false;
  }
  return prefix.every((segment, index) => segments[index] === segment);
}

function normalizeInstancePathSegmentsForMountGuard(value) {
  const rawSegments = Array.isArray(value)
    ? value
    : String(value || "").split(".");
  return rawSegments
    .map((segment) => String(segment || "").trim())
    .filter((segment) => segment.length > 0 && !["game", "datamodel"].includes(segment.toLowerCase()));
}

function mountSegmentsForGuard(mount) {
  if (Array.isArray(mount?.segments)) {
    return mount.segments.filter((segment) => typeof segment === "string" && segment.length > 0);
  }
  if (typeof mount?.path === "string") {
    return mount.path.split(".").filter(Boolean);
  }
  if (typeof mount?.id === "string") {
    return mount.id.split(".").filter(Boolean);
  }
  return [];
}

function activeSyncMountSegments(project, syncTargets) {
  const mounts = Array.isArray(project?.mounts) ? project.mounts : [];
  return mounts
    .filter((mount) => isMountSyncEnabled(mount, syncTargets))
    .map((mount) => mountSegmentsForGuard(mount))
    .filter((segments) => segments.length > 0);
}

function instancePathLabel(segments) {
  return segments.length > 0 ? `game.${segments.join(".")}` : "game";
}

function targetSegmentsForDestructiveCommand(type, payload: any = {}) {
  if (type === "modify_property" || type === "delete_instance") {
    return normalizeInstancePathSegmentsForMountGuard(payload.path);
  }
  if (type === "create_instance") {
    const parentSegments = normalizeInstancePathSegmentsForMountGuard(payload.parentPath);
    const instanceName = typeof payload.name === "string" && payload.name.length > 0
      ? payload.name
      : (typeof payload.className === "string" ? payload.className : "");
    return instanceName ? parentSegments.concat(instanceName) : parentSegments;
  }
  return null;
}

function validateDestructiveCommandSyncMount(project, session, type, payload: any, syncTargets) {
  const targetSegments = targetSegmentsForDestructiveCommand(type, payload);
  if (!targetSegments) {
    return { allowed: true };
  }

  const activeMounts = activeSyncMountSegments(project, syncTargets);
  const isInsideActiveMount = activeMounts.some((mountSegments) => segmentsHavePrefix(targetSegments, mountSegments));
  if (isInsideActiveMount) {
    const duplicateMountIssue = findDuplicateMountRootPathIssue(
      filterProjectBySyncTargets(project, normalizeSyncTargets(syncTargets)),
      targetSegments
    );
    if (duplicateMountIssue) {
      const targetLabel = instancePathLabel(targetSegments);
      return {
        allowed: false,
        blocked: true,
        reasonCode: "DUPLICATE_MOUNT_ROOT",
        message: `${type} blocked: target path '${targetLabel}' would create or mutate duplicate mount root '${duplicateMountIssue.fileName}' inside active mount '${duplicateMountIssue.expectedMountPath}'. Put children directly under '${duplicateMountIssue.expectedMountPath}' instead.`,
        targetPath: targetLabel,
        expectedMountPath: duplicateMountIssue.expectedMountPath,
        mountId: duplicateMountIssue.mountId
      };
    }
    return { allowed: true };
  }

  const activeMountLabels = activeMounts.map(instancePathLabel);
  const projectLabel = project?.name || project?.id || session?.projectId || "current project";
  const targetLabel = instancePathLabel(targetSegments);
  const mountList = activeMountLabels.length > 0 ? activeMountLabels.join(", ") : "none";
  return {
    allowed: false,
    blocked: true,
    reasonCode: "OUTSIDE_SYNC_MOUNT",
    message: `${type} blocked: target path '${targetLabel}' is outside the active sync mounts for project '${projectLabel}'. Active mounts: ${mountList}.`,
    targetPath: targetLabel,
    activeMounts: activeMountLabels
  };
}

function findSnapshotNode(snapshot, instanceSegments) {
  if (!snapshot || !Array.isArray(snapshot.mounts) || !Array.isArray(instanceSegments)) {
    return null;
  }

  for (const mount of snapshot.mounts) {
    const mountSegments = Array.isArray(mount.segments) ? mount.segments : [];
    if (!segmentsHavePrefix(instanceSegments, mountSegments)) {
      continue;
    }

    let children = Array.isArray(mount.children) ? mount.children : [];
    let node = null;
    for (const segment of instanceSegments.slice(mountSegments.length)) {
      node = children.find((child) => child.name === segment) || null;
      if (!node) {
        return null;
      }
      children = Array.isArray(node.children) ? node.children : [];
    }
    return node || mount;
  }

  return null;
}

function isScriptSnapshotNode(node) {
  return Boolean(
    node
    && (
      Boolean(node.fileKind)
      || node.className === "Script"
      || node.className === "LocalScript"
      || node.className === "ModuleScript"
    )
  );
}

function normalizeScriptSourceForPatchVerification(source) {
  return String(source ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/g, "");
}

function scriptSourcesMatchForPatchVerification(expected, observed) {
  const expectedSource = String(expected ?? "");
  const observedSource = String(observed ?? "");
  return observedSource === expectedSource ||
    normalizeScriptSourceForPatchVerification(observedSource) === normalizeScriptSourceForPatchVerification(expectedSource);
}

function normalizeStudioInstancePathSegments(instancePath) {
  if (Array.isArray(instancePath)) {
    return instancePath.filter((segment) => typeof segment === "string" && segment.length > 0);
  }
  if (typeof instancePath !== "string") {
    return [];
  }
  return instancePath
    .split(".")
    .filter((segment) => segment.length > 0 && segment !== "game" && segment !== "DataModel");
}

function collectFilesRecursive(dirPath, results = []) {
  if (!fs.existsSync(dirPath)) {
    return results;
  }
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_error) {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(fullPath, results);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function isInitialStudioSyncPending(session) {
  return (session?.connectionState || "ready") !== "ready"
    && session?.truthSource === "studio"
    && !session?.lastAppliedAt;
}

class PluginRobloxApp {
  workspaceRoot: string;
  host: string;
  port: number;
  strictPort: boolean;
  autoSyncToStudioExplicit: boolean;
  autoSyncToStudio: boolean;
  syncTargets: Record<string, boolean>;
  privilegedActionConfirmation: boolean;
  bridgeToken: string | null;
  extensionVersion: string | null;
  extensionProtocolVersion: number | null;
  initialStudioContactGraceMs: number;
  studioSessionStaleMs: number;
  httpServer: HttpServer | null;
  allProjects: RuntimeProject[];
  projects: RuntimeProject[];
  projectCatalogIssues: ProjectCatalogIssue[];
  config: DaemonConfig;
  defaultProjectId: string | null;
  sessions: Map<string, RuntimeSession>;
  connectionOffer: ConnectionOfferRuntime | null;
  pendingPlaceSetup: Record<string, unknown> | null;
  fileWatchers: FSWatcher[];
  pendingStudioWrites: Map<string, PendingStudioWrite>;
  lastWorkspaceRefresh: string | null;
  lastDiskWriteTime: number | null;
  lastProjectIssueKeys: Set<string>;
  errorTracker: ErrorTrackerLike;
  activityLog: ActivityLogLike;
  mcpAuditLog: McpAuditLogLike;
  activityFileState: Map<string, ActivityFileInfo>;
  activityFileStateTextBytes: number;
  activityKnownFiles: Set<string>;
  mcpShield: McpShieldState;
  recentUnauthorizedHttpRequests: Map<string, number>;
  rateLimiter: RateLimiterLike;
  privilegedRateLimiter: RateLimiterLike;
  shutdownPromise: Promise<void> | null;
  shuttingDown: boolean;
  perfTracker: any;
  doctorService: any;
  sessionRegistry: any;
  studioSnapshotWriter: any;
  syncCoordinator: any;
  workspaceWatcher: any;

  constructor(options: AppOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.host = options.host || "127.0.0.1";
    this.port = Number(options.port || 8323);
    this.strictPort = options.strictPort === true;
    this.autoSyncToStudioExplicit = options.autoSyncToStudio !== undefined;
    this.autoSyncToStudio = coerceBoolean(options.autoSyncToStudio, DEFAULT_AUTO_SYNC_TO_STUDIO);
    this.syncTargets = normalizeSyncTargets(options.syncTargets);
    this.privilegedActionConfirmation = coerceBoolean(options.privilegedActionConfirmation, DEFAULT_PRIVILEGED_ACTION_CONFIRMATION);
    this.bridgeToken = normalizeToken(options.bridgeToken || process.env.AMARILLO_BRIDGE_TOKEN || null);
    this.extensionVersion = normalizeVersion(options.extensionVersion);
    this.extensionProtocolVersion = normalizeProtocolVersion(options.extensionProtocolVersion);
    this.initialStudioContactGraceMs = Number(options.initialStudioContactGraceMs) > 0
      ? Number(options.initialStudioContactGraceMs)
      : INITIAL_STUDIO_CONTACT_GRACE_MS;
    this.studioSessionStaleMs = Number(options.studioSessionStaleMs) > 0
      ? Number(options.studioSessionStaleMs)
      : STUDIO_SESSION_STALE_MS;
    this.httpServer = null;
    this.allProjects = [];
    this.projects = [];
    this.projectCatalogIssues = [];
    this.config = {
      argon: {},
      plugin: {}
    };
    this.defaultProjectId = null;
    this.sessions = new Map<string, RuntimeSession>();
    this.connectionOffer = null;
    this.pendingPlaceSetup = null;
    this.fileWatchers = [];
    this.pendingStudioWrites = new Map<string, PendingStudioWrite>();
    this.lastWorkspaceRefresh = null;
    this.lastDiskWriteTime = null;
    this.lastProjectIssueKeys = new Set();
    this.errorTracker = new ErrorTracker({
      workspaceRoot: this.workspaceRoot,
      persistOnAdd: true
    });
    this.activityLog = new ActivityLog({
      workspaceRoot: this.workspaceRoot
    });
    this.mcpAuditLog = new McpAuditLog({
      workspaceRoot: this.workspaceRoot
    });
    this.activityFileState = new Map<string, ActivityFileInfo>();
    this.activityFileStateTextBytes = 0;
    this.activityKnownFiles = new Set<string>();
    this.mcpShield = createMcpShieldState();
    this.recentUnauthorizedHttpRequests = new Map<string, number>();
    this.rateLimiter = new RateLimiter({ maxRequests: 120, windowMs: 1000 });
    this.privilegedRateLimiter = new RateLimiter({
      maxRequests: PRIVILEGED_ACTION_RATE_LIMIT,
      windowMs: PRIVILEGED_ACTION_RATE_WINDOW_MS
    });
    this.shutdownPromise = null;
    this.shuttingDown = false;
    this.perfTracker = new PerfTracker();
    this.doctorService = new DoctorService(this);
    this.sessionRegistry = new SessionRegistry(this);
    this.studioSnapshotWriter = new StudioSnapshotWriter({
      app: this,
      logSync,
      initialStudioSyncReason: INITIAL_STUDIO_SYNC_REASON
    });
    this.pendingStudioWrites = this.studioSnapshotWriter.pendingWrites;
    this.syncCoordinator = new SyncCoordinator(this);
    this.workspaceWatcher = new WorkspaceWatcher({
      app: this,
      logSync,
      eventDebounceMs: WORKSPACE_WATCHER_EVENT_DEBOUNCE_MS
    });
  }

  createSessionToken() {
    return crypto.randomBytes(24).toString("hex");
  }

  isBridgeRequestAuthorized(request) {
    if (!this.bridgeToken) {
      return true;
    }
    return timingSafeEqualString(bridgeTokenFromHeaders(request.headers), this.bridgeToken);
  }

  isSessionRequestAuthorized(request, session = null) {
    if (!this.bridgeToken) {
      return true;
    }
    if (this.isBridgeRequestAuthorized(request)) {
      return true;
    }
    const token = normalizeToken(request.headers?.[SESSION_TOKEN_HEADER]);
    if (!token) {
      return false;
    }
    if (session) {
      return timingSafeEqualString(token, session.sessionToken);
    }
    return Array.from(this.sessions.values()).some((candidate) => timingSafeEqualString(token, candidate.sessionToken));
  }

  isPublicHttpRoute(request, requestUrl) {
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return true;
    }
    if (request.method === "GET" && requestUrl.pathname === MCP_AUTH_HELP_PATH) {
      return true;
    }
    if (request.method === "GET" && requestUrl.pathname === "/projects") {
      return true;
    }
    if (request.method === "GET" && requestUrl.pathname === "/studio/poll" && !requestUrl.searchParams.get("sessionId")) {
      return true;
    }
    if (isLoopbackHost(this.host) && request.method === "POST" && (
      requestUrl.pathname === "/connection/accept"
      || requestUrl.pathname === "/connection/decline"
      || requestUrl.pathname === "/connection/diff"
    )) {
      return true;
    }
    return false;
  }

  authorizeHttpRequest(request, requestUrl) {
    if (this.isPublicHttpRoute(request, requestUrl)) {
      return true;
    }
    if (!this.bridgeToken) {
      return isLoopbackHost(this.host);
    }
    if (requestUrl.pathname.startsWith("/studio/")) {
      return true;
    }
    const sessionActionMatch = requestUrl.pathname.match(/^\/session\/([^/]+)\//);
    if (sessionActionMatch) {
      const session = this.sessions.get(decodeURIComponent(sessionActionMatch[1]));
      return this.isBridgeRequestAuthorized(request) || this.isSessionRequestAuthorized(request, session);
    }
    if (requestUrl.pathname === "/session/close") {
      return this.isBridgeRequestAuthorized(request) || this.isSessionRequestAuthorized(request);
    }
    if (requestUrl.pathname === "/errors/add") {
      return this.isBridgeRequestAuthorized(request) || this.isSessionRequestAuthorized(request);
    }
    return this.isBridgeRequestAuthorized(request);
  }

  recordUnauthorizedHttpRequest(request, requestUrl) {
    const now = Date.now();
    const route = requestUrl.pathname;
    const method = request.method || "UNKNOWN";
    const hasBridgeTokenHeader = Boolean(normalizeToken(request.headers?.[BRIDGE_TOKEN_HEADER]));
    const hasAuthorizationHeader = Boolean(normalizeToken(request.headers?.[AUTHORIZATION_HEADER]));
    const hasSessionTokenHeader = Boolean(normalizeToken(request.headers?.[SESSION_TOKEN_HEADER]));
    const key = [
      method,
      route,
      hasBridgeTokenHeader ? "bridge" : "no-bridge",
      hasAuthorizationHeader ? "authorization" : "no-authorization",
      hasSessionTokenHeader ? "session" : "no-session"
    ].join("|");
    const previous = this.recentUnauthorizedHttpRequests.get(key) || 0;
    if (now - previous < 30000) {
      return;
    }
    this.recentUnauthorizedHttpRequests.set(key, now);
    this.recordError({
      component: "daemon",
      severity: "warning",
      code: "HTTP-UNAUTHORIZED",
      message: `Unauthorized HTTP request to ${method} ${route}. Missing or invalid Amarillo authorization token.`,
      context: {
        method,
        route,
        expectedHeader: BRIDGE_TOKEN_HEADER_DISPLAY,
        acceptedAuthorization: "Authorization: Bearer <bridge token>",
        sessionHeader: SESSION_TOKEN_HEADER_DISPLAY,
        hasBridgeTokenHeader,
        hasAuthorizationHeader,
        hasSessionTokenHeader,
        userAgent: request.headers?.["user-agent"] || null,
        help: authHelpPayload()
      }
    });
  }

  async start() {
    this.refreshWorkspace();
    if (!this.port) {
      this.port = Number(this.config.plugin.daemonPort || this.config.argon.port || 8323);
    }
    if (!this.host) {
      this.host = String(this.config.argon.host || "127.0.0.1");
    }
    if (!isLoopbackHost(this.host) && !this.bridgeToken) {
      throw new Error("A bridge token is required when the daemon listens outside loopback.");
    }
    this.startWatchers();
    this.httpServer = http.createServer((request, response) => {
      this.handleHttp(request, response).catch((error) => {
        this.recordError({
          component: "daemon",
          severity: "error",
          code: "HTTP-500",
          message: error.message,
          context: { method: request.method, url: request.url },
          stack: error.stack
        });
        jsonResponse(response, 500, {
          ok: false,
          code: "INTERNAL_ERROR",
          error: "Internal server error."
        }, request);
      });
    });
    // CLI users can scan like Argon; VS Code uses a strict port so Studio and MCP stay aligned.
    const maxPortScanAttempts = this.strictPort ? 1 : 10;
    let actualPort = this.port;
    let listening = false;

    for (let attempt = 0; attempt < maxPortScanAttempts; attempt++) {
      try {
        this.httpServer.listen(actualPort, this.host);
        await once(this.httpServer, "listening");
        listening = true;
        break;
      } catch (error) {
        if (error.code === "EADDRINUSE" && attempt < maxPortScanAttempts - 1) {
          actualPort++;
          // Recreate server since listen failure leaves it in broken state
          this.httpServer = http.createServer((request, response) => {
            this.handleHttp(request, response).catch((httpError) => {
              this.recordError({
                component: "daemon",
                severity: "error",
                code: "HTTP-500",
                message: httpError.message,
                context: { method: request.method, url: request.url },
                stack: httpError.stack
              });
              jsonResponse(response, 500, {
                ok: false,
                code: "INTERNAL_ERROR",
                error: "Internal server error."
              }, request);
            });
          });
          continue;
        }
        throw error;
      }
    }

    if (listening && actualPort !== this.port) {
      process.stderr.write(`Port ${this.port} in use, using port ${actualPort}\n`);
      this.port = actualPort;
    }
  }

  async stop() {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.performStop();
    }
    return this.shutdownPromise;
  }

  async performStop() {
    this.shuttingDown = true;

    // Stop accepting file-system events
    for (const watcher of this.fileWatchers) {
      try {
        watcher.close();
      } catch (error) {
        this.recordError({
          component: "daemon",
          severity: "warning",
          code: "WATCHER-CLOSE",
          message: error.message,
          stack: error.stack
        });
      }
    }
    this.fileWatchers = [];

    await this.drainPendingStudioWrites(5000);

    // Drain in-flight commands and resolve pending responses
    for (const session of this.sessions.values()) {
      for (const deferred of session.pendingResponses.values()) {
        clearTimeout(deferred.timeout);
        deferred.reject(new Error("Daemon is shutting down."));
      }
      session.pendingResponses.clear();
      this.clearSessionRuntimeState(session);
    }

    // Dispose rate limiter
    if (this.rateLimiter) {
      this.rateLimiter.dispose();
    }
    if (this.privilegedRateLimiter) {
      this.privilegedRateLimiter.dispose();
    }

    if (this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(() => {
          const closableServer = server as HttpServer & {
            closeAllConnections?: () => void;
            closeIdleConnections?: () => void;
          };
          closableServer.closeAllConnections?.();
          closableServer.closeIdleConnections?.();
          finish();
        }, HTTP_SHUTDOWN_TIMEOUT_MS);
        if (typeof timeout.unref === "function") {
          timeout.unref();
        }
        try {
          server.close(finish);
        } catch (_error) {
          finish();
        }
      });
      this.httpServer = null;
    }
  }

  recordPerformance(name, durationMs) {
    return this.perfTracker.record(name, durationMs);
  }

  performanceSummary() {
    return this.perfTracker.summary();
  }

  performanceReport() {
    return this.perfTracker.report();
  }

  normalizeAndHashSnapshotWithPerf(snapshot) {
    const startedAt = performance.now();
    try {
      return normalizeAndHashSnapshot(snapshot);
    } finally {
      this.recordPerformance("snapshot.hash.duration", performance.now() - startedAt);
    }
  }

  rawSnapshotHash(snapshot) {
    return crypto.createHash("sha1").update(stringifySorted(snapshot || {})).digest("hex");
  }

  syncTargetsForSession(session = null) {
    return normalizeSyncTargets(session?.syncTargets || this.syncTargets);
  }

  projectForSync(project, syncTargets = this.syncTargets) {
    return filterProjectBySyncTargets(project, normalizeSyncTargets(syncTargets));
  }

  snapshotForSync(snapshot, syncTargets = this.syncTargets) {
    return filterSnapshotBySyncTargets(snapshot, normalizeSyncTargets(syncTargets));
  }

  isInstancePathSyncEnabled(session, instanceSegments) {
    return isMountSyncEnabled(instanceSegments, this.syncTargetsForSession(session));
  }

  readLocalProjectStateWithPerf(project, options: any = {}) {
    const startedAt = performance.now();
    try {
      const syncTargets = normalizeSyncTargets(options.syncTargets || this.syncTargets);
      const syncProject = this.projectForSync(project, syncTargets);
      this.ensureProjectMountDirectories(syncProject, syncTargets);
      return readLocalProjectState(syncProject, options);
    } finally {
      this.recordPerformance("project.read.duration", performance.now() - startedAt);
    }
  }

  async readLocalProjectStateAsyncWithPerf(project, options: any = {}) {
    const startedAt = performance.now();
    try {
      const syncTargets = normalizeSyncTargets(options.syncTargets || this.syncTargets);
      const syncProject = this.projectForSync(project, syncTargets);
      this.ensureProjectMountDirectories(syncProject, syncTargets);
      return await readLocalProjectStateAsync(syncProject, options);
    } finally {
      this.recordPerformance("project.read.duration", performance.now() - startedAt);
    }
  }

  ensureProjectMountDirectories(project = null, syncTargets = this.syncTargets) {
    const projects = project ? [project] : this.allProjects;
    const targets = normalizeSyncTargets(syncTargets);
    for (const candidate of projects || []) {
      for (const mount of candidate?.mounts || []) {
        if (mount?.absolutePath && isMountSyncEnabled(mount, targets)) {
          try {
            fs.mkdirSync(mount.absolutePath, { recursive: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.recordError({
              component: "daemon",
              severity: "error",
              code: "MOUNT-DIRECTORY-CREATE",
              message: `Failed to prepare sync mount '${mount.id || "unknown"}'.`,
              projectId: candidate?.id || null,
              context: {
                mountId: mount.id || null,
                mountPath: mount.absolutePath,
                error: message
              },
              stack: error instanceof Error ? error.stack : null
            });
            const wrapped = new Error(`Failed to prepare sync mount '${mount.id || "unknown"}'.`) as Error & { code?: string; cause?: unknown };
            wrapped.code = "MOUNT_DIRECTORY_CREATE_FAILED";
            wrapped.cause = error;
            throw wrapped;
          }
        }
      }
    }
  }

  recordError(entry: ErrorInput = {}) {
    return this.errorTracker.add({
      component: entry.component || "daemon",
      severity: entry.severity || "error",
      code: entry.code || null,
      eventId: entry.eventId || null,
      message: entry.message || "Unknown error",
      file: entry.file || null,
      line: entry.line || null,
      sessionId: entry.sessionId || null,
      projectId: entry.projectId || null,
      context: entry.context || null,
      suggestion: entry.suggestion || null,
      stack: entry.stack || null
    });
  }

  recordMcpContact(source = "unknown", details: Record<string, unknown> = {}) {
    if (!this.mcpShield) {
      this.mcpShield = createMcpShieldState();
    }
    const now = new Date().toISOString();
    this.mcpShield.state = "ready";
    this.mcpShield.lastFailure = null;
    const toolName = typeof details.toolName === "string" ? details.toolName : null;
    if (toolName) {
      this.mcpShield.lastTool = toolName;
      this.mcpShield.callCount += 1;
    }
    if (source === "native_stdio") {
      this.mcpShield.lastNativeCallAt = now;
    } else if (source === "proxy_http") {
      this.mcpShield.lastProxyContactAt = now;
    } else if (source === "http_fallback") {
      this.mcpShield.lastHttpFallbackCallAt = now;
    } else if (source === "http_probe") {
      this.mcpShield.lastProbeAt = now;
    }
  }

  recordMcpFailure(source = "unknown", error: unknown, details: Record<string, unknown> = {}) {
    if (!this.mcpShield) {
      this.mcpShield = createMcpShieldState();
    }
    const message = error instanceof Error ? error.message : String(error || "Unknown MCP error.");
    const now = new Date().toISOString();
    const toolName = typeof details.toolName === "string" ? details.toolName : null;
    const route = typeof details.route === "string" ? details.route : null;
    const code = typeof details.code === "string" ? details.code : "MCP-SHIELD";
    this.mcpShield.state = "degraded";
    this.mcpShield.failureCount += 1;
    this.mcpShield.lastFailure = {
      at: now,
      source,
      toolName,
      route,
      message
    };
    this.recordError({
      component: "mcp",
      severity: "warning",
      code,
      message,
      context: {
        source,
        toolName,
        route
      }
    });
  }

  versionPayload() {
    const extensionProtocolMatches = this.extensionProtocolVersion === null
      || this.extensionProtocolVersion === AMARILLO_PROTOCOL_VERSION;
    return {
      daemon: {
        version: DAEMON_VERSION,
        protocolVersion: AMARILLO_PROTOCOL_VERSION,
        minimumPluginVersion: MIN_PLUGIN_VERSION,
        currentPluginVersion: CURRENT_PLUGIN_VERSION
      },
      extension: {
        version: this.extensionVersion,
        protocolVersion: this.extensionProtocolVersion,
        state: extensionProtocolMatches ? (this.extensionProtocolVersion === null ? "unknown" : "compatible") : "blocked",
        message: extensionProtocolMatches
          ? (this.extensionProtocolVersion === null ? "Extension protocol was not provided by the launcher." : "Extension protocol is compatible.")
          : `Extension protocol ${this.extensionProtocolVersion} is incompatible with daemon protocol ${AMARILLO_PROTOCOL_VERSION}.`
      }
    };
  }

  updateSessionPluginVersion(session: RuntimeSession | null, metadata: SessionOpenOptions = {}) {
    if (!session || !metadata || typeof metadata !== "object") {
      return;
    }
    const pluginVersion = normalizeVersion(metadata.pluginVersion);
    const pluginProtocolVersion = normalizeProtocolVersion(metadata.pluginProtocolVersion);
    if (pluginVersion) {
      session.pluginVersion = pluginVersion;
    }
    if (pluginProtocolVersion !== null) {
      session.pluginProtocolVersion = pluginProtocolVersion;
    }
    if (pluginVersion || pluginProtocolVersion !== null) {
      session.lastPluginVersionSeenAt = new Date().toISOString();
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "privilegedActionConfirmationEnabled")) {
      session.privilegedActionConfirmationEnabled = coerceBoolean(
        (metadata as Record<string, unknown>).privilegedActionConfirmationEnabled,
        session.privilegedActionConfirmationEnabled ?? null
      );
      this.queuePrivilegedActionConfirmationPreference(session, "plugin_report");
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "detectModels")) {
      session.detectModels = coerceBoolean(
        (metadata as Record<string, unknown>).detectModels,
        session.detectModels ?? false
      );
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "syncTargets")) {
      session.syncTargets = normalizeSyncTargets((metadata as Record<string, unknown>).syncTargets);
    }
  }

  sessionVersionStatus(session) {
    const requiresPlugin = session?.requirePluginVersion === true;
    const pluginVersion = normalizeVersion(session?.pluginVersion);
    const pluginProtocolVersion = normalizeProtocolVersion(session?.pluginProtocolVersion);
    if (!requiresPlugin) {
      return {
        state: "compatible",
        message: pluginVersion
          ? "Plugin protocol is compatible."
          : "Plugin version is not required for this internal session.",
        requiresPluginUpdate: false,
        pluginUpdateAvailable: false
      };
    }
    if (!pluginVersion || pluginProtocolVersion === null) {
      return {
        state: "blocked",
        message: "Plugin update required: this Studio plugin did not report its Amarillo version/protocol.",
        requiresPluginUpdate: true,
        pluginUpdateAvailable: true
      };
    }
    if (pluginProtocolVersion !== AMARILLO_PROTOCOL_VERSION) {
      return {
        state: "blocked",
        message: `Plugin update required: plugin protocol ${pluginProtocolVersion} is incompatible with daemon protocol ${AMARILLO_PROTOCOL_VERSION}.`,
        requiresPluginUpdate: true,
        pluginUpdateAvailable: true
      };
    }
    if (!isVersionAtLeast(pluginVersion, MIN_PLUGIN_VERSION)) {
      return {
        state: "blocked",
        message: `Plugin update required: plugin version ${pluginVersion} is older than ${MIN_PLUGIN_VERSION}. Reinstall the Amarillo plugin and reload Roblox Studio.`,
        requiresPluginUpdate: true,
        pluginUpdateAvailable: true
      };
    }
    if (!isVersionAtLeast(pluginVersion, CURRENT_PLUGIN_VERSION)) {
      return {
        state: "outdated",
        message: `Plugin update available: Roblox Studio is running Amarillo plugin ${pluginVersion}; current plugin is ${CURRENT_PLUGIN_VERSION}. Amarillo installs the local plugin file automatically, but Studio must be reloaded or reopened to run it.`,
        requiresPluginUpdate: false,
        pluginUpdateAvailable: true
      };
    }
    return {
      state: "compatible",
      message: "Plugin protocol is compatible.",
      requiresPluginUpdate: false,
      pluginUpdateAvailable: false
    };
  }

  isSessionVersionBlocked(session) {
    return this.sessionVersionStatus(session).state === "blocked";
  }

  hasPendingPrivilegedActionConfirmationCommand(session, enabled) {
    if (!session) {
      return false;
    }
    const matches = (command) => command
      && command.type === "set_privileged_action_confirmation"
      && command.payload
      && command.payload.enabled === enabled;
    return session.pendingCommands.some(matches)
      || Array.from(session.inFlightCommands.values()).some(matches);
  }

  queuePrivilegedActionConfirmationPreference(session, reason = "settings") {
    if (!session || session.requirePluginVersion !== true || !session.studioInstanceId || session.privilegedActionConfirmationEnabled === this.privilegedActionConfirmation) {
      return false;
    }
    const version = this.sessionVersionStatus(session);
    if (version.state === "blocked" || version.pluginUpdateAvailable === true) {
      return false;
    }
    if (this.hasPendingPrivilegedActionConfirmationCommand(session, this.privilegedActionConfirmation)) {
      return false;
    }
    this.enqueueCommand(session.id, "set_privileged_action_confirmation", {
      enabled: this.privilegedActionConfirmation,
      reason
    });
    return true;
  }

  queuePrivilegedActionConfirmationPreferenceForSessions(reason = "settings") {
    const queuedSessionIds = [];
    for (const session of this.sessions.values()) {
      if (this.queuePrivilegedActionConfirmationPreference(session, reason)) {
        queuedSessionIds.push(session.id);
      }
    }
    return queuedSessionIds;
  }

  studioContactStatus(session) {
    const lastContactAt = this.studioSessionLastContactAt(session) || session?.createdAt || null;
    if (!lastContactAt) {
      return {
        state: "unknown",
        ageMs: null,
        lastContactAt: null,
        message: "Studio plugin contact time is not available yet."
      };
    }
    const lastContactMs = parseTimestampMs(lastContactAt);
    if (lastContactMs === null) {
      return {
        state: "unknown",
        ageMs: null,
        lastContactAt,
        message: "Studio plugin contact time is invalid."
      };
    }
    const ageMs = Math.max(0, Date.now() - lastContactMs);
    const ageLabel = formatElapsedMs(ageMs);
    if (ageMs > STUDIO_CONTACT_CRITICAL_MS) {
      return {
        state: "critical",
        ageMs,
        lastContactAt,
        message: `Studio plugin has not contacted the daemon for ${ageLabel}.`
      };
    }
    if (ageMs > STUDIO_CONTACT_STALE_WARNING_MS) {
      return {
        state: "stale",
        ageMs,
        lastContactAt,
        message: `Studio plugin last contacted the daemon ${ageLabel} ago.`
      };
    }
    return {
      state: "fresh",
      ageMs,
      lastContactAt,
      message: `Studio plugin last contacted the daemon ${ageLabel} ago.`
    };
  }

  protectedStudioActionPolicy(session, action = "protected action", kind = "privileged") {
    const actionNoun = kind === "destructive" ? "destructive action" : "privileged action";
    const changeNoun = kind === "destructive" ? "destructive changes" : "privileged actions";
    const allowedMessage = kind === "destructive"
      ? "Destructive actions are allowed."
      : "Privileged actions are allowed.";
    if (!session) {
      return {
        allowed: false,
        blocked: true,
        reasonCode: "SESSION_NOT_FOUND",
        message: `${action} blocked: Studio session not found.`
      };
    }
    if ((session.connectionState || "ready") !== "ready") {
      return {
        allowed: false,
        blocked: true,
        reasonCode: "SESSION_NOT_READY",
        message: `${action} blocked: the Studio session is not ready yet.`
      };
    }
    const version = this.sessionVersionStatus(session);
    if (version.state === "blocked") {
      return {
        allowed: false,
        blocked: true,
        reasonCode: "PLUGIN_UPDATE_REQUIRED",
        message: `${action} blocked: ${version.message}`
      };
    }
    const sync = this.ensureSessionSyncState(session);
    if (sync.state === "degraded") {
      return {
        allowed: false,
        blocked: true,
        reasonCode: "SYNC_DEGRADED",
        message: `${action} blocked: ${sync.degradedReason || sync.lastFailure?.message || "Sync verification failed."}`
      };
    }
    if (session.destructiveConfirmationPending === true) {
      const actionType = session.destructiveConfirmationType || actionNoun;
      return {
        allowed: false,
        blocked: true,
        reasonCode: "DESTRUCTIVE_CONFIRMATION_PENDING",
        message: `${action} blocked: Roblox Studio is already waiting for confirmation for ${actionType}. Approve or decline it in Studio before sending another ${actionNoun}.`
      };
    }
    const contact = this.studioContactStatus(session);
    if (contact.state === "critical") {
      return {
        allowed: false,
        blocked: true,
        reasonCode: "STUDIO_CONTACT_CRITICAL",
        message: `${action} blocked: ${contact.message} Wait for Roblox Studio to reconnect before applying ${changeNoun}.`
      };
    }
    if (contact.state === "stale") {
      return {
        allowed: false,
        blocked: true,
        reasonCode: "STUDIO_CONTACT_STALE",
        message: `${action} blocked: ${contact.message} Wait for a fresh Studio poll before applying ${changeNoun}.`
      };
    }
    return {
      allowed: true,
      blocked: false,
      reasonCode: null,
      message: allowedMessage
    };
  }

  destructiveActionPolicy(session, action = "destructive action") {
    return this.protectedStudioActionPolicy(session, action, "destructive");
  }

  privilegedActionPolicy(session, action = "privileged action") {
    return this.protectedStudioActionPolicy(session, action, "privileged");
  }

  syncBlockedReason(session) {
    const version = this.sessionVersionStatus(session);
    if (version.state === "blocked") {
      return version.message;
    }
    const sync = this.ensureSessionSyncState(session);
    if (sync.state === "degraded") {
      return sync.degradedReason || sync.lastFailure?.message || "Sync verification failed.";
    }
    return null;
  }

  assertSessionSyncAllowed(session, action = "sync") {
    const reason = this.syncBlockedReason(session);
    if (reason) {
      const error = new Error(`${action} blocked: ${reason}`) as Error & { statusCode?: number; code?: string };
      error.statusCode = 409;
      error.code = "SYNC-BLOCKED";
      throw error;
    }
  }

  recordMcpAudit(entry: Record<string, unknown> = {}) {
    return this.mcpAuditLog.add(entry);
  }

  refreshWorkspace() {
    const previousDefaultProjectId = this.defaultProjectId;
    const config = readWorkspaceConfig(this.workspaceRoot);
    this.config = config;
    if (!this.autoSyncToStudioExplicit) {
      this.autoSyncToStudio = coerceBoolean(this.config.plugin.autoSyncToStudio, DEFAULT_AUTO_SYNC_TO_STUDIO);
    }
    const projectCatalog = loadWorkspaceProjectCatalog(this.workspaceRoot);
    this.allProjects = projectCatalog.allProjects;
    this.projects = projectCatalog.selectableProjects;
    this.projectCatalogIssues = [
      ...(config.issues || []),
      ...(projectCatalog.issues || [])
    ];
    this.ensureProjectMountDirectories();
    this.defaultProjectId = this.resolveDefaultProjectId(previousDefaultProjectId);
    if (this.pendingPlaceSetup && this.hasProjectForPlace(this.pendingPlaceSetup.placeId)) {
      this.pendingPlaceSetup = null;
    }
    this.reportProjectCatalogIssues();
    this.refreshActivityKnownFiles();
    this.ensureInstructionsFile();
    this.lastWorkspaceRefresh = new Date().toISOString();
  }

  resolveDefaultProjectId(previousDefaultProjectId = null) {
    const configuredDefaultProjectId = this.config.plugin.defaultProject || null;
    for (const candidateId of [configuredDefaultProjectId, previousDefaultProjectId]) {
      if (!candidateId) {
        continue;
      }
      if (this.projects.some((project) => project.id === candidateId)) {
        return candidateId;
      }
    }
    return null;
  }

  reportProjectCatalogIssues() {
    const nextIssueKeys = new Set<string>();
    for (const issue of this.projectCatalogIssues) {
      nextIssueKeys.add(issue.key);
      if (this.lastProjectIssueKeys.has(issue.key)) {
        continue;
      }
      process.stderr.write(`[amarillo] ${issue.message}\n`);
      this.recordError({
        component: "daemon",
        severity: "error",
        code: issue.code || "PROJECT-CATALOG",
        message: issue.message,
        context: {
          projectId: issue.projectId || null,
          projectPath: issue.projectPath || null,
          filePath: issue.filePath || null,
          error: issue.error || null
        }
      });
    }
    this.lastProjectIssueKeys = nextIssueKeys;
  }

  ensureInstructionsFile() {
    try {
      ensurePluginInstructionsFile({
        workspaceRoot: this.workspaceRoot,
        projects: this.projects
      });
    } catch (error) {
      this.recordError({
        component: "daemon",
        severity: "warning",
        code: "INSTRUCTIONS",
        message: error.message,
        stack: error.stack
      });
    }
  }

  refreshActivityKnownFiles() {
    this.activityKnownFiles.clear();
    this.activityFileState.clear();
    this.activityFileStateTextBytes = 0;
    for (const project of this.allProjects) {
      for (const mount of project.mounts || []) {
        for (const filePath of collectFilesRecursive(mount.absolutePath)) {
          const normalized = normalizeFsPath(filePath);
          this.activityKnownFiles.add(normalized);
          const info = getFileInfo(normalized, { includeText: true });
          if (info?.hash) {
            this.setActivityFileState(normalized, info);
          }
        }
      }
    }
  }

  setActivityFileState(filePath, info) {
    this.removeActivityFileState(filePath);
    if (!info || !info.hash) {
      return;
    }
    const nextInfo = { ...info };
    if (typeof nextInfo.text === "string") {
      const textBytes = Buffer.byteLength(nextInfo.text, "utf8");
      if (textBytes > ACTIVITY_STATE_MAX_TEXT_BYTES) {
        delete nextInfo.text;
        nextInfo.textTruncated = true;
      } else {
        this.activityFileStateTextBytes += textBytes;
      }
    }
    this.activityFileState.set(filePath, nextInfo);

    if (this.activityFileStateTextBytes <= ACTIVITY_STATE_MAX_TEXT_BYTES) {
      return;
    }
    for (const [candidatePath, candidateInfo] of this.activityFileState) {
      if (this.activityFileStateTextBytes <= ACTIVITY_STATE_MAX_TEXT_BYTES) {
        break;
      }
      if (typeof candidateInfo.text !== "string") {
        continue;
      }
      this.activityFileStateTextBytes -= Buffer.byteLength(candidateInfo.text, "utf8");
      delete candidateInfo.text;
      candidateInfo.textTruncated = true;
    }
  }

  removeActivityFileState(filePath) {
    const previous = this.activityFileState.get(filePath);
    if (previous && typeof previous.text === "string") {
      this.activityFileStateTextBytes = Math.max(
        0,
        this.activityFileStateTextBytes - Buffer.byteLength(previous.text, "utf8")
      );
    }
    this.activityFileState.delete(filePath);
  }


  findMountedFileContext(filePath) {
    const normalized = normalizeFsPath(filePath);

    for (const session of this.sessions.values()) {
      if (session.connectionState !== "ready") {
        continue;
      }
      const project = this.getProjectById(session.projectId);
      if (!project) {
        continue;
      }
      const mount = (project.mounts || []).find((candidate) => isPathInside(normalized, candidate.absolutePath));
      if (mount) {
        return {
          projectId: project.id,
          mountId: mount.id,
          sessionId: session.id
        };
      }
    }

    for (const project of this.projects.length > 0 ? this.projects : this.allProjects) {
      const mount = (project.mounts || []).find((candidate) => isPathInside(normalized, candidate.absolutePath));
      if (mount) {
        return {
          projectId: project.id,
          mountId: mount.id,
          sessionId: null
        };
      }
    }

    return null;
  }

  recordActivity(change: ActivityChangeInput = {}, defaults: ActivityDefaults = {}) {
    const filePath = change.filePath || change.path;
    if (!filePath) {
      return null;
    }
    const normalized = normalizeFsPath(filePath);
    const context = this.findMountedFileContext(normalized);
    const projectId = change.projectId || defaults.projectId || (context && context.projectId);
    const mountId = change.mountId || defaults.mountId || (context && context.mountId);
    if (!projectId || !mountId) {
      return null;
    }
    const previousInfo = this.activityFileState.get(normalized) || null;
    const nextInfo = getFileInfo(normalized, { includeText: true });
    const action = change.action || "modify";
    const oldInfo = change.oldInfo || (action === "create" ? null : previousInfo);
    const newInfo = change.newInfo || (action === "delete" ? null : nextInfo);

    const record = this.activityLog.add({
      action,
      path: normalized,
      projectId,
      mountId,
      direction: defaults.direction,
      source: defaults.source,
      reason: defaults.reason,
      sessionId: defaults.sessionId || (context && context.sessionId),
      size: change.size ?? newInfo?.size ?? oldInfo?.size ?? null,
      hash: change.hash ?? newInfo?.hash ?? oldInfo?.hash ?? null,
      oldSize: oldInfo?.size ?? null,
      oldHash: oldInfo?.hash ?? null,
      oldText: typeof oldInfo?.text === "string" ? oldInfo.text : undefined,
      newSize: newInfo?.size ?? null,
      newHash: newInfo?.hash ?? null,
      newText: typeof newInfo?.text === "string" ? newInfo.text : undefined
    });

    if (record.action === "delete") {
      this.removeActivityFileState(normalized);
      this.activityKnownFiles.delete(normalized);
    } else {
      this.activityKnownFiles.add(normalized);
      const nextStateInfo = nextInfo || getFileInfo(normalized, { includeText: true }) || {
        size: record.size,
        hash: record.hash
      };
      if (nextStateInfo && nextStateInfo.hash) {
        this.setActivityFileState(normalized, nextStateInfo);
      }
    }
    return record;
  }

  recordWorkspaceFileActivity(filePath, defaults: ActivityDefaults = {}) {
    const normalized = normalizeFsPath(filePath);
    const context = this.findMountedFileContext(normalized);
    if (!context) {
      return null;
    }

    const previousInfo = this.activityFileState.get(normalized) || null;
    const wasKnown = this.activityKnownFiles.has(normalized);
    const nextInfo = getFileInfo(normalized, { includeText: true });
    let action = null;
    let info = nextInfo || previousInfo || {};

    if (!previousInfo && nextInfo) {
      action = wasKnown ? "modify" : "create";
    } else if (previousInfo && !nextInfo) {
      action = "delete";
    } else if (previousInfo && nextInfo && (previousInfo.hash !== nextInfo.hash || previousInfo.size !== nextInfo.size)) {
      action = "modify";
    }

    if (!action) {
      return null;
    }

    return this.recordActivity({
      action,
      filePath: normalized,
      projectId: context.projectId,
      mountId: context.mountId,
      size: info.size,
      hash: info.hash,
      oldInfo: previousInfo,
      newInfo: nextInfo
    }, {
      ...defaults,
      sessionId: defaults.sessionId || context.sessionId
    });
  }

  revertActivityEntry(entryId) {
    const entry: any = typeof this.activityLog.get === "function"
      ? this.activityLog.get(entryId, { includeDetails: true })
      : null;
    if (!entry) {
      const error = new Error("Activity entry not found.") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const detail = entry.detail || {};
    if (!entry.path || !isPathInside(entry.path, this.workspaceRoot)) {
      const error = new Error("Activity entry path is outside the workspace.") as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
    const currentInfo = getFileInfo(entry.path, { includeText: true });
    const expectedHash = detail.newHash || entry.newHash || null;
    if (entry.action === "delete" && currentInfo) {
      const error = new Error("The deleted file already exists again. Refresh before reverting.") as Error & { statusCode?: number; code?: string };
      error.statusCode = 409;
      error.code = "ACTIVITY_REVERT_CONFLICT";
      throw error;
    }
    if (expectedHash && currentInfo?.hash !== expectedHash) {
      const error = new Error("The file changed after this history entry. Refresh before reverting.") as Error & { statusCode?: number; code?: string };
      error.statusCode = 409;
      error.code = "ACTIVITY_REVERT_CONFLICT";
      throw error;
    }

    if (entry.action === "create") {
      if (!currentInfo) {
        const error = new Error("Created file no longer exists.") as Error & { statusCode?: number };
        error.statusCode = 409;
        throw error;
      }
      fs.rmSync(entry.path, { force: true });
    } else if (entry.action === "delete") {
      if (typeof detail.oldText !== "string") {
        const error = new Error("This delete entry does not have a text snapshot to restore.") as Error & { statusCode?: number };
        error.statusCode = 409;
        throw error;
      }
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      fs.writeFileSync(entry.path, detail.oldText, "utf8");
    } else if (entry.action === "modify") {
      if (typeof detail.oldText !== "string") {
        const error = new Error("This modify entry does not have a text snapshot to restore.") as Error & { statusCode?: number };
        error.statusCode = 409;
        throw error;
      }
      fs.writeFileSync(entry.path, detail.oldText, "utf8");
    } else {
      const error = new Error(`Activity action '${entry.action}' cannot be reverted.`) as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }

    const revertedInfo = getFileInfo(entry.path, { includeText: true });
    const revertRecord = this.recordActivity({
      action: entry.action === "create" ? "delete" : (entry.action === "delete" ? "create" : "modify"),
      filePath: entry.path,
      projectId: entry.projectId,
      mountId: entry.mountId,
      oldInfo: currentInfo,
      newInfo: revertedInfo,
      size: revertedInfo?.size ?? currentInfo?.size ?? null,
      hash: revertedInfo?.hash ?? currentInfo?.hash ?? null
    }, {
      direction: entry.direction,
      source: "activity_revert",
      reason: "activity_revert",
      sessionId: entry.sessionId
    });
    return {
      ok: true,
      reverted: entry,
      entry: revertRecord
    };
  }

  studioSessionLastContactAt(session) {
    return session.lastStudioContactAt || session.lastStudioSeenAt || null;
  }

  canReclaimStudioSession(session) {
    const lastContactAt = this.studioSessionLastContactAt(session);
    if (lastContactAt) {
      const lastContactMs = parseTimestampMs(lastContactAt);
      if (lastContactMs === null) {
        return false;
      }
      return (Date.now() - lastContactMs) >= this.studioSessionStaleMs;
    }

    const createdAtMs = parseTimestampMs(session.createdAt);
    if (createdAtMs === null) {
      return false;
    }
    return (Date.now() - createdAtMs) >= this.initialStudioContactGraceMs;
  }

  markStudioSessionContact(session) {
    if (!session) {
      return;
    }
    session.lastStudioContactAt = new Date().toISOString();
  }

  updateDestructiveConfirmationState(session, payload: any = {}) {
    if (!session || !payload) {
      return;
    }
    const rawPending = payload.destructiveConfirmationPending;
    const pending = typeof rawPending === "boolean"
      ? rawPending
      : coerceQueryBoolean(String(rawPending ?? ""));
    if (!pending) {
      session.destructiveConfirmationPending = false;
      session.destructiveConfirmationType = null;
      session.destructiveConfirmationSinceAt = null;
      return;
    }
    session.destructiveConfirmationPending = true;
    session.destructiveConfirmationType = typeof payload.destructiveConfirmationType === "string"
      ? payload.destructiveConfirmationType
      : null;
    session.destructiveConfirmationSinceAt = typeof payload.destructiveConfirmationSinceAt === "string"
      ? payload.destructiveConfirmationSinceAt
      : null;
  }

  clearWorkspacePatchBatch(session) {
    if (!session) {
      return;
    }
    if (session.filePatchBatchTimer) {
      clearTimeout(session.filePatchBatchTimer);
      session.filePatchBatchTimer = null;
    }
    session.filePatchBatch.clear();
  }

  clearSessionRuntimeState(session) {
    if (!session) {
      return;
    }
    if (session.fileChangeTimer) {
      clearTimeout(session.fileChangeTimer);
      session.fileChangeTimer = null;
    }
    for (const timer of session.filePatchTimers.values()) {
      clearTimeout(timer);
    }
    session.filePatchTimers.clear();
    this.clearWorkspacePatchBatch(session);
    for (const command of session.pendingCommands) {
      this.clearCommandSyncGuard(command);
    }
    for (const command of session.inFlightCommands.values()) {
      this.clearCommandSyncGuard(command);
    }
    for (const deferred of session.pendingResponses.values()) {
      clearTimeout(deferred.timeout);
    }
    session.pendingResponses.clear();
    session.inFlightCommands.clear();
    session.pendingCommands = [];
    const pollWaiter = session._pollWaiter;
    session._pollWaiter = null;
    if (pollWaiter) {
      pollWaiter();
    }
  }

  reclaimStudioSession(session: RuntimeSession, selection: ProjectSelection, placeId, options: SessionOpenOptions = {}) {
    this.clearSessionRuntimeState(session);
    session.placeId = Number(placeId || 0);
    session.placeName = normalizePlaceName(options.placeName);
    session.createdAt = new Date().toISOString();
    session.lastStudioHash = null;
    session.lastStudioRawHash = null;
    session.lastStudioSnapshot = null;
    session.lastStudioSeenAt = null;
    session.lastStudioContactAt = null;
    session.lastAppliedAt = null;
    session.connectionState = options.connectionState || "ready";
    session.truthSource = options.truthSource || null;
    session.studioInstanceId = options.studioInstanceId || null;
    session.requirePluginVersion = options.requirePluginVersion === true;
    session.pluginVersion = normalizeVersion(options.pluginVersion);
    session.pluginProtocolVersion = normalizeProtocolVersion(options.pluginProtocolVersion);
    session.syncTargets = normalizeSyncTargets(options.syncTargets);
    session.privilegedActionConfirmationEnabled = coerceBoolean(
      options.privilegedActionConfirmationEnabled,
      null
    );
    session.detectModels = coerceBoolean(options.detectModels, false);
    session.lastPluginVersionSeenAt = session.pluginVersion || session.pluginProtocolVersion !== null
      ? new Date().toISOString()
      : null;
    session.lastCommandError = null;
    session.destructiveConfirmationPending = false;
    session.destructiveConfirmationType = null;
    session.destructiveConfirmationSinceAt = null;
    session.sync = createSyncState();
    session.projectSelectionReason = selection.reason;
    session.projectSelectionMessage = selection.message;
  }

  startWatchers() {
    return this.workspaceWatcher.start();
  }

  handleProjectDefinitionChanged(changedProjectId) {
    if (!this.autoSyncToStudio) {
      logSync("workspace_project_changed_auto_sync_disabled", { changedProjectId });
      return;
    }

    for (const session of this.sessions.values()) {
      if (session.connectionState !== "ready") {
        continue;
      }
      const project = this.getProjectById(session.projectId);
      if (!project) {
        continue;
      }
      const inheritsChangedProject = project.id === changedProjectId
        || (project.inheritanceIds || []).includes(changedProjectId);
      if (!inheritsChangedProject) {
        continue;
      }
      this.scheduleProjectTreeApply(
        session,
        project,
        "workspace_project_changed",
        path.join(this.workspaceRoot, changedProjectId),
        50
      );
    }
  }

  projectReadOptions(session) {
    return {
      syncTargets: this.syncTargetsForSession(session),
      repairOrphanScriptMetas: true,
      onFileChange: (change) => {
        this.recordActivity(change, {
          direction: "pc_to_studio",
          source: "workspace_watcher",
          reason: "workspace_meta_repaired",
          sessionId: session?.id || null
        });
      }
    };
  }

  scheduleProjectTreeApply(session, project, reason, changedPath = null, debounceMs = PROJECT_TREE_DEBOUNCE_MS, allowWhenDegraded = false) {
    logSync("enqueue_apply_project_tree_scheduled", {
      sessionId: session.id,
      path: changedPath,
      debounceMs
    });
    this.clearWorkspacePatchBatch(session);
    if (session.fileChangeTimer) {
      clearTimeout(session.fileChangeTimer);
    }
    session.fileChangeTimer = setTimeout(async () => {
      session.fileChangeTimer = null;
      if (!this.sessions.has(session.id)) {
        return;
      }
      if (!allowWhenDegraded && this.isSessionSyncBlocked(session)) {
        logSync("enqueue_apply_project_tree_skipped", {
          sessionId: session.id,
          reason: "sync_degraded",
          degradedReason: session.sync?.degradedReason || null
        });
        return;
      }
      logSync("enqueue_apply_project_tree_executing", {
        sessionId: session.id,
        reason
      });
      if (this.blockInvalidProjectTree(session, project)) {
        logSync("enqueue_apply_project_tree_blocked", {
          sessionId: session.id,
          reason: "project_tree_invalid"
        });
        return;
      }
      // OPT-006: Use async file reading to avoid blocking the event loop
      try {
        const projectState = await this.readLocalProjectStateAsyncWithPerf(project, this.projectReadOptions(session));
        this.enqueueCommand(session.id, "apply_project_tree", {
          project: projectState,
          reason
        });
      } catch (error) {
        logSync("async_read_fallback_sync", {
          sessionId: session.id,
          error: error.message
        });
        this.enqueueCommand(session.id, "apply_project_tree", {
          project: this.readLocalProjectStateWithPerf(project, this.projectReadOptions(session)),
          reason
        });
      }
    }, debounceMs);
  }

  scheduleScriptFilePatch(session, project, filePath, instanceSegments) {
    if (!isMountSyncEnabled(instanceSegments, this.syncTargetsForSession(session))) {
      logSync("enqueue_apply_file_patch_skipped", {
        sessionId: session.id,
        reason: "sync_target_disabled",
        path: instanceSegments.join(".")
      });
      return;
    }
    const duplicateMountIssue = findDuplicateMountRootPathIssue(
      this.projectForSync(project, this.syncTargetsForSession(session)),
      instanceSegments
    );
    if (duplicateMountIssue) {
      this.projectTreeInvalidError(session, [duplicateMountIssue], { commandType: "apply_file_patch" });
      logSync("enqueue_apply_file_patch_blocked", {
        sessionId: session.id,
        reason: "duplicate_mount_root",
        path: instanceSegments.join(".")
      });
      return;
    }
    const patchKey = instanceSegments.join(".");
    session.filePatchBatch.set(patchKey, {
      project,
      filePath,
      instanceSegments
    });
    if (session.filePatchBatchTimer) {
      clearTimeout(session.filePatchBatchTimer);
    }

    session.filePatchBatchTimer = setTimeout(() => {
      session.filePatchBatchTimer = null;
      const batch: Array<{ project: RuntimeProject; filePath: string; instanceSegments: string[] }> = Array.from(session.filePatchBatch.values());
      session.filePatchBatch.clear();
      if (!this.sessions.has(session.id)) {
        return;
      }
      if (this.isSessionSyncBlocked(session)) {
        logSync("enqueue_apply_file_patch_skipped", {
          sessionId: session.id,
          reason: "sync_degraded",
          path: patchKey,
          degradedReason: session.sync?.degradedReason || null
        });
        return;
      }

      if (batch.length >= SCRIPT_PATCH_BURST_LIMIT) {
        logSync("apply_file_patch_burst_fallback_tree", {
          sessionId: session.id,
          patchCount: batch.length,
          threshold: SCRIPT_PATCH_BURST_LIMIT
        });
        const first = batch[0];
        this.scheduleProjectTreeApply(session, first.project, "workspace_patch_burst", first.filePath, 0);
        return;
      }

      for (const item of batch) {
        const itemKey = item.instanceSegments.join(".");
        try {
          const source = fs.readFileSync(item.filePath, "utf8");
          logSync("enqueue_apply_file_patch", {
            sessionId: session.id,
            path: itemKey,
            sourceSize: source.length
          });
          this.enqueueCommand(session.id, "apply_file_patch", {
            path: item.instanceSegments,
            source
          });
        } catch (error) {
          logSync("apply_file_patch_fallback_tree", {
            sessionId: session.id,
            path: itemKey,
            error: error.message
          });
          this.scheduleProjectTreeApply(session, item.project, "workspace_changed", item.filePath);
          return;
        }
      }
    }, SCRIPT_PATCH_DEBOUNCE_MS);
  }

  snapshotHasScriptInstance(session, instanceSegments) {
    if (!isMountSyncEnabled(instanceSegments, this.syncTargetsForSession(session))) {
      return false;
    }
    const snapshot = session.lastStudioSnapshot;
    if (!snapshot) {
      return null;
    }
    return isScriptSnapshotNode(findSnapshotNode(snapshot, instanceSegments));
  }

  resolveWorkspaceEventPath(filePath) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      return null;
    }
    const resolved = path.resolve(this.workspaceRoot, filePath);
    if (!isPathInside(resolved, this.workspaceRoot)) {
      return null;
    }
    return resolved;
  }

  duplicateMountRootIssueForWorkspacePath(session, project, mount, filePath) {
    const relative = path.relative(mount.absolutePath, filePath).replace(/\\/g, "/");
    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0) {
      return null;
    }
    return findDuplicateMountRootPathIssue(
      this.projectForSync(project, this.syncTargetsForSession(session)),
      mount.segments.concat(parts)
    );
  }

  handleWorkspaceFileEvents(events = []) {
    const acceptedPaths = [];
    const ignoredPaths = [];
    const pendingPaths = [];

    const addPath = (filePath, eventType) => {
      const resolved = this.resolveWorkspaceEventPath(filePath);
      if (!resolved) {
        if (filePath) {
          ignoredPaths.push(filePath);
        }
        return;
      }
      pendingPaths.push({ path: resolved, eventType });
    };

    for (const event of Array.isArray(events) ? events : []) {
      if (!event || typeof event !== "object") {
        continue;
      }
      const eventType = typeof event.type === "string" && event.type
        ? event.type
        : "vscode_file_operation";
      if (event.oldPath || event.oldUri) {
        addPath(event.oldPath || event.oldUri, `${eventType}:old`);
      }
      if (event.newPath || event.newUri) {
        addPath(event.newPath || event.newUri, `${eventType}:new`);
      }
      if (event.path || event.uri) {
        addPath(event.path || event.uri, eventType);
      }
    }

    const seen = new Set();
    for (const item of pendingPaths) {
      const key = `${item.eventType}:${normalizeFsPath(item.path)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      acceptedPaths.push(item.path);
      this.onWorkspaceFileChanged(item.path, item.eventType);
    }

    return {
      accepted: acceptedPaths.length,
      ignored: ignoredPaths.length
    };
  }

  onWorkspaceFileChanged(changedPath, eventType = "change") {
    const pendingStudioWriteCount = this.pendingStudioWrites?.size || 0;
    if (pendingStudioWriteCount > 0) {
      logSync("file_change_ignored", {
        reason: "studio_snapshot_write_pending",
        pendingStudioWriteCount,
        now: Date.now()
      });
      return;
    }
    if (this.lastDiskWriteTime && Date.now() - this.lastDiskWriteTime < STUDIO_DISK_WRITE_EVENT_SUPPRESSION_MS) {
      logSync("file_change_ignored", {
        reason: "recent_studio_snapshot_write",
        lastDiskWriteTime: this.lastDiskWriteTime,
        suppressionMs: STUDIO_DISK_WRITE_EVENT_SUPPRESSION_MS,
        now: Date.now()
      });
      return;
    }
    const normalizedChangedPath = normalizeFsPath(changedPath);
    logSync("disk_file_changed", { path: normalizedChangedPath, eventType });
    this.recordWorkspaceFileActivity(normalizedChangedPath, {
      direction: "pc_to_studio",
      source: "workspace_watcher",
      reason: "workspace_changed",
      eventType
    });
    if (!this.autoSyncToStudio) {
      logSync("disk_file_change_auto_sync_disabled", { path: normalizedChangedPath });
      return;
    }
    const isLuau = normalizedChangedPath.endsWith(".luau") || normalizedChangedPath.endsWith(".lua");
    
    for (const session of this.sessions.values()) {
      if (session.connectionState !== "ready") {
        continue;
      }
      if (this.isSessionSyncBlocked(session)) {
        logSync("disk_file_change_auto_sync_paused", {
          sessionId: session.id,
          path: normalizedChangedPath,
          degradedReason: session.sync?.degradedReason || null
        });
        continue;
      }
      const project = this.getProjectById(session.projectId);
      if (!project) {
        continue;
      }
      
      const mount = project.mounts.find((m) => isPathInside(normalizedChangedPath, m.absolutePath));
      if (!mount) {
        continue;
      }
      if (!isMountSyncEnabled(mount, this.syncTargetsForSession(session))) {
        logSync("disk_file_change_sync_target_disabled", {
          sessionId: session.id,
          path: normalizedChangedPath,
          mountId: mount.id
        });
        continue;
      }
      const duplicateMountIssue = this.duplicateMountRootIssueForWorkspacePath(session, project, mount, normalizedChangedPath);
      if (duplicateMountIssue) {
        this.projectTreeInvalidError(session, [duplicateMountIssue], { commandType: "workspace_watcher" });
        logSync("disk_file_change_blocked", {
          sessionId: session.id,
          reason: "duplicate_mount_root",
          path: normalizedChangedPath,
          mountId: mount.id
        });
        continue;
      }

      if (isLuau && fs.existsSync(normalizedChangedPath)) {
        const metaMove = moveOrphanScriptMetaForFile(mount, normalizedChangedPath, {
          project,
          mount,
          onFileChange: (change) => {
            this.recordActivity(change, {
              direction: "pc_to_studio",
              source: "workspace_watcher",
              reason: "workspace_meta_repaired",
              sessionId: session.id
            });
          }
        });
        if (metaMove.moved) {
          logSync("orphan_script_meta_moved", {
            sessionId: session.id,
            from: normalizeFsPath(metaMove.from),
            to: normalizeFsPath(metaMove.to)
          });
        }
      }

      if (!fs.existsSync(normalizedChangedPath)) {
        this.scheduleProjectTreeApply(session, project, "workspace_changed", normalizedChangedPath);
        continue;
      }

      if (isLuau) {
        const normalizedMountPath = normalizeFsPath(mount.absolutePath).replace(/\/+$/, "");
        const relative = normalizedChangedPath.slice(normalizedMountPath.length).replace(/^\//, "");
        if (relative) {
          const parts = relative.split("/");
          const lastPart = parts[parts.length - 1];
          const nameMatch = lastPart.match(/^(.*?)(?:\.server|\.client)?\.(?:luau|lua)$/i);
          
          if (nameMatch) {
            let baseName = nameMatch[1];
            if (baseName === "init") {
              parts.pop();
            } else {
              parts[parts.length - 1] = baseName;
            }
            const instanceSegments = mount.segments.concat(parts);
            if (this.snapshotHasScriptInstance(session, instanceSegments) !== true) {
              this.scheduleProjectTreeApply(session, project, "workspace_changed", normalizedChangedPath);
              continue;
            }
            this.scheduleScriptFilePatch(session, project, normalizedChangedPath, instanceSegments);
            continue;
          }
        }
      }

      this.scheduleProjectTreeApply(session, project, "workspace_changed", normalizedChangedPath);
    }
  }

  getProjectById(projectId) {
    return this.allProjects.find((project) => project.id === projectId) || null;
  }

  listProjects() {
    return this.projects.map((project) => ({
      id: project.id,
      name: project.name,
      projectPath: path.relative(this.workspaceRoot, project.projectPath).replace(/\\/g, "/"),
      enabled: project.enabled,
      abstract: project.abstract === true,
      extendsProjectId: project.extendsProjectId || null,
      extendsProjectPath: project.extendsProjectPath || null,
      placeIds: project.placeIds,
      mountCount: project.mounts.length,
      placeSync: buildProjectPlaceSyncPayload(project),
      mounts: project.mounts.map((mount) => ({
        id: mount.id,
        path: mount.segments.join("."),
        relativePath: mount.relativePath
      }))
    }));
  }

  projectPayload(project) {
    if (!project) {
      return null;
    }
    return {
      id: project.id,
      name: project.name,
      projectPath: path.relative(this.workspaceRoot, project.projectPath).replace(/\\/g, "/"),
      abstract: project.abstract === true,
      extendsProjectId: project.extendsProjectId || null,
      extendsProjectPath: project.extendsProjectPath || null,
      placeIds: project.placeIds,
      placeSync: buildProjectPlaceSyncPayload(project),
      mounts: project.mounts.map((mount) => ({
        id: mount.id,
        path: mount.segments.join("."),
        relativePath: mount.relativePath,
        keepUnknowns: mount.keepUnknowns
      }))
    };
  }

  hasProjectForPlace(placeId) {
    const numericPlaceId = Number(placeId || 0);
    return numericPlaceId > 0 && this.projects.some((project) => (project.placeIds || []).includes(numericPlaceId));
  }

  requiresPlaceSetup(placeId, projectId = null) {
    return !projectId && Number(placeId || 0) > 0 && !this.hasProjectForPlace(placeId);
  }

  buildPendingPlaceSetup(placeId, placeName = null) {
    const numericPlaceId = Number(placeId || 0);
    if (numericPlaceId <= 0) {
      return null;
    }
    const normalizedPlaceName = normalizePlaceName(placeName) || `Place ${numericPlaceId}`;
    const placeSlug = placeSlugFromName(normalizedPlaceName, `Place${numericPlaceId}`);
    return {
      placeId: numericPlaceId,
      placeName: normalizedPlaceName,
      suggestedName: normalizedPlaceName,
      suggestedSlug: placeSlug,
      suggestedProjectId: `${placeSlug}.project.json`,
      suggestedExclusiveFolder: `${placeSlug}/exclusive`,
      action: "create_place_project",
      message: `Place ${numericPlaceId} is not mapped to any Amarillo project yet. Create a place project before syncing.`
    };
  }

  rememberPendingPlaceSetup(placeId, placeName = null) {
    const pending = this.buildPendingPlaceSetup(placeId, placeName);
    this.pendingPlaceSetup = pending;
    return pending;
  }

  clearPendingPlaceSetupForPlace(placeId) {
    if (this.pendingPlaceSetup && Number(this.pendingPlaceSetup.placeId || 0) === Number(placeId || 0)) {
      this.pendingPlaceSetup = null;
    }
  }

  sourceProjectForPlaceSetup() {
    const configured = this.defaultProjectId ? this.getProjectById(this.defaultProjectId) : null;
    if (configured && (configured.placeIds || []).length === 0) {
      return configured;
    }
    return this.projects.find((project) => (project.placeIds || []).length === 0) || configured || null;
  }

  readRawProjectTree(project) {
    const raw = this.readRawProject(project);
    return raw && typeof raw === "object" && raw.tree && typeof raw.tree === "object"
      ? cloneJson(raw.tree)
      : null;
  }

  readRawProject(project) {
    if (!project?.projectPath || !fs.existsSync(project.projectPath)) {
      return null;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(project.projectPath, "utf8"));
      return raw && typeof raw === "object" ? raw : null;
    } catch (_error) {
      return null;
    }
  }

  uniquePlaceProjectSlug(baseSlug) {
    const cleanBase = placeSlugFromName(baseSlug, "Place");
    let candidate = cleanBase;
    let suffix = 2;
    while (fs.existsSync(path.join(this.workspaceRoot, `${candidate}.project.json`))) {
      candidate = `${cleanBase}${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  createPlaceProject(options: Record<string, unknown> = {}) {
    const placeId = Number(options.placeId || this.pendingPlaceSetup?.placeId || 0);
    const placeIds = normalizePlaceIds(placeId);
    if (placeIds.length === 0) {
      const error = new Error("A published placeId is required to create a place project.") as Error & { statusCode?: number; code?: string };
      error.statusCode = 400;
      error.code = "PLACE_ID_REQUIRED";
      throw error;
    }
    if (this.hasProjectForPlace(placeIds[0])) {
      const error = new Error(`Place ${placeIds[0]} is already mapped to a project.`) as Error & { statusCode?: number; code?: string };
      error.statusCode = 409;
      error.code = "PLACE_ALREADY_MAPPED";
      throw error;
    }

    const placeName = normalizePlaceName(options.placeName) || normalizePlaceName(this.pendingPlaceSetup?.placeName) || `Place ${placeIds[0]}`;
    const placeSlug = this.uniquePlaceProjectSlug(placeSlugFromName(placeName, `Place${placeIds[0]}`));
    const sourceProject = this.sourceProjectForPlaceSetup();
    const sharedRoot = resolvePlaceProjectRoot(this.workspaceRoot, sourceProject, "sync");
    const baseTree = this.readRawProjectTree(sourceProject) || buildDefaultPlaceProjectTree(sharedRoot);
    const projectFile = path.join(this.workspaceRoot, `${placeSlug}.project.json`);
    let tree = configurePlaceSyncTree(baseTree, placeSlug, { ...options, defaultSharedRoot: sharedRoot });
    if (objectHasOwn(options, "keepUnknowns")) {
      tree = setKeepUnknowns(tree, options.keepUnknowns === true);
    }
    const projectJson = {
      name: placeName,
      place_ids: placeIds,
      tree
    };

    fs.writeFileSync(projectFile, `${JSON.stringify(projectJson, null, 2)}\n`, "utf8");
    this.refreshWorkspace();
    const projectId = path.relative(this.workspaceRoot, projectFile).replace(/\\/g, "/");
    const project = this.getProjectById(projectId);
    this.ensureProjectMountDirectories(project);
    this.clearPendingPlaceSetupForPlace(placeIds[0]);
    return {
      ok: true,
      project: this.projectPayload(project),
      projectId,
      projectPath: projectId,
      placeId: placeIds[0],
      placeName,
      sourceProjectId: sourceProject?.id || null
    };
  }

  updateProjectPlaceSync(projectId, options: Record<string, unknown> = {}) {
    const project = this.getProjectById(projectId);
    if (!project) {
      const error = new Error(`Project '${projectId}' not found.`) as Error & { statusCode?: number; code?: string };
      error.statusCode = 404;
      error.code = "PROJECT_NOT_FOUND";
      throw error;
    }

    const raw = this.readRawProject(project);
    if (!raw || typeof raw.tree !== "object") {
      const error = new Error(`Project '${projectId}' could not be read.`) as Error & { statusCode?: number; code?: string };
      error.statusCode = 500;
      error.code = "PROJECT_READ_FAILED";
      throw error;
    }

    const projectName = normalizePlaceName(raw.name) || normalizePlaceName(project.name) || path.basename(project.id, ".project.json");
    const placeSlug = placeSlugFromName(projectName, "Place");
    const sharedRoot = inferProjectRootFromTree(raw.tree) || resolveWorkspaceProjectRoot(this.workspaceRoot, { fallback: "sync" });
    raw.tree = configurePlaceSyncTree(raw.tree, placeSlug, { ...options, defaultSharedRoot: sharedRoot });
    if (objectHasOwn(options, "keepUnknowns")) {
      raw.tree = setKeepUnknowns(raw.tree, options.keepUnknowns === true);
    }

    fs.writeFileSync(project.projectPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    this.refreshWorkspace();
    const refreshedProject = this.getProjectById(projectId);
    this.ensureProjectMountDirectories(refreshedProject);
    return {
      ok: true,
      project: this.projectPayload(refreshedProject),
      projectId,
      projectPath: path.relative(this.workspaceRoot, project.projectPath).replace(/\\/g, "/")
    };
  }

  updateProjectPlaceIds(projectId, placeIdsInput) {
    const project = this.getProjectById(projectId);
    if (!project) {
      const error = new Error(`Project '${projectId}' not found.`) as Error & { statusCode?: number; code?: string };
      error.statusCode = 404;
      error.code = "PROJECT_NOT_FOUND";
      throw error;
    }
    const placeIds = normalizePlaceIds(placeIdsInput);
    const duplicate = this.projects.find((candidate) => candidate.id !== projectId && (candidate.placeIds || []).some((id) => placeIds.includes(id)));
    if (duplicate) {
      const error = new Error(`One or more place IDs are already mapped by '${duplicate.id}'.`) as Error & { statusCode?: number; code?: string };
      error.statusCode = 409;
      error.code = "PLACE_ALREADY_MAPPED";
      throw error;
    }

    const raw = JSON.parse(fs.readFileSync(project.projectPath, "utf8"));
    raw.place_ids = placeIds;
    delete raw.placeIds;
    delete raw.placeId;
    fs.writeFileSync(project.projectPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    this.refreshWorkspace();
    for (const id of placeIds) {
      this.clearPendingPlaceSetupForPlace(id);
    }
    return {
      ok: true,
      project: this.projectPayload(this.getProjectById(projectId)),
      placeIds
    };
  }

  connectionOfferSummary() {
    if (!this.connectionOffer) {
      return null;
    }
    const project = this.connectionOffer.projectId ? this.getProjectById(this.connectionOffer.projectId) : null;
    return {
      offerId: this.connectionOffer.offerId,
      status: this.connectionOffer.status,
      requestedBy: this.connectionOffer.requestedBy,
      createdAt: this.connectionOffer.createdAt,
      updatedAt: this.connectionOffer.updatedAt,
      resolvedAt: this.connectionOffer.resolvedAt || null,
      declinedAt: this.connectionOffer.declinedAt || null,
      acceptedAt: this.connectionOffer.acceptedAt || null,
      acceptedStudioInstanceId: this.connectionOffer.acceptedStudioInstanceId || null,
      declinedStudioInstanceId: this.connectionOffer.declinedStudioInstanceId || null,
      sessionId: this.connectionOffer.sessionId || null,
      projectId: this.connectionOffer.projectId || null,
      projectName: project ? project.name : this.connectionOffer.projectName || null,
      truthSource: this.connectionOffer.truthSource || null
    };
  }

  beginConnectionOffer(requestedBy = "vscode") {
    const now = new Date().toISOString();
    this.connectionOffer = {
      offerId: crypto.randomUUID(),
      status: "pending",
      requestedBy,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      declinedAt: null,
      acceptedAt: null,
      acceptedStudioInstanceId: null,
      declinedStudioInstanceId: null,
      sessionId: null,
      projectId: null,
      projectName: null,
      truthSource: null
    };
    return this.connectionOfferSummary();
  }

  resolveConnectionOffer(status: ConnectionOfferStatus, details: ConnectionOfferResolutionDetails = {}) {
    if (!this.connectionOffer) {
      return null;
    }
    const now = new Date().toISOString();
    this.connectionOffer.status = status;
    this.connectionOffer.updatedAt = now;
    if (status === "declined") {
      this.connectionOffer.declinedAt = now;
      this.connectionOffer.resolvedAt = now;
      this.connectionOffer.declinedStudioInstanceId = details.studioInstanceId || null;
    }
    if (status === "accepted") {
      this.connectionOffer.acceptedAt = now;
      this.connectionOffer.acceptedStudioInstanceId = details.studioInstanceId || null;
      this.connectionOffer.sessionId = details.sessionId || null;
      this.connectionOffer.projectId = details.projectId || null;
      this.connectionOffer.projectName = details.projectName || null;
      this.connectionOffer.truthSource = details.truthSource || null;
    }
    if (status === "ready") {
      this.connectionOffer.resolvedAt = now;
    }
    return this.connectionOfferSummary();
  }

  resolveProject(placeId, preferredProjectId = null) {
    return this.resolveProjectSelection(placeId, preferredProjectId).project;
  }

  resolveProjectSelection(placeId, preferredProjectId = null) {
    if (preferredProjectId) {
      const preferredProject = this.getProjectById(preferredProjectId);
      if (!preferredProject || preferredProject.abstract === true || preferredProject.enabled === false) {
        throw new Error(`Project '${preferredProjectId}' not found.`);
      }
      return {
        project: preferredProject,
        reason: "preferred_project",
        message: `Project '${preferredProject.name}' was manually selected for this session.`
      };
    }
    return resolveProjectSelectionForPlace(this.projects, placeId, this.defaultProjectId);
  }

  openSession(placeId, preferredProjectId = null, options: SessionOpenOptions = {}) {
    const selection = this.resolveProjectSelection(placeId, preferredProjectId);
    const project = selection.project;
    if (!project) {
      throw new Error("No compatible Argon project was found in the workspace.");
    }
    const existing = Array.from(this.sessions.values()).find((session) => session.placeId === Number(placeId) && session.projectId === project.id);
    if (existing) {
      if (options.studioInstanceId && existing.studioInstanceId && existing.studioInstanceId !== options.studioInstanceId) {
        if (!this.canReclaimStudioSession(existing)) {
          throw new Error("This project is already connected by another Roblox Studio window.");
        }
        this.reclaimStudioSession(existing, selection, placeId, options);
      }
      if (!options.studioInstanceId || !existing.studioInstanceId || existing.studioInstanceId === options.studioInstanceId) {
        if (options.connectionState && existing.connectionState !== "ready") {
          this.clearSessionRuntimeState(existing);
          existing.createdAt = new Date().toISOString();
          existing.lastCommandError = null;
          existing.destructiveConfirmationPending = false;
          existing.destructiveConfirmationType = null;
          existing.destructiveConfirmationSinceAt = null;
          existing.sync = createSyncState();
        }
        existing.projectSelectionReason = selection.reason;
        existing.projectSelectionMessage = selection.message;
        if (options.connectionState) {
          existing.connectionState = options.connectionState;
        }
        if (options.truthSource) {
          existing.truthSource = options.truthSource;
        }
        if (Object.prototype.hasOwnProperty.call(options, "placeName")) {
          existing.placeName = normalizePlaceName(options.placeName);
        }
        if (options.studioInstanceId) {
          existing.studioInstanceId = options.studioInstanceId;
        }
        if (!existing.sessionToken) {
          existing.sessionToken = this.createSessionToken();
        }
        if (options.requirePluginVersion === true) {
          existing.requirePluginVersion = true;
        }
        this.updateSessionPluginVersion(existing, options);
        if (Object.prototype.hasOwnProperty.call(options, "syncTargets")) {
          existing.syncTargets = normalizeSyncTargets(options.syncTargets);
        }
        this.queuePrivilegedActionConfirmationPreference(existing, "session_open");
      }
      return {
        session: existing,
        project
      };
    }
    const session: RuntimeSession = {
      id: crypto.randomUUID(),
      sessionToken: this.createSessionToken(),
      placeId: Number(placeId || 0),
      placeName: normalizePlaceName(options.placeName),
      projectId: project.id,
      createdAt: new Date().toISOString(),
      lastStudioHash: null,
      lastStudioRawHash: null,
      lastStudioSnapshot: null,
      lastStudioSeenAt: null,
      lastStudioContactAt: null,
      pendingCommands: [],
      pendingResponses: new Map(),
      inFlightCommands: new Map(),
      fileChangeTimer: null,
      filePatchTimers: new Map(),
      filePatchBatchTimer: null,
      filePatchBatch: new Map(),
      lastAppliedAt: null,
      sync: createSyncState(),
      connectionState: options.connectionState || "ready",
      truthSource: options.truthSource || null,
      studioInstanceId: options.studioInstanceId || null,
      requirePluginVersion: options.requirePluginVersion === true,
      pluginVersion: normalizeVersion(options.pluginVersion),
      pluginProtocolVersion: normalizeProtocolVersion(options.pluginProtocolVersion),
      syncTargets: normalizeSyncTargets(options.syncTargets),
      detectModels: coerceBoolean(options.detectModels, false),
      privilegedActionConfirmationEnabled: coerceBoolean(
        options.privilegedActionConfirmationEnabled,
        null
      ),
      lastPluginVersionSeenAt: null,
      lastCommandError: null,
      destructiveConfirmationPending: false,
      destructiveConfirmationType: null,
      destructiveConfirmationSinceAt: null,
      projectSelectionReason: selection.reason,
      projectSelectionMessage: selection.message,
      _pollWaiter: null
    };
    if (session.pluginVersion || session.pluginProtocolVersion !== null) {
      session.lastPluginVersionSeenAt = new Date().toISOString();
    }
    this.sessions.set(session.id, session);
    this.queuePrivilegedActionConfirmationPreference(session, "session_open");
    return {
      session,
      project
    };
  }

  markSessionReady(session, reason = null) {
    if (!session) {
      return;
    }
    session.connectionState = "ready";
    if (this.ensureSessionSyncState(session).state !== "degraded") {
      session.lastCommandError = null;
    }
    if (this.connectionOffer && this.connectionOffer.sessionId === session.id) {
      this.resolveConnectionOffer("ready", {
        studioInstanceId: session.studioInstanceId,
        sessionId: session.id,
        projectId: session.projectId,
        projectName: this.getProjectById(session.projectId)?.name || null,
        truthSource: session.truthSource
      });
    }
    logSync("session_ready", {
      sessionId: session.id,
      reason
    });
  }

  declineConnectionOffer(offerId, studioInstanceId = null) {
    if (!this.connectionOffer || this.connectionOffer.offerId !== offerId) {
      return {
        ok: false,
        error: "Connection offer not found.",
        offer: this.connectionOfferSummary()
      };
    }
    if (this.connectionOffer.status !== "pending") {
      return {
        ok: false,
        error: "Connection offer has already been resolved.",
        offer: this.connectionOfferSummary()
      };
    }
    return {
      ok: true,
      offer: this.resolveConnectionOffer("declined", { studioInstanceId })
    };
  }

  acceptConnection({
    offerId = null,
    studioInstanceId = null,
    placeId = 0,
    placeName = null,
    projectId = null,
    truthSource = "pc",
    pluginVersion = null,
    pluginProtocolVersion = null,
    privilegedActionConfirmationEnabled = null,
    detectModels = null,
    syncTargets = null,
    requirePluginVersion = false
  }) {
    if (offerId) {
      if (!this.connectionOffer || this.connectionOffer.offerId !== offerId) {
        return {
          ok: false,
          error: "Connection offer not found.",
          offer: this.connectionOfferSummary()
        };
      }
      if (this.connectionOffer.status !== "pending") {
        return {
          ok: false,
          error: "Connection offer has already been resolved.",
          offer: this.connectionOfferSummary()
        };
      }
    }

    const normalizedTruthSource = truthSource === "studio" ? "studio" : "pc";
    if (this.requiresPlaceSetup(placeId, projectId)) {
      const pendingPlaceSetup = this.rememberPendingPlaceSetup(placeId, placeName);
      return {
        ok: false,
        code: "PLACE_SETUP_REQUIRED",
        error: pendingPlaceSetup?.message || "Create a place project before syncing this Roblox place.",
        offer: this.connectionOfferSummary(),
        pendingPlaceSetup
      };
    }
    const initialConnectionState = "accepted";
    let sessionResult;
    try {
      sessionResult = this.openSession(placeId, projectId, {
        connectionState: initialConnectionState,
        truthSource: normalizedTruthSource,
        studioInstanceId,
        placeName,
        pluginVersion,
        pluginProtocolVersion,
        privilegedActionConfirmationEnabled,
        detectModels,
        syncTargets,
        requirePluginVersion
      });
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        offer: this.connectionOfferSummary()
      };
    }
    const { session, project } = sessionResult;
    this.clearPendingPlaceSetupForPlace(placeId);

    if (offerId) {
      this.resolveConnectionOffer("accepted", {
        studioInstanceId,
        sessionId: session.id,
        projectId: project.id,
        projectName: project.name,
        truthSource: normalizedTruthSource
      });
    }

    const versionStatus = this.sessionVersionStatus(session);
    if (versionStatus.state === "blocked") {
      session.lastCommandError = versionStatus.message;
      this.recordError({
        component: "plugin",
        severity: "error",
        code: "VERSION-BLOCKED",
        message: versionStatus.message,
        sessionId: session.id,
        projectId: project.id,
        context: {
          pluginVersion: session.pluginVersion || null,
          pluginProtocolVersion: session.pluginProtocolVersion || null,
          daemonProtocolVersion: AMARILLO_PROTOCOL_VERSION
        }
      });
    } else if (normalizedTruthSource === "pc") {
      this.enqueueCommand(session.id, "apply_project_tree", {
        project: this.readLocalProjectStateWithPerf(project, this.projectReadOptions(session)),
        reason: INITIAL_PC_SYNC_REASON
      });
    }

    return {
      ok: true,
      offer: this.connectionOfferSummary(),
      session,
      project
    };
  }

  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    this.clearSessionRuntimeState(session);
    this.sessions.delete(sessionId);
    return true;
  }

  ensureSessionSyncState(session) {
    if (!session.sync) {
      session.sync = createSyncState();
    }
    return session.sync;
  }

  syncMessage(session) {
    const blockedReason = this.syncBlockedReason(session);
    if (blockedReason && this.isSessionVersionBlocked(session)) {
      return `Sync blocked: ${blockedReason}`;
    }
    const sync = this.ensureSessionSyncState(session);
    if (sync.state === "degraded") {
      return sync.degradedReason
        ? `Sync paused: ${sync.degradedReason}`
        : "Sync paused. Run a manual resync before continuing.";
    }
    if (session.pendingCommands.length > 0 || session.inFlightCommands.size > 0) {
      return "Sync command pending confirmation from Studio.";
    }
    return "Sync healthy.";
  }

  isSessionSyncBlocked(session) {
    return Boolean(this.syncBlockedReason(session));
  }

  clearCommandSyncGuard(command) {
    if (command && command.syncGuardTimer) {
      clearTimeout(command.syncGuardTimer);
      command.syncGuardTimer = null;
    }
  }

  removePendingSyncCommand(session, commandId) {
    session.pendingCommands = session.pendingCommands.filter((command) => {
      if (command.id !== commandId) {
        return true;
      }
      this.clearCommandSyncGuard(command);
      return false;
    });
  }

  markSyncDegraded(session, reason, details: SyncDegradedDetails = {}) {
    const sync = this.ensureSessionSyncState(session);
    const message = String(reason || "Sync verification failed.");
    const timestamp = new Date().toISOString();
    const contextExtras = Object.entries(details).reduce((next, [key, value]) => {
      if (!["code", "component", "severity", "suggestion"].includes(key)) {
        next[key] = value;
      }
      return next;
    }, {} as Record<string, unknown>);
    sync.state = "degraded";
    sync.degradedReason = message;
    sync.lastFailure = {
      at: timestamp,
      message,
      commandId: details.commandId || null,
      commandType: details.commandType || null
    };
    if (details.expectedHash !== undefined) {
      sync.lastExpectedHash = details.expectedHash;
    }
    if (details.observedHash !== undefined) {
      sync.lastObservedHash = details.observedHash;
    }
    if (!session.lastCommandError) {
      session.lastCommandError = message;
    }
    this.recordError({
      component: details.component || "daemon",
      severity: details.severity || "error",
      code: details.code || "SYNC-DEGRADED",
      message,
      sessionId: session.id,
      projectId: session.projectId,
      context: {
        commandId: details.commandId || null,
        commandType: details.commandType || null,
        expectedHash: details.expectedHash || null,
        observedHash: details.observedHash || null,
        path: details.path || null,
        ...contextExtras
      },
      suggestion: typeof details.suggestion === "string" ? details.suggestion : null
    });
  }

  projectTreeInvalidError(session, issues, options: any = {}) {
    const normalizedIssues = (issues || []).slice(0, 10).map((issue) => ({
      code: issue.code || "PROJECT_TREE_INVALID",
      mountId: issue.mountId || null,
      path: issue.path || null,
      expectedMountPath: issue.expectedMountPath || null,
      relativePath: issue.relativePath || null,
      fileName: issue.fileName || null,
      suggestedFileName: issue.suggestedFileName || null,
      message: issue.message || null
    }));
    const first = normalizedIssues[0] || {};
    const pathLabel = first.path || first.relativePath || first.fileName || "unknown";
    const isDuplicateMountRoot = first.code === "DUPLICATE_MOUNT_ROOT";
    const suggestion = isDuplicateMountRoot
      ? `Move the contents out of '${pathLabel}' and place them directly under '${first.expectedMountPath || "the active mount"}'. Amarillo will not auto-delete the duplicate folder.`
      : (first.suggestedFileName
        ? `Rename '${first.fileName}' to '${first.suggestedFileName}', or represent that script as a folder with an init script if the dot is part of the intended instance name.`
        : "Rename the ambiguous script file before syncing, or represent it as a folder with an init script if the dot is part of the intended instance name.");
    const message = isDuplicateMountRoot
      ? `Project tree contains a duplicate mount root: ${pathLabel}. Remove the nested mount-name folder before syncing.`
      : `Project tree contains an ambiguous script filename: ${pathLabel}. Rename it before syncing.`;
    this.markSyncDegraded(session, message, {
      code: "PROJECT-TREE-INVALID",
      commandType: options.commandType || "apply_project_tree",
      path: pathLabel,
      issues: normalizedIssues,
      issueCount: (issues || []).length,
      suggestion
    });
    const error = new Error(message) as Error & { statusCode?: number; code?: string; issues?: unknown[] };
    error.statusCode = 409;
    error.code = "PROJECT-TREE-INVALID";
    error.issues = normalizedIssues;
    return error;
  }

  blockInvalidProjectTree(session, project) {
    const issues = validateProjectTreeFiles(this.projectForSync(project, this.syncTargetsForSession(session)));
    if (issues.length === 0) {
      return null;
    }
    return this.projectTreeInvalidError(session, issues);
  }

  blockInvalidProjectSnapshot(session, project, snapshot, commandType = "apply_project_tree") {
    const syncTargets = this.syncTargetsForSession(session);
    const issues = validateProjectSnapshotMounts(
      this.projectForSync(project, syncTargets),
      this.snapshotForSync(snapshot, syncTargets)
    );
    if (issues.length === 0) {
      return null;
    }
    return this.projectTreeInvalidError(session, issues, { commandType });
  }

  scheduleFilePatchVerificationFallback(session, command, commandId, observedHash, instanceSegments) {
    const project = this.getProjectById(session.projectId);
    const pathLabel = instanceSegments.join(".");
    this.recordError({
      component: "daemon",
      severity: "warning",
      code: "SYNC-PATCH-MISMATCH-FALLBACK",
      message: "Fast file patch verification failed; falling back to full project sync.",
      sessionId: session.id,
      projectId: session.projectId,
      context: {
        commandId,
        commandType: command.type,
        observedHash,
        path: pathLabel
      }
    });
    if (!project) {
      return false;
    }
    logSync("apply_file_patch_mismatch_fallback_tree", {
      sessionId: session.id,
      commandId,
      path: pathLabel,
      observedHash
    });
    this.scheduleProjectTreeApply(session, project, "file_patch_mismatch", pathLabel, 50, true);
    return true;
  }

  resolveStaleProjectTreeMismatch(session, command, commandId, observedHash) {
    const project = this.getProjectById(session.projectId);
    if (!project || !command?.expectedHash) {
      return false;
    }

    let currentInfo = null;
    try {
      const currentSnapshot = this.readLocalProjectStateWithPerf(project, this.projectReadOptions(session));
      currentInfo = this.normalizeAndHashSnapshotWithPerf(currentSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordError({
        component: "daemon",
        severity: "warning",
        code: "SYNC-HASH-MISMATCH-STALE-CHECK-FAILED",
        message: "Could not compare the failed project tree command against the current workspace state.",
        sessionId: session.id,
        projectId: session.projectId,
        context: {
          commandId,
          commandType: command.type,
          expectedHash: command.expectedHash || null,
          observedHash: observedHash || null,
          error: message
        }
      });
      return false;
    }

    if (!currentInfo?.hash || currentInfo.hash === command.expectedHash) {
      return false;
    }

    const action = observedHash && observedHash === currentInfo.hash
      ? "verified_current_workspace"
      : "queued_latest_project_tree";
    this.recordError({
      component: "daemon",
      severity: "warning",
      code: "SYNC-HASH-MISMATCH-STALE",
      message: "Studio snapshot hash did not match the completed command, but the local project changed while that command was in flight.",
      sessionId: session.id,
      projectId: session.projectId,
      context: {
        commandId,
        commandType: command.type,
        reason: command.payload?.reason || null,
        expectedHash: command.expectedHash || null,
        observedHash: observedHash || null,
        currentHash: currentInfo.hash,
        action
      }
    });

    if (observedHash && observedHash === currentInfo.hash) {
      this.markSyncVerified(session, observedHash);
      return true;
    }

    logSync("apply_project_tree_stale_retry", {
      sessionId: session.id,
      commandId,
      reason: command.payload?.reason || null,
      expectedHash: command.expectedHash || null,
      observedHash: observedHash || null,
      currentHash: currentInfo.hash
    });
    this.scheduleProjectTreeApply(session, project, "project_tree_changed_during_apply", null, 50, true);
    return true;
  }

  markSyncAck(session, command) {
    const sync = this.ensureSessionSyncState(session);
    sync.lastAckAt = new Date().toISOString();
    if (command?.expectedHash) {
      sync.lastExpectedHash = command.expectedHash;
    }
  }

  markSyncVerified(session, observedHash = null) {
    const sync = this.ensureSessionSyncState(session);
    const timestamp = new Date().toISOString();
    sync.state = "ready";
    sync.lastVerifiedAt = timestamp;
    sync.degradedReason = null;
    sync.lastFailure = null;
    if (observedHash) {
      sync.lastObservedHash = observedHash;
    }
    if ((session.connectionState || "ready") === "ready") {
      session.lastCommandError = null;
    }
  }

  cacheStudioSnapshot(session, snapshot, reason = "command_verified", snapshotInfo = null) {
    const filteredSnapshot = this.snapshotForSync(snapshot, this.syncTargetsForSession(session));
    const effectiveSnapshotInfo = snapshotInfo || this.normalizeAndHashSnapshotWithPerf(filteredSnapshot);
    const snapshotHash = effectiveSnapshotInfo.hash;
    const rawSnapshotHash = this.rawSnapshotHash(filteredSnapshot);
    session.lastStudioSnapshot = filteredSnapshot && typeof filteredSnapshot === "object" ? filteredSnapshot : { mounts: [] };
    session.lastStudioHash = snapshotHash;
    session.lastStudioRawHash = rawSnapshotHash;
    session.lastStudioSeenAt = new Date().toISOString();
    logSync("studio_snapshot_cached", {
      sessionId: session.id,
      reason,
      snapshotHash,
      rawSnapshotHash
    });
    return snapshotHash;
  }

  startSyncCommandGuard(session, command, timeoutMs = SYNC_COMMAND_PICKUP_TIMEOUT_MS, phase = "pickup") {
    if (!isSyncCommandType(command.type)) {
      return;
    }
    this.clearCommandSyncGuard(command);
    command.syncGuardTimer = setTimeout(() => {
      command.syncGuardTimer = null;
      const stillPending = session.pendingCommands.some((pending) => pending.id === command.id);
      const stillInFlight = session.inFlightCommands.has(command.id);
      if (!stillPending && !stillInFlight) {
        return;
      }
      if (phase === "pickup") {
        this.removePendingSyncCommand(session, command.id);
      }
      const waitLabel = phase === "pickup" ? "Studio to pick up" : "Studio confirmation for";
      this.markSyncDegraded(session, `Timed out waiting for ${waitLabel} ${command.type}.`, {
        code: "SYNC-TIMEOUT",
        commandId: command.id,
        commandType: command.type,
        expectedHash: command.expectedHash || null,
        phase
      });
    }, timeoutMs);
    if (typeof command.syncGuardTimer.unref === "function") {
      command.syncGuardTimer.unref();
    }
  }

  enqueueCommand(
    sessionId,
    type,
    payload,
    waitForResult = false,
    timeoutMs = waitForResult
      ? (isSyncCommandType(type) ? SYNC_COMMAND_WAIT_TIMEOUT_MS : COMMAND_RESULT_TIMEOUT_MS)
      : SYNC_COMMAND_PICKUP_TIMEOUT_MS
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    if (isSyncCommandType(type) && this.isSessionVersionBlocked(session)) {
      const error = new Error(`${type} blocked: ${this.syncBlockedReason(session)}`) as Error & { statusCode?: number; code?: string };
      error.statusCode = 409;
      error.code = "VERSION-BLOCKED";
      throw error;
    }
    const syncTargets = this.syncTargetsForSession(session);
    if (type === "apply_project_tree" && payload?.project) {
      payload = {
        ...payload,
        project: this.snapshotForSync(payload.project, syncTargets),
        syncTargets
      };
    }
    if (type === "apply_file_patch" && Array.isArray(payload?.path) && !isMountSyncEnabled(payload.path, syncTargets)) {
      logSync("enqueue_command_skipped", {
        sessionId,
        type,
        reason: "sync_target_disabled",
        path: payload.path.join("."),
        syncTargets
      });
      return Promise.resolve({ ok: true, skipped: true, reason: "sync_target_disabled" });
    }
    if (type === "apply_file_patch" && Array.isArray(payload?.path)) {
      const project = this.getProjectById(session.projectId);
      const duplicateMountIssue = project
        ? findDuplicateMountRootPathIssue(this.projectForSync(project, syncTargets), payload.path)
        : null;
      if (duplicateMountIssue) {
        const error = this.projectTreeInvalidError(session, [duplicateMountIssue], { commandType: "apply_file_patch" });
        return waitForResult
          ? Promise.reject(error)
          : Promise.resolve({
              ok: false,
              blocked: true,
              code: error.code,
              reasonCode: "DUPLICATE_MOUNT_ROOT",
              error: error.message
            });
      }
    }
    if (type === "apply_project_tree") {
      const project = this.getProjectById(session.projectId);
      if (project) {
        const invalidProjectTree = this.blockInvalidProjectTree(session, project);
        if (invalidProjectTree) {
          return waitForResult
            ? Promise.reject(invalidProjectTree)
            : Promise.resolve({ ok: false, blocked: true, code: invalidProjectTree.code, error: invalidProjectTree.message });
        }
        const invalidProjectSnapshot = this.blockInvalidProjectSnapshot(session, project, payload?.project, "apply_project_tree");
        if (invalidProjectSnapshot) {
          return waitForResult
            ? Promise.reject(invalidProjectSnapshot)
            : Promise.resolve({ ok: false, blocked: true, code: invalidProjectSnapshot.code, error: invalidProjectSnapshot.message });
        }
      }
      session.pendingCommands = session.pendingCommands.filter((command) => {
        const keep = command.type !== "apply_project_tree" && command.type !== "apply_file_patch";
        if (!keep) {
          this.clearCommandSyncGuard(command);
        }
        return keep;
      });
    }
    if (type === "apply_file_patch" && Array.isArray(payload?.path)) {
      const patchPath = payload.path.join(".");
      session.pendingCommands = session.pendingCommands.filter((c) => {
        if (c.type !== "apply_file_patch" || !Array.isArray(c.payload?.path)) {
          return true;
        }
        const keep = c.payload.path.join(".") !== patchPath;
        if (!keep) {
          this.clearCommandSyncGuard(c);
        }
        return keep;
      });
    }
    const command: SyncCommand = {
      id: crypto.randomUUID(),
      type,
      payload,
      queuedAt: Date.now()
    };
    if (type === "apply_project_tree" && payload?.project) {
      command.expectedHash = this.normalizeAndHashSnapshotWithPerf(payload.project).hash;
      this.ensureSessionSyncState(session).lastExpectedHash = command.expectedHash;
    }
    logSync("enqueue_command", {
      sessionId,
      commandId: command.id,
      type,
      waitForResult,
      queueLength: session.pendingCommands.length + 1
    });
    let deferred = null;
    if (waitForResult) {
      deferred = createDeferred();
      deferred.timeout = setTimeout(() => {
        if (session.pendingResponses.delete(command.id)) {
          session.pendingCommands = session.pendingCommands.filter(c => c.id !== command.id);
          this.clearCommandSyncGuard(command);
          if (isSyncCommandType(command.type)) {
            this.markSyncDegraded(session, `Timed out waiting for Studio response for ${type}.`, {
              code: "SYNC-TIMEOUT",
              commandId: command.id,
              commandType: command.type,
              expectedHash: command.expectedHash || null
            });
          }
          deferred.reject(new Error(`Timed out waiting for Studio response for ${type}.`));
        }
      }, timeoutMs);
      session.pendingResponses.set(command.id, deferred);
    } else if (isSyncCommandType(type)) {
      this.startSyncCommandGuard(session, command, timeoutMs);
    }
    session.pendingCommands.push(command);
    // Wake up long-poll waiter immediately
    if (session._pollWaiter) {
      session._pollWaiter();
    }
    return deferred ? deferred.promise : Promise.resolve({ ok: true, queued: true });
  }

  dequeueCommands(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    const commands = session.pendingCommands.splice(0, session.pendingCommands.length);
    const nowMs = Date.now();
    for (const command of commands) {
      if (Number.isFinite(command.queuedAt)) {
        this.recordPerformance("command.queue_age", nowMs - command.queuedAt);
      }
      session.inFlightCommands.set(command.id, command);
      if (isSyncCommandType(command.type) && !session.pendingResponses.has(command.id)) {
        this.startSyncCommandGuard(session, command, SYNC_COMMAND_COMPLETION_TIMEOUT_MS, "completion");
      }
    }
    if (commands.length > 0) {
      logSync("dequeue_commands", {
        sessionId,
        commandCount: commands.length,
        commandTypes: commands.map(c => c.type)
      });
    }
    return {
      commands: commands.map((command) => ({
        id: command.id,
        type: command.type,
        payload: command.payload
      })),
      session: {
        id: session.id,
        placeId: session.placeId,
        placeName: session.placeName || null,
        projectId: session.projectId,
        lastStudioSeenAt: session.lastStudioSeenAt,
        lastAppliedAt: session.lastAppliedAt,
        syncState: this.ensureSessionSyncState(session).state,
        syncMessage: this.syncMessage(session),
        requiresManualResync: this.ensureSessionSyncState(session).state === "degraded",
        versionState: this.sessionVersionStatus(session).state,
        versionMessage: this.sessionVersionStatus(session).message,
        requiresPluginUpdate: this.sessionVersionStatus(session).requiresPluginUpdate,
        currentPluginVersion: CURRENT_PLUGIN_VERSION,
        pluginUpdateAvailable: this.sessionVersionStatus(session).pluginUpdateAvailable === true,
        syncBlockedReason: this.syncBlockedReason(session),
        syncTargets: this.syncTargetsForSession(session)
      }
    };
  }

  completeCommand(sessionId, commandId, payload) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    const command = session.inFlightCommands.get(commandId) || null;
    if (command) {
      session.inFlightCommands.delete(commandId);
      this.clearCommandSyncGuard(command);
      if (isSyncCommandType(command.type)) {
        this.markSyncAck(session, command);
      }
      if (command.type === "apply_project_tree" && command.payload?.project) {
        if (payload?.snapshot) {
          const observedSnapshot = this.snapshotForSync(payload.snapshot, this.syncTargetsForSession(session));
          const correctedSnapshotReported = payload?.corrected === true;
          const snapshotReason = correctedSnapshotReported
            ? "apply_project_tree_corrected"
            : "apply_project_tree_verified";
          const snapshotInfo = this.normalizeAndHashSnapshotWithPerf(observedSnapshot);
          const previousHash = session.lastStudioHash;
          const previousRawHash = session.lastStudioRawHash || null;
          const observedHash = snapshotInfo.hash;
          const observedRawHash = this.rawSnapshotHash(observedSnapshot);
          const hashChanged = observedHash !== previousHash;
          const rawHashChanged = observedRawHash !== previousRawHash;
          logSync("studio_snapshot_received", {
            sessionId,
            reason: snapshotReason,
            snapshotSize: snapshotInfo.byteLength,
            hash: observedHash,
            hashChanged,
            previousHash,
            rawHash: observedRawHash,
            rawHashChanged,
            previousRawHash
          });
          this.cacheStudioSnapshot(session, observedSnapshot, snapshotReason, snapshotInfo);
          this.ensureSessionSyncState(session).lastObservedHash = observedHash;
          const scheduleVerifiedWrite = () => {
            if (!hashChanged && !rawHashChanged) {
              logSync("disk_write_skipped", {
                sessionId,
                reason: "snapshot_unchanged",
                snapshotHash: session.lastStudioHash
              });
              return;
            }
            this.scheduleStudioSnapshotWrite(session, snapshotReason, false);
          };
          const hashesMatch = Boolean(command.expectedHash && observedHash === command.expectedHash);
          let mismatchSummary = null;
          let correctedSnapshotAccepted = false;
          if (!hashesMatch && correctedSnapshotReported) {
            mismatchSummary = diffSnapshots(command.payload.project, observedSnapshot, {
              allowCorrectedStudioClasses: true,
              maxChanges: 10
            });
            correctedSnapshotAccepted = mismatchSummary.changeCount === 0;
          }
          if (hashesMatch || correctedSnapshotAccepted) {
            this.markSyncVerified(session, observedHash);
            scheduleVerifiedWrite();
          } else if (this.resolveStaleProjectTreeMismatch(session, command, commandId, observedHash)) {
            // The workspace moved on while Studio was applying this command.
          } else {
            mismatchSummary = mismatchSummary || diffSnapshots(command.payload.project, observedSnapshot, { maxChanges: 10 });
            this.markSyncDegraded(session, "Studio snapshot hash did not match the applied project tree.", {
              code: "SYNC-HASH-MISMATCH",
              commandId,
              commandType: command.type,
              expectedHash: command.expectedHash || null,
              observedHash: observedHash || null,
              mismatchSummary
            });
          }
        } else {
          this.recordAppliedProjectSnapshot(session, command.payload.project, command.payload?.reason);
          this.markSyncDegraded(session, "Studio confirmed apply_project_tree without a verification snapshot.", {
            code: "SYNC-UNVERIFIED",
            commandId,
            commandType: command.type,
            expectedHash: command.expectedHash || null,
            observedHash: session.lastStudioHash || null
          });
        }
      }
      if (command.type === "apply_file_patch") {
        if (payload?.snapshot) {
          const observedSnapshot = this.snapshotForSync(payload.snapshot, this.syncTargetsForSession(session));
          const observedHash = this.cacheStudioSnapshot(session, observedSnapshot, "apply_file_patch_verified");
          const instanceSegments = normalizeStudioInstancePathSegments(command.payload?.path);
          const node = findSnapshotNode(observedSnapshot, instanceSegments);
          if (isScriptSnapshotNode(node) && scriptSourcesMatchForPatchVerification(command.payload?.source, node?.source)) {
            this.markSyncVerified(session, observedHash);
          } else if (this.scheduleFilePatchVerificationFallback(session, command, commandId, observedHash, instanceSegments)) {
            // Keep the session active while the queued full-tree apply verifies the local state.
          } else {
            this.markSyncDegraded(session, "Studio snapshot did not contain the applied file patch source.", {
              code: "SYNC-PATCH-MISMATCH",
              commandId,
              commandType: command.type,
              observedHash,
              path: instanceSegments.join(".")
            });
          }
        } else {
          this.markSyncDegraded(session, "Studio confirmed apply_file_patch without a verification snapshot.", {
            code: "SYNC-UNVERIFIED",
            commandId,
            commandType: command.type
          });
        }
      }
      if (command.type === "apply_project_tree" && command.payload?.reason === INITIAL_PC_SYNC_REASON) {
        this.markSessionReady(session, INITIAL_PC_SYNC_REASON);
      }
    }
    const deferred = session.pendingResponses.get(commandId);
    if (!deferred) {
      return;
    }
    session.pendingResponses.delete(commandId);
    clearTimeout(deferred.timeout);
    deferred.resolve(payload);
  }

  recordAppliedProjectSnapshot(session, projectSnapshot, reason = "apply_project_tree") {
    if (!projectSnapshot) {
      return;
    }
    const filteredSnapshot = this.snapshotForSync(projectSnapshot, this.syncTargetsForSession(session));
    const snapshotInfo = this.normalizeAndHashSnapshotWithPerf(filteredSnapshot);
    session.lastStudioSnapshot = filteredSnapshot;
    session.lastStudioHash = snapshotInfo.hash;
    session.lastStudioRawHash = this.rawSnapshotHash(filteredSnapshot);
    session.lastStudioSeenAt = new Date().toISOString();
    logSync("studio_snapshot_assumed_from_project_apply", {
      sessionId: session.id,
      reason,
      snapshotHash: session.lastStudioHash,
      rawSnapshotHash: session.lastStudioRawHash
    });
  }

  recordPatchedStudioSource(session, instancePath, source) {
    if (!session.lastStudioSnapshot) {
      return false;
    }
    const instanceSegments = normalizeStudioInstancePathSegments(instancePath);
    const node = findSnapshotNode(session.lastStudioSnapshot, instanceSegments);
    if (!isScriptSnapshotNode(node)) {
      return false;
    }

    node.source = String(source ?? "");
    const snapshotInfo = this.normalizeAndHashSnapshotWithPerf(session.lastStudioSnapshot);
    session.lastStudioHash = snapshotInfo.hash;
    session.lastStudioRawHash = this.rawSnapshotHash(session.lastStudioSnapshot);
    session.lastStudioSeenAt = new Date().toISOString();
    logSync("studio_snapshot_assumed_from_source_patch", {
      sessionId: session.id,
      path: instanceSegments.join("."),
      snapshotHash: session.lastStudioHash,
      rawSnapshotHash: session.lastStudioRawHash
    });
    return true;
  }

  rejectCommand(sessionId, commandId, error) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    const command = session.inFlightCommands.get(commandId) || null;
    if (command) {
      session.inFlightCommands.delete(commandId);
      this.clearCommandSyncGuard(command);
      session.lastCommandError = String(error || "Studio reported an error.");
      const commandPath = Array.isArray(command.payload?.path) ? command.payload.path.join(".") : null;
      this.recordError({
        component: "studio",
        severity: command.type === "apply_project_tree" ? "error" : "warning",
        code: "CMD-REJECT",
        message: `Command ${command.type} was rejected by Studio: ${error || "unknown error"}`,
        sessionId,
        projectId: session.projectId,
        context: { commandId, commandType: command.type, reason: command.payload?.reason, path: commandPath }
      });
      if (command.type === "apply_file_patch") {
        const project = this.getProjectById(session.projectId);
        if (project) {
          logSync("apply_file_patch_rejected_fallback_tree", {
            sessionId,
            commandId,
            path: commandPath,
            error: String(error || "Studio reported an error.")
          });
          this.scheduleProjectTreeApply(session, project, "file_patch_rejected", commandPath, 50, true);
        }
      }
      if (command.type === "apply_project_tree" && command.payload?.reason === INITIAL_PC_SYNC_REASON) {
        session.connectionState = "error";
      }
      if (isSyncCommandType(command.type)) {
        this.markSyncDegraded(session, `Studio rejected ${command.type}: ${error || "unknown error"}`, {
          component: "studio",
          code: "CMD-REJECT",
          commandId,
          commandType: command.type,
          expectedHash: command.expectedHash || null
        });
      }
    }
    const deferred = session.pendingResponses.get(commandId);
    if (!deferred) {
      return;
    }
    session.pendingResponses.delete(commandId);
    clearTimeout(deferred.timeout);
    deferred.reject(new Error(error));
  }

  scheduleStudioSnapshotWrite(session: RuntimeSession, reason, writeNow) {
    return this.studioSnapshotWriter.schedule(session, reason, writeNow);
  }

  async flushStudioWrite(sessionId) {
    return this.studioSnapshotWriter.flush(sessionId);
  }

  async drainPendingStudioWrites(timeoutMs = 5000) {
    return this.studioSnapshotWriter.drain(timeoutMs);
  }

  updateStudioSnapshot(sessionId, snapshot, reason = "auto", options: { requestByteLength?: number | null } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    if (this.isSessionVersionBlocked(session)) {
      const reason = this.syncBlockedReason(session);
      const error = new Error(`Studio snapshot write blocked: ${reason}`) as Error & { statusCode?: number; code?: string };
      error.statusCode = 409;
      error.code = "VERSION-BLOCKED";
      throw error;
    }
    const syncTargets = this.syncTargetsForSession(session);
    const filteredSnapshot = this.snapshotForSync(snapshot, syncTargets);
    const project = this.getProjectById(session.projectId);
    if (project) {
      const invalidSnapshot = this.blockInvalidProjectSnapshot(session, project, filteredSnapshot, "studio_snapshot");
      if (invalidSnapshot) {
        throw invalidSnapshot;
      }
    }
    const snapshotInfo = this.normalizeAndHashSnapshotWithPerf(filteredSnapshot);
    const nextHash = snapshotInfo.hash;
    const prevHash = session.lastStudioHash;
    const nextRawHash = this.rawSnapshotHash(filteredSnapshot);
    const prevRawHash = session.lastStudioRawHash || null;
    const hashChanged = nextHash !== prevHash;
    const rawHashChanged = nextRawHash !== prevRawHash;
    logSync("studio_snapshot_received", {
      sessionId,
      reason,
      snapshotSize: options.requestByteLength || snapshotInfo.byteLength,
      hash: nextHash,
      hashChanged,
      previousHash: prevHash,
      rawHash: nextRawHash,
      rawHashChanged,
      previousRawHash: prevRawHash
    });
    this.cacheStudioSnapshot(session, filteredSnapshot, reason, snapshotInfo);
    this.ensureSessionSyncState(session).lastObservedHash = nextHash;

    if (!hashChanged && !rawHashChanged && reason !== "manual" && reason !== INITIAL_STUDIO_SYNC_REASON) {
      logSync("disk_write_skipped", {
        sessionId,
        reason: "snapshot_unchanged",
        snapshotHash: session.lastStudioHash
      });
      return;
    }

    const writeNow = reason === "manual" || reason === INITIAL_STUDIO_SYNC_REASON;
    this.scheduleStudioSnapshotWrite(session, reason, writeNow);
  }

  async requestStudioTree(sessionId, options: { writeToDisk?: boolean; reason?: string } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    const result = await this.enqueueCommand(sessionId, "get_tree", {}, true);
    if (!result.ok) {
      throw new Error(result.error || "Studio did not return a tree.");
    }
    if (result.snapshot) {
      const shouldWriteToDisk = options.writeToDisk === true && !this.isSessionVersionBlocked(session);
      if (shouldWriteToDisk) {
        this.updateStudioSnapshot(sessionId, result.snapshot, options.reason || "manual");
      } else {
        const observedHash = this.cacheStudioSnapshot(session, result.snapshot, options.reason || "manual_readonly");
        this.ensureSessionSyncState(session).lastObservedHash = observedHash;
      }
    }
    return result.snapshot;
  }

  async requestStudioSelection(sessionId) {
    const result = await this.enqueueCommand(sessionId, "get_selection", {}, true);
    if (!result.ok) {
      throw new Error(result.error || "Studio did not return a selection.");
    }
    return result.selection || [];
  }

  privilegedActionRateLimitResult(session, type) {
    if (!this.privilegedRateLimiter.isLimited(session.id)) {
      return null;
    }
    logSync("privileged_action_rate_limited", {
      sessionId: session.id,
      actionType: type,
      limit: PRIVILEGED_ACTION_RATE_LIMIT,
      windowMs: PRIVILEGED_ACTION_RATE_WINDOW_MS
    });
    return {
      ok: false,
      blocked: true,
      declined: false,
      confirmed: false,
      reasonCode: "RATE_LIMITED",
      error: "Too many privileged actions. Try again shortly.",
      sessionId: session.id
    };
  }

  async runStudioCode(sessionId, code) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    const rateLimitResult = this.privilegedActionRateLimitResult(session, "run_code");
    if (rateLimitResult) {
      return rateLimitResult;
    }
    const policy = this.privilegedActionPolicy(session, "run_code");
    if (!policy.allowed) {
      return {
        ok: false,
        error: policy.message,
        blocked: true,
        declined: false,
        confirmed: false,
        reasonCode: policy.reasonCode,
        sessionId: session.id
      };
    }
    const result = await this.enqueueCommand(sessionId, "run_code", { code }, true);
    const normalized = this.normalizePrivilegedCommandResult(session, result);
    if (!normalized.ok && (normalized.blocked || normalized.declined)) {
      return normalized;
    }
    if (!normalized.ok) {
      throw new Error(normalized.error || "Luau execution failed.");
    }
    const sanitized = { ...normalized };
    delete sanitized.error;
    return sanitized;
  }

  normalizePrivilegedCommandResult(session, result: DestructiveCommandResult = {}) {
    return this.normalizeDestructiveCommandResult(session, result);
  }

  normalizeDestructiveCommandResult(session, result: DestructiveCommandResult = {}) {
    const normalized: DestructiveCommandResult = result && typeof result === "object"
      ? { ...result }
      : {
        ok: false,
        error: String(result || "Unknown destructive command result.")
      };
    normalized.blocked = normalized.blocked === true;
    normalized.declined = normalized.declined === true;
    normalized.confirmed = normalized.confirmed === true
      || (normalized.ok === true && !normalized.blocked && !normalized.declined);
    normalized.reasonCode = normalized.reasonCode || (normalized.declined ? "DECLINED_BY_USER" : null);
    if (session?.id && !normalized.sessionId) {
      normalized.sessionId = session.id;
    }
    return normalized;
  }

  async enqueueDestructiveCommand(sessionId, type, payload) {
    if (!isDestructiveActionType(type)) {
      throw new Error(`Unsupported destructive command: ${type}`);
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    const rateLimitResult = this.privilegedActionRateLimitResult(session, type);
    if (rateLimitResult) {
      return rateLimitResult;
    }
    const policy = this.destructiveActionPolicy(session, type);
    if (!policy.allowed) {
      return {
        ok: false,
        error: policy.message,
        blocked: true,
        declined: false,
        confirmed: false,
        reasonCode: policy.reasonCode,
        sessionId: session.id
      };
    }
    const project = this.getProjectById(session.projectId);
    const mountPolicy = validateDestructiveCommandSyncMount(project, session, type, payload, this.syncTargetsForSession(session));
    if (!mountPolicy.allowed) {
      logSync("destructive_command_blocked", {
        sessionId,
        type,
        reason: mountPolicy.reasonCode,
        targetPath: mountPolicy.targetPath,
        activeMounts: mountPolicy.activeMounts
      });
      return {
        ok: false,
        error: mountPolicy.message,
        blocked: true,
        declined: false,
        confirmed: false,
        reasonCode: mountPolicy.reasonCode,
        sessionId: session.id,
        targetPath: mountPolicy.targetPath,
        activeMounts: mountPolicy.activeMounts,
        expectedMountPath: mountPolicy.expectedMountPath,
        mountId: mountPolicy.mountId
      };
    }
    const result = await this.enqueueCommand(sessionId, type, payload, true);
    return this.normalizeDestructiveCommandResult(session, result);
  }

  async setActiveProject(projectId) {
    const project = this.getProjectById(projectId);
    if (!project || project.abstract === true || project.enabled === false) {
      throw new Error(`Project '${projectId}' not found.`);
    }
    this.defaultProjectId = project.id;
    return project;
  }

  setAutoSyncToStudio(enabled) {
    this.autoSyncToStudio = enabled === true;
    this.autoSyncToStudioExplicit = true;
    logSync("auto_sync_to_studio_changed", {
      enabled: this.autoSyncToStudio
    });
    return {
      ok: true,
      autoSyncToStudio: this.autoSyncToStudio
    };
  }

  setPrivilegedActionConfirmation(enabled) {
    this.privilegedActionConfirmation = enabled === true;
    const queuedSessionIds = this.queuePrivilegedActionConfirmationPreferenceForSessions("vscode_setting");
    logSync("privileged_action_confirmation_changed", {
      enabled: this.privilegedActionConfirmation,
      queuedSessionIds
    });
    return {
      ok: true,
      privilegedActionConfirmation: this.privilegedActionConfirmation,
      queuedSessionIds
    };
  }

  activeLastCommandError(session) {
    if (!session?.lastCommandError) {
      return null;
    }
    const sync = this.ensureSessionSyncState(session);
    if (
      sync.state === "degraded"
      || (session.connectionState || "ready") === "error"
      || session.pendingCommands.length > 0
      || session.inFlightCommands.size > 0
    ) {
      return session.lastCommandError;
    }
    return null;
  }

  sessionSummary(session, options: { includeSessionToken?: boolean } = {}) {
    const project = this.getProjectById(session.projectId);
    const sync = this.ensureSessionSyncState(session);
    const version = this.sessionVersionStatus(session);
    const syncBlockedReason = this.syncBlockedReason(session);
    const contact = this.studioContactStatus(session);
    const destructive = this.destructiveActionPolicy(session);
    const privileged = this.privilegedActionPolicy(session);
    const destructiveSinceAtMs = parseTimestampMs(session.destructiveConfirmationSinceAt);
    const destructiveConfirmationAgeMs = session.destructiveConfirmationPending && destructiveSinceAtMs !== null
      ? Math.max(0, Date.now() - destructiveSinceAtMs)
      : null;
    return {
      id: session.id,
      ...(options.includeSessionToken ? { sessionToken: session.sessionToken || null } : {}),
      projectId: session.projectId,
      projectName: project ? project.name : session.projectId,
      projectPath: project ? path.relative(this.workspaceRoot, project.projectPath).replace(/\\/g, "/") : null,
      connectionState: session.connectionState || "ready",
      truthSource: session.truthSource || null,
      studioInstanceId: session.studioInstanceId || null,
      pluginVersion: session.pluginVersion || null,
      pluginProtocolVersion: session.pluginProtocolVersion || null,
      lastPluginVersionSeenAt: session.lastPluginVersionSeenAt || null,
      versionState: version.state,
      versionMessage: version.message,
      requiresPluginUpdate: version.requiresPluginUpdate,
      currentPluginVersion: CURRENT_PLUGIN_VERSION,
      pluginUpdateAvailable: version.pluginUpdateAvailable === true,
      syncBlockedReason,
      projectSelectionReason: session.projectSelectionReason || null,
      projectSelectionMessage: session.projectSelectionMessage || null,
      placeId: session.placeId,
      placeName: session.placeName || null,
      lastStudioContactAt: session.lastStudioContactAt,
      lastStudioSeenAt: session.lastStudioSeenAt,
      studioContactState: contact.state,
      studioContactAgeMs: contact.ageMs,
      studioContactMessage: contact.message,
      lastAppliedAt: session.lastAppliedAt,
      pendingCommands: session.pendingCommands.length,
      inFlightCommands: session.inFlightCommands.size,
      syncState: sync.state,
      syncMessage: this.syncMessage(session),
      lastAckAt: sync.lastAckAt,
      lastVerifiedAt: sync.lastVerifiedAt,
      lastSyncError: sync.state === "degraded" ? (sync.degradedReason || sync.lastFailure?.message || null) : null,
      requiresManualResync: sync.state === "degraded",
      lastCommandError: this.activeLastCommandError(session),
      destructiveActionsAllowed: destructive.allowed,
      destructiveActionReasonCode: destructive.reasonCode,
      destructiveActionMessage: destructive.allowed ? null : destructive.message,
      privilegedActionsAllowed: privileged.allowed,
      privilegedActionReasonCode: privileged.reasonCode,
      privilegedActionMessage: privileged.allowed ? null : privileged.message,
      privilegedActionConfirmationEnabled: session.privilegedActionConfirmationEnabled ?? null,
      detectModels: session.detectModels === true,
      syncTargets: this.syncTargetsForSession(session),
      destructiveConfirmationPending: session.destructiveConfirmationPending === true,
      destructiveConfirmationType: session.destructiveConfirmationType || null,
      destructiveConfirmationSinceAt: session.destructiveConfirmationSinceAt || null,
      destructiveConfirmationAgeMs
    };
  }

  doctorReport() {
    return this.doctorService.report();
  }

  calculateDiff(studioSnapshot, pcSnapshot, truthSource) {
    const changes = [];
    const maxChanges = 50;
    let changeCount = 0;

    function addChange(msg) {
      if (changeCount < maxChanges) {
        changes.push(msg);
      }
      changeCount++;
    }

    function compareNodes(path, sNode, pNode) {
      if (!sNode && pNode) {
        addChange(truthSource === "pc" ? `+ Created in Studio: ${path}` : `- Deleted locally: ${path}`);
        return;
      }
      if (sNode && !pNode) {
        addChange(truthSource === "pc" ? `- Deleted from Studio: ${path}` : `+ Created locally: ${path}`);
        return;
      }
      if (sNode && pNode) {
        if (sNode.className !== pNode.className && sNode.className !== "Folder" && pNode.className !== "Folder") {
           addChange(`~ Modified (Class): ${path}`);
        } else if (sNode.source !== undefined && pNode.source !== undefined && sNode.source !== pNode.source) {
           addChange(`~ Modified (Source): ${path}`);
        }
        
        const sChildren = {};
        for (const child of (sNode.children || [])) {
          sChildren[child.name] = child;
        }
        const pChildren = {};
        for (const child of (pNode.children || [])) {
          pChildren[child.name] = child;
        }

        const allNames = new Set([...Object.keys(sChildren), ...Object.keys(pChildren)]);
        for (const childName of allNames) {
           compareNodes(`${path}/${childName}`, sChildren[childName], pChildren[childName]);
        }
      }
    }

    const sMounts = {};
    for (const m of (studioSnapshot.mounts || [])) sMounts[m.id] = m;
    const pMounts = {};
    for (const m of (pcSnapshot.mounts || [])) pMounts[m.id] = m;

    const allMounts = new Set([...Object.keys(sMounts), ...Object.keys(pMounts)]);
    for (const mId of allMounts) {
      const sM = sMounts[mId];
      const pM = pMounts[mId];
      if (!sM && pM) {
        addChange(truthSource === "pc" ? `+ Created in Studio: [Mount ${mId}]` : `- Deleted locally: [Mount ${mId}]`);
        continue;
      }
      if (sM && !pM) {
        addChange(truthSource === "pc" ? `- Deleted from Studio: [Mount ${mId}]` : `+ Created locally: [Mount ${mId}]`);
        continue;
      }

      const sC = {};
      for (const child of (sM.children || [])) sC[child.name] = child;
      const pC = {};
      for (const child of (pM.children || [])) pC[child.name] = child;

      const allC = new Set([...Object.keys(sC), ...Object.keys(pC)]);
      for (const cName of allC) {
        compareNodes(`${mId}/${cName}`, sC[cName], pC[cName]);
      }
    }

    if (changeCount > maxChanges) {
      changes.push(`... and ${changeCount - maxChanges} more changes.`);
    }
    if (changeCount === 0) {
      changes.push("No changes detected. Everything is up to date.");
    }

    return changes;
  }

  async handleHttp(request, response) {
    try {
      if (this.shuttingDown) {
        jsonResponse(response, 503, { ok: false, error: "Daemon is shutting down." }, request);
        return;
      }

      const remoteAddress = request.socket?.remoteAddress || "unknown";
      if (this.rateLimiter && this.rateLimiter.isLimited(remoteAddress)) {
        jsonResponse(response, 429, { ok: false, error: "Too many requests. Try again shortly." }, request);
        return;
      }

      const requestUrl = new URL(request.url, `http://${request.headers.host || `${this.host}:${this.port}`}`);
      if (request.headers["x-amarillo-mcp-proxy"]) {
        this.recordMcpContact("proxy_http", { route: requestUrl.pathname });
      }
      if (request.method === "OPTIONS") {
        if (request.headers.origin && !isCorsOriginAllowed(request.headers.origin)) {
          jsonResponse(response, 403, {
            ok: false,
            code: "CORS_ORIGIN_FORBIDDEN",
            error: "CORS preflight origin is not allowed."
          }, request);
          return;
        }
        jsonResponse(response, 204, { ok: true }, request);
        return;
      }
      if (!this.authorizeHttpRequest(request, requestUrl)) {
        this.recordUnauthorizedHttpRequest(request, requestUrl);
        jsonResponse(response, 401, {
          ok: false,
          code: "UNAUTHORIZED",
          error: "Missing or invalid Amarillo authorization token.",
          ...authHelpPayload(),
          hint: `Send ${BRIDGE_TOKEN_HEADER_DISPLAY}: <bridge token> or Authorization: Bearer <bridge token>. The bridge token is stored in .amarillo/mcp-local.json for the portable MCP bootstrap or provided by VS Code when Amarillo starts the bridge.`
        }, request);
        return;
      }
      for (const routeHandler of [
        handleDiagnosticsRoutes,
        handleMcpRoutes,
        handleConnectionRoutes,
        handleStudioRoutes,
        handleSessionRoutes
      ]) {
        if (await routeHandler(this, request, response, requestUrl)) {
          return;
        }
      }

      jsonResponse(response, 404, {
        ok: false,
        error: `Endpoint not found: ${request.method} ${requestUrl.pathname}`
      }, request);
    } catch (error) {
      if (error instanceof HttpError) {
        errorResponse(response, error, request);
        return;
      }
      throw error;
    }
  }
}

module.exports = {
  PluginRobloxApp,
  hashSnapshot,
  normalizeAndHashSnapshot
};
