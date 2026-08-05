"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildInstructionsMarkdown,
  ensurePluginInstructionsFile
} = require("../src/daemon/lib/instructions");
const { PluginRobloxApp } = require("../src/daemon/app");
const { createTempDirectory } = require("./helpers/test-temp");

function createTempWorkspace() {
  return createTempDirectory("amarillo-instructions-");
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
  return workspace;
}

test("instructions markdown includes plugin commands and MCP tools", () => {
  const markdown = buildInstructionsMarkdown({
    workspaceRoot: "C:/Workspace",
    projects: [{ id: "Game.project.json", name: "Game" }]
  });

  assert.match(markdown, /## Studio Plugin Commands/);
  assert.match(markdown, /### apply_project_tree/);
  assert.match(markdown, /### modify_property/);
  assert.match(markdown, /Privileged operations are `run_code`/);
  assert.match(markdown, /## Native MCP Workflow/);
  assert.match(markdown, /Start with `health`/);
  assert.match(markdown, /requires `sessionId` should reuse the `id` returned by `health`/);
  assert.match(markdown, /## MCP Tools/);
  assert.match(markdown, /### get_tree/);
  assert.match(markdown, /### delete_instance/);
  assert.match(markdown, /### insert_model/);
  assert.match(markdown, /Treat `run_code` as privileged arbitrary Luau execution/);
  assert.match(markdown, /reasonCode: "SYNC_DEGRADED"/);
  assert.match(markdown, /recover the session with `pull_changes`/);
  assert.match(markdown, /mcp\.jsonl/);
  assert.match(markdown, /reasonCode/);
  assert.match(markdown, /Game\.project\.json/);
});

test("ensurePluginInstructionsFile writes .amarillo/plugin-instructions.md", () => {
  const workspace = createTempWorkspace();
  const result = ensurePluginInstructionsFile({
    workspaceRoot: workspace,
    projects: [{ id: "Game.project.json", name: "Game" }]
  });

  assert.equal(result.changed, true);
  assert.equal(path.basename(result.path), "plugin-instructions.md");
  assert.match(fs.readFileSync(result.path, "utf8"), /Amarillo Plugin Instructions/);
});

test("daemon refresh creates plugin instructions file", () => {
  const workspace = createWorkspaceWithProject();
  const app = new PluginRobloxApp({ workspaceRoot: workspace, host: "127.0.0.1", port: 8323 });
  app.refreshWorkspace();

  const instructionsPath = path.join(workspace, ".amarillo", "plugin-instructions.md");
  assert.equal(fs.existsSync(instructionsPath), true);
  assert.match(fs.readFileSync(instructionsPath, "utf8"), /### list_projects/);
});
