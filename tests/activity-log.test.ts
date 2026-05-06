"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ActivityLog } = require("../src/daemon/lib/activity-log");

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-activity-"));
}

test("ActivityLog writes JSONL and Markdown timeline entries", () => {
  const workspace = createTempWorkspace();
  const log = new ActivityLog({ workspaceRoot: workspace });
  const filePath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");

  const record = log.add({
    timestamp: "2026-05-04T10:00:00.000Z",
    action: "create",
    path: filePath,
    projectId: "Game.project.json",
    mountId: "ServerScriptService",
    direction: "pc_to_studio",
    source: "workspace_watcher",
    reason: "workspace_changed",
    sessionId: "session-1",
    size: 8,
    hash: "hash-1"
  });

  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.relativePath, "sync/ServerScriptService/Hello.server.luau");

  const jsonlPath = path.join(workspace, ".amarillo", "activity", "2026-05-04", "activity.jsonl");
  const markdownPath = path.join(workspace, ".amarillo", "activity", "2026-05-04", "activity.md");
  assert.equal(fs.existsSync(jsonlPath), true);
  assert.equal(fs.existsSync(markdownPath), true);
  assert.equal(fs.existsSync(path.join(workspace, ".amarillo", "activity.jsonl")), false);

  const parsed = JSON.parse(fs.readFileSync(jsonlPath, "utf8").trim());
  assert.equal(parsed.action, "create");
  assert.equal(parsed.direction, "pc_to_studio");
  assert.match(fs.readFileSync(markdownPath, "utf8"), /Hello\.server\.luau/);
  assert.equal(log.query({ limit: 1 }).length, 1);
  assert.equal(log.summary().byAction.create, 1);
});

test("ActivityLog separates entries by day and queries across days", () => {
  const workspace = createTempWorkspace();
  const log = new ActivityLog({ workspaceRoot: workspace });
  const filePath = path.join(workspace, "sync", "ServerScriptService", "Hello.server.luau");

  log.add({
    timestamp: "2026-05-04T10:00:00.000Z",
    action: "create",
    path: filePath,
    projectId: "Game.project.json",
    mountId: "ServerScriptService"
  });
  log.add({
    timestamp: "2026-05-05T10:00:00.000Z",
    action: "delete",
    path: filePath,
    projectId: "Game.project.json",
    mountId: "ServerScriptService"
  });

  assert.equal(fs.existsSync(path.join(workspace, ".amarillo", "activity", "2026-05-04", "activity.jsonl")), true);
  assert.equal(fs.existsSync(path.join(workspace, ".amarillo", "activity", "2026-05-05", "activity.jsonl")), true);
  assert.deepEqual(log.query({ limit: 2 }).map((entry) => entry.action), ["delete", "create"]);
});
