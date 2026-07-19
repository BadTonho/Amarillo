"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { brotliDecompressSync, gunzipSync } = require("node:zlib");
const { PluginRobloxApp } = require("../src/daemon/app");
const { readLocalProjectState } = require("../src/daemon/project");
const { jsonResponse } = require("../src/daemon/http-utils");
const { AMARILLO_PROTOCOL_VERSION, MIN_PLUGIN_VERSION } = require("../src/daemon/version");
const {
  createTempWorkspace,
  createWorkspaceWithProject,
  createWorkspaceWithInheritedProjects,
  invoke,
  wait,
  seedStudioSnapshotFromLocalProject,
  findSnapshotNodeByPath
} = require("./helpers/daemon-workspace");

test("daemon compresses large JSON responses when the client supports gzip", () => {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let responseBody = null;
  const response = {
    writeHead(status, nextHeaders) {
      statusCode = status;
      headers = nextHeaders;
    },
    end(body) {
      responseBody = body;
    }
  };

  jsonResponse(response, 200, { value: "x".repeat(4096) }, {
    headers: { "accept-encoding": "gzip" }
  });

  assert.equal(statusCode, 200);
  assert.equal(headers["Content-Encoding"], "gzip");
  assert.match(headers.Vary, /Accept-Encoding/);
  assert.equal(JSON.parse(gunzipSync(responseBody).toString("utf8")).value.length, 4096);
});

test("daemon prefers Brotli when the client supports it", () => {
  let headers: Record<string, string> = {};
  let responseBody = null;
  const response = {
    writeHead(_status, nextHeaders) {
      headers = nextHeaders;
    },
    end(body) {
      responseBody = body;
    }
  };

  jsonResponse(response, 200, { value: "x".repeat(4096) }, {
    headers: { "accept-encoding": "gzip, br" }
  });

  assert.equal(headers["Content-Encoding"], "br");
  assert.equal(JSON.parse(brotliDecompressSync(responseBody).toString("utf8")).value.length, 4096);
});

test("daemon keeps small JSON responses uncompressed", () => {
  let headers: Record<string, string> = {};
  let responseBody = null;
  const response = {
    writeHead(_status, nextHeaders) {
      headers = nextHeaders;
    },
    end(body) {
      responseBody = body;
    }
  };

  jsonResponse(response, 200, { ok: true }, {
    headers: { "accept-encoding": "gzip" }
  });

  assert.equal(headers["Content-Encoding"], undefined);
  assert.deepEqual(JSON.parse(responseBody.toString("utf8")), { ok: true });
});

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

test("daemon CORS preflight only allows local origins", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    bridgeToken: "secret-token"
  });
  app.refreshWorkspace();

  const blocked = await invoke(app, "OPTIONS", "/mcp/call", undefined, {
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST"
    }
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.payload.code, "CORS_ORIGIN_FORBIDDEN");
  assert.equal(blocked.headers["Access-Control-Allow-Origin"], undefined);

  const localOrigin = "http://127.0.0.1:5173";
  const allowed = await invoke(app, "OPTIONS", "/mcp/call", undefined, {
    headers: {
      origin: localOrigin,
      "access-control-request-method": "POST"
    }
  });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], localOrigin);
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

test("daemon requires a bridge token for connection routes outside loopback", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "0.0.0.0",
    port: 8323,
    bridgeToken: "secret-token"
  });
  app.refreshWorkspace();

  const body = {
    projectId: "Game.project.json",
    truthSource: "pc",
    studioSnapshot: { mounts: [] }
  };
  const unauthorized = await invoke(app, "POST", "/connection/diff", body);
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await invoke(app, "POST", "/connection/diff", body, {
    headers: { "x-amarillo-bridge-token": "secret-token" }
  });
  assert.equal(authorized.statusCode, 200);
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
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
  });
  assert.equal(accept.statusCode, 200);

  const snapshot = await invoke(app, "POST", "/studio/snapshot", {
    sessionId: accept.payload.session.id,
    reason: "initial_accept",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    snapshot: largeSnapshot
  }, {
    headers: {
      "x-amarillo-session-token": accept.payload.session.sessionToken
    }
  });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.payload.ok, true);
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
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
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
