"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const {
  loadWorkspaceProjectCatalog,
  moveOrphanScriptMetaForFile,
  readLocalProjectState,
  readLocalProjectStateAsync,
  readWorkspaceConfig,
  resolveProjectSelectionForPlace,
  writeStudioProjectState
} = require("./project");
const { ErrorTracker } = require("./lib/error-tracker");
const { ActivityLog, getFileInfo } = require("./lib/activity-log");
const { ensurePluginInstructionsFile } = require("./lib/instructions");

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// OPT-001/002: Simplified hash — direct JSON.stringify with sorted keys
function hashSnapshot(snapshot) {
  const json = JSON.stringify(snapshot, (_, value) => {
    if (Array.isArray(value)) {
      return value;
    }
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((accumulator, key) => {
          accumulator[key] = value[key];
          return accumulator;
        }, {});
    }
    return value;
  });
  return crypto.createHash("sha1").update(json).digest("hex");
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function logSync(event, details = {}) {
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

const SCRIPT_PATCH_DEBOUNCE_MS = 75;
const PROJECT_TREE_DEBOUNCE_MS = 250;
const COMMAND_RESULT_TIMEOUT_MS = 120000;
const INITIAL_STUDIO_SYNC_REASON = "initial_accept";
const INITIAL_PC_SYNC_REASON = "initial_pc_truth";
const INITIAL_STUDIO_CONTACT_GRACE_MS = 5000;
const STUDIO_SESSION_STALE_MS = 30000;
const DEFAULT_AUTO_SYNC_TO_STUDIO = true;

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

function segmentsHavePrefix(segments, prefix) {
  if (!Array.isArray(segments) || !Array.isArray(prefix) || prefix.length > segments.length) {
    return false;
  }
  return prefix.every((segment, index) => segments[index] === segment);
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

class PluginRobloxApp {
  constructor(options) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.host = options.host || "127.0.0.1";
    this.port = Number(options.port || 8323);
    this.autoSyncToStudioExplicit = options.autoSyncToStudio !== undefined;
    this.autoSyncToStudio = coerceBoolean(options.autoSyncToStudio, DEFAULT_AUTO_SYNC_TO_STUDIO);
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
    this.sessions = new Map();
    this.connectionOffer = null;
    this.fileWatchers = [];
    this.pendingStudioWrites = new Map();
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
    this.activityFileState = new Map();
  }

  async start() {
    this.refreshWorkspace();
    if (!this.port) {
      this.port = Number(this.config.plugin.daemonPort || this.config.argon.port || 8323);
    }
    if (!this.host) {
      this.host = this.config.argon.host || "127.0.0.1";
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
          error: error.message
        });
      });
    });
    // Port scanning (Argon pattern): try next ports if default is in use
    const maxPortScanAttempts = 10;
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
              jsonResponse(response, 500, { ok: false, error: httpError.message });
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
    for (const watcher of this.fileWatchers) {
      watcher.close();
    }
    this.fileWatchers = [];
    if (this.httpServer) {
      this.httpServer.close();
      await once(this.httpServer, "close");
      this.httpServer = null;
    }
  }

  recordError(entry = {}) {
    return this.errorTracker.add({
      component: entry.component || "daemon",
      severity: entry.severity || "error",
      code: entry.code || null,
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

  refreshWorkspace() {
    const previousDefaultProjectId = this.defaultProjectId;
    this.config = readWorkspaceConfig(this.workspaceRoot);
    if (!this.autoSyncToStudioExplicit) {
      this.autoSyncToStudio = coerceBoolean(this.config.plugin.autoSyncToStudio, DEFAULT_AUTO_SYNC_TO_STUDIO);
    }
    const projectCatalog = loadWorkspaceProjectCatalog(this.workspaceRoot);
    this.allProjects = projectCatalog.allProjects;
    this.projects = projectCatalog.selectableProjects;
    this.projectCatalogIssues = projectCatalog.issues;
    this.defaultProjectId = this.resolveDefaultProjectId(previousDefaultProjectId);
    this.reportProjectCatalogIssues();
    this.rebuildActivityFileState();
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
    const nextIssueKeys = new Set();
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
          projectPath: issue.projectPath || null
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

  rebuildActivityFileState() {
    this.activityFileState.clear();
    const seen = new Set();
    for (const project of this.allProjects) {
      for (const mount of project.mounts || []) {
        for (const filePath of collectFilesRecursive(mount.absolutePath)) {
          const normalized = normalizeFsPath(filePath);
          if (seen.has(normalized)) {
            continue;
          }
          seen.add(normalized);
          const info = getFileInfo(normalized);
          if (info) {
            this.activityFileState.set(normalized, info);
          }
        }
      }
    }
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

  recordActivity(change = {}, defaults = {}) {
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

    const record = this.activityLog.add({
      action: change.action,
      path: normalized,
      projectId,
      mountId,
      direction: defaults.direction,
      source: defaults.source,
      reason: defaults.reason,
      sessionId: defaults.sessionId || (context && context.sessionId),
      size: change.size,
      hash: change.hash
    });

    if (record.action === "delete") {
      this.activityFileState.delete(normalized);
    } else {
      const nextInfo = getFileInfo(normalized) || {
        size: record.size,
        hash: record.hash
      };
      if (nextInfo && nextInfo.hash) {
        this.activityFileState.set(normalized, nextInfo);
      }
    }
    return record;
  }

  recordWorkspaceFileActivity(filePath, defaults = {}) {
    const normalized = normalizeFsPath(filePath);
    const context = this.findMountedFileContext(normalized);
    if (!context) {
      return null;
    }

    const previousInfo = this.activityFileState.get(normalized) || null;
    const nextInfo = getFileInfo(normalized);
    let action = null;
    let info = nextInfo || previousInfo || {};

    if (!previousInfo && nextInfo) {
      action = "create";
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
      hash: info.hash
    }, {
      ...defaults,
      sessionId: defaults.sessionId || context.sessionId
    });
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
    for (const deferred of session.pendingResponses.values()) {
      clearTimeout(deferred.timeout);
    }
    session.pendingResponses.clear();
    session.inFlightCommands.clear();
    session.pendingCommands = [];
    session._pollWaiter = null;
  }

  reclaimStudioSession(session, selection, placeId, options = {}) {
    this.clearSessionRuntimeState(session);
    session.placeId = Number(placeId || 0);
    session.createdAt = new Date().toISOString();
    session.lastStudioHash = null;
    session.lastStudioSnapshot = null;
    session.lastStudioSeenAt = null;
    session.lastStudioContactAt = null;
    session.lastAppliedAt = null;
    session.connectionState = options.connectionState || "ready";
    session.truthSource = options.truthSource || null;
    session.studioInstanceId = options.studioInstanceId || null;
    session.lastCommandError = null;
    session.projectSelectionReason = selection.reason;
    session.projectSelectionMessage = selection.message;
  }

  startWatchers() {
    // OPT-009: More aggressive filtering to reduce CPU overhead from fs.watch
    let configRefreshTimer = null;
    let configRefreshTarget = null;
    const watcher = fs.watch(this.workspaceRoot, { recursive: true }, (eventType, fileName) => {
      if (!fileName) {
        return;
      }
      const normalized = String(fileName).replace(/\\/g, "/");

      // Skip known non-relevant directories early
      if (
        normalized.startsWith(".git/")
        || normalized.startsWith("node_modules/")
        || normalized.startsWith(".amarillo/")
        || normalized.startsWith(".vscode/")
        || normalized.startsWith("dist/")
        || normalized.startsWith("build/")
      ) {
        return;
      }

      // Debounce config refreshes to avoid repeated workspace reloads
      if (normalized === "argon.toml" || normalized === ".pluginroblox.json" || normalized.endsWith(".project.json")) {
        if (normalized.endsWith(".project.json")) {
          configRefreshTarget = normalized;
        }
        if (configRefreshTimer) {
          clearTimeout(configRefreshTimer);
        }
        configRefreshTimer = setTimeout(() => {
          const refreshTarget = configRefreshTarget;
          configRefreshTimer = null;
          configRefreshTarget = null;
          this.refreshWorkspace();
          if (refreshTarget) {
            this.handleProjectDefinitionChanged(refreshTarget);
          }
        }, 200);
      }

      // Only forward relevant file types to the change handler
      if (
        normalized.endsWith(".lua")
        || normalized.endsWith(".luau")
        || normalized.endsWith(".meta.json")
        || normalized.endsWith(".model.json")
        || normalized.endsWith(".rbxm")
        || normalized.endsWith(".rbxmx")
        || normalized.endsWith(".project.json")
      ) {
        this.onWorkspaceFileChanged(path.join(this.workspaceRoot, fileName), eventType);
      }
    });
    this.fileWatchers.push(watcher);
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

  scheduleProjectTreeApply(session, project, reason, changedPath = null, debounceMs = PROJECT_TREE_DEBOUNCE_MS) {
    logSync("enqueue_apply_project_tree_scheduled", {
      sessionId: session.id,
      path: changedPath,
      debounceMs
    });
    if (session.fileChangeTimer) {
      clearTimeout(session.fileChangeTimer);
    }
    session.fileChangeTimer = setTimeout(async () => {
      session.fileChangeTimer = null;
      if (!this.sessions.has(session.id)) {
        return;
      }
      logSync("enqueue_apply_project_tree_executing", {
        sessionId: session.id,
        reason
      });
      // OPT-006: Use async file reading to avoid blocking the event loop
      try {
        const projectState = await readLocalProjectStateAsync(project, this.projectReadOptions(session));
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
          project: readLocalProjectState(project, this.projectReadOptions(session)),
          reason
        });
      }
    }, debounceMs);
  }

  scheduleScriptFilePatch(session, project, filePath, instanceSegments) {
    const patchKey = instanceSegments.join(".");
    const existingTimer = session.filePatchTimers.get(patchKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      session.filePatchTimers.delete(patchKey);
      if (!this.sessions.has(session.id)) {
        return;
      }

      try {
        const source = fs.readFileSync(filePath, "utf8");
        logSync("enqueue_apply_file_patch", {
          sessionId: session.id,
          path: patchKey,
          sourceSize: source.length
        });
        this.enqueueCommand(session.id, "apply_file_patch", {
          path: instanceSegments,
          source
        });
      } catch (error) {
        logSync("apply_file_patch_fallback_tree", {
          sessionId: session.id,
          path: patchKey,
          error: error.message
        });
        this.scheduleProjectTreeApply(session, project, "workspace_changed", filePath);
      }
    }, SCRIPT_PATCH_DEBOUNCE_MS);

    session.filePatchTimers.set(patchKey, timer);
  }

  snapshotHasScriptInstance(session, instanceSegments) {
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
    if (this.lastDiskWriteTime && Date.now() - this.lastDiskWriteTime < 1000) {
      logSync("file_change_ignored", {
        reason: "within_1s_of_last_write",
        lastDiskWriteTime: this.lastDiskWriteTime,
        now: Date.now()
      });
      return;
    }
    const normalizedChangedPath = normalizeFsPath(changedPath);
    logSync("disk_file_changed", { path: normalizedChangedPath, eventType });
    this.recordWorkspaceFileActivity(normalizedChangedPath, {
      direction: "pc_to_studio",
      source: "workspace_watcher",
      reason: "workspace_changed"
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
      const project = this.getProjectById(session.projectId);
      if (!project) {
        continue;
      }
      
      const mount = project.mounts.find((m) => isPathInside(normalizedChangedPath, m.absolutePath));
      if (!mount) {
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
      mounts: project.mounts.map((mount) => ({
        id: mount.id,
        path: mount.segments.join("."),
        relativePath: mount.relativePath
      }))
    }));
  }

  projectPayload(project) {
    return {
      id: project.id,
      name: project.name,
      projectPath: path.relative(this.workspaceRoot, project.projectPath).replace(/\\/g, "/"),
      abstract: project.abstract === true,
      extendsProjectId: project.extendsProjectId || null,
      extendsProjectPath: project.extendsProjectPath || null,
      placeIds: project.placeIds,
      mounts: project.mounts.map((mount) => ({
        id: mount.id,
        path: mount.segments.join("."),
        relativePath: mount.relativePath,
        keepUnknowns: mount.keepUnknowns
      }))
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

  resolveConnectionOffer(status, details = {}) {
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

  openSession(placeId, preferredProjectId = null, options = {}) {
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
        }
        existing.projectSelectionReason = selection.reason;
        existing.projectSelectionMessage = selection.message;
        if (options.connectionState) {
          existing.connectionState = options.connectionState;
        }
        if (options.truthSource) {
          existing.truthSource = options.truthSource;
        }
        if (options.studioInstanceId) {
          existing.studioInstanceId = options.studioInstanceId;
        }
      }
      return {
        session: existing,
        project
      };
    }
    const session = {
      id: crypto.randomUUID(),
      placeId: Number(placeId || 0),
      projectId: project.id,
      createdAt: new Date().toISOString(),
      lastStudioHash: null,
      lastStudioSnapshot: null,
      lastStudioSeenAt: null,
      lastStudioContactAt: null,
      pendingCommands: [],
      pendingResponses: new Map(),
      inFlightCommands: new Map(),
      fileChangeTimer: null,
      filePatchTimers: new Map(),
      lastAppliedAt: null,
      connectionState: options.connectionState || "ready",
      truthSource: options.truthSource || null,
      studioInstanceId: options.studioInstanceId || null,
      lastCommandError: null,
      projectSelectionReason: selection.reason,
      projectSelectionMessage: selection.message,
      _pollWaiter: null
    };
    this.sessions.set(session.id, session);
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
    session.lastCommandError = null;
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
    projectId = null,
    truthSource = "pc"
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
    const initialConnectionState = "accepted";
    let sessionResult;
    try {
      sessionResult = this.openSession(placeId, projectId, {
        connectionState: initialConnectionState,
        truthSource: normalizedTruthSource,
        studioInstanceId
      });
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        offer: this.connectionOfferSummary()
      };
    }
    const { session, project } = sessionResult;

    if (offerId) {
      this.resolveConnectionOffer("accepted", {
        studioInstanceId,
        sessionId: session.id,
        projectId: project.id,
        projectName: project.name,
        truthSource: normalizedTruthSource
      });
    }

    if (normalizedTruthSource === "pc") {
      this.enqueueCommand(session.id, "apply_project_tree", {
        project: readLocalProjectState(project, this.projectReadOptions(session)),
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

  enqueueCommand(sessionId, type, payload, waitForResult = false, timeoutMs = COMMAND_RESULT_TIMEOUT_MS) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    if (type === "apply_project_tree") {
      session.pendingCommands = session.pendingCommands.filter(c => c.type !== "apply_project_tree" && c.type !== "apply_file_patch");
    }
    if (type === "apply_file_patch" && Array.isArray(payload?.path)) {
      const patchPath = payload.path.join(".");
      session.pendingCommands = session.pendingCommands.filter((c) => {
        if (c.type !== "apply_file_patch" || !Array.isArray(c.payload?.path)) {
          return true;
        }
        return c.payload.path.join(".") !== patchPath;
      });
    }
    const command = {
      id: crypto.randomUUID(),
      type,
      payload
    };
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
          deferred.reject(new Error(`Timed out waiting for Studio response for ${type}.`));
        }
      }, timeoutMs);
      session.pendingResponses.set(command.id, deferred);
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
    for (const command of commands) {
      session.inFlightCommands.set(command.id, command);
    }
    if (commands.length > 0) {
      logSync("dequeue_commands", {
        sessionId,
        commandCount: commands.length,
        commandTypes: commands.map(c => c.type)
      });
    }
    return {
      commands,
      session: {
        id: session.id,
        placeId: session.placeId,
        projectId: session.projectId,
        lastStudioSeenAt: session.lastStudioSeenAt,
        lastAppliedAt: session.lastAppliedAt
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
      if (command.type === "apply_project_tree" && command.payload?.project) {
        if (payload?.snapshot) {
          this.updateStudioSnapshot(sessionId, payload.snapshot, "apply_project_tree_corrected");
        } else {
          this.recordAppliedProjectSnapshot(session, command.payload.project, command.payload?.reason);
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
    const normalized = {
      ...projectSnapshot,
      mounts: (projectSnapshot.mounts || []).map((mount) => ({
        ...mount,
        children: mount.children || []
      }))
    };
    session.lastStudioSnapshot = normalized;
    session.lastStudioHash = hashSnapshot(normalized);
    session.lastStudioSeenAt = new Date().toISOString();
    logSync("studio_snapshot_assumed_from_project_apply", {
      sessionId: session.id,
      reason,
      snapshotHash: session.lastStudioHash
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
    const normalized = {
      ...session.lastStudioSnapshot,
      mounts: (session.lastStudioSnapshot.mounts || []).map((mount) => ({
        ...mount,
        children: mount.children || []
      }))
    };
    session.lastStudioSnapshot = normalized;
    session.lastStudioHash = hashSnapshot(normalized);
    session.lastStudioSeenAt = new Date().toISOString();
    logSync("studio_snapshot_assumed_from_source_patch", {
      sessionId: session.id,
      path: instanceSegments.join("."),
      snapshotHash: session.lastStudioHash
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
          this.scheduleProjectTreeApply(session, project, "file_patch_rejected", commandPath, 50);
        }
      }
      if (command.type === "apply_project_tree" && command.payload?.reason === INITIAL_PC_SYNC_REASON) {
        session.connectionState = "error";
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

  updateStudioSnapshot(sessionId, snapshot, reason = "auto") {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    const normalized = {
      ...snapshot,
      mounts: (snapshot.mounts || []).map((mount) => ({
        ...mount,
        children: mount.children || []
      }))
    };
    const nextHash = hashSnapshot(normalized);
    const prevHash = session.lastStudioHash;
    const hashChanged = nextHash !== prevHash;
    logSync("studio_snapshot_received", {
      sessionId,
      reason,
      snapshotSize: JSON.stringify(snapshot).length,
      hash: nextHash,
      hashChanged,
      previousHash: prevHash
    });
    session.lastStudioSnapshot = snapshot;
    session.lastStudioHash = nextHash;
    session.lastStudioSeenAt = new Date().toISOString();

    if (!hashChanged && reason !== "manual" && reason !== INITIAL_STUDIO_SYNC_REASON) {
      logSync("disk_write_skipped", {
        sessionId,
        reason: "snapshot_unchanged",
        snapshotHash: session.lastStudioHash
      });
      return;
    }

    if (this.pendingStudioWrites.has(sessionId)) {
      clearTimeout(this.pendingStudioWrites.get(sessionId));
    }

    const writeNow = reason === "manual" || reason === INITIAL_STUDIO_SYNC_REASON;
    const timer = setTimeout(() => {
      const project = this.getProjectById(session.projectId);
      if (!project || !session.lastStudioSnapshot) {
        logSync("disk_write_skipped", {
          sessionId,
          reason: project ? "no_snapshot" : "no_project"
        });
        return;
      }
      logSync("disk_write_start", {
        sessionId,
        reason,
        snapshotHash: session.lastStudioHash
      });
      this.lastDiskWriteTime = Date.now();
      try {
        writeStudioProjectState(project, session.lastStudioSnapshot, {
          onFileChange: (change) => {
            this.recordActivity(change, {
              direction: "studio_to_pc",
              source: "studio_snapshot",
              reason,
              sessionId
            });
          }
        });
      } catch (error) {
        this.pendingStudioWrites.delete(sessionId);
        this.recordError({
          component: "daemon",
          severity: "error",
          code: "DISK-WRITE",
          message: error.message,
          sessionId,
          projectId: project.id,
          context: { reason },
          stack: error.stack
        });
        return;
      }
      this.pendingStudioWrites.delete(sessionId);
      session.lastAppliedAt = new Date().toISOString();
      if (reason === INITIAL_STUDIO_SYNC_REASON || (session.connectionState !== "ready" && session.truthSource === "studio")) {
        this.markSessionReady(session, reason);
      }
      logSync("disk_write_complete", {
        sessionId,
        timestamp: session.lastAppliedAt
      });
    }, writeNow ? 0 : 300);
    this.pendingStudioWrites.set(sessionId, timer);
  }

  async requestStudioTree(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    const result = await this.enqueueCommand(sessionId, "get_tree", {}, true);
    if (!result.ok) {
      throw new Error(result.error || "Studio did not return a tree.");
    }
    if (result.snapshot) {
      this.updateStudioSnapshot(sessionId, result.snapshot, "manual");
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

  async runStudioCode(sessionId, code) {
    const result = await this.enqueueCommand(sessionId, "run_code", { code }, true);
    if (!result.ok) {
      throw new Error(result.error || "Luau execution failed.");
    }
    return result;
  }

  async setActiveProject(projectId) {
    const project = this.getProjectById(projectId);
    if (!project || project.abstract === true || project.enabled === false) {
      throw new Error(`Project '${projectId}' not found.`);
    }
    this.defaultProjectId = project.id;
    return project;
  }

  sessionSummary(session) {
    const project = this.getProjectById(session.projectId);
    return {
      id: session.id,
      projectId: session.projectId,
      projectName: project ? project.name : session.projectId,
      projectPath: project ? path.relative(this.workspaceRoot, project.projectPath).replace(/\\/g, "/") : null,
      connectionState: session.connectionState || "ready",
      truthSource: session.truthSource || null,
      studioInstanceId: session.studioInstanceId || null,
      projectSelectionReason: session.projectSelectionReason || null,
      projectSelectionMessage: session.projectSelectionMessage || null,
      placeId: session.placeId,
      lastStudioContactAt: session.lastStudioContactAt,
      lastStudioSeenAt: session.lastStudioSeenAt,
      lastAppliedAt: session.lastAppliedAt,
      pendingCommands: session.pendingCommands.length,
      lastCommandError: session.lastCommandError || null
    };
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
    const requestUrl = new URL(request.url, `http://${request.headers.host || `${this.host}:${this.port}`}`);
    if (request.method === "OPTIONS") {
      jsonResponse(response, 204, { ok: true });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      jsonResponse(response, 200, {
        ok: true,
        workspaceRoot: this.workspaceRoot,
        host: this.host,
        port: this.port,
        autoSyncToStudio: this.autoSyncToStudio,
        projectCount: this.projects.length,
        defaultProjectId: this.defaultProjectId,
        defaultProjectPath: this.defaultProjectId
          ? (this.getProjectById(this.defaultProjectId)?.id || null)
          : null,
        connectionOffer: this.connectionOfferSummary(),
        sessions: Array.from(this.sessions.values()).map((session) => this.sessionSummary(session)),
        refreshedAt: this.lastWorkspaceRefresh
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/projects") {
      jsonResponse(response, 200, {
        ok: true,
        projects: this.listProjects(),
        defaultProjectId: this.defaultProjectId
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/project/active") {
      const body = await readJsonBody(request);
      const project = await this.setActiveProject(body.projectId);
      jsonResponse(response, 200, {
        ok: true,
        project
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/workspace/files-changed") {
      const body = await readJsonBody(request);
      const result = this.handleWorkspaceFileEvents(body.events || [body]);
      jsonResponse(response, 200, {
        ok: true,
        ...result
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/debug/sync-state") {
      const sessionId = requestUrl.searchParams.get("sessionId");
      const session = sessionId ? this.sessions.get(sessionId) : null;
      
      if (sessionId && !session) {
        jsonResponse(response, 404, { ok: false, error: "Session not found" });
        return;
      }

      if (session) {
        const project = this.getProjectById(session.projectId);
        jsonResponse(response, 200, {
          ok: true,
          mode: "single_session",
          timestamp: new Date().toISOString(),
          session: {
            id: session.id,
            projectId: session.projectId,
            projectName: project ? project.name : "unknown",
            placeId: session.placeId,
            connectionState: session.connectionState || "ready",
            truthSource: session.truthSource || null,
            lastStudioContactAt: session.lastStudioContactAt,
            lastStudioSeenAt: session.lastStudioSeenAt,
            lastAppliedAt: session.lastAppliedAt,
            lastStudioHash: session.lastStudioHash,
            hasSnapshot: !!session.lastStudioSnapshot,
            snapshotSize: session.lastStudioSnapshot ? JSON.stringify(session.lastStudioSnapshot).length : 0,
            pendingCommandCount: session.pendingCommands.length,
            pendingCommands: session.pendingCommands.map(c => ({ id: c.id, type: c.type })),
            inFlightCommandCount: session.inFlightCommands.size,
            fileChangeTimerActive: !!session.fileChangeTimer
          },
          lastDiskWriteTime: this.lastDiskWriteTime,
          autoSyncToStudio: this.autoSyncToStudio
        });
        return;
      }

      // All sessions
      jsonResponse(response, 200, {
        ok: true,
        mode: "all_sessions",
        timestamp: new Date().toISOString(),
        daemon: {
          workspaceRoot: this.workspaceRoot,
          projectCount: this.projects.length,
          sessionCount: this.sessions.size,
          autoSyncToStudio: this.autoSyncToStudio,
          lastDiskWriteTime: this.lastDiskWriteTime,
          connectionOffer: this.connectionOfferSummary()
        },
        sessions: Array.from(this.sessions.values()).map((session) => {
          const project = this.getProjectById(session.projectId);
          return {
            id: session.id,
            projectId: session.projectId,
            projectName: project ? project.name : "unknown",
            placeId: session.placeId,
            lastStudioContactAt: session.lastStudioContactAt,
            lastStudioSeenAt: session.lastStudioSeenAt,
            lastAppliedAt: session.lastAppliedAt,
            lastStudioHash: session.lastStudioHash,
            hasSnapshot: !!session.lastStudioSnapshot,
            pendingCommandCount: session.pendingCommands.length,
            pendingCommandTypes: session.pendingCommands.map(c => c.type)
          };
        })
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/connection/request") {
      const body = await readJsonBody(request);
      jsonResponse(response, 200, {
        ok: true,
        offer: this.beginConnectionOffer(body.requestedBy || "vscode")
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/connection/decline") {
      const body = await readJsonBody(request);
      const result = this.declineConnectionOffer(body.offerId, body.studioInstanceId || null);
      jsonResponse(response, result.ok ? 200 : 409, result);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/connection/accept") {
      const body = await readJsonBody(request);
      const result = this.acceptConnection({
        offerId: body.offerId || null,
        studioInstanceId: body.studioInstanceId || null,
        placeId: body.placeId || 0,
        projectId: body.projectId || null,
        truthSource: body.truthSource || "pc"
      });
      if (!result.ok) {
        jsonResponse(response, 409, result);
        return;
      }
      jsonResponse(response, 200, {
        ok: true,
        offer: result.offer,
        session: this.sessionSummary(result.session),
        project: this.projectPayload(result.project)
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/connection/diff") {
      const body = await readJsonBody(request);
      const project = this.getProjectById(body.projectId);
      if (!project) {
        jsonResponse(response, 404, { ok: false, error: "Project not found" });
        return;
      }
      const { readLocalProjectState } = require('./project');
      const pcSnapshot = readLocalProjectState(project);
      const studioSnapshot = body.studioSnapshot || { mounts: [] };
      const changes = this.calculateDiff(studioSnapshot, pcSnapshot, body.truthSource);
      
      jsonResponse(response, 200, {
        ok: true,
        changes
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/session/open") {
      const body = await readJsonBody(request);
      const { session, project } = this.openSession(body.placeId || 0, body.projectId || null, {
        studioInstanceId: body.studioInstanceId || null,
        truthSource: body.truthSource || null,
        connectionState: body.connectionState || "ready"
      });
      jsonResponse(response, 200, {
        ok: true,
        session: this.sessionSummary(session),
        project: this.projectPayload(project)
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/session/close") {
      const body = await readJsonBody(request);
      jsonResponse(response, 200, {
        ok: this.closeSession(body.sessionId)
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/studio/poll") {
      const sessionId = requestUrl.searchParams.get("sessionId");
      if (!sessionId) {
        jsonResponse(response, 200, {
          ok: true,
          mode: "offer",
          offer: this.connectionOffer && this.connectionOffer.status === "pending"
            ? this.connectionOfferSummary()
            : null
        });
        return;
      }

      const session = this.sessions.get(sessionId);
      if (!session) {
        jsonResponse(response, 404, { ok: false, error: "Session not found." });
        return;
      }
      this.markStudioSessionContact(session);

      // If commands are already pending, respond immediately
      if (session.pendingCommands.length > 0) {
        const data = this.dequeueCommands(sessionId);
        jsonResponse(response, 200, { ok: true, ...data });
        return;
      }

      // Long-poll: hold connection open until commands arrive or timeout
      const LONG_POLL_TIMEOUT = 25000;
      let resolved = false;

      const respond = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (session._pollWaiter === respond) {
          session._pollWaiter = null;
        }
        try {
          const data = this.dequeueCommands(sessionId);
          jsonResponse(response, 200, { ok: true, ...data });
        } catch (_) {
          jsonResponse(response, 200, { ok: true, commands: [] });
        }
      };

      const timer = setTimeout(respond, LONG_POLL_TIMEOUT);
      session._pollWaiter = respond;

      // Handle client disconnect
      request.on("close", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          if (session._pollWaiter === respond) {
            session._pollWaiter = null;
          }
        }
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/studio/complete") {
      const body = await readJsonBody(request);
      this.markStudioSessionContact(this.sessions.get(body.sessionId));
      if (body.ok) {
        this.completeCommand(body.sessionId, body.commandId, body);
      } else {
        this.rejectCommand(body.sessionId, body.commandId, body.error || "Studio reported an error.");
      }
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/studio/snapshot") {
      const body = await readJsonBody(request);
      this.markStudioSessionContact(this.sessions.get(body.sessionId));
      this.updateStudioSnapshot(body.sessionId, body.snapshot, body.reason || "auto");
      jsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/studio/patch-source") {
      const body = await readJsonBody(request);
      const sessionId = body.sessionId;
      const session = this.sessions.get(sessionId);
      if (!session) {
        jsonResponse(response, 404, { ok: false, error: "Session not found." });
        return;
      }
      this.markStudioSessionContact(session);
      const project = this.getProjectById(session.projectId);
      if (!project) {
        jsonResponse(response, 404, { ok: false, error: "Project not found." });
        return;
      }
      
      this.lastDiskWriteTime = Date.now();
      const result = require("./project").patchStudioFileSource(project, body.path, body.source, {
        project,
        onFileChange: (change) => {
          this.recordActivity(change, {
            direction: "studio_to_pc",
            source: "studio_patch",
            reason: "script_patch",
            sessionId
          });
        }
      });
      if (!result.ok) {
        this.recordError({
          component: "daemon",
          severity: "warning",
          code: "STUDIO-PATCH",
          message: result.error || "Studio patch could not be written to disk.",
          sessionId,
          projectId: project.id,
          context: { path: body.path }
        });
      }
      if (result.ok) {
        this.recordPatchedStudioSource(session, body.path, body.source);
      }
      
      jsonResponse(response, 200, result);
      return;
    }

    const sessionActionMatch = requestUrl.pathname.match(/^\/session\/([^/]+)\/(status|pull|push|tree|exec|selection|playtest|properties|descendants|search|services|instance-info|output-log|modify-property|create-instance|delete-instance)$/);
    if (sessionActionMatch) {
      const [, sessionId, action] = sessionActionMatch;
      const session = this.sessions.get(sessionId);
      if (!session) {
        jsonResponse(response, 404, {
          ok: false,
          error: "Session not found."
        });
        return;
      }
      const project = this.getProjectById(session.projectId);

      if (request.method === "GET" && action === "status") {
        jsonResponse(response, 200, {
          ok: true,
          session: this.sessionSummary(session),
          project: project ? { id: project.id, name: project.name } : null
        });
        return;
      }

      if (request.method === "POST" && action === "pull") {
        const result = await this.enqueueCommand(sessionId, "apply_project_tree", {
          project: readLocalProjectState(project, this.projectReadOptions(session)),
          reason: "manual_pull"
        }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "POST" && action === "push") {
        const snapshot = await this.requestStudioTree(sessionId);
        jsonResponse(response, 200, {
          ok: true,
          snapshot,
          snapshotHash: session.lastStudioHash
        });
        return;
      }

      if (request.method === "GET" && action === "tree") {
        const snapshot = session.lastStudioSnapshot || await this.requestStudioTree(sessionId);
        jsonResponse(response, 200, {
          ok: true,
          snapshot
        });
        return;
      }

      if (request.method === "POST" && action === "exec") {
        const body = await readJsonBody(request);
        const result = await this.runStudioCode(sessionId, body.code || "");
        jsonResponse(response, 200, {
          ok: true,
          result
        });
        return;
      }

      if (request.method === "GET" && action === "selection") {
        const selection = await this.requestStudioSelection(sessionId);
        jsonResponse(response, 200, {
          ok: true,
          selection
        });
        return;
      }

      if (request.method === "POST" && action === "playtest") {
        const body = await readJsonBody(request);
        const mode = body.mode === "stop" ? "stop" : "start";
        const result = await this.enqueueCommand(sessionId, "playtest", { mode }, true);
        jsonResponse(response, 200, {
          ok: true,
          result
        });
        return;
      }

      if (request.method === "POST" && action === "properties") {
        const body = await readJsonBody(request);
        const result = await this.enqueueCommand(sessionId, "get_properties", { path: body.path }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "POST" && action === "descendants") {
        const body = await readJsonBody(request);
        const result = await this.enqueueCommand(sessionId, "get_descendants", {
          path: body.path,
          maxDepth: Math.min(Math.max(Number(body.maxDepth) || 10, 1), 10),
          classFilter: body.classFilter || null
        }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "POST" && action === "search") {
        const body = await readJsonBody(request);
        const result = await this.enqueueCommand(sessionId, "search_instances", {
          query: body.query,
          searchBy: body.searchBy || "both",
          scope: body.scope || null
        }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "GET" && action === "services") {
        const result = await this.enqueueCommand(sessionId, "get_services", {}, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "POST" && action === "instance-info") {
        const body = await readJsonBody(request);
        const result = await this.enqueueCommand(sessionId, "get_instance_info", { path: body.path }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "GET" && action === "output-log") {
        const count = Math.min(Math.max(Number(requestUrl.searchParams.get("count")) || 50, 1), 200);
        const result = await this.enqueueCommand(sessionId, "get_output_log", { count }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "POST" && action === "modify-property") {
        const body = await readJsonBody(request);
        const result = await this.enqueueCommand(sessionId, "modify_property", {
          path: body.path,
          property: body.property,
          value: body.value
        }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "POST" && action === "create-instance") {
        const body = await readJsonBody(request);
        const result = await this.enqueueCommand(sessionId, "create_instance", {
          parentPath: body.parentPath,
          className: body.className,
          name: body.name || body.className,
          properties: body.properties || {}
        }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }

      if (request.method === "POST" && action === "delete-instance") {
        const body = await readJsonBody(request);
        const result = await this.enqueueCommand(sessionId, "delete_instance", { path: body.path }, true);
        jsonResponse(response, 200, { ok: true, result });
        return;
      }
    }

    // ===== Activity log endpoints =====
    if (request.method === "GET" && requestUrl.pathname === "/activity") {
      jsonResponse(response, 200, {
        ok: true,
        entries: this.activityLog.query({
          limit: Number(requestUrl.searchParams.get("limit") || 100),
          action: requestUrl.searchParams.get("action") || null,
          direction: requestUrl.searchParams.get("direction") || null,
          projectId: requestUrl.searchParams.get("projectId") || null
        })
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/activity/summary") {
      jsonResponse(response, 200, {
        ok: true,
        summary: this.activityLog.summary()
      });
      return;
    }

    // ===== Error Tracker endpoints =====
    if (request.method === "GET" && requestUrl.pathname === "/errors") {
      const filters = {};
      const severity = requestUrl.searchParams.get("severity");
      const component = requestUrl.searchParams.get("component");
      const resolved = requestUrl.searchParams.get("resolved");
      const code = requestUrl.searchParams.get("code");
      const limit = requestUrl.searchParams.get("limit");
      const since = requestUrl.searchParams.get("since");
      const sessionIdFilter = requestUrl.searchParams.get("sessionId");

      if (severity) filters.severity = severity;
      if (component) filters.component = component;
      if (resolved !== null && resolved !== undefined && resolved !== "") {
        filters.resolved = resolved === "true";
      }
      if (code) filters.code = code;
      if (limit) filters.limit = Number(limit);
      if (since) filters.since = since;
      if (sessionIdFilter) filters.sessionId = sessionIdFilter;

      const entries = this.errorTracker.query(filters);
      jsonResponse(response, 200, {
        ok: true,
        totalEntries: entries.length,
        entries
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/errors/summary") {
      jsonResponse(response, 200, {
        ok: true,
        summary: this.errorTracker.summary()
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/errors/add") {
      const body = await readJsonBody(request);
      const record = this.recordError(body);
      jsonResponse(response, 200, {
        ok: true,
        entry: record
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/errors/resolve") {
      const body = await readJsonBody(request);
      if (body.all === true) {
        const count = this.errorTracker.resolveAll();
        jsonResponse(response, 200, { ok: true, resolvedCount: count });
        return;
      }
      const entry = this.errorTracker.resolve(body.id);
      if (!entry) {
        jsonResponse(response, 404, { ok: false, error: "Entry not found." });
        return;
      }
      jsonResponse(response, 200, { ok: true, entry });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/errors/clear") {
      this.errorTracker.clear();
      jsonResponse(response, 200, { ok: true });
      return;
    }

    jsonResponse(response, 404, {
      ok: false,
      error: `Endpoint not found: ${request.method} ${requestUrl.pathname}`
    });
  }
}

module.exports = {
  PluginRobloxApp,
  hashSnapshot
};
