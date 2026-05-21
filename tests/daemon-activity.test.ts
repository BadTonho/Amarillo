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
  await app.drainPendingStudioWrites();

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

test("autoSyncToStudio can be toggled live while activity history still records changes", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);
  seedStudioSnapshotFromLocalProject(app, session);

  const toggle = await invoke(app, "POST", "/settings/auto-sync-to-studio", { enabled: false });
  assert.equal(toggle.statusCode, 200);
  assert.equal(toggle.payload.autoSyncToStudio, false);

  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.writeFileSync(scriptPath, "return 123", "utf8");
  app.onWorkspaceFileChanged(scriptPath);
  await wait(120);

  assert.equal(app.autoSyncToStudio, false);
  assert.equal(session.pendingCommands.length, 0);

  const activity = await invoke(app, "GET", "/activity?limit=1&includeDetails=true");
  assert.equal(activity.statusCode, 200);
  assert.equal(activity.payload.entries[0].action, "modify");
  assert.equal(activity.payload.entries[0].detail.oldText, "return 1");
  assert.equal(activity.payload.entries[0].detail.newText, "return 123");

  const health = await invoke(app, "GET", "/health");
  assert.equal(health.payload.autoSyncToStudio, false);
});

test("privileged action confirmation preference is stored and queued for current Studio sessions", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, {
    studioInstanceId: "studio-current",
    pluginVersion: CURRENT_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    requirePluginVersion: true,
    privilegedActionConfirmationEnabled: true
  });

  const toggle = await invoke(app, "POST", "/settings/privileged-action-confirmation", { enabled: false });
  assert.equal(toggle.statusCode, 200);
  assert.equal(toggle.payload.privilegedActionConfirmation, false);
  assert.deepEqual(toggle.payload.queuedSessionIds, [session.id]);
  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "set_privileged_action_confirmation");
  assert.equal(session.pendingCommands[0].payload.enabled, false);

  const health = await invoke(app, "GET", "/health");
  assert.equal(health.payload.privilegedActionConfirmation, false);
});

test("privileged action confirmation preference is queued when Studio connects later", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const toggle = await invoke(app, "POST", "/settings/privileged-action-confirmation", { enabled: false });
  assert.equal(toggle.statusCode, 200);
  assert.deepEqual(toggle.payload.queuedSessionIds, []);

  const { session } = app.openSession(0, null, {
    studioInstanceId: "studio-current",
    pluginVersion: CURRENT_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    requirePluginVersion: true,
    privilegedActionConfirmationEnabled: true
  });

  assert.equal(session.pendingCommands.length, 1);
  assert.equal(session.pendingCommands[0].type, "set_privileged_action_confirmation");
  assert.equal(session.pendingCommands[0].payload.enabled, false);
});

test("activity entries can revert create, modify, and delete changes with conflict protection", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    autoSyncToStudio: false
  });
  app.refreshWorkspace();
  app.openSession(0, null);

  const serviceRoot = path.join(workspace, "sync", "ServerScriptService");
  const scriptPath = path.join(serviceRoot, "Hello.server.luau");
  const createdPath = path.join(serviceRoot, "Created.server.luau");

  fs.writeFileSync(createdPath, "return 'created'", "utf8");
  app.onWorkspaceFileChanged(createdPath);
  let createEntry = app.activityLog
    .query({ limit: 5, includeDetails: true })
    .find((entry) => entry.action === "create" && entry.relativePath.endsWith("Created.server.luau"));
  assert.equal(createEntry.canRevert, true);
  let revert = await invoke(app, "POST", `/activity/${createEntry.id}/revert`, {});
  assert.equal(revert.statusCode, 200);
  assert.equal(fs.existsSync(createdPath), false);
  assert.equal(revert.payload.entry.reason, "activity_revert");

  fs.writeFileSync(scriptPath, "return 200", "utf8");
  app.onWorkspaceFileChanged(scriptPath);
  let modifyEntry = app.activityLog
    .query({ limit: 10, includeDetails: true })
    .find((entry) => entry.action === "modify" && entry.relativePath.endsWith("Hello.server.luau") && entry.detail.newText === "return 200");
  revert = await invoke(app, "POST", `/activity/${modifyEntry.id}/revert`, {});
  assert.equal(revert.statusCode, 200);
  assert.equal(fs.readFileSync(scriptPath, "utf8"), "return 1");

  fs.writeFileSync(scriptPath, "return 300", "utf8");
  app.onWorkspaceFileChanged(scriptPath);
  const conflictEntry = app.activityLog
    .query({ limit: 10, includeDetails: true })
    .find((entry) => entry.action === "modify" && entry.detail.newText === "return 300");
  fs.writeFileSync(scriptPath, "return 301", "utf8");
  const conflict = await invoke(app, "POST", `/activity/${conflictEntry.id}/revert`, {});
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.payload.code, "ACTIVITY_REVERT_CONFLICT");

  app.onWorkspaceFileChanged(scriptPath);
  fs.rmSync(scriptPath);
  app.onWorkspaceFileChanged(scriptPath);
  const deleteEntry = app.activityLog
    .query({ limit: 10, includeDetails: true })
    .find((entry) => entry.action === "delete" && entry.relativePath.endsWith("Hello.server.luau"));
  revert = await invoke(app, "POST", `/activity/${deleteEntry.id}/revert`, {});
  assert.equal(revert.statusCode, 200);
  assert.equal(fs.readFileSync(scriptPath, "utf8"), "return 301");
});

test("activity delete revert conflicts when the deleted file already exists again", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({
    workspaceRoot: workspace,
    host: "127.0.0.1",
    port: 8323,
    autoSyncToStudio: false
  });
  app.refreshWorkspace();
  app.openSession(0, null);

  const scriptPath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");
  fs.rmSync(scriptPath);
  app.onWorkspaceFileChanged(scriptPath);
  const deleteEntry = app.activityLog.query({ limit: 5 })[0];

  fs.writeFileSync(scriptPath, "return 'recreated'", "utf8");
  const response = await invoke(app, "POST", `/activity/${deleteEntry.id}/revert`, {});
  assert.equal(response.statusCode, 409);
  assert.equal(response.payload.code, "ACTIVITY_REVERT_CONFLICT");
});
