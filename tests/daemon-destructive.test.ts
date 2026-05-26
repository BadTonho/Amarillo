"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PluginRobloxApp } = require("../src/daemon/app");
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

function createWorkspaceWithExclusiveReplicatedStorageMount() {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "LoadingScreen", "exclusive", "ReplicatedStorage"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "LoadingScreen.project.json"), JSON.stringify({
    name: "LoadingScreen",
    place_ids: [94245376988608],
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $amarilloDisabledPath: "sync/ReplicatedStorage",
        ExclusivoLoadingScreen: {
          $path: "LoadingScreen/exclusive/ReplicatedStorage"
        }
      }
    }
  }, null, 2));
  return workspace;
}

function createWorkspaceWithExclusiveLoadingScreenMounts() {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "LoadingScreen", "exclusive", "StarterGui"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "LoadingScreen", "exclusive", "StarterPlayer", "StarterPlayerScripts"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "LoadingScreen.project.json"), JSON.stringify({
    name: "LoadingScreen",
    place_ids: [94245376988608],
    tree: {
      $className: "DataModel",
      StarterGui: {
        $amarilloDisabledPath: "sync/StarterGui",
        ExclusivoLoadingScreen: {
          $path: "LoadingScreen/exclusive/StarterGui",
          $keepUnknowns: true
        }
      },
      StarterPlayer: {
        StarterPlayerScripts: {
          $amarilloDisabledPath: "sync/StarterPlayer/StarterPlayerScripts",
          ExclusivoLoadingScreen: {
            $path: "LoadingScreen/exclusive/StarterPlayer/StarterPlayerScripts",
            $keepUnknowns: true
          }
        }
      }
    }
  }, null, 2));
  return workspace;
}

test("runStudioCode removes success text from the error field", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null);

  const resultPromise = app.runStudioCode(session.id, "return 'ok'");
  const command = app.dequeueCommands(session.id).commands[0];
  app.completeCommand(session.id, command.id, {
    ok: true,
    result: "ok",
    error: "ok"
  });

  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.result, "ok");
  assert.equal(Object.prototype.hasOwnProperty.call(result, "error"), false);
});

test("runStudioCode is blocked by privileged action policy gates", async () => {
  const cases = [
    {
      name: "not ready",
      mutate(session) {
        session.connectionState = "waiting";
      },
      reasonCode: "SESSION_NOT_READY"
    },
    {
      name: "plugin update required",
      options: {
        requirePluginVersion: true,
        pluginVersion: "1.1.1",
        pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION
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
      name: "confirmation pending",
      mutate(session) {
        session.destructiveConfirmationPending = true;
        session.destructiveConfirmationType = "run_code";
        session.destructiveConfirmationSinceAt = new Date().toISOString();
      },
      reasonCode: "DESTRUCTIVE_CONFIRMATION_PENDING"
    },
    {
      name: "studio contact critical",
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
    const { session } = app.openSession(0, null, {
      connectionState: "ready",
      truthSource: "pc",
      ...(testCase.options || {})
    });
    session.lastStudioSeenAt = new Date().toISOString();
    if (testCase.mutate) {
      testCase.mutate(session, app);
    }

    const result = await app.runStudioCode(session.id, "return 'blocked'");
    assert.equal(result.ok, false, `${testCase.name} should return ok=false`);
    assert.equal(result.blocked, true, `${testCase.name} should be blocked`);
    assert.equal(result.confirmed, false);
    assert.equal(result.reasonCode, testCase.reasonCode);
    assert.equal(session.pendingCommands.length, 0, `${testCase.name} should not enqueue run_code`);
  }
});

test("declined run_code completions are returned to the caller", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, { connectionState: "ready", truthSource: "pc" });
  session.lastStudioSeenAt = new Date().toISOString();

  const resultPromise = app.runStudioCode(session.id, "return 'nope'");
  const dequeued = app.dequeueCommands(session.id);
  assert.equal(dequeued.commands.length, 1);
  assert.equal(dequeued.commands[0].type, "run_code");

  const response = await invoke(app, "POST", "/studio/complete", {
    sessionId: session.id,
    commandId: dequeued.commands[0].id,
    ok: false,
    error: "Privileged action declined by user.",
    blocked: false,
    declined: true,
    confirmed: false,
    reasonCode: "DECLINED_BY_USER",
    pluginVersion: MIN_PLUGIN_VERSION,
    pluginProtocolVersion: AMARILLO_PROTOCOL_VERSION,
    privilegedActionConfirmationEnabled: true
  });
  assert.equal(response.statusCode, 200);

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.declined, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.reasonCode, "DECLINED_BY_USER");
  assert.equal(result.error, "Privileged action declined by user.");
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
      name: "destructive confirmation pending",
      mutate(session) {
        session.destructiveConfirmationPending = true;
        session.destructiveConfirmationType = "create_instance";
        session.destructiveConfirmationSinceAt = new Date().toISOString();
      },
      reasonCode: "DESTRUCTIVE_CONFIRMATION_PENDING"
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

test("path-based destructive actions are blocked outside active project mounts", async () => {
  const workspace = createWorkspaceWithExclusiveReplicatedStorageMount();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(94245376988608, null, { connectionState: "ready", truthSource: "pc" });
  session.lastStudioSeenAt = new Date().toISOString();

  const blockedCreate = await app.enqueueDestructiveCommand(session.id, "create_instance", {
    parentPath: "game.ReplicatedStorage",
    className: "ModuleScript",
    name: "ModuleScript",
    properties: {}
  });

  assert.equal(blockedCreate.ok, false);
  assert.equal(blockedCreate.blocked, true);
  assert.equal(blockedCreate.reasonCode, "OUTSIDE_SYNC_MOUNT");
  assert.match(blockedCreate.error, /game\.ReplicatedStorage\.ModuleScript/);
  assert.match(blockedCreate.error, /game\.ReplicatedStorage\.ExclusivoLoadingScreen/);
  assert.equal(session.pendingCommands.length, 0);

  const blockedModify = await app.enqueueDestructiveCommand(session.id, "modify_property", {
    path: "game.ReplicatedStorage.ModuleScript",
    property: "Name",
    value: "StillOutside"
  });
  assert.equal(blockedModify.blocked, true);
  assert.equal(blockedModify.reasonCode, "OUTSIDE_SYNC_MOUNT");
  assert.equal(session.pendingCommands.length, 0);

  const blockedDelete = await app.enqueueDestructiveCommand(session.id, "delete_instance", {
    path: "game.ReplicatedStorage.ModuleScript"
  });
  assert.equal(blockedDelete.blocked, true);
  assert.equal(blockedDelete.reasonCode, "OUTSIDE_SYNC_MOUNT");
  assert.equal(session.pendingCommands.length, 0);

  const allowedPromise = app.enqueueDestructiveCommand(session.id, "create_instance", {
    parentPath: "game.ReplicatedStorage.ExclusivoLoadingScreen",
    className: "ModuleScript",
    name: "InsideMount",
    properties: {}
  });
  await wait(10);

  const dequeued = app.dequeueCommands(session.id);
  assert.equal(dequeued.commands.length, 1);
  assert.equal(dequeued.commands[0].type, "create_instance");
  assert.equal(dequeued.commands[0].payload.parentPath, "game.ReplicatedStorage.ExclusivoLoadingScreen");

  app.completeCommand(session.id, dequeued.commands[0].id, {
    ok: true,
    result: "Instance created successfully",
    fullName: "ReplicatedStorage.ExclusivoLoadingScreen.InsideMount",
    confirmed: true
  });

  const allowedResult = await allowedPromise;
  assert.equal(allowedResult.ok, true);
  assert.equal(allowedResult.blocked, false);
});

test("path-based destructive actions are blocked for duplicate exclusive mount roots", async () => {
  const workspace = createWorkspaceWithExclusiveLoadingScreenMounts();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(94245376988608, null, { connectionState: "ready", truthSource: "pc" });
  session.lastStudioSeenAt = new Date().toISOString();

  const blockedCreate = await app.enqueueDestructiveCommand(session.id, "create_instance", {
    parentPath: "game.StarterGui.ExclusivoLoadingScreen",
    className: "Folder",
    name: "ExclusivoLoadingScreen",
    properties: {}
  });
  assert.equal(blockedCreate.ok, false);
  assert.equal(blockedCreate.blocked, true);
  assert.equal(blockedCreate.reasonCode, "DUPLICATE_MOUNT_ROOT");
  assert.match(blockedCreate.error, /game\.StarterGui\.ExclusivoLoadingScreen\.ExclusivoLoadingScreen/);
  assert.match(blockedCreate.error, /game\.StarterGui\.ExclusivoLoadingScreen/);
  assert.equal(session.pendingCommands.length, 0);

  const blockedModify = await app.enqueueDestructiveCommand(session.id, "modify_property", {
    path: "game.StarterGui.ExclusivoLoadingScreen.ExclusivoLoadingScreen",
    property: "Name",
    value: "StillDuplicate"
  });
  assert.equal(blockedModify.blocked, true);
  assert.equal(blockedModify.reasonCode, "DUPLICATE_MOUNT_ROOT");
  assert.equal(session.pendingCommands.length, 0);

  const blockedDelete = await app.enqueueDestructiveCommand(session.id, "delete_instance", {
    path: "game.StarterGui.ExclusivoLoadingScreen.ExclusivoLoadingScreen"
  });
  assert.equal(blockedDelete.blocked, true);
  assert.equal(blockedDelete.reasonCode, "DUPLICATE_MOUNT_ROOT");
  assert.equal(session.pendingCommands.length, 0);

  const allowedPromise = app.enqueueDestructiveCommand(session.id, "create_instance", {
    parentPath: "game.StarterGui.ExclusivoLoadingScreen",
    className: "ScreenGui",
    name: "Loading",
    properties: {}
  });
  await wait(10);

  const dequeued = app.dequeueCommands(session.id);
  assert.equal(dequeued.commands.length, 1);
  assert.equal(dequeued.commands[0].type, "create_instance");
  assert.equal(dequeued.commands[0].payload.name, "Loading");

  app.completeCommand(session.id, dequeued.commands[0].id, {
    ok: true,
    result: "Instance created successfully",
    fullName: "StarterGui.ExclusivoLoadingScreen.Loading",
    confirmed: true
  });

  const allowedResult = await allowedPromise;
  assert.equal(allowedResult.ok, true);
  assert.equal(allowedResult.blocked, false);
});

test("destructive confirmation pending is surfaced in health", async () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, { connectionState: "ready", truthSource: "pc" });
  session.lastStudioSeenAt = new Date().toISOString();
  app.updateDestructiveConfirmationState(session, {
    destructiveConfirmationPending: true,
    destructiveConfirmationType: "delete_instance",
    destructiveConfirmationSinceAt: new Date(Date.now() - 5000).toISOString()
  });

  const health = await invoke(app, "GET", "/health");
  const summary = health.payload.sessions[0];
  assert.equal(summary.destructiveConfirmationPending, true);
  assert.equal(summary.destructiveConfirmationType, "delete_instance");
  assert.equal(summary.destructiveActionReasonCode, "DESTRUCTIVE_CONFIRMATION_PENDING");
  assert.equal(summary.destructiveActionsAllowed, false);
  assert.ok(summary.destructiveConfirmationAgeMs >= 0);
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
