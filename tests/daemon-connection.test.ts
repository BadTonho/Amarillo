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

test("published places without a project mapping require place setup before sync", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const diff = await invoke(app, "POST", "/connection/diff", {
    placeId: 987654,
    placeName: "Namek Prime",
    truthSource: "pc",
    studioSnapshot: { mounts: [] }
  });
  assert.equal(diff.statusCode, 409);
  assert.equal(diff.payload.code, "PLACE_SETUP_REQUIRED");
  assert.equal(diff.payload.pendingPlaceSetup.placeId, 987654);
  assert.equal(diff.payload.pendingPlaceSetup.placeName, "Namek Prime");
  const health = await invoke(app, "GET", "/health");
  assert.equal(health.payload.pendingPlaceSetup.placeId, 987654);

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-new-place",
    placeId: 987654,
    placeName: "Namek Prime",
    truthSource: "pc",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
  });
  assert.equal(accept.statusCode, 409);
  assert.equal(accept.payload.code, "PLACE_SETUP_REQUIRED");
  assert.equal(app.sessions.size, 0);
});

test("place setup creates a place project and all base and exclusive folders", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  app.rememberPendingPlaceSetup(987654, "Namek Prime");

  const response = await invoke(app, "POST", "/projects/place-setup", {
    placeId: 987654,
    placeName: "Namek Prime"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.projectId, "NamekPrime.project.json");
  const projectPath = path.join(workspace, "NamekPrime.project.json");
  const projectJson = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  assert.deepEqual(projectJson.place_ids, [987654]);
  assert.equal(projectJson.tree.Workspace.ExclusivoNamekPrime.$path, "NamekPrime/exclusive/Workspace");
  assert.equal(projectJson.tree.StarterPlayer.StarterPlayerScripts.ExclusivoNamekPrime.$path, "NamekPrime/exclusive/StarterPlayer/StarterPlayerScripts");

  for (const relativePath of [
    "sync/ReplicatedStorage",
    "sync/ServerScriptService",
    "sync/ServerStorage",
    "sync/StarterGui",
    "sync/StarterPlayer/StarterCharacterScripts",
    "sync/StarterPlayer/StarterPlayerScripts",
    "NamekPrime/exclusive/ReplicatedStorage",
    "NamekPrime/exclusive/ServerScriptService",
    "NamekPrime/exclusive/ServerStorage",
    "NamekPrime/exclusive/StarterGui",
    "NamekPrime/exclusive/StarterPlayer/StarterCharacterScripts",
    "NamekPrime/exclusive/StarterPlayer/StarterPlayerScripts"
  ]) {
    assert.equal(fs.existsSync(path.join(workspace, relativePath)), true, relativePath);
  }
  assert.equal(fs.existsSync(path.join(workspace, "sync/Workspace")), false);
  assert.equal(fs.existsSync(path.join(workspace, "NamekPrime/exclusive/Workspace")), false);
  assert.equal(app.pendingPlaceSetup, null);

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-namek-prime",
    placeId: 987654,
    placeName: "Namek Prime",
    truthSource: "pc",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
  });
  assert.equal(accept.statusCode, 200);
  assert.equal(accept.payload.session.projectId, "NamekPrime.project.json");
  assert.equal(accept.payload.session.placeName, "Namek Prime");
});

test("place setup and place sync edit select exclusive and shared base mounts by canonical id", async () => {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "src", "ServerScriptService"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "src", "ReplicatedStorage"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "src", "StarterGui"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Base.project.json"), JSON.stringify({
    name: "Base",
    tree: {
      $className: "DataModel",
      ServerScriptService: {
        $path: "src/ServerScriptService"
      },
      ReplicatedStorage: {
        $path: "src/ReplicatedStorage"
      },
      StarterGui: {
        $path: "src/StarterGui"
      }
    }
  }, null, 2));
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  app.rememberPendingPlaceSetup(222333, "Arena");

  const create = await invoke(app, "POST", "/projects/place-setup", {
    placeId: 222333,
    placeName: "Arena",
    exclusiveMountIds: ["ServerScriptService", "StarterGui"],
    baseMountIds: ["ServerScriptService"],
    keepUnknowns: true
  });

  assert.equal(create.statusCode, 200);
  const projectPath = path.join(workspace, "Arena.project.json");
  let projectJson = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  assert.equal(projectJson.tree.ServerScriptService.$path, "src/ServerScriptService");
  assert.equal(projectJson.tree.ServerScriptService.ExclusivoArena.$path, "Arena/exclusive/ServerScriptService");
  assert.equal(projectJson.tree.ServerScriptService.$keepUnknowns, true);
  assert.equal(projectJson.tree.ServerScriptService.ExclusivoArena.$keepUnknowns, true);
  assert.equal(projectJson.tree.ReplicatedStorage.$path, undefined);
  assert.equal(projectJson.tree.ReplicatedStorage.$amarilloDisabledPath, "src/ReplicatedStorage");
  assert.equal(projectJson.tree.ReplicatedStorage.ExclusivoArena, undefined);
  assert.equal(projectJson.tree.StarterGui.$path, undefined);
  assert.equal(projectJson.tree.StarterGui.$amarilloDisabledPath, "src/StarterGui");
  assert.equal(projectJson.tree.StarterGui.ExclusivoArena.$path, "Arena/exclusive/StarterGui");

  const update = await invoke(app, "PATCH", `/projects/${encodeURIComponent("Arena.project.json")}/place-sync`, {
    exclusiveMountIds: ["ServerScriptService"],
    baseMountIds: ["ServerScriptService", "ReplicatedStorage"],
    keepUnknowns: false
  });

  assert.equal(update.statusCode, 200);
  projectJson = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  assert.equal(projectJson.tree.ServerScriptService.$path, "src/ServerScriptService");
  assert.equal(projectJson.tree.ServerScriptService.$keepUnknowns, undefined);
  assert.equal(projectJson.tree.ServerScriptService.ExclusivoArena.$path, "Arena/exclusive/ServerScriptService");
  assert.equal(projectJson.tree.ServerScriptService.ExclusivoArena.$keepUnknowns, undefined);
  assert.equal(projectJson.tree.ReplicatedStorage.$path, "src/ReplicatedStorage");
  assert.equal(projectJson.tree.ReplicatedStorage.$amarilloDisabledPath, undefined);
  assert.equal(projectJson.tree.ReplicatedStorage.ExclusivoArena, undefined);
  assert.equal(projectJson.tree.StarterGui.ExclusivoArena, undefined);
  assert.equal(projectJson.tree.StarterGui.$amarilloDisabledPath, "src/StarterGui");
});

test("place IDs can be edited from the projects route", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const update = await invoke(app, "PATCH", `/projects/${encodeURIComponent("Game.project.json")}/place-ids`, {
    placeIds: [444, "555"]
  });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.payload.placeIds, [444, 555]);

  const diff = await invoke(app, "POST", "/connection/diff", {
    placeId: 444,
    truthSource: "pc",
    studioSnapshot: { mounts: [] }
  });
  assert.equal(diff.statusCode, 200);
  assert.equal(app.getProjectById("Game.project.json").placeIds.includes(444), true);
});

test("workspace refresh materializes missing mount folders", () => {
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, "Namek.project.json"), JSON.stringify({
    name: "Namek",
    place_ids: [123],
    tree: {
      "$className": "DataModel",
      Workspace: {
        "$path": "sync/Workspace",
        ExclusivoNamek: {
          "$path": "Namek/exclusive/Workspace"
        }
      },
      StarterPlayer: {
        StarterPlayerScripts: {
          "$path": "sync/StarterPlayer/StarterPlayerScripts",
          ExclusivoNamek: {
            "$path": "Namek/exclusive/StarterPlayer/StarterPlayerScripts"
          }
        }
      }
    }
  }, null, 2));

  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  assert.equal(fs.existsSync(path.join(workspace, "sync/Workspace")), false);
  assert.equal(fs.existsSync(path.join(workspace, "sync/StarterPlayer/StarterPlayerScripts")), true);
  assert.equal(fs.existsSync(path.join(workspace, "Namek/exclusive/Workspace")), false);
  assert.equal(fs.existsSync(path.join(workspace, "Namek/exclusive/StarterPlayer/StarterPlayerScripts")), true);
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
