"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PluginRobloxApp } = require("../src/daemon/app");
const { readLocalProjectState } = require("../src/daemon/project");
const { AMARILLO_PROTOCOL_VERSION, CURRENT_PLUGIN_VERSION, MIN_PLUGIN_VERSION } = require("../src/daemon/version");
const {
  createTempWorkspace,
  createWorkspaceWithProject,
  createWorkspaceWithInheritedProjects,
  invoke,
  wait,
  seedStudioSnapshotFromLocalProject,
  findSnapshotNodeByPath
} = require("./helpers/daemon-workspace");


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
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
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
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
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

test("HTTP connection accept blocks plugins below the minimum verified-sync version", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const offer = app.beginConnectionOffer("test");
  const response = await invoke(app, "POST", "/connection/accept", {
    offerId: offer.offerId,
    studioInstanceId: "studio-old",
    placeId: 0,
    truthSource: "pc",
    pluginVersion: "1.0.28",
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.session.versionState, "blocked");
  assert.equal(response.payload.session.requiresPluginUpdate, true);
  assert.match(response.payload.session.versionMessage, /older than/);
  assert.equal((Array.from(app.sessions.values())[0] as any).pendingCommands.length, 0);
});

test("HTTP connection accept warns for compatible plugins older than the current bundled version", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const offer = app.beginConnectionOffer("test");
  const response = await invoke(app, "POST", "/connection/accept", {
    offerId: offer.offerId,
    studioInstanceId: "studio-outdated",
    placeId: 0,
    truthSource: "pc",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    privilegedActionConfirmationEnabled: true
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.session.versionState, "outdated");
  assert.equal(response.payload.session.requiresPluginUpdate, false);
  assert.equal(response.payload.session.pluginUpdateAvailable, true);
  assert.equal(response.payload.session.currentPluginVersion, CURRENT_PLUGIN_VERSION);
  assert.match(response.payload.session.versionMessage, /Plugin update available/);
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

test("healthy session summaries hide stale lastCommandError values", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  session.lastCommandError = "Another destructive action is already awaiting confirmation.";

  const health = await invoke(app, "GET", "/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.payload.sessions[0].syncState, "ready");
  assert.equal(health.payload.sessions[0].lastCommandError, null);
  assert.equal(session.lastCommandError, "Another destructive action is already awaiting confirmation.");
});
