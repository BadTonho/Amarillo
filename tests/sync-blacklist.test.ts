"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PluginRobloxApp } = require("../src/daemon/app");
const {
  filterSnapshotBySyncBlacklist,
  normalizeSyncBlacklist
} = require("../src/daemon/sync-blacklist");
const {
  loadWorkspaceProjectCatalog,
  parseProjectFile,
  readLocalProjectState,
  writeStudioProjectState
} = require("../src/daemon/project");
const { createTempDirectory } = require("./helpers/test-temp");
const { invoke } = require("./helpers/daemon-workspace");

function createBlacklistWorkspace(blacklist = []) {
  const workspace = createTempDirectory("amarillo-blacklist-");
  const mountRoot = path.join(workspace, "sync", "Workspace");
  fs.mkdirSync(path.join(mountRoot, "Worlds", "World1", "chao", "CharQuadrado"), { recursive: true });
  fs.mkdirSync(path.join(mountRoot, "Worlds", "World1", "chao", "Visible"), { recursive: true });
  fs.writeFileSync(
    path.join(mountRoot, "Worlds", "World1", "chao", "CharQuadrado", "Floor.server.luau"),
    "return 'floor'",
    "utf8"
  );
  fs.writeFileSync(
    path.join(mountRoot, "Worlds", "World1", "chao", "Visible", "Keep.server.luau"),
    "return 'keep'",
    "utf8"
  );
  fs.writeFileSync(path.join(workspace, "Game.project.json"), JSON.stringify({
    name: "Game",
    tree: {
      $className: "DataModel",
      Workspace: { $path: "sync/Workspace" }
    },
    syncBlacklist: blacklist
  }, null, 2));
  return workspace;
}

function blacklistEntry(id = "floor-id") {
  return {
    id,
    path: "Workspace.Worlds.World1.chao.CharQuadrado",
    name: "CharQuadrado",
    className: "Folder"
  };
}

function node(name, children = [], extra = {}) {
  return {
    name,
    className: "Folder",
    properties: {},
    children,
    ...extra
  };
}

test("local snapshots remove a blacklisted subtree by its original path", () => {
  const workspace = createBlacklistWorkspace([blacklistEntry()]);
  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);
  const snapshot = readLocalProjectState(project);
  const workspaceMount = snapshot.mounts.find((mount) => mount.id === "Workspace");
  const chao = workspaceMount.children.find((child) => child.name === "Worlds")
    .children.find((child) => child.name === "World1")
    .children.find((child) => child.name === "chao");

  assert.equal(chao.children.some((child) => child.name === "CharQuadrado"), false);
  assert.equal(chao.children.some((child) => child.name === "Visible"), true);
});

test("Studio snapshots remove a moved or renamed blacklisted subtree by AmarilloId", () => {
  const filtered = filterSnapshotBySyncBlacklist({
    mounts: [{
      id: "Workspace",
      segments: ["Workspace"],
      children: [
        node("RenamedFloor", [node("Part", [], { amarilloId: "child-id" })], { amarilloId: "floor-id" }),
        node("Keep")
      ]
    }]
  }, [blacklistEntry()], "studio");

  assert.deepEqual(filtered.mounts[0].children.map((child) => child.name), ["Keep"]);
});

test("blacklisted geometry changes do not affect the semantic diff or hash", () => {
  const rules = [blacklistEntry()];
  const pc = {
    projectId: "Game.project.json",
    mounts: [{
      id: "Workspace",
      segments: ["Workspace"],
      children: [node("Keep")]
    }]
  };
  const studio = {
    projectId: "Game.project.json",
    mounts: [{
      id: "Workspace",
      segments: ["Workspace"],
      children: [
        node("CharQuadrado", [], {
          amarilloId: "floor-id",
          properties: { CFrame: "changed", Size: "changed" }
        }),
        node("Keep")
      ]
    }]
  };
  const filteredStudio = filterSnapshotBySyncBlacklist(studio, rules, "studio");
  const filteredPc = filterSnapshotBySyncBlacklist(pc, rules, "local");
  assert.deepEqual(filteredStudio, filteredPc);
});

test("syncback preserves the local blacklisted folder and its files", () => {
  const workspace = createBlacklistWorkspace([blacklistEntry()]);
  const project = parseProjectFile(path.join(workspace, "Game.project.json"), workspace);
  const floorFile = path.join(
    workspace,
    "sync",
    "Workspace",
    "Worlds",
    "World1",
    "chao",
    "CharQuadrado",
    "Floor.server.luau"
  );

  writeStudioProjectState(project, {
    mounts: [{
      id: "Workspace",
      segments: ["Workspace"],
      children: [
        node("Worlds", [node("World1", [node("chao", [node("CharQuadrado", [], { amarilloId: "floor-id" })])])]),
        node("Visible", [node("NewFolder")])
      ]
    }]
  });

  assert.equal(fs.existsSync(floorFile), true);
  assert.equal(fs.readFileSync(floorFile, "utf8"), "return 'floor'");
});

test("blacklist route persists entries, filters filesystem events, and deduplicates inheritance", async () => {
  const workspace = createBlacklistWorkspace();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();
  const { session } = app.openSession(0, null, { syncTargets: { Workspace: true } });
  const floorFile = path.join(workspace, "sync", "Workspace", "Worlds", "World1", "chao", "CharQuadrado", "Floor.server.luau");

  const response = await invoke(app, "POST", `/session/${session.id}/sync-blacklist`, {
    action: "add",
    entries: [blacklistEntry()]
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.syncBlacklist, [blacklistEntry()]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, "Game.project.json"), "utf8")).syncBlacklist.length, 1);

  const before = session.pendingCommands.length;
  const watcherResult = app.handleWorkspaceFileEvents([{ type: "change", path: floorFile }]);
  assert.equal(watcherResult.accepted, 1);
  assert.equal(session.pendingCommands.length, before);

  const patchResponse = await invoke(app, "POST", "/studio/patch-source", {
    sessionId: session.id,
    path: ["Workspace", "Worlds", "World1", "chao", "CharQuadrado", "Floor"],
    source: "return 'must stay local'"
  });
  assert.equal(patchResponse.statusCode, 200);
  assert.equal(patchResponse.payload.reason, "sync_blacklist");
  assert.equal(fs.readFileSync(floorFile, "utf8"), "return 'floor'");

  const removeResponse = await invoke(app, "POST", `/session/${session.id}/sync-blacklist`, {
    action: "remove",
    entries: [{ id: "floor-id" }]
  });
  assert.equal(removeResponse.statusCode, 200);
  assert.deepEqual(removeResponse.payload.syncBlacklist, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, "Game.project.json"), "utf8")).syncBlacklist, []);

  assert.deepEqual(normalizeSyncBlacklist([
    blacklistEntry(),
    { ...blacklistEntry(), name: "Duplicate" },
    { id: "second", path: "Workspace.Other" }
  ]).map((entry) => entry.id), ["floor-id", "second"]);
});

test("derived projects inherit and deduplicate blacklist entries", () => {
  const workspace = createTempDirectory("amarillo-blacklist-inherit-");
  const inherited = blacklistEntry("shared-floor");
  fs.writeFileSync(path.join(workspace, "Base.project.json"), JSON.stringify({
    name: "Base",
    abstract: true,
    syncBlacklist: [inherited],
    tree: { Workspace: { $path: "sync/Workspace" } }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "Place.project.json"), JSON.stringify({
    name: "Place",
    extends: "Base.project.json",
    syncBlacklist: [{ ...inherited, name: "Same id from child" }, blacklistEntry("place-floor")],
    tree: {}
  }, null, 2));

  const catalog = loadWorkspaceProjectCatalog(workspace);
  const place = catalog.selectableProjects.find((project) => project.id === "Place.project.json");
  assert.deepEqual(place.syncBlacklist.map((entry) => entry.id), ["shared-floor", "place-floor"]);
  assert.equal(place.syncBlacklist[0].name, "CharQuadrado");
});
