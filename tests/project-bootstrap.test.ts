"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildDefaultProjectPath,
  ensureWorkspaceProjectFile
} = require("../vscode-extension/project-bootstrap");
const { createTempDirectory } = require("./helpers/test-temp");

function createTempWorkspace() {
  return createTempDirectory("amarillo-bootstrap-");
}

test("ensureWorkspaceProjectFile creates a default project scaffold when the workspace is empty", async () => {
  const workspace = createTempWorkspace();

  const result = await ensureWorkspaceProjectFile(workspace, () => []);
  const projectPath = buildDefaultProjectPath(workspace);
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));

  assert.equal(result.created, true);
  assert.equal(result.projectFilePath, projectPath);
  assert.equal(project.name, path.basename(workspace));
  assert.equal(project.tree.$className, "DataModel");
  assert.equal(project.tree.ReplicatedStorage.$path, "src/ReplicatedStorage");
  assert.equal(project.tree.ServerScriptService.$path, "src/ServerScriptService");
  assert.equal(project.tree.StarterPlayer.StarterPlayerScripts.$path, "src/StarterPlayer/StarterPlayerScripts");
  assert.equal(project.tree.StarterGui.$path, "src/StarterGui");
  assert.equal(project.tree.Workspace.$path, "src/Workspace");
  assert.equal(fs.existsSync(path.join(workspace, "src", "Workspace")), false);
});

test("ensureWorkspaceProjectFile uses an existing sync root instead of creating src", async () => {
  const workspace = createTempWorkspace();
  fs.mkdirSync(path.join(workspace, "sync", "ServerScriptService"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau"), "return 1", "utf8");

  const result = await ensureWorkspaceProjectFile(workspace, () => []);
  const project = JSON.parse(fs.readFileSync(buildDefaultProjectPath(workspace), "utf8"));

  assert.equal(result.created, true);
  assert.equal(project.tree.ReplicatedStorage.$path, "sync/ReplicatedStorage");
  assert.equal(project.tree.ServerScriptService.$path, "sync/ServerScriptService");
  assert.equal(project.tree.StarterPlayer.StarterPlayerScripts.$path, "sync/StarterPlayer/StarterPlayerScripts");
  assert.equal(project.tree.StarterGui.$path, "sync/StarterGui");
  assert.equal(project.tree.Workspace.$path, "sync/Workspace");
  assert.equal(fs.existsSync(path.join(workspace, "sync", "ReplicatedStorage")), true);
  assert.equal(fs.existsSync(path.join(workspace, "src")), false);
});

test("ensureWorkspaceProjectFile keeps existing project files untouched", async () => {
  const workspace = createTempWorkspace();
  const existingProjectPath = path.join(workspace, "Existing.project.json");
  fs.writeFileSync(existingProjectPath, JSON.stringify({ name: "Existing", tree: {} }, null, 2));

  const result = await ensureWorkspaceProjectFile(workspace, () => [existingProjectPath]);

  assert.equal(result.created, false);
  assert.equal(result.projectFilePath, null);
  assert.deepEqual(result.projectFiles, [existingProjectPath]);
  assert.equal(fs.existsSync(buildDefaultProjectPath(workspace)), false);
});
