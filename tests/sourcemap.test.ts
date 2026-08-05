"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildRojoSourcemapArgs,
  ensureWorkspaceSourcemap,
  resolveSourcemapProjectFile,
  sourcemapNeedsGeneration
} = require("../vscode-extension/sourcemap");
const { createTempDirectory } = require("./helpers/test-temp");

function createTempWorkspace() {
  return createTempDirectory("amarillo-sourcemap-");
}

test("resolveSourcemapProjectFile prefers workspace-named project", () => {
  const workspace = createTempWorkspace();
  const projectFiles = [
    path.join(workspace, "Other.project.json"),
    path.join(workspace, `${path.basename(workspace)}.project.json`)
  ];

  const resolved = resolveSourcemapProjectFile(workspace, projectFiles);
  assert.equal(resolved, path.join(workspace, `${path.basename(workspace)}.project.json`));
});

test("sourcemapNeedsGeneration detects missing and invalid files", () => {
  const workspace = createTempWorkspace();
  const sourcemapPath = path.join(workspace, "sourcemap.json");
  assert.equal(sourcemapNeedsGeneration(sourcemapPath), true);

  fs.writeFileSync(sourcemapPath, "{ invalid", "utf8");
  assert.equal(sourcemapNeedsGeneration(sourcemapPath), true);

  fs.writeFileSync(sourcemapPath, JSON.stringify({ name: "ok" }), "utf8");
  assert.equal(sourcemapNeedsGeneration(sourcemapPath), false);
});

test("buildRojoSourcemapArgs uses workspace-relative paths", () => {
  const workspace = createTempWorkspace();
  const args = buildRojoSourcemapArgs(
    workspace,
    path.join(workspace, "Game.project.json"),
    path.join(workspace, "sourcemap.json")
  );

  assert.deepEqual(args, [
    "sourcemap",
    "--include-non-scripts",
    "Game.project.json",
    "--output",
    "sourcemap.json"
  ]);
});

test("ensureWorkspaceSourcemap updates luau settings and generates missing sourcemap", async () => {
  const workspace = createTempWorkspace();
  const projectPath = path.join(workspace, "Game.project.json");
  fs.writeFileSync(projectPath, JSON.stringify({ name: "Game", tree: {} }, null, 2), "utf8");

  let commandInvocation = null;
  const result = await ensureWorkspaceSourcemap(workspace, {
    projectFiles: [projectPath],
    runCommand: async (command, args, options) => {
      commandInvocation = { command, args, options };
      fs.writeFileSync(path.join(workspace, "sourcemap.json"), JSON.stringify({ generated: true }), "utf8");
      return { stdout: "", stderr: "" };
    },
    commandCandidates: ["rojo"]
  });

  assert.equal(result.projectFilePath, projectPath);
  assert.equal(result.settingsUpdated, true);
  assert.equal(result.sourcemapGenerated, true);
  assert.equal(commandInvocation.command, "rojo");
  assert.deepEqual(commandInvocation.args, [
    "sourcemap",
    "--include-non-scripts",
    "Game.project.json",
    "--output",
    "sourcemap.json"
  ]);

  const settings = JSON.parse(fs.readFileSync(path.join(workspace, ".vscode", "settings.json"), "utf8"));
  assert.equal(settings["luau-lsp.sourcemap.rojoProjectFile"], "Game.project.json");
  assert.equal(settings["luau-lsp.sourcemap.sourcemapFile"], "sourcemap.json");
});

test("ensureWorkspaceSourcemap regenerates when the active project changes", async () => {
  const workspace = createTempWorkspace();
  const baseProjectPath = path.join(workspace, "Base.project.json");
  const lobbyProjectPath = path.join(workspace, "Lobby.project.json");
  fs.writeFileSync(baseProjectPath, JSON.stringify({ name: "Base", tree: {} }, null, 2), "utf8");
  fs.writeFileSync(lobbyProjectPath, JSON.stringify({ name: "Lobby", tree: {} }, null, 2), "utf8");
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
    "luau-lsp.sourcemap.rojoProjectFile": "Base.project.json"
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(workspace, "sourcemap.json"), JSON.stringify({ generated: true }), "utf8");

  let commandInvocation = null;
  const result = await ensureWorkspaceSourcemap(workspace, {
    projectFiles: [baseProjectPath, lobbyProjectPath],
    projectFilePath: lobbyProjectPath,
    runCommand: async (command, args, options) => {
      commandInvocation = { command, args, options };
      fs.writeFileSync(path.join(workspace, "sourcemap.json"), JSON.stringify({ generatedFor: "Lobby" }), "utf8");
      return { stdout: "", stderr: "" };
    },
    commandCandidates: ["rojo"]
  });

  assert.equal(result.projectFilePath, lobbyProjectPath);
  assert.equal(result.projectChanged, true);
  assert.equal(result.sourcemapGenerated, true);
  assert.equal(commandInvocation.command, "rojo");
  assert.deepEqual(commandInvocation.args, [
    "sourcemap",
    "--include-non-scripts",
    "Lobby.project.json",
    "--output",
    "sourcemap.json"
  ]);

  const settings = JSON.parse(fs.readFileSync(path.join(workspace, ".vscode", "settings.json"), "utf8"));
  assert.equal(settings["luau-lsp.sourcemap.rojoProjectFile"], "Lobby.project.json");
});
