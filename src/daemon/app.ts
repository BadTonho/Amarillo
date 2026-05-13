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
const { McpAuditLog } = require("./lib/mcp-audit-log");
const { RateLimiter } = require("./lib/rate-limiter");
const { ensurePluginInstructionsFile } = require("./lib/instructions");
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
  jsonResponse,
  normalizeToken,
  readJsonBody,
  timingSafeEqualString
} = require("./http-utils");
const { handleTool: handleMcpTool } = require("./mcp");
const {
  createMcpShieldState,
  listTools,
  mcpShieldSummary,
  mcpToolResultToHttpPayload
} = require("./mcp-shield");
const {
  AMARILLO_PROTOCOL_VERSION,
  DAEMON_VERSION,
  MIN_PLUGIN_VERSION,
  isVersionAtLeast,
  normalizeProtocolVersion,
  normalizeVersion
} = require("./version");

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

function logSync(event, details: any = {}) {
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
const SYNC_COMMAND_TIMEOUT_MS = 30000;
const INITIAL_STUDIO_SYNC_REASON = "initial_accept";
const INITIAL_PC_SYNC_REASON = "initial_pc_truth";
const INITIAL_STUDIO_CONTACT_GRACE_MS = 5000;
const STUDIO_SESSION_STALE_MS = 30000;
const STUDIO_CONTACT_STALE_WARNING_MS = 35000;
const STUDIO_CONTACT_CRITICAL_MS = 65000;
const DEFAULT_AUTO_SYNC_TO_STUDIO = true;
const SYNC_COMMAND_TYPES = new Set(["apply_project_tree", "apply_file_patch"]);
const DESTRUCTIVE_ACTION_TYPES = new Set(["modify_property", "create_instance", "delete_instance", "insert_model"]);

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

function recentTimestamp(entries = []) {
  return entries
    .map((entry) => Date.parse(entry.timestamp || entry.at || entry.createdAt || ""))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => right - left)[0] || null;
}

function isInitialStudioSyncPending(session) {
  return (session?.connectionState || "ready") !== "ready"
    && session?.truthSource === "studio"
    && !session?.lastAppliedAt;
}

class PluginRobloxApp {
  [key: string]: any;
  workspaceRoot: string;
  host: string;
  port: number;
  strictPort: boolean;
  autoSyncToStudioExplicit: boolean;
  autoSyncToStudio: boolean;
  bridgeToken: string | null;
  extensionVersion: string | null;
  extensionProtocolVersion: number | null;
  initialStudioContactGraceMs: number;
  studioSessionStaleMs: number;
  httpServer: any;
  allProjects: any[];
  projects: any[];
  projectCatalogIssues: any[];
  config: any;
  defaultProjectId: string | null;
  sessions: Map<string, any>;
  connectionOffer: any;
  fileWatchers: any[];
  pendingStudioWrites: Map<string, any>;
  lastWorkspaceRefresh: string | null;
  lastDiskWriteTime: number | null;
  lastProjectIssueKeys: Set<any>;
  errorTracker: any;
  activityLog: any;
  mcpAuditLog: any;
  activityFileState: Map<string, any>;
  activityKnownFiles: Set<string>;
  mcpShield: any;
  recentUnauthorizedHttpRequests: Map<string, number>;
  rateLimiter: any;
  shuttingDown: boolean;

  constructor(options) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.host = options.host || "127.0.0.1";
    this.port = Number(options.port || 8323);
    this.strictPort = options.strictPort === true;
    this.autoSyncToStudioExplicit = options.autoSyncToStudio !== undefined;
    this.autoSyncToStudio = coerceBoolean(options.autoSyncToStudio, DEFAULT_AUTO_SYNC_TO_STUDIO);
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
    this.sessions = new Map<string, any>();
    this.connectionOffer = null;
    this.fileWatchers = [];
    this.pendingStudioWrites = new Map<string, any>();
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
    this.activityFileState = new Map<string, any>();
    this.activityKnownFiles = new Set<string>();
    this.mcpShield = createMcpShieldState();
    this.recentUnauthorizedHttpRequests = new Map<string, number>();
    this.rateLimiter = new RateLimiter({ maxRequests: 120, windowMs: 1000 });
    this.shuttingDown = false;
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
    if (request.method === "POST" && (
      requestUrl.pathname === "/connection/accept"
      || requestUrl.pathname === "/connection/decline"
      || requestUrl.pathname === "/connection/diff"
    )) {
      return true;
    }
    return false;
  }

  authorizeHttpRequest(request, requestUrl) {
    if (!this.bridgeToken || this.isPublicHttpRoute(request, requestUrl)) {
      return true;
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
    this.shuttingDown = true;

    // Stop accepting file-system events
    for (const watcher of this.fileWatchers) {
      watcher.close();
    }
    this.fileWatchers = [];

    // Wait for pending disk writes to finish (max 5s)
    if (this.pendingStudioWrites.size > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          const check = () => {
            if (this.pendingStudioWrites.size === 0) {
              resolve();
            } else {
              setTimeout(check, 100);
            }
          };
          check();
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000))
      ]);
    }

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

    if (this.httpServer) {
      this.httpServer.close();
      await once(this.httpServer, "close");
      this.httpServer = null;
    }
  }

  recordError(entry: any = {}) {
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

  recordMcpContact(source = "unknown", details: any = {}) {
    if (!this.mcpShield) {
      this.mcpShield = createMcpShieldState();
    }
    const now = new Date().toISOString();
    this.mcpShield.state = "ready";
    this.mcpShield.lastFailure = null;
    if (details.toolName) {
      this.mcpShield.lastTool = details.toolName;
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

  recordMcpFailure(source = "unknown", error: any, details: any = {}) {
    if (!this.mcpShield) {
      this.mcpShield = createMcpShieldState();
    }
    const message = error?.message || String(error || "Unknown MCP error.");
    const now = new Date().toISOString();
    this.mcpShield.state = "degraded";
    this.mcpShield.failureCount += 1;
    this.mcpShield.lastFailure = {
      at: now,
      source,
      toolName: details.toolName || null,
      route: details.route || null,
      message
    };
    this.recordError({
      component: "mcp",
      severity: "warning",
      code: details.code || "MCP-SHIELD",
      message,
      context: {
        source,
        toolName: details.toolName || null,
        route: details.route || null
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
        minimumPluginVersion: MIN_PLUGIN_VERSION
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

  updateSessionPluginVersion(session: any, metadata: any = {}) {
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
        requiresPluginUpdate: false
      };
    }
    if (!pluginVersion || pluginProtocolVersion === null) {
      return {
        state: "blocked",
        message: "Plugin update required: this Studio plugin did not report its Amarillo version/protocol.",
        requiresPluginUpdate: true
      };
    }
    if (pluginProtocolVersion !== AMARILLO_PROTOCOL_VERSION) {
      return {
        state: "blocked",
        message: `Plugin update required: plugin protocol ${pluginProtocolVersion} is incompatible with daemon protocol ${AMARILLO_PROTOCOL_VERSION}.`,
        requiresPluginUpdate: true
      };
    }
    if (!isVersionAtLeast(pluginVersion, MIN_PLUGIN_VERSION)) {
      return {
        state: "blocked",
        message: `Plugin update required: plugin version ${pluginVersion} is older than ${MIN_PLUGIN_VERSION}. Reinstall the Amarillo plugin and reload Roblox Studio.`,
        requiresPluginUpdate: true
      };
    }
    return {
      state: "compatible",
      message: "Plugin protocol is compatible.",
      requiresPluginUpdate: false
    };
  }

  isSessionVersionBlocked(session) {
    return this.sessionVersionStatus(session).state === "blocked";
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

  destructiveActionPolicy(session, action = "destructive action") {
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
    const contact = this.studioContactStatus(session);
    if (contact.state === "critical") {
      return {
        allowed: false,
        blocked: true,
        reasonCode: "STUDIO_CONTACT_CRITICAL",
        message: `${action} blocked: ${contact.message} Wait for Roblox Studio to reconnect before applying destructive changes.`
      };
    }
    if (contact.state === "stale") {
      return {
        allowed: false,
        blocked: true,
        reasonCode: "STUDIO_CONTACT_STALE",
        message: `${action} blocked: ${contact.message} Wait for a fresh Studio poll before applying destructive changes.`
      };
    }
    return {
      allowed: true,
      blocked: false,
      reasonCode: null,
      message: "Destructive actions are allowed."
    };
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
      const error: any = new Error(`${action} blocked: ${reason}`);
      error.statusCode = 409;
      error.code = "SYNC-BLOCKED";
      throw error;
    }
  }

  recordMcpAudit(entry: any = {}) {
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
    this.defaultProjectId = this.resolveDefaultProjectId(previousDefaultProjectId);
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
    for (const project of this.allProjects) {
      for (const mount of project.mounts || []) {
        for (const filePath of collectFilesRecursive(mount.absolutePath)) {
          this.activityKnownFiles.add(normalizeFsPath(filePath));
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

  recordActivity(change: any = {}, defaults: any = {}) {
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
      this.activityKnownFiles.delete(normalized);
    } else {
      this.activityKnownFiles.add(normalized);
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

  recordWorkspaceFileActivity(filePath, defaults: any = {}) {
    const normalized = normalizeFsPath(filePath);
    const context = this.findMountedFileContext(normalized);
    if (!context) {
      return null;
    }

    const previousInfo = this.activityFileState.get(normalized) || null;
    const wasKnown = this.activityKnownFiles.has(normalized);
    const nextInfo = getFileInfo(normalized);
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
    session._pollWaiter = null;
  }

  reclaimStudioSession(session: any, selection: any, placeId, options: any = {}) {
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
    session.requirePluginVersion = options.requirePluginVersion === true;
    session.pluginVersion = normalizeVersion(options.pluginVersion);
    session.pluginProtocolVersion = normalizeProtocolVersion(options.pluginProtocolVersion);
    session.lastPluginVersionSeenAt = session.pluginVersion || session.pluginProtocolVersion !== null
      ? new Date().toISOString()
      : null;
    session.lastCommandError = null;
    session.sync = createSyncState();
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

  scheduleProjectTreeApply(session, project, reason, changedPath = null, debounceMs = PROJECT_TREE_DEBOUNCE_MS, allowWhenDegraded = false) {
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
      if (this.isSessionSyncBlocked(session)) {
        logSync("enqueue_apply_file_patch_skipped", {
          sessionId: session.id,
          reason: "sync_degraded",
          path: patchKey,
          degradedReason: session.sync?.degradedReason || null
        });
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

  resolveConnectionOffer(status, details: any = {}) {
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

  openSession(placeId, preferredProjectId = null, options: any = {}) {
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
      }
      return {
        session: existing,
        project
      };
    }
    const session: any = {
      id: crypto.randomUUID(),
      sessionToken: this.createSessionToken(),
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
      sync: createSyncState(),
      connectionState: options.connectionState || "ready",
      truthSource: options.truthSource || null,
      studioInstanceId: options.studioInstanceId || null,
      requirePluginVersion: options.requirePluginVersion === true,
      pluginVersion: normalizeVersion(options.pluginVersion),
      pluginProtocolVersion: normalizeProtocolVersion(options.pluginProtocolVersion),
      lastPluginVersionSeenAt: null,
      lastCommandError: null,
      projectSelectionReason: selection.reason,
      projectSelectionMessage: selection.message,
      _pollWaiter: null
    };
    if (session.pluginVersion || session.pluginProtocolVersion !== null) {
      session.lastPluginVersionSeenAt = new Date().toISOString();
    }
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
    truthSource = "pc",
    pluginVersion = null,
    pluginProtocolVersion = null,
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
    const initialConnectionState = "accepted";
    let sessionResult;
    try {
      sessionResult = this.openSession(placeId, projectId, {
        connectionState: initialConnectionState,
        truthSource: normalizedTruthSource,
        studioInstanceId,
        pluginVersion,
        pluginProtocolVersion,
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

  markSyncDegraded(session, reason, details: any = {}) {
    const sync = this.ensureSessionSyncState(session);
    const message = String(reason || "Sync verification failed.");
    const timestamp = new Date().toISOString();
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
        observedHash: details.observedHash || null
      }
    });
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

  cacheStudioSnapshot(session, snapshot, reason = "command_verified") {
    const normalized = {
      ...snapshot,
      mounts: (snapshot.mounts || []).map((mount) => ({
        ...mount,
        children: mount.children || []
      }))
    };
    const snapshotHash = hashSnapshot(normalized);
    session.lastStudioSnapshot = normalized;
    session.lastStudioHash = snapshotHash;
    session.lastStudioSeenAt = new Date().toISOString();
    logSync("studio_snapshot_cached", {
      sessionId: session.id,
      reason,
      snapshotHash
    });
    return snapshotHash;
  }

  startSyncCommandGuard(session, command, timeoutMs = SYNC_COMMAND_TIMEOUT_MS) {
    if (!isSyncCommandType(command.type)) {
      return;
    }
    command.syncGuardTimer = setTimeout(() => {
      command.syncGuardTimer = null;
      this.removePendingSyncCommand(session, command.id);
      this.markSyncDegraded(session, `Timed out waiting for Studio confirmation for ${command.type}.`, {
        code: "SYNC-TIMEOUT",
        commandId: command.id,
        commandType: command.type,
        expectedHash: command.expectedHash || null
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
    timeoutMs = waitForResult ? COMMAND_RESULT_TIMEOUT_MS : SYNC_COMMAND_TIMEOUT_MS
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    if (isSyncCommandType(type) && this.isSessionVersionBlocked(session)) {
      const error: any = new Error(`${type} blocked: ${this.syncBlockedReason(session)}`);
      error.statusCode = 409;
      error.code = "VERSION-BLOCKED";
      throw error;
    }
    if (type === "apply_project_tree") {
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
    const command: any = {
      id: crypto.randomUUID(),
      type,
      payload
    };
    if (type === "apply_project_tree" && payload?.project) {
      command.expectedHash = hashSnapshot(payload.project);
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
      commands: commands.map((command) => ({
        id: command.id,
        type: command.type,
        payload: command.payload
      })),
      session: {
        id: session.id,
        placeId: session.placeId,
        projectId: session.projectId,
        lastStudioSeenAt: session.lastStudioSeenAt,
        lastAppliedAt: session.lastAppliedAt,
        syncState: this.ensureSessionSyncState(session).state,
        syncMessage: this.syncMessage(session),
        requiresManualResync: this.ensureSessionSyncState(session).state === "degraded",
        versionState: this.sessionVersionStatus(session).state,
        versionMessage: this.sessionVersionStatus(session).message,
        requiresPluginUpdate: this.sessionVersionStatus(session).requiresPluginUpdate,
        syncBlockedReason: this.syncBlockedReason(session)
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
          this.updateStudioSnapshot(sessionId, payload.snapshot, "apply_project_tree_corrected");
          this.markSyncVerified(session, session.lastStudioHash);
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
          const observedHash = this.cacheStudioSnapshot(session, payload.snapshot, "apply_file_patch_verified");
          this.markSyncVerified(session, observedHash);
        } else if (payload?.appliedHash) {
          this.markSyncVerified(session, String(payload.appliedHash));
        } else {
          this.markSyncDegraded(session, "Studio confirmed apply_file_patch without a verification snapshot or hash.", {
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

  updateStudioSnapshot(sessionId, snapshot, reason = "auto") {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Studio session not found.");
    }
    if (this.isSessionVersionBlocked(session)) {
      const reason = this.syncBlockedReason(session);
      const error: any = new Error(`Studio snapshot write blocked: ${reason}`);
      error.statusCode = 409;
      error.code = "VERSION-BLOCKED";
      throw error;
    }
    const nextHash = hashSnapshot({
      ...snapshot,
      mounts: (snapshot.mounts || []).map((mount) => ({
        ...mount,
        children: mount.children || []
      }))
    });
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
    this.cacheStudioSnapshot(session, snapshot, reason);
    this.ensureSessionSyncState(session).lastObservedHash = nextHash;

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
        this.markSyncDegraded(session, `Failed to write Studio snapshot to disk: ${error.message}`, {
          code: "DISK-WRITE",
          observedHash: session.lastStudioHash || null
        });
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
      if (reason === "manual" || reason === INITIAL_STUDIO_SYNC_REASON) {
        this.markSyncVerified(session, session.lastStudioHash);
      }
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
      if (this.isSessionVersionBlocked(session)) {
        this.cacheStudioSnapshot(session, result.snapshot, "manual_readonly");
      } else {
        this.updateStudioSnapshot(sessionId, result.snapshot, "manual");
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

  async runStudioCode(sessionId, code) {
    const result = await this.enqueueCommand(sessionId, "run_code", { code }, true);
    if (!result.ok) {
      throw new Error(result.error || "Luau execution failed.");
    }
    return result;
  }

  normalizeDestructiveCommandResult(session, result: any = {}) {
    const normalized: any = result && typeof result === "object"
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

  sessionSummary(session, options: any = {}) {
    const project = this.getProjectById(session.projectId);
    const sync = this.ensureSessionSyncState(session);
    const version = this.sessionVersionStatus(session);
    const syncBlockedReason = this.syncBlockedReason(session);
    const contact = this.studioContactStatus(session);
    const destructive = this.destructiveActionPolicy(session);
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
      syncBlockedReason,
      projectSelectionReason: session.projectSelectionReason || null,
      projectSelectionMessage: session.projectSelectionMessage || null,
      placeId: session.placeId,
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
      lastCommandError: session.lastCommandError || null,
      destructiveActionsAllowed: destructive.allowed,
      destructiveActionReasonCode: destructive.reasonCode,
      destructiveActionMessage: destructive.allowed ? null : destructive.message
    };
  }

  doctorReport() {
    const sessions = Array.from(this.sessions.values()).map((session) => this.sessionSummary(session));
    const versions = this.versionPayload();
    const mcp = mcpShieldSummary(this);
    const errors = this.errorTracker.summary();
    const recentUnresolvedErrors = this.errorTracker.query({ resolved: false, limit: 5 });
    const activity = this.activityLog.summary();
    const mcpAudit = this.mcpAuditLog.summary();
    const blockedReasons = [];
    const warnings = [];

    if (this.projects.length === 0) {
      blockedReasons.push("No enabled .project.json was found in this workspace.");
    }
    if (versions.extension.state === "blocked") {
      blockedReasons.push(versions.extension.message);
    }
    for (const session of sessions) {
      if (isInitialStudioSyncPending(session)) {
        warnings.push(`${session.projectName}: initial Studio sync is still accepted but no Studio snapshot has been applied yet.`);
      }
      if (session.requiresPluginUpdate) {
        blockedReasons.push(`${session.projectName}: ${session.versionMessage}`);
      }
      if (session.requiresManualResync) {
        blockedReasons.push(`${session.projectName}: ${session.lastSyncError || "Sync degraded."}`);
      }
      if (session.studioContactState === "stale" || session.studioContactState === "critical") {
        warnings.push(`${session.projectName}: ${session.studioContactMessage}`);
      }
    }

    if (sessions.length === 0) {
      warnings.push("No active Studio session is connected.");
    }
    if (mcp.state !== "ready") {
      warnings.push(`MCP is ${mcp.state}: ${mcp.message}`);
    }
    if (errors.unresolved > 0 && blockedReasons.length === 0) {
      warnings.push(`${errors.unresolved} unresolved diagnostic error(s) are recorded.`);
    }

    const status = blockedReasons.length > 0
      ? "blocked"
      : (warnings.length > 0 ? "warning" : "ok");
    const recommendations = [];
    if (sessions.some((session) => session.requiresPluginUpdate)) {
      recommendations.push("Run Amarillo: Install Roblox Studio Plugin, then reload the plugin in Roblox Studio.");
    }
    if (sessions.some((session) => session.requiresManualResync)) {
      recommendations.push("Run a manual resync after checking the sync paused message.");
    }
    if (this.projects.length === 0) {
      recommendations.push("Create or select a valid .project.json for this workspace.");
    }
    if (mcp.state !== "ready") {
      recommendations.push("Run Amarillo: Configure MCP for Workspace and reopen the AI/MCP client session.");
    }
    if (sessions.length === 0) {
      recommendations.push("Open Roblox Studio and connect the Amarillo plugin.");
    }
    if (recommendations.length === 0) {
      recommendations.push("No action required.");
    }

    return {
      ok: status !== "blocked",
      status,
      generatedAt: new Date().toISOString(),
      summary: {
        message: status === "ok"
          ? "Amarillo Doctor did not find blocking issues."
          : (status === "blocked" ? "Amarillo Doctor found blocking issues." : "Amarillo Doctor found warnings."),
        blockedReasons,
        warnings,
        projectCount: this.projects.length,
        sessionCount: sessions.length,
        syncBlockedSessionCount: sessions.filter((session) => session.syncBlockedReason).length,
        unresolvedErrorCount: errors.unresolved,
        initialSyncStuckSessionCount: sessions.filter(isInitialStudioSyncPending).length,
        mcpAuditCount: mcpAudit.total
      },
      versions,
      compatibility: {
        protocolVersion: AMARILLO_PROTOCOL_VERSION,
        extensionState: versions.extension.state,
        blockedSessionIds: sessions.filter((session) => session.requiresPluginUpdate).map((session) => session.id)
      },
      workspace: {
        root: this.workspaceRoot,
        host: this.host,
        port: this.port,
        projectCount: this.projects.length,
        defaultProjectId: this.defaultProjectId,
        refreshedAt: this.lastWorkspaceRefresh
      },
      sessions,
      sync: {
        autoSyncToStudio: this.autoSyncToStudio,
        lastDiskWriteTime: this.lastDiskWriteTime,
        degradedSessionIds: sessions.filter((session) => session.requiresManualResync).map((session) => session.id),
        blockedSessionIds: sessions.filter((session) => session.syncBlockedReason).map((session) => session.id)
      },
      mcp,
      errors: {
        ...errors,
        recentUnresolved: recentUnresolvedErrors,
        lastErrorAt: recentTimestamp(errors.recent)
      },
      activity: {
        ...activity,
        lastActivityAt: recentTimestamp(activity.recent)
      },
      mcpAudit: {
        ...mcpAudit,
        lastToolAt: mcpAudit.lastTool?.timestamp || null,
        lastFailureOrDeclineAt: mcpAudit.lastFailureOrDecline?.timestamp || null
      },
      recommendations
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
  hashSnapshot
};



