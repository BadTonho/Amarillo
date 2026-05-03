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

function seedStudioSnapshotFromLocalProject(app, session) {
  app.recordAppliedProjectSnapshot(
    session,
    readLocalProjectState(app.getProjectById(session.projectId)),
    "test_seed"
  );
}

async function invoke(app, method, url, body) {
  const request = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  request.method = method;
  request.url = url;
  request.headers = {
    host: "127.0.0.1:8323"
  };

  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let responseBody = "";
    const response = {
      writeHead(code) {
        statusCode = code;
      },
      end(chunk = "") {
        responseBody += chunk;
        resolve({
          statusCode,
          payload: responseBody ? JSON.parse(responseBody) : {}
        });
      }
    };

    app.handleHttp(request, response).catch(reject);
  });
}

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

test("first studio acceptance wins and creates a pending PC-truth initial sync", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const offer = app.beginConnectionOffer("test");
  const acceptResponse = await invoke(app, "POST", "/connection/accept", {
    offerId: offer.offerId,
    studioInstanceId: "studio-a",
    placeId: 0,
    truthSource: "pc"
  });
  assert.equal(acceptResponse.statusCode, 200);
  assert.equal(acceptResponse.payload.session.connectionState, "accepted");
  assert.equal(acceptResponse.payload.offer.status, "accepted");

  const session = Array.from(app.sessions.values())[0];
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

  const session = app.sessions.get(result.session.id);
  assert.equal(session.connectionState, "ready");
  assert.ok(session.lastStudioSnapshot);
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
