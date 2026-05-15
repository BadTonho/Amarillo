"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PluginRobloxApp } = require("../src/daemon/app");
const {
  createWorkspaceWithProject,
  createWorkspaceWithInheritedProjects,
  invoke,
  findSnapshotNodeByPath
} = require("./helpers/daemon-workspace");

test("daemon workspace helpers create canonical test projects and invoke daemon routes", async () => {
  const workspace = createWorkspaceWithProject();
  assert.equal(fs.existsSync(path.join(workspace, "Game.project.json")), true);
  assert.equal(fs.readFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "utf8"), "return 1");

  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const health = await invoke(app, "GET", "/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.payload.projectCount, 1);
});

test("daemon inherited workspace helper exposes place-specific projects", () => {
  const workspace = createWorkspaceWithInheritedProjects();
  assert.equal(fs.existsSync(path.join(workspace, "Base.project.json")), true);
  assert.equal(fs.existsSync(path.join(workspace, "Lobby.project.json")), true);
  assert.equal(fs.existsSync(path.join(workspace, "Dungeon.project.json")), true);
});

test("snapshot path helper finds nested nodes by mount path", () => {
  const node = findSnapshotNodeByPath({
    mounts: [{
      segments: ["ServerScriptService"],
      children: [{
        name: "Folder",
        children: [{
          name: "Script",
          children: []
        }]
      }]
    }]
  }, ["ServerScriptService", "Folder", "Script"]);

  assert.equal(node.name, "Script");
});
