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

// Smoke coverage for the initial Studio handshake path; domain tests live in daemon-*.test.ts.

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
