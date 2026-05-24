"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PluginRobloxApp } = require("../src/daemon/app");
const { handleTool } = require("../src/daemon/mcp");
const { diffSnapshots, hashSnapshot } = require("../src/daemon/lib/snapshot-hash");
const { readLocalProjectState } = require("../src/daemon/project");
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

async function waitForPendingCommand(session, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.pendingCommands.length > 0) {
      return session.pendingCommands[0];
    }
    await wait(10);
  }
  assert.fail("Timed out waiting for a pending Studio command.");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createWorkspaceWithWorkspaceMount() {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "sync", "ServerScriptService"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "return 'server'", "utf8");
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      Workspace: {
        $path: "sync/Workspace"
      },
      ServerScriptService: {
        $path: "sync/ServerScriptService"
      }
    }
  }, null, 2));
  return workspace;
}

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
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
  });
  assert.equal(accept.statusCode, 200);
  const sessionId = accept.payload.session.id;

  const rejected = await invoke(app, "POST", "/studio/snapshot", {
    sessionId,
    reason: "initial_accept",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
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

test("session open no longer auto-enqueues apply_project_tree on session_opened", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const { session } = app.openSession(0, null);

  assert.equal(session.pendingCommands.length, 0);
  assert.equal(session.connectionState, "ready");
});

test("Workspace sync target is disabled by default for Studio snapshot writes", async () => {
  const workspace = createWorkspaceWithWorkspaceMount();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  assert.equal(fs.existsSync(path.join(workspace, "sync", "Workspace")), false);

  app.updateStudioSnapshot(session.id, {
    mounts: [
      {
        id: "Workspace",
        segments: ["Workspace"],
        children: [
          {
            name: "World",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 'studio workspace'",
            properties: {},
            children: []
          }
        ]
      },
      {
        id: "ServerScriptService",
        segments: ["ServerScriptService"],
        children: [
          {
            name: "Hello",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 'studio server'",
            properties: {},
            children: []
          }
        ]
      }
    ]
  }, "manual");
  await app.drainPendingStudioWrites(1000);

  assert.equal(fs.existsSync(path.join(workspace, "sync", "Workspace")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "utf8"), "return 'studio server'");
  assert.equal(session.lastStudioSnapshot.mounts.some((mount) => mount.id === "Workspace"), false);
});

test("Workspace sync target is disabled by default for PC to Studio applies and diff", async () => {
  const workspace = createWorkspaceWithWorkspaceMount();
  fs.mkdirSync(path.join(workspace, "sync", "Workspace"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sync", "Workspace", "World.server.luau"), "return 'workspace'", "utf8");
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const accept = await invoke(app, "POST", "/connection/accept", {
    studioInstanceId: "studio-workspace-off",
    placeId: 0,
    truthSource: "pc",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
  });
  assert.equal(accept.statusCode, 200);
  const session = app.sessions.get(accept.payload.session.id);
  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].payload.project.mounts.some((mount) => mount.id === "Workspace"), false);

  const diff = await invoke(app, "POST", "/connection/diff", {
    placeId: 0,
    projectId: "Game.project.json",
    truthSource: "studio",
    studioSnapshot: {
      mounts: [
        {
          id: "Workspace",
          segments: ["Workspace"],
          children: [
            {
              name: "StudioOnly",
              className: "Script",
              fileKind: "server",
              ext: ".server.luau",
              source: "return 'studio'",
              properties: {},
              children: []
            }
          ]
        },
        readLocalProjectState(app.projectForSync(app.getProjectById("Game.project.json"), { Workspace: false })).mounts[0]
      ]
    }
  });
  assert.equal(diff.statusCode, 200);
  assert.deepEqual(diff.payload.changes, ["No changes detected. Everything is up to date."]);
});

test("Workspace sync target can be enabled for both sync directions", async () => {
  const workspace = createWorkspaceWithWorkspaceMount();
  fs.mkdirSync(path.join(workspace, "sync", "Workspace"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sync", "Workspace", "World.server.luau"), "return 'workspace'", "utf8");
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, { syncTargets: { Workspace: true } });
  const project = app.getProjectById(session.projectId);

  const localSnapshot = app.readLocalProjectStateWithPerf(project, app.projectReadOptions(session));
  assert.equal(localSnapshot.mounts.some((mount) => mount.id === "Workspace"), true);

  app.updateStudioSnapshot(session.id, {
    mounts: [
      {
        id: "Workspace",
        segments: ["Workspace"],
        children: [
          {
            name: "World",
            className: "Script",
            fileKind: "server",
            ext: ".server.luau",
            source: "return 'studio workspace'",
            properties: {},
            children: []
          }
        ]
      }
    ]
  }, "manual");
  await app.drainPendingStudioWrites(1000);

  assert.equal(fs.readFileSync(path.join(workspace, "sync", "Workspace", "World.server.luau"), "utf8"), "return 'studio workspace'");
  assert.equal(session.lastStudioSnapshot.mounts.some((mount) => mount.id === "Workspace"), true);
});

test("semantic snapshot hash ignores representation-only fields", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const project = app.getProjectById("Game.project.json");
  const localSnapshot = readLocalProjectState(project);
  const studioSnapshot = cloneJson(localSnapshot);
  const studioNode = studioSnapshot.mounts[0].children[0];

  delete studioSnapshot.name;
  delete studioSnapshot.placeIds;
  delete studioSnapshot.mounts[0].absolutePath;
  delete studioSnapshot.mounts[0].relativePath;
  delete studioNode.ext;
  studioNode.classNameSource = "studio";
  studioNode.source = "return 1\n";

  assert.equal(hashSnapshot(studioSnapshot), hashSnapshot(localSnapshot));

  studioNode.source = "return 2";
  assert.notEqual(hashSnapshot(studioSnapshot), hashSnapshot(localSnapshot));
});

test("semantic snapshot hash treats script Enabled as Disabled inverse", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const project = app.getProjectById("Game.project.json");
  const localSnapshot = readLocalProjectState(project);
  const studioEnabledSnapshot = cloneJson(localSnapshot);

  studioEnabledSnapshot.mounts[0].children[0].properties = { Enabled: true };

  assert.equal(hashSnapshot(studioEnabledSnapshot), hashSnapshot(localSnapshot));
  assert.equal(diffSnapshots(localSnapshot, studioEnabledSnapshot).changeCount, 0);

  const localDisabledSnapshot = cloneJson(localSnapshot);
  const studioDisabledSnapshot = cloneJson(localSnapshot);
  localDisabledSnapshot.mounts[0].children[0].properties = { Disabled: true };
  studioDisabledSnapshot.mounts[0].children[0].properties = { Enabled: false };

  assert.equal(hashSnapshot(studioDisabledSnapshot), hashSnapshot(localDisabledSnapshot));
  assert.equal(diffSnapshots(localDisabledSnapshot, studioDisabledSnapshot).changeCount, 0);
  assert.notEqual(hashSnapshot(studioDisabledSnapshot), hashSnapshot(localSnapshot));
});

test("semantic snapshot hash ignores opaque Models and accepts duplicate folders", () => {
  const expectedSnapshot = {
    projectId: "Game.project.json",
    mounts: [
      {
        id: "ReplicatedStorage",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "Duplicate",
            className: "Folder",
            properties: {},
            amarilloId: "id-a",
            children: []
          },
          {
            name: "Duplicate",
            fsName: "Duplicate.amarillo-2",
            className: "Folder",
            properties: {},
            amarilloId: "id-b",
            duplicateOrdinal: 2,
            children: []
          },
          {
            name: "Vehicle",
            className: "Model",
            properties: {},
            children: [
              {
                name: "Hull",
                className: "Part",
                properties: {},
                keepUnknowns: true,
                children: [
                  {
                    name: "Controller",
                    className: "Script",
                    fileKind: "server",
                    source: "return 'drive'",
                    properties: {},
                    children: []
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };
  const observedSnapshot = {
    projectId: "Game.project.json",
    mounts: [
      {
        id: "ReplicatedStorage",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "Vehicle",
            className: "Model",
            properties: {},
            children: [
              {
                name: "Wheel",
                className: "Attachment",
                properties: {},
                children: []
              },
              {
                name: "Wheel",
                className: "Attachment",
                properties: {},
                children: []
              },
              {
                name: "Hull",
                className: "Part",
                properties: { Anchored: true },
                children: [
                  {
                    name: "Controller",
                    className: "Script",
                    fileKind: "server",
                    source: "return 'drive'\n",
                    properties: {},
                    children: []
                  }
                ]
              }
            ]
          },
          {
            name: "Duplicate",
            className: "Folder",
            properties: {},
            children: []
          },
          {
            name: "Duplicate",
            className: "Folder",
            properties: {},
            children: []
          }
        ]
      }
    ]
  };

  assert.equal(hashSnapshot(observedSnapshot), hashSnapshot(expectedSnapshot));
  assert.equal(diffSnapshots(expectedSnapshot, observedSnapshot).changeCount, 0);

  const emptyExpectedSnapshot = {
    projectId: "Game.project.json",
    mounts: [
      {
        id: "ReplicatedStorage",
        segments: ["ReplicatedStorage"],
        children: []
      }
    ]
  };
  const observedModelOnlySnapshot = {
    projectId: "Game.project.json",
    mounts: [
      {
        id: "ReplicatedStorage",
        segments: ["ReplicatedStorage"],
        children: [
          {
            name: "EsferaTransformacaoBroly",
            className: "Model",
            properties: {},
            children: [
              {
                name: "UpThings",
                className: "Folder",
                properties: {},
                children: [
                  { name: "1", className: "MeshPart", properties: {}, children: [] },
                  { name: "1", className: "MeshPart", properties: {}, children: [] },
                  { name: "1", className: "MeshPart", properties: {}, children: [] }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  assert.equal(hashSnapshot(observedModelOnlySnapshot), hashSnapshot(emptyExpectedSnapshot));
  assert.equal(diffSnapshots(emptyExpectedSnapshot, observedModelOnlySnapshot).changeCount, 0);
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
    corrected: true,
    snapshot: {
      projectId: "Game.project.json",
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
  await app.drainPendingStudioWrites();
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

  await app.drainPendingStudioWrites();

  assert.equal(app.sessions.get(result.session.id).connectionState, "ready");
  assert.match(
    fs.readFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "utf8"),
    /return 42/
  );
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

test("workspace watcher ignores Studio snapshot disk writes instead of echoing them back", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.writeFileSync(scriptPath, "return 20", "utf8");

  app.pendingStudioWrites.set(session.id, {
    sessionId: session.id,
    reason: "apply_project_tree_corrected",
    snapshotHash: null,
    queuedAt: Date.now(),
    updatedAt: Date.now(),
    timer: null,
    running: true,
    promise: Promise.resolve(),
    resolve: () => {}
  });
  app.onWorkspaceFileChanged(scriptPath);
  await wait(320);
  assert.equal(session.pendingCommands.length, 0);

  app.pendingStudioWrites.clear();
  app.lastDiskWriteTime = Date.now();
  fs.writeFileSync(scriptPath, "return 21", "utf8");
  app.onWorkspaceFileChanged(scriptPath);
  await wait(320);
  assert.equal(session.pendingCommands.length, 0);

  app.lastDiskWriteTime = Date.now() - 2000;
  app.onWorkspaceFileChanged(scriptPath);
  await wait(320);
  assert.equal(session.pendingCommands.length, 1);
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

test("large VS Code script edit bursts fall back to a project tree apply", async () => {
  const workspace = createWorkspaceWithProject();
  const serviceRoot = path.join(workspace, "sync", "ServerScriptService");
  for (let index = 0; index < 25; index++) {
    fs.writeFileSync(path.join(serviceRoot, `Burst${index}.server.luau`), `return ${index}`, "utf8");
  }
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  for (let index = 0; index < 25; index++) {
    const scriptPath = path.join(serviceRoot, `Burst${index}.server.luau`);
    fs.writeFileSync(scriptPath, `return ${index + 100}`, "utf8");
    app.onWorkspaceFileChanged(scriptPath);
  }
  await wait(180);

  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "apply_project_tree");
  assert.equal(session.pendingCommands[0].payload.reason, "workspace_patch_burst");
  const script = findSnapshotNodeByPath(session.pendingCommands[0].payload.project, ["ServerScriptService", "Burst24"]);
  assert.equal(script.source, "return 124");
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

test("sync guard gives Studio more time after an apply command is picked up", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  const snapshot = readLocalProjectState(project);

  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: snapshot,
    reason: "test_pickup"
  }, false, 10);

  const dequeued = app.dequeueCommands(session.id);
  await wait(25);

  assert.equal(session.sync.state, "ready");
  assert.equal(dequeued.commands.length, 1);

  app.completeCommand(session.id, dequeued.commands[0].id, {
    ok: true,
    snapshot
  });

  assert.equal(session.sync.state, "ready");
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

test("MCP pull_changes can recover a degraded session with a verified apply", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  const snapshot = readLocalProjectState(project);

  app.markSyncDegraded(session, "test degradation");
  const resultPromise = handleTool(app, "pull_changes", { sessionId: session.id });

  await waitForPendingCommand(session);
  const command = app.dequeueCommands(session.id).commands[0];
  assert.equal(command.type, "apply_project_tree");
  assert.equal(command.payload.reason, "mcp_pull");

  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot
  });
  const toolResult = await resultPromise;
  const parsed = JSON.parse(toolResult.content[0].text);

  assert.equal(parsed.ok, true);
  assert.equal(session.sync.state, "ready");
  assert.equal(session.sync.degradedReason, null);
});

test("MCP get_tree caches Studio snapshots without writing them to disk", async () => {
  const workspace = createWorkspaceWithProject();
  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const studioSnapshot = readLocalProjectState(app.getProjectById(session.projectId));
  studioSnapshot.mounts[0].children[0].source = "return 99";

  const resultPromise = handleTool(app, "get_tree", { sessionId: session.id });
  await wait(25);

  const command = app.dequeueCommands(session.id).commands[0];
  assert.equal(command.type, "get_tree");
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: studioSnapshot
  });

  const toolResult = await resultPromise;
  const parsed = JSON.parse(toolResult.content[0].text);
  await app.drainPendingStudioWrites(1000);

  assert.equal(parsed.mounts[0].children[0].source, "return 99");
  assert.equal(session.lastStudioHash, hashSnapshot(studioSnapshot));
  assert.equal(fs.readFileSync(scriptPath, "utf8"), "return 1");
  assert.equal(app.pendingStudioWrites.size, 0);
});

test("MCP push_changes explicitly persists Studio snapshots to disk", async () => {
  const workspace = createWorkspaceWithProject();
  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const studioSnapshot = readLocalProjectState(app.getProjectById(session.projectId));
  studioSnapshot.mounts[0].children[0].source = "return 99";

  const resultPromise = handleTool(app, "push_changes", { sessionId: session.id });
  await wait(25);

  const command = app.dequeueCommands(session.id).commands[0];
  assert.equal(command.type, "get_tree");
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: studioSnapshot
  });

  const toolResult = await resultPromise;
  const parsed = JSON.parse(toolResult.content[0].text);
  await app.drainPendingStudioWrites(1000);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshotHash, hashSnapshot(studioSnapshot));
  assert.equal(fs.readFileSync(scriptPath, "utf8"), "return 99");
});

test("apply project tree accepts semantically equivalent Studio snapshots", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  const expectedSnapshot = readLocalProjectState(project);
  const studioSnapshot = cloneJson(expectedSnapshot);
  const studioNode = studioSnapshot.mounts[0].children[0];
  delete studioSnapshot.name;
  delete studioSnapshot.placeIds;
  delete studioSnapshot.mounts[0].absolutePath;
  delete studioSnapshot.mounts[0].relativePath;
  delete studioNode.ext;
  studioNode.classNameSource = "studio";
  studioNode.source = "return 1\n";

  app.markSyncDegraded(session, "test degradation");
  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: expectedSnapshot,
    reason: "manual_resync"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: studioSnapshot
  });

  assert.equal(session.sync.state, "ready");
  assert.equal(session.sync.degradedReason, null);
  assert.equal(session.sync.lastExpectedHash, session.sync.lastObservedHash);
});

test("corrected apply snapshots accept safe Studio class preservation only", async () => {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "sync", "StarterGui", "MainGui"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      StarterGui: {
        $path: "sync/StarterGui"
      }
    }
  }, null, 2));
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  const expectedSnapshot = readLocalProjectState(project);
  const correctedSnapshot = cloneJson(expectedSnapshot);
  correctedSnapshot.mounts[0].children[0].className = "ScreenGui";
  correctedSnapshot.mounts[0].children[0].classNameSource = "studio";

  app.markSyncDegraded(session, "test degradation");
  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: expectedSnapshot,
    reason: "manual_resync"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: correctedSnapshot,
    corrected: true
  });

  assert.equal(session.sync.state, "ready");
  assert.equal(session.sync.degradedReason, null);
  assert.notEqual(session.sync.lastExpectedHash, session.sync.lastObservedHash);
});

test("corrected apply snapshots still degrade when source differs", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  const expectedSnapshot = readLocalProjectState(project);
  const correctedSnapshot = readLocalProjectState(project);
  correctedSnapshot.mounts[0].children[0].source = "return 'not expected'";

  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: expectedSnapshot,
    reason: "manual_resync"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: correctedSnapshot,
    corrected: true
  });

  assert.equal(session.sync.state, "degraded");
  const errors = app.errorTracker.query({ code: "SYNC-HASH-MISMATCH", limit: 1 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context.mismatchSummary.changes[0].type, "source");
});

test("apply project tree with a mismatched Studio snapshot marks sync degraded", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  const expectedSnapshot = readLocalProjectState(project);
  const staleSnapshot = readLocalProjectState(project);
  staleSnapshot.mounts[0].children[0].source = "return 'stale'";

  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: expectedSnapshot,
    reason: "manual_resync"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: staleSnapshot
  });

  assert.equal(session.sync.state, "degraded");
  assert.match(session.sync.degradedReason, /hash did not match/);
  assert.notEqual(session.sync.lastExpectedHash, session.sync.lastObservedHash);
  const errors = app.errorTracker.query({ code: "SYNC-HASH-MISMATCH", limit: 1 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context.mismatchSummary.changes[0].type, "source");
  assert.equal(app.pendingStudioWrites.size, 0);
});

test("ambiguous script suffixes block project tree apply without repairing files", async () => {
  const workspace = createWorkspaceWithProject();
  const ambiguousPath = path.join(workspace, "sync", "ServerScriptService", "Broken.server.server.luau");
  fs.writeFileSync(ambiguousPath, "return 'broken'", "utf8");
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);

  await assert.rejects(
    app.enqueueCommand(session.id, "apply_project_tree", {
      project: readLocalProjectState(project),
      reason: "manual_resync"
    }, true),
    /ambiguous script filename/
  );

  assert.equal(session.sync.state, "degraded");
  assert.equal(fs.existsSync(ambiguousPath), true);
  assert.equal(fs.existsSync(path.join(workspace, "sync", "ServerScriptService", "Broken.server.luau")), false);
  const errors = app.errorTracker.query({ code: "PROJECT-TREE-INVALID", limit: 1 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context.issues[0].relativePath, "Broken.server.server.luau");
  assert.equal(errors[0].context.issues[0].suggestedFileName, "Broken.server.luau");
});

test("stale apply project tree mismatch retries the latest workspace instead of pausing sync", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  const expectedSnapshot = readLocalProjectState(project);
  const mismatchedSnapshot = readLocalProjectState(project);
  mismatchedSnapshot.mounts[0].children[0].source = "return 'studio-stale'";

  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: expectedSnapshot,
    reason: "file_patch_mismatch"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  fs.writeFileSync(scriptPath, "return 42", "utf8");

  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: mismatchedSnapshot
  });

  assert.equal(session.sync.state, "ready");
  assert.equal(session.sync.degradedReason, null);
  const warnings = app.errorTracker.query({ code: "SYNC-HASH-MISMATCH-STALE", limit: 1 });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].context.action, "queued_latest_project_tree");

  await wait(120);
  const fallback = app.dequeueCommands(session.id).commands[0];
  assert.equal(fallback.type, "apply_project_tree");
  assert.equal(fallback.payload.reason, "project_tree_changed_during_apply");
  assert.notEqual(hashSnapshot(fallback.payload.project), hashSnapshot(expectedSnapshot));
  const script = findSnapshotNodeByPath(fallback.payload.project, ["ServerScriptService", "Hello"]);
  assert.equal(script.source, "return 42");
});

test("stale apply project tree mismatch verifies when Studio already matches the latest workspace", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const project = app.getProjectById(session.projectId);
  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  const expectedSnapshot = readLocalProjectState(project);

  await app.enqueueCommand(session.id, "apply_project_tree", {
    project: expectedSnapshot,
    reason: "workspace_changed"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  fs.writeFileSync(scriptPath, "return 99", "utf8");
  const currentSnapshot = readLocalProjectState(project);

  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: currentSnapshot
  });

  assert.equal(session.sync.state, "ready");
  assert.equal(session.pendingCommands.length, 0);
  assert.equal(session.sync.lastObservedHash, hashSnapshot(currentSnapshot));
  const warnings = app.errorTracker.query({ code: "SYNC-HASH-MISMATCH-STALE", limit: 1 });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].context.action, "verified_current_workspace");
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

test("verified fast file patch tolerates Studio final newline normalization", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  app.enqueueCommand(session.id, "apply_file_patch", {
    path: ["ServerScriptService", "Hello"],
    source: "return 11"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  const verifiedSnapshot = readLocalProjectState(app.getProjectById(session.projectId));
  verifiedSnapshot.mounts[0].children[0].source = "return 11\n";
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: verifiedSnapshot
  });

  assert.equal(session.sync.state, "ready");
  const script = findSnapshotNodeByPath(session.lastStudioSnapshot, ["ServerScriptService", "Hello"]);
  assert.equal(script.source, "return 11\n");
});

test("fast file patch with a stale Studio snapshot falls back to full tree apply", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  app.enqueueCommand(session.id, "apply_file_patch", {
    path: ["ServerScriptService", "Hello"],
    source: "return 99"
  });
  const command = app.dequeueCommands(session.id).commands[0];
  const staleSnapshot = readLocalProjectState(app.getProjectById(session.projectId));
  staleSnapshot.mounts[0].children[0].source = "return 1";
  app.completeCommand(session.id, command.id, {
    ok: true,
    snapshot: staleSnapshot
  });

  assert.equal(session.sync.state, "ready");
  await wait(100);
  const fallback = app.dequeueCommands(session.id).commands[0];
  assert.equal(fallback.type, "apply_project_tree");
  assert.equal(fallback.payload.reason, "file_patch_mismatch");
});

test("Studio snapshot writes coalesce bursts and persist the latest snapshot", async () => {
  const workspace = createWorkspaceWithProject();
  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
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
            source: "return 2",
            properties: {},
            children: []
          }
        ]
      }
    ]
  }, "auto");
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
            source: "return 3",
            properties: {},
            children: []
          }
        ]
      }
    ]
  }, "auto");

  assert.equal(app.pendingStudioWrites.size, 1);
  await wait(360);

  assert.equal(app.pendingStudioWrites.size, 0);
  assert.equal(fs.readFileSync(scriptPath, "utf8"), "return 3");
  const helloWrites = app.activityLog
    .query({ limit: 10, includeDetails: true })
    .filter((entry) => entry.relativePath === "sync/ServerScriptService/Hello.server.luau");
  assert.equal(helloWrites.length, 1);
  assert.equal(helloWrites[0].detail.newText, "return 3");
});

test("unchanged Studio snapshots update cache without scheduling disk writes", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const snapshot = {
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
            source: "return 7",
            properties: {},
            children: []
          }
        ]
      }
    ]
  };

  app.updateStudioSnapshot(session.id, snapshot, "auto", { requestByteLength: 123 });
  await app.drainPendingStudioWrites(1000);
  const firstAppliedAt = session.lastAppliedAt;
  const firstHash = session.lastStudioHash;

  app.updateStudioSnapshot(session.id, JSON.parse(JSON.stringify(snapshot)), "auto", { requestByteLength: 456 });

  assert.equal(session.lastStudioHash, firstHash);
  assert.equal(session.lastAppliedAt, firstAppliedAt);
  assert.equal(app.pendingStudioWrites.size, 0);
});

test("Studio snapshot write jobs clean up after skipped and failed writes", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  const snapshot = {
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
            source: "return 2",
            properties: {},
            children: []
          }
        ]
      }
    ]
  };

  const project = app.getProjectById(session.projectId);
  app.allProjects = [];
  app.projects = [];
  app.updateStudioSnapshot(session.id, snapshot, "manual");
  await app.drainPendingStudioWrites(1000);
  assert.equal(app.pendingStudioWrites.size, 0);
  assert.equal(session.lastAppliedAt, null);

  app.allProjects = [project];
  app.projects = [project];
  const blockedMountPath = path.join(workspace, "blocked-mount");
  fs.writeFileSync(blockedMountPath, "not a directory", "utf8");
  project.mounts[0].absolutePath = blockedMountPath;

  app.updateStudioSnapshot(session.id, snapshot, "manual");
  await app.drainPendingStudioWrites(1000);

  assert.equal(app.pendingStudioWrites.size, 0);
  assert.equal(session.sync.state, "degraded");
  assert.match(session.sync.degradedReason, /Failed to write Studio snapshot to disk/);
});

test("daemon stop flushes pending Studio snapshot writes immediately", async () => {
  const workspace = createWorkspaceWithProject();
  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
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
            source: "return 'stopped'",
            properties: {},
            children: []
          }
        ]
      }
    ]
  }, "auto");
  assert.equal(app.pendingStudioWrites.size, 1);

  const startedAt = Date.now();
  await app.stop();

  assert.ok(Date.now() - startedAt < 250);
  assert.equal(fs.readFileSync(scriptPath, "utf8"), "return 'stopped'");
  assert.equal(app.pendingStudioWrites.size, 0);
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
