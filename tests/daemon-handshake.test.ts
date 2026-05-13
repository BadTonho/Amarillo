"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { PluginRobloxApp } = require("../src/daemon/app");
const { readLocalProjectState } = require("../src/daemon/project");

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-daemon-"));
}

function createWorkspaceWithProject() {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "sync", "ServerScriptService"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "sync/ServerScriptService"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "return 1", "utf8");
  return workspace;
}

function createWorkspaceWithInheritedProjects() {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "shared", "ServerScriptService"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "places", "Lobby", "ReplicatedStorage"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "places", "Dungeon", "ReplicatedStorage"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "shared", "ServerScriptService", "Common.server.luau"), "return 'shared'", "utf8");
  fs.writeFileSync(path.join(workspace, "places", "Lobby", "ReplicatedStorage", "Lobby.server.luau"), "return 'lobby'", "utf8");
  fs.writeFileSync(path.join(workspace, "places", "Dungeon", "ReplicatedStorage", "Dungeon.server.luau"), "return 'dungeon'", "utf8");
  fs.writeFileSync(path.join(workspace, "Base.project.json"), JSON.stringify({
    name: "Base",
    abstract: true,
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "shared/ServerScriptService"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Lobby.project.json"), JSON.stringify({
    name: "Lobby",
    extends: "Base.project.json",
    place_ids: [101],
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "places/Lobby/ReplicatedStorage"
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Dungeon.project.json"), JSON.stringify({
    name: "Dungeon",
    extends: "Base.project.json",
    place_ids: [202],
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: "places/Dungeon/ReplicatedStorage"
      }
    }
  }, null, 2));
  return workspace;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type InvokeOptions = {
  rawBody?: string;
  headers?: Record<string, string>;
};

type InvokeResult = {
  statusCode: number;
  headers: Record<string, string>;
  payload: any;
};

function seedStudioSnapshotFromLocalProject(app, session) {
  app.recordAppliedProjectSnapshot(
    session,
    readLocalProjectState(app.getProjectById(session.projectId)),
    "test_seed"
  );
}

function findSnapshotNodeByPath(snapshot, segments) {
  for (const mount of snapshot.mounts || []) {
    const mountSegments = mount.segments || [];
    if (!mountSegments.every((segment, index) => segments[index] === segment)) {
      continue;
    }
    let children = mount.children || [];
    let node = null;
    for (const segment of segments.slice(mountSegments.length)) {
      node = children.find((child) => child.name === segment) || null;
      if (!node) {
        return null;
      }
      children = node.children || [];
    }
    return node;
  }
  return null;
}

async function invoke(app, method, url, body?: any, options: InvokeOptions = {}): Promise<InvokeResult> {
  const request: any = options.rawBody !== undefined
    ? Readable.from([Buffer.from(options.rawBody, "utf8")])
    : (body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body), "utf8")]));
  request.method = method;
  request.url = url;
  request.headers = {
    host: "127.0.0.1:8323",
    ...(options.headers || {})
  };

  return new Promise<InvokeResult>((resolve, reject) => {
    let statusCode = 200;
    let responseHeaders: Record<string, string> = {};
    let responseBody = "";
    const response: any = {
      writeHead(code, headers = {}) {
        statusCode = code;
        responseHeaders = headers;
      },
      end(chunk = "") {
        responseBody += chunk;
        resolve({
          statusCode,
          headers: responseHeaders,
          payload: responseBody ? JSON.parse(responseBody) : {}
        });
      }
    };

    app.handleHttp(request, response).catch(reject);
  });
}

test("daemon JSON responses disable network caching", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323
  });
  app.refreshWorkspace();

  const health = await invoke(app, "GET", "/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.headers["Cache-Control"], "no-store, no-cache, must-revalidate, proxy-revalidate");
  assert.equal(health.headers.Pragma, "no-cache");
  assert.equal(health.headers.Expires, "0");
});

test("daemon rejects new HTTP requests while shutting down", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323
  });
  app.refreshWorkspace();
  app.shuttingDown = true;

  const response = await invoke(app, "GET", "/health");
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.error, "Daemon is shutting down.");
  assert.equal(response.headers["Cache-Control"], "no-store, no-cache, must-revalidate, proxy-revalidate");
});

test("daemon rate limits runaway HTTP clients before route dispatch", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323
  });
  app.refreshWorkspace();
  app.rateLimiter = {
    isLimited() {
      return true;
    }
  };

  const response = await invoke(app, "GET", "/health");
  assert.equal(response.statusCode, 429);
  assert.equal(response.payload.error, "Too many requests. Try again shortly.");
  assert.equal(response.headers["Cache-Control"], "no-store, no-cache, must-revalidate, proxy-revalidate");
});

test("bridge token protects administrative and MCP HTTP routes", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "secret-token"
  });
  app.refreshWorkspace();

  const publicHealth = await invoke(app, "GET", "/health");
  assert.equal(publicHealth.statusCode, 200);

  const authHelp = await invoke(app, "GET", "/mcp/auth-help");
  assert.equal(authHelp.statusCode, 200);
  assert.equal(authHelp.payload.expectedHeader, "X-Amarillo-Bridge-Token");
  assert.ok(authHelp.payload.acceptedHeaders.includes("Authorization: Bearer <bridge token>"));

  const publicDiff = await invoke(app, "POST", "/connection/diff", {
    projectId: "Game.project.json",
    truthSource: "pc",
    studioSnapshot: { mounts: [] }
  });
  assert.equal(publicDiff.statusCode, 200);
  assert.equal(publicDiff.payload.ok, true);

  const missingToken = await invoke(app, "POST", "/mcp/call", {
    name: "health",
    arguments: {}
  });
  assert.equal(missingToken.statusCode, 401);
  assert.equal(missingToken.payload.code, "UNAUTHORIZED");
  assert.equal(missingToken.payload.expectedHeader, "X-Amarillo-Bridge-Token");
  assert.match(missingToken.payload.hint, /Authorization: Bearer <bridge token>/);

  const invalidToken = await invoke(app, "POST", "/mcp/call", {
    name: "health",
    arguments: {}
  }, {
    headers: {
      "x-amarillo-bridge-token": "wrong-token"
    }
  });
  assert.equal(invalidToken.statusCode, 401);

  const authErrors = app.errorTracker.query({ resolved: false, code: "HTTP-UNAUTHORIZED", limit: 5 });
  assert.ok(authErrors.length >= 1);
  assert.equal(authErrors[0].context.expectedHeader, "X-Amarillo-Bridge-Token");
  assert.equal(authErrors[0].context.help.publicHelpUrl, "/mcp/auth-help");

  const authorized = await invoke(app, "POST", "/mcp/call", {
    name: "health",
    arguments: {}
  }, {
    headers: {
      "x-amarillo-bridge-token": "secret-token"
    }
  });
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.payload.ok, true);

  const bearerAuthorized = await invoke(app, "GET", "/mcp/status", undefined, {
    headers: {
      authorization: "Bearer secret-token"
    }
  });
  assert.equal(bearerAuthorized.statusCode, 200);
  assert.equal(bearerAuthorized.payload.ok, true);
  assert.equal(bearerAuthorized.payload.mcp.fallback.example.headers["X-Amarillo-Bridge-Token"], "<bridge token>");
  assert.match(bearerAuthorized.payload.mcp.fallback.example.alternativeAuthorizationHeader, /Authorization: Bearer/);
});

test("daemon returns standard JSON errors for invalid or oversized bodies", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "secret-token"
  });
  app.refreshWorkspace();

  const invalidJson = await invoke(app, "POST", "/mcp/call", null, {
    rawBody: "{invalid-json",
    headers: {
      "x-amarillo-bridge-token": "secret-token"
    }
  });
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(invalidJson.payload.code, "INVALID_JSON");

  const oversized = await invoke(app, "POST", "/mcp/call", null, {
    rawBody: JSON.stringify({ data: "x".repeat(1024 * 1024 + 1) }),
    headers: {
      "x-amarillo-bridge-token": "secret-token"
    }
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.payload.code, "BODY_TOO_LARGE");
});

test("Studio sync routes accept snapshots larger than the generic JSON limit", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "secret-token"
  });
  app.refreshWorkspace();

  const largeSource = `return [[${"x".repeat(1024 * 1024 + 4096)}]]`;
  const largeSnapshot = {
    mounts: [
      {
        id: "ServerScriptService",
        children: [
          {
            name: "Large",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: largeSource,
            properties: {},
            children: []
          }
        ]
      }
    ]
  };

  const diff = await invoke(app, "POST", "/connection/diff", {
    projectId: "Game.project.json",
    truthSource: "studio",
    studioSnapshot: largeSnapshot
  });
  assert.equal(diff.statusCode, 200);
  assert.equal(diff.payload.ok, true);

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-large-snapshot",
    placeId: 0,
    truthSource: "studio",
    pluginVersion: "1.0.23",
    pluginProtocolVersion: 1
  });
  assert.equal(accept.statusCode, 200);

  const snapshot = await invoke(app, "POST", "/studio/snapshot", {
    sessionId: accept.payload.session.id,
    reason: "initial_accept",
    pluginVersion: "1.0.23",
    pluginProtocolVersion: 1,
    snapshot: largeSnapshot
  }, {
    headers: {
      "x-amarillo-session-token": accept.payload.session.sessionToken
    }
  });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.payload.ok, true);
});

test("Studio sessions receive and must use a session token after handshake", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "secret-token"
  });
  app.refreshWorkspace();

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-secure",
    placeId: 0,
    truthSource: "pc",
    pluginVersion: "1.0.17",
    pluginProtocolVersion: 1
  });
  assert.equal(accept.statusCode, 200);
  const sessionId = accept.payload.session.id;
  const sessionToken = accept.payload.session.sessionToken;
  assert.equal(typeof sessionToken, "string");

  const missingToken = await invoke(app, "GET", `/studio/poll?sessionId=${sessionId}`);
  assert.equal(missingToken.statusCode, 401);

  const validToken = await invoke(app, "GET", `/studio/poll?sessionId=${sessionId}`, undefined, {
    headers: {
      "x-amarillo-session-token": sessionToken
    }
  });
  assert.equal(validToken.statusCode, 200);
  assert.equal(validToken.payload.ok, true);
  assert.equal(validToken.payload.commands.length, 1);

  const invalidSessionRoute = await invoke(app, "GET", `/session/${sessionId}/status`, undefined, {
    headers: {
      "x-amarillo-session-token": "wrong-token"
    }
  });
  assert.equal(invalidSessionRoute.statusCode, 401);

  const validSessionRoute = await invoke(app, "GET", `/session/${sessionId}/status`, undefined, {
    headers: {
      "x-amarillo-session-token": sessionToken
    }
  });
  assert.equal(validSessionRoute.statusCode, 200);
  assert.equal(validSessionRoute.payload.ok, true);

  const invalidClose = await invoke(app, "POST", "/session/close", {
    sessionId
  }, {
    headers: {
      "x-amarillo-session-token": "wrong-token"
    }
  });
  assert.equal(invalidClose.statusCode, 401);

  const validClose = await invoke(app, "POST", "/session/close", {
    sessionId
  }, {
    headers: {
      "x-amarillo-session-token": sessionToken
    }
  });
  assert.equal(validClose.statusCode, 200);
  assert.equal(validClose.payload.ok, true);
});

test("unauthorized initial Studio snapshot is recorded as a diagnostic error", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "secret-token"
  });
  app.refreshWorkspace();

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-snapshot-auth",
    placeId: 0,
    truthSource: "studio",
    pluginVersion: "1.0.19",
    pluginProtocolVersion: 1
  });
  assert.equal(accept.statusCode, 200);
  const sessionId = accept.payload.session.id;

  const rejected = await invoke(app, "POST", "/studio/snapshot", {
    sessionId,
    reason: "initial_accept",
    pluginVersion: "1.0.19",
    pluginProtocolVersion: 1,
    snapshot: { mounts: [] }
  });

  assert.equal(rejected.statusCode, 401);
  assert.equal(rejected.payload.code, "UNAUTHORIZED");

  const session = app.sessions.get(sessionId);
  assert.equal(session.lastCommandError, "Missing or invalid Studio session token.");

  const errors = app.errorTracker.query({ resolved: false, code: "STUDIO-SNAPSHOT-AUTH", limit: 1 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].sessionId, sessionId);
  assert.equal(errors[0].projectId, "Game.project.json");
  assert.equal(errors[0].context.route, "/studio/snapshot");
  assert.equal(errors[0].context.statusCode, 401);
  assert.equal(errors[0].context.reason, "initial_accept");
  assert.equal(errors[0].context.truthSource, "studio");
  assert.equal(errors[0].context.hasSessionToken, false);
});

test("Doctor includes unresolved diagnostics and accepted Studio initial sync warnings", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const { session } = app.openSession(0, null, {
    connectionState: "accepted",
    truthSource: "studio",
    studioInstanceId: "studio-stuck",
    pluginVersion: "1.0.19",
    pluginProtocolVersion: 1,
    requirePluginVersion: true
  });
  app.recordError({
    component: "studio",
    severity: "error",
    code: "STUDIO-SNAPSHOT-AUTH",
    message: "Missing or invalid Studio session token.",
    sessionId: session.id,
    projectId: session.projectId,
    context: {
      route: "/studio/snapshot",
      statusCode: 401,
      reason: "initial_accept",
      hasSessionToken: false
    }
  });

  const report = app.doctorReport();
  assert.equal(report.summary.initialSyncStuckSessionCount, 1);
  assert.ok(report.summary.warnings.some((warning) => /initial Studio sync is still accepted/.test(warning)));
  assert.equal(report.errors.recentUnresolved.length, 1);
  assert.equal(report.errors.recentUnresolved[0].code, "STUDIO-SNAPSHOT-AUTH");
  assert.equal(report.sessions[0].connectionState, "accepted");
  assert.equal(report.sessions[0].lastCommandError, null);
});

test("session open no longer auto-enqueues apply_project_tree on session_opened", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const { session } = app.openSession(0, null);

  assert.equal(session.pendingCommands.length, 0);
  assert.equal(session.connectionState, "ready");
});

test("stale studio session can be reclaimed by a new Studio window", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    initialStudioContactGraceMs: 5,
    studioSessionStaleMs: 20
  });
  app.refreshWorkspace();

  const first = app.acceptConnection({
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "pc"
  });
  assert.equal(first.ok, true);
  assert.equal(first.session.pendingCommands.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = app.acceptConnection({
    studioInstanceId: "studio-b",
    placeId: 0,
    truthSource: "pc"
  });
  assert.equal(second.ok, true);
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.session.studioInstanceId, "studio-b");
  assert.equal(second.session.pendingCommands.length, 1);
  assert.equal(second.session.pendingCommands[0].payload.reason, "initial_pc_truth");
});

test("active studio session still blocks a second Studio window", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    initialStudioContactGraceMs: 5,
    studioSessionStaleMs: 100
  });
  app.refreshWorkspace();

  const first = app.acceptConnection({
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "pc"
  });
  assert.equal(first.ok, true);

  await invoke(app, "GET", `/studio/poll?sessionId=${first.session.id}`);

  const second = app.acceptConnection({
    studioInstanceId: "studio-b",
    placeId: 0,
    truthSource: "pc"
  });
  assert.equal(second.ok, false);
  assert.match(second.error, /another Roblox Studio window/);
});

test("connection offer can be requested, polled without session and declined", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const offerResponse = await invoke(app, "POST", "/connection/request", { requestedBy: "test" });
  assert.equal(offerResponse.statusCode, 200);
  assert.equal(offerResponse.payload.offer.status, "pending");

  const pollResponse = await invoke(app, "GET", "/studio/poll");
  assert.equal(pollResponse.statusCode, 200);
  assert.equal(pollResponse.payload.mode, "offer");
  assert.equal(pollResponse.payload.offer.offerId, offerResponse.payload.offer.offerId);

  const declineResponse = await invoke(app, "POST", "/connection/decline", {
    offerId: offerResponse.payload.offer.offerId,
    studioInstanceId: "studio-a"
  });
  assert.equal(declineResponse.statusCode, 200);
  assert.equal(declineResponse.payload.offer.status, "declined");
});

test("connection request defaults requestedBy to vscode", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const response = await invoke(app, "POST", "/connection/request", {});

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.offer.requestedBy, "vscode");
});

test("connection accept with a minimal body still creates a session", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const response = await invoke(app, "POST", "/connection/accept", {});

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(typeof response.payload.session.id, "string");
  assert.equal(response.payload.session.placeId, 0);
  assert.equal(response.payload.session.truthSource, "pc");
  assert.equal(app.sessions.size, 1);
});

test("connection accept normalizes an invalid truthSource to pc", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const response = await invoke(app, "POST", "/connection/accept", {
    truthSource: "invalid",
    pluginVersion: "1.0.17",
    pluginProtocolVersion: 1
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.session.truthSource, "pc");
  const session = Array.from(app.sessions.values())[0] as any;
  assert.equal(session.truthSource, "pc");
  assert.equal(session.pendingCommands[0].payload.reason, "initial_pc_truth");
});

test("connection diff returns 404 for an unknown project", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const response = await invoke(app, "POST", "/connection/diff", {
    projectId: "missing-project"
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error, "Project not found");
});

test("connection diff auto-resolves the project when Studio has not selected one", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const response = await invoke(app, "POST", "/connection/diff", {
    placeId: 0,
    truthSource: "studio",
    studioSnapshot: { mounts: [] }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.ok(Array.isArray(response.payload.changes));
});

test("first studio acceptance wins and creates a pending PC-truth initial sync", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const offer = app.beginConnectionOffer("test");
  const acceptResponse = await invoke(app, "POST", "/connection/accept", {
    offerId: offer.offerId,
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "pc",
    pluginVersion: "1.0.16",
    pluginProtocolVersion: 1
  });
  assert.equal(acceptResponse.statusCode, 200);
  assert.equal(acceptResponse.payload.session.connectionState, "accepted");
  assert.equal(acceptResponse.payload.offer.status, "accepted");

  const session = Array.from(app.sessions.values())[0] as any;
  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].payload.reason, "initial_pc_truth");

  const secondAccept = await invoke(app, "POST", "/connection/accept", {
    offerId: offer.offerId,
    studioInstanceId: "studio-b",
    placeId: 0,
    truthSource: "pc"
  });
  assert.equal(secondAccept.statusCode, 409);
  assert.equal(secondAccept.payload.offer.status, "accepted");
});

test("HTTP connection accept blocks old plugins that do not report a version", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const offer = app.beginConnectionOffer("test");
  const response = await invoke(app, "POST", "/connection/accept", {
    offerId: offer.offerId,
    studioInstanceId: "studio-old",
    placeId: 0,
    truthSource: "pc"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.session.versionState, "blocked");
  assert.equal(response.payload.session.requiresPluginUpdate, true);
  assert.match(response.payload.session.versionMessage, /Plugin update required/);

  const session = Array.from(app.sessions.values())[0] as any;
  assert.equal(session.pendingCommands.length, 0);
});

test("HTTP connection accept blocks incompatible plugin protocol versions", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const offer = app.beginConnectionOffer("test");
  const response = await invoke(app, "POST", "/connection/accept", {
    offerId: offer.offerId,
    studioInstanceId: "studio-old",
    placeId: 0,
    truthSource: "pc",
    pluginVersion: "0.0.1",
    pluginProtocolVersion: 999
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.session.versionState, "blocked");
  assert.equal(response.payload.session.requiresPluginUpdate, true);
  assert.equal((Array.from(app.sessions.values())[0] as any).pendingCommands.length, 0);
});

test("PC truth becomes ready after the Studio completes the initial apply", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const result = app.acceptConnection({
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "pc"
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.connectionState, "accepted");

  const dequeued = app.dequeueCommands(result.session.id);
  assert.equal(dequeued.commands.length, 1);
  assert.equal(dequeued.commands[0].payload.reason, "initial_pc_truth");

  app.completeCommand(result.session.id, dequeued.commands[0].id, {
    ok: true,
    result: "Snapshot aplicado"
  });

  const session = app.sessions.get(result.session.id) as any;
  assert.equal(session.connectionState, "ready");
  assert.ok(session.lastStudioSnapshot);
});

test("failed initial PC sync can be retried by the same Studio window", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const first = app.acceptConnection({
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "pc"
  });
  const firstCommand = app.dequeueCommands(first.session.id).commands[0];
  app.rejectCommand(first.session.id, firstCommand.id, "Initial apply failed.");

  assert.equal(first.session.connectionState, "error");
  assert.equal(first.session.lastCommandError, "Initial apply failed.");

  const retry = app.acceptConnection({
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "pc"
  });

  assert.equal(retry.ok, true);
  assert.equal(retry.session.id, first.session.id);
  assert.equal(retry.session.connectionState, "accepted");
  assert.equal(retry.session.lastCommandError, null);
  assert.equal(retry.session.inFlightCommands.size, 0);
  assert.equal(retry.session.pendingCommands.length, 1);
  assert.equal(retry.session.pendingCommands[0].payload.reason, "initial_pc_truth");
});

test("corrected apply snapshot replaces assumed daemon cache and writes metadata", async () => {
  const workspace = createWorkspaceWithProject();
  fs.mkdirSync(path.join(workspace, "sync", "ServerScriptService", "ImplicitGui"), { recursive: true });
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: readLocalProjectState(project),
    reason: "manual_pull"
  });

  const command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, {
    ok: true,
    result: "Snapshot aplicado",
    snapshot: {
      mounts: [
        {
          id: "ServerScriptService",
          segments: ["ServerScriptService"],
          children: [
            {
              name: "Hello",
              className: "Script",
              classNameSource: "studio",
              fileKind: "server",
              ext: ".server.luau",
              source: "return 1",
              properties: {},
              children: []
            },
            {
              name: "ImplicitGui",
              className: "ScreenGui",
              classNameSource: "studio",
              properties: {},
              children: []
            }
          ]
        }
      ]
    }
  });

  assert.equal(session.lastStudioSnapshot.mounts[0].children[1].className, "ScreenGui");
  await wait(350);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(workspace, "sync", "ServerScriptService", "ImplicitGui", "init.meta.json"), "utf8")).className,
    "ScreenGui"
  );
});

test("Studio truth writes the initial snapshot to disk and marks the session ready", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const result = app.acceptConnection({
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "studio"
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.connectionState, "accepted");

  app.updateStudioSnapshot(result.session.id, {
    mounts: [
      {
        id: "ServerScriptService",
        children: [
          {
            name: "Hello",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 42",
            properties: {},
            children: []
          }
        ]
      }
    ]
  }, "initial_accept");

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(app.sessions.get(result.session.id).connectionState, "ready");
  assert.match(
    fs.readFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "utf8"),
    /return 42/
  );
});

test("projects endpoint hides abstract bases and exposes inheritance metadata", async () => {
  const workspace = createWorkspaceWithInheritedProjects();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const response = await invoke(app, "GET", "/projects");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.projects.map((project) => project.name), ["Dungeon", "Lobby"]);
  assert.ok(response.payload.projects.every((project) => project.abstract === false));
  assert.ok(response.payload.projects.every((project) => project.extendsProjectId === "Base.project.json"));
});

test("reported plugin and extension errors are persisted through ErrorTracker", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const pluginResponse = await invoke(app, "POST", "/errors/add", {
    component: "plugin",
    severity: "error",
    code: "PLUGIN-TEST",
    message: "Plugin reported a test error"
  });
  const extensionResponse = await invoke(app, "POST", "/errors/add", {
    component: "extension",
    severity: "warning",
    code: "EXTENSION-TEST",
    message: "Extension reported a test warning"
  });

  assert.equal(pluginResponse.statusCode, 200);
  assert.equal(extensionResponse.statusCode, 200);
  const errors = await invoke(app, "GET", "/errors?limit=10");
  assert.equal(errors.payload.entries.some((entry) => entry.component === "plugin" && entry.code === "PLUGIN-TEST"), true);
  assert.equal(errors.payload.entries.some((entry) => entry.component === "extension" && entry.code === "EXTENSION-TEST"), true);
});

test("shared and exclusive files target only the derived sessions that include them", async () => {
  const workspace = createWorkspaceWithInheritedProjects();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const lobbySession = app.openSession(101, null).session;
  const dungeonSession = app.openSession(202, null).session;

  app.onWorkspaceFileChanged(path.join(workspace, "shared", "ServerScriptService", "Common.server.luau"));
  await wait(320);

  assert.equal(lobbySession.pendingCommands.length, 1);
  assert.equal(dungeonSession.pendingCommands.length, 1);

  app.dequeueCommands(lobbySession.id);
  app.dequeueCommands(dungeonSession.id);

  app.onWorkspaceFileChanged(path.join(workspace, "places", "Lobby", "ReplicatedStorage", "Lobby.server.luau"));
  await wait(320);

  assert.equal(lobbySession.pendingCommands.length, 1);
  assert.equal(dungeonSession.pendingCommands.length, 0);
});

test("new VS Code script files enqueue a project tree apply instead of a file patch", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  const newScriptPath = path.join(workspace, "sync", "ServerScriptService", "NewScript.server.luau");
  fs.writeFileSync(newScriptPath, "return 2", "utf8");
  app.onWorkspaceFileChanged(newScriptPath);
  await wait(320);

  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "apply_project_tree");
  const mount = session.pendingCommands[0].payload.project.mounts.find((candidate) => candidate.id === "ServerScriptService");
  assert.ok(mount.children.some((child) => child.name === "NewScript"));
});

test("VS Code script moves carry sidecar metadata before applying the tree", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  const mountRoot = path.join(workspace, "sync", "ServerScriptService");
  const oldScriptPath = path.join(mountRoot, "Hello.server.luau");
  const oldMetaPath = path.join(mountRoot, "Hello.meta.json");
  fs.writeFileSync(oldMetaPath, JSON.stringify({
    properties: {
      Disabled: true
    }
  }, null, 2));
  seedStudioSnapshotFromLocalProject(app, session);

  const targetDir = path.join(mountRoot, "Moved");
  fs.mkdirSync(targetDir, { recursive: true });
  const newScriptPath = path.join(targetDir, "Hello.server.luau");
  fs.renameSync(oldScriptPath, newScriptPath);
  app.onWorkspaceFileChanged(newScriptPath);
  await wait(320);

  assert.equal(fs.existsSync(oldMetaPath), false);
  assert.equal(fs.existsSync(path.join(targetDir, "Hello.meta.json")), true);
  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "apply_project_tree");
  const mount = session.pendingCommands[0].payload.project.mounts.find((candidate) => candidate.id === "ServerScriptService");
  assert.equal(mount.children.some((child) => child.name === "Hello"), false);
  const movedFolder = mount.children.find((child) => child.name === "Moved");
  const movedScript = movedFolder.children.find((child) => child.name === "Hello");
  assert.equal(movedScript.properties.Disabled, true);
});

test("VS Code rename notifications carry moved scripts into the daemon sync queue", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  const mountRoot = path.join(workspace, "sync", "ServerScriptService");
  const oldScriptPath = path.join(mountRoot, "Hello.server.luau");
  const oldMetaPath = path.join(mountRoot, "Hello.meta.json");
  fs.writeFileSync(oldMetaPath, JSON.stringify({
    properties: {
      Disabled: true
    }
  }, null, 2));
  seedStudioSnapshotFromLocalProject(app, session);

  const targetDir = path.join(mountRoot, "Moved");
  fs.mkdirSync(targetDir, { recursive: true });
  const newScriptPath = path.join(targetDir, "Hello.server.luau");
  fs.renameSync(oldScriptPath, newScriptPath);

  const response = await invoke(app, "POST", "/workspace/files-changed", {
    source: "vscode_rename",
    events: [
      {
        type: "vscode_rename",
        oldPath: oldScriptPath,
        newPath: newScriptPath
      }
    ]
  });
  await wait(320);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.accepted, 2);
  assert.equal(fs.existsSync(oldMetaPath), false);
  assert.equal(fs.existsSync(path.join(targetDir, "Hello.meta.json")), true);
  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "apply_project_tree");
  const mount = session.pendingCommands[0].payload.project.mounts.find((candidate) => candidate.id === "ServerScriptService");
  const movedFolder = mount.children.find((child) => child.name === "Moved");
  const movedScript = movedFolder.children.find((child) => child.name === "Hello");
  assert.equal(movedScript.properties.Disabled, true);
});

test("Studio source patches update the daemon snapshot after a VS Code move", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  const mountRoot = path.join(workspace, "sync", "ServerScriptService");
  const oldScriptPath = path.join(mountRoot, "Hello.server.luau");
  const targetDir = path.join(mountRoot, "Moved");
  fs.mkdirSync(targetDir, { recursive: true });
  const newScriptPath = path.join(targetDir, "Hello.server.luau");
  fs.renameSync(oldScriptPath, newScriptPath);
  app.onWorkspaceFileChanged(newScriptPath);
  await wait(320);

  const dequeued = app.dequeueCommands(session.id);
  assert.equal(dequeued.commands.length, 1);
  app.completeCommand(session.id, dequeued.commands[0].id, { ok: true });

  const previousHash = session.lastStudioHash;
  const response = await invoke(app, "POST", "/studio/patch-source", {
    sessionId: session.id,
    path: ["ServerScriptService", "Moved", "Hello"],
    source: "return 99"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(fs.readFileSync(newScriptPath, "utf8"), "return 99");
  assert.notEqual(session.lastStudioHash, previousHash);
  const movedScript = findSnapshotNodeByPath(session.lastStudioSnapshot, ["ServerScriptService", "Moved", "Hello"]);
  assert.equal(movedScript.source, "return 99");
});

test("workspace file changes are recorded in the local activity log", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    autoSyncToStudio: false
  });
  app.refreshWorkspace();
  app.openSession(0, null);

  const existingScriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.writeFileSync(existingScriptPath, "return 42", "utf8");
  app.onWorkspaceFileChanged(existingScriptPath);

  const newScriptPath = path.join(workspace, "sync", "ServerScriptService", "NewScript.server.luau");
  fs.writeFileSync(newScriptPath, "return 2", "utf8");
  app.onWorkspaceFileChanged(newScriptPath);

  fs.rmSync(existingScriptPath);
  app.onWorkspaceFileChanged(existingScriptPath);

  const entries = app.activityLog.query({ limit: 10 });
  const byPath = new Map(entries.map((entry) => [`${entry.action}:${entry.relativePath}`, entry]));
  assert.equal(byPath.has("modify:sync/ServerScriptService/Hello.server.luau"), true);
  assert.equal(byPath.has("create:sync/ServerScriptService/NewScript.server.luau"), true);
  assert.equal(byPath.has("delete:sync/ServerScriptService/Hello.server.luau"), true);
  assert.ok(entries.every((entry) => entry.direction === "pc_to_studio"));
});

test("existing VS Code script edits still use the fast file patch path", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.writeFileSync(scriptPath, "return 42", "utf8");
  app.onWorkspaceFileChanged(scriptPath);
  await wait(120);

  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "apply_file_patch");
  assert.deepEqual(session.pendingCommands[0].payload.path, ["ServerScriptService", "Hello"]);
  assert.equal(session.pendingCommands[0].payload.source, "return 42");
});

test("rejected fast file patches fall back to a full project tree apply", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  const emotesDir = path.join(workspace, "sync", "ServerScriptService", "Emotes");
  fs.mkdirSync(emotesDir, { recursive: true });
  fs.writeFileSync(path.join(emotesDir, "Script.server.luau"), "return 'emote'", "utf8");
  app.refreshWorkspace();
  app.enqueueCommand(session.id, "apply_file_patch", {
    path: ["ServerScriptService", "Emotes", "Script"],
    source: "return 'edited'"
  });

  const dequeued = app.dequeueCommands(session.id);
  assert.equal(dequeued.commands.length, 1);
  assert.equal(dequeued.commands[0].type, "apply_file_patch");
  app.rejectCommand(
    session.id,
    dequeued.commands[0].id,
    "Instance not found for path: ServerScriptService.Emotes.Script"
  );
  await wait(120);

  assert.equal(session.pendingCommands.length, 1);
  const fallback = session.pendingCommands[0];
  assert.equal(fallback.type, "apply_project_tree");
  assert.equal(fallback.payload.reason, "file_patch_rejected");
  const script = findSnapshotNodeByPath(fallback.payload.project, ["ServerScriptService", "Emotes", "Script"]);
  assert.equal(script.source, "return 'emote'");
});

test("sync guard marks timed out apply commands as degraded and pauses auto-sync", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);

  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: readLocalProjectState(project),
    reason: "test_timeout"
  }, false, 10);
  await wait(25);

  assert.equal(session.sync.state, "degraded");
  assert.equal(session.sync.lastFailure.commandType, "apply_project_tree");

  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.writeFileSync(scriptPath, "return 100", "utf8");
  app.onWorkspaceFileChanged(scriptPath);
  await wait(320);

  assert.equal(session.pendingCommands.length, 0);
});

test("verified apply snapshot clears degraded sync state", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);

  app.markSyncDegraded(session, "test degradation");
  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: readLocalProjectState(project),
    reason: "manual_resync"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: readLocalProjectState(project)
  });

  assert.equal(session.sync.state, "ready");
  assert.equal(session.sync.degradedReason, null);
  assert.ok(session.sync.lastVerifiedAt);
});

test("unverified fast file patch degrades but verified patch updates snapshot", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  app.enqueueCommand(session.id, "apply_file_patch", {
    path: ["ServerScriptService", "Hello"],
    source: "return 10"
  });
  let command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, { ok: true });
  assert.equal(session.sync.state, "degraded");

  app.enqueueCommand(session.id, "apply_file_patch", {
    path: ["ServerScriptService", "Hello"],
    source: "return 11"
  });
  command = app.dequeueCommands(session.id).commands[0];
  const verifiedSnapshot = readLocalProjectState(app.getProjectById(session.projectId));
  verifiedSnapshot.mounts[0].children[0].source = "return 11";
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: verifiedSnapshot
  });

  assert.equal(session.sync.state, "ready");
  const script = findSnapshotNodeByPath(session.lastStudioSnapshot, ["ServerScriptService", "Hello"]);
  assert.equal(script.source, "return 11");
});

test("Studio snapshot disk writes are recorded in the local activity log", async () => {
  const workspace = createWorkspaceWithProject();
  const oldScriptPath = path.join(workspace, "sync", "ServerScriptService", "Old.server.luau");
  fs.writeFileSync(oldScriptPath, "return 'old'", "utf8");
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  app.updateStudioSnapshot(session.id, {
    mounts: [
      {
        id: "ServerScriptService",
        segments: ["ServerScriptService"],
        children: [
          {
            name: "Hello",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 42",
            properties: {},
            children: []
          },
          {
            name: "NewScript",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 2",
            properties: {},
            children: []
          }
        ]
      }
    ]
  }, "manual");
  await wait(50);

  const entries = app.activityLog.query({ limit: 10 });
  const byPath = new Map(entries.map((entry) => [`${entry.action}:${entry.relativePath}`, entry]));
  assert.equal(byPath.has("modify:sync/ServerScriptService/Hello.server.luau"), true);
  assert.equal(byPath.has("create:sync/ServerScriptService/NewScript.server.luau"), true);
  assert.equal(byPath.has("delete:sync/ServerScriptService/Old.server.luau"), true);
  assert.ok(entries.every((entry) => entry.direction === "studio_to_pc"));

  const response = await invoke(app, "GET", "/activity?limit=2");
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.entries.length, 2);
});

test("deleted VS Code files enqueue a project tree apply so Studio mirrors removals", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.rmSync(scriptPath);
  app.onWorkspaceFileChanged(scriptPath);
  await wait(320);

  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "apply_project_tree");
  const mount = session.pendingCommands[0].payload.project.mounts.find((candidate) => candidate.id === "ServerScriptService");
  assert.equal(mount.children.some((child) => child.name === "Hello"), false);
});

test("autoSyncToStudio false disables automatic VS Code file apply commands", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    autoSyncToStudio: false
  });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.writeFileSync(scriptPath, "return 99", "utf8");
  app.onWorkspaceFileChanged(scriptPath);
  await wait(320);

  assert.equal(session.pendingCommands.length, 0);
});

test("autoSyncToStudio can be disabled through workspace plugin config", async () => {
  const workspace = createWorkspaceWithProject();
  fs.writeFileSync(path.join(workspace, ".pluginroblox.json"), JSON.stringify({
    daemonPort: 8323,
    autoSyncToStudio: false
  }, null, 2));
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  assert.equal(app.autoSyncToStudio, false);
});

test("manual pull still sends files to Studio when autoSyncToStudio is disabled", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    autoSyncToStudio: false
  });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  const pullPromise = invoke(app, "POST", `/session/${session.id}/pull`, {});
  await wait(20);

  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "apply_project_tree");
  const command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, { ok: true, result: "Snapshot aplicado" });

  const response = await pullPromise;
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
});

test("version-blocked sessions reject manual sync recovery endpoints", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-old",
    placeId: 0,
    truthSource: "pc"
  });
  const sessionId = accept.payload.session.id;

  for (const action of ["pull", "push", "resync"]) {
    const response = await invoke(app, "POST", `/session/${sessionId}/${action}`, {});
    assert.equal(response.statusCode, 409, `${action} should be blocked`);
    assert.equal(response.payload.ok, false);
    assert.match(response.payload.error, /Plugin update required/);
  }
});

test("auto-sync ignores version-blocked sessions", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-old",
    placeId: 0,
    truthSource: "pc"
  });
  const session = app.sessions.get(accept.payload.session.id);

  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.writeFileSync(scriptPath, "return 200", "utf8");
  app.onWorkspaceFileChanged(scriptPath);
  await wait(320);

  assert.equal(session.pendingCommands.length, 0);
  assert.equal(app.sessionSummary(session).requiresPluginUpdate, true);
});

test("MCP shield exposes HTTP fallback diagnostics and tool calls", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const status = await invoke(app, "GET", "/mcp/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.mcp.state, "fallback_ready");
  assert.equal(status.payload.mcp.config.status, "missing");
  assert.match(status.payload.mcp.fallback.callUrl, /\/mcp\/call$/);

  const tools = await invoke(app, "GET", "/mcp/tools");
  assert.equal(tools.statusCode, 200);
  assert.equal(tools.payload.ok, true);
  assert.ok(tools.payload.tools.some((tool) => tool.name === "health"));

  const probe = await invoke(app, "POST", "/mcp/probe", {});
  assert.equal(probe.statusCode, 200);
  assert.equal(probe.payload.ok, true);
  assert.equal(probe.payload.parsed.workspaceRoot, workspace);
  assert.ok(app.mcpShield.lastProbeAt);

  const call = await invoke(app, "POST", "/mcp/call", {
    name: "list_projects",
    arguments: {}
  });
  assert.equal(call.statusCode, 200);
  assert.equal(call.payload.ok, true);
  assert.equal(call.payload.name, "list_projects");
  assert.equal(call.payload.parsed[0].name, "Game");
  assert.ok(app.mcpShield.lastHttpFallbackCallAt);
});

test("MCP shield reports ready when VS Code servers config is valid", async () => {
  const workspace = createWorkspaceWithProject();
  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  const proxyEntry = path.join(workspace, "runtime", "mcp-proxy", "index.js");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify({
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        args: [
          proxyEntry,
          "--workspace",
          workspace,
          "--host",
          "127.0.0.1",
          "--port",
          "8323"
        ]
      }
    }
  }, null, 2)}\n`, "utf8");

  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const status = await invoke(app, "GET", "/mcp/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.mcp.state, "ready");
  assert.equal(status.payload.mcp.config.status, "ready");

  const health = await invoke(app, "GET", "/health");
  assert.equal(health.payload.mcpShield.state, "ready");
});

test("Doctor reports healthy workspace with compatible plugin and MCP config", async () => {
  const workspace = createWorkspaceWithProject();
  const mcpPath = path.join(workspace, ".vscode", "mcp.json");
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, `${JSON.stringify({
    servers: {
      amarillo: {
        type: "stdio",
        command: "node",
        args: [
          path.join(workspace, "runtime", "mcp-proxy", "index.js"),
          "--workspace",
          workspace,
          "--host",
          "127.0.0.1",
          "--port",
          "8323"
        ]
      }
    }
  }, null, 2)}\n`, "utf8");
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    extensionVersion: "1.0.16",
    extensionProtocolVersion: 1
  });
  app.refreshWorkspace();

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "studio",
    pluginVersion: "1.0.16",
    pluginProtocolVersion: 1
  });
  const sessionId = accept.payload.session.id;
  await invoke(app, "POST", "/studio/snapshot", {
    sessionId,
    reason: "initial_accept",
    pluginVersion: "1.0.16",
    pluginProtocolVersion: 1,
    snapshot: readLocalProjectState(app.getProjectById(accept.payload.session.projectId))
  }, {
    headers: {
      "x-amarillo-session-token": accept.payload.session.sessionToken
    }
  });
  await wait(25);

  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.statusCode, 200);
  assert.equal(doctor.payload.status, "ok");
  assert.equal(doctor.payload.versions.daemon.protocolVersion, 1);
  assert.equal(doctor.payload.sessions[0].versionState, "compatible");
});

test("Doctor reports warning when MCP is only available through fallback", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  app.openSession(0, null);

  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.payload.status, "warning");
  assert.match(doctor.payload.summary.warnings.join("\n"), /MCP/);
});

test("Doctor reports blocked when sync is degraded", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  app.markSyncDegraded(session, "test degradation");
  const doctor = await invoke(app, "GET", "/doctor");

  assert.equal(doctor.payload.status, "blocked");
  assert.match(doctor.payload.summary.blockedReasons.join("\n"), /test degradation/);
});

test("Doctor reports blocked when a connected plugin needs an update", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-old",
    placeId: 0,
    truthSource: "pc"
  });
  const doctor = await invoke(app, "GET", "/doctor");

  assert.equal(doctor.payload.status, "blocked");
  assert.match(doctor.payload.summary.blockedReasons.join("\n"), /Plugin update required/);
  assert.equal(doctor.payload.compatibility.blockedSessionIds.length, 1);
});

test("destructive session routes block on session health gates", async () => {
  const cases = [
    {
      name: "not ready",
      mutate(session) {
        session.connectionState = "waiting";
      },
      reasonCode: "SESSION_NOT_READY"
    },
    {
      name: "version blocked",
      mutate(session) {
        session.requirePluginVersion = true;
        session.pluginVersion = null;
        session.pluginProtocolVersion = null;
      },
      reasonCode: "PLUGIN_UPDATE_REQUIRED"
    },
    {
      name: "sync degraded",
      mutate(session, app) {
        app.markSyncDegraded(session, "test degradation");
      },
      reasonCode: "SYNC_DEGRADED"
    },
    {
      name: "studio contact stale",
      mutate(session) {
        session.lastStudioSeenAt = new Date(Date.now() - 70000).toISOString();
      },
      reasonCode: "STUDIO_CONTACT_CRITICAL"
    }
  ];

  for (const testCase of cases) {
    const workspace = createWorkspaceWithProject();
    const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
    app.refreshWorkspace();
    const { session } = app.openSession(0, null, { connectionState: "ready", truthSource: "pc" });
    session.lastStudioSeenAt = new Date().toISOString();
    testCase.mutate(session, app);

    const response = await invoke(app, "POST", `/session/${session.id}/create-instance`, {
      parentPath: "game.ServerScriptService",
      className: "Folder",
      name: "Blocked"
    });
    assert.equal(response.statusCode, 409, `${testCase.name} should be blocked`);
    assert.equal(response.payload.result.blocked, true);
    assert.equal(response.payload.result.reasonCode, testCase.reasonCode);
  }
});

test("blocked destructive MCP calls are recorded in the MCP audit log and surfaced by Doctor", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, { connectionState: "ready", truthSource: "pc" });
  session.lastStudioSeenAt = new Date(Date.now() - 70000).toISOString();

  const response = await invoke(app, "POST", "/mcp/call", {
    name: "delete_instance",
    arguments: {
      sessionId: session.id,
      path: "game.Workspace.Part"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.parsed.ok, false);
  assert.equal(response.payload.parsed.blocked, true);
  assert.equal(response.payload.parsed.reasonCode, "STUDIO_CONTACT_CRITICAL");

  const doctor = await invoke(app, "GET", "/doctor");
  assert.equal(doctor.payload.mcpAudit.total, 1);
  assert.equal(doctor.payload.mcpAudit.lastFailureOrDecline.reasonCode, "STUDIO_CONTACT_CRITICAL");
});

test("declined destructive MCP actions are returned to the caller and tracked in the MCP audit log", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, { connectionState: "ready", truthSource: "pc" });
  session.lastStudioSeenAt = new Date().toISOString();

  const responsePromise = invoke(app, "POST", "/mcp/call", {
    name: "modify_property",
    arguments: {
      sessionId: session.id,
      path: "game.ServerScriptService.Hello",
      property: "Disabled",
      value: true
    }
  });

  await wait(10);
  const dequeued = app.dequeueCommands(session.id);
  assert.equal(dequeued.commands.length, 1);
  assert.equal(dequeued.commands[0].type, "modify_property");
  app.completeCommand(session.id, dequeued.commands[0].id, {
    ok: false,
    error: "Destructive action declined by user.",
    blocked: false,
    declined: true,
    confirmed: false,
    reasonCode: "DECLINED_BY_USER"
  });

  const response = await responsePromise;
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.parsed.ok, false);
  assert.equal(response.payload.parsed.declined, true);
  assert.equal(response.payload.parsed.reasonCode, "DECLINED_BY_USER");

  const auditSummary = app.mcpAuditLog.summary();
  assert.equal(auditSummary.total, 1);
  assert.equal(auditSummary.lastFailureOrDecline.reasonCode, "DECLINED_BY_USER");
});
