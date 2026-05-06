"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ErrorTracker } = require("../src/daemon/lib/error-tracker");

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-errors-"));
}

test("ErrorTracker writes daily error files under .amarillo/errors", () => {
  const workspace = createTempWorkspace();
  const tracker = new ErrorTracker({ workspaceRoot: workspace, timeZone: "America/Sao_Paulo" });
  const record = tracker.add({
    component: "plugin",
    severity: "error",
    code: "PLUGIN-TEST",
    message: "Plugin reported a test error"
  });
  const day = record.timestamp.slice(0, 10);
  const dailyPath = path.join(workspace, ".amarillo", "errors", day, "error-tracker.json");

  assert.equal(fs.existsSync(dailyPath), true);
  assert.equal(fs.existsSync(path.join(workspace, ".amarillo", "error-tracker.json")), false);
  const parsed = JSON.parse(fs.readFileSync(dailyPath, "utf8"));
  assert.equal(parsed.timeZone, "America/Sao_Paulo");
  assert.match(parsed.generatedAt, /-03:00$/);
  assert.match(parsed.entries[0].timestamp, /-03:00$/);
  assert.equal(parsed.entries[0].code, "PLUGIN-TEST");
});

test("ErrorTracker loads legacy single-file logs when daily logs do not exist", () => {
  const workspace = createTempWorkspace();
  const legacyPath = path.join(workspace, ".amarillo", "error-tracker.json");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    entries: [
      {
        id: "legacy-1",
        timestamp: "2026-05-04T10:00:00.000Z",
        component: "daemon",
        severity: "warning",
        code: "LEGACY",
        message: "legacy entry",
        resolved: false
      }
    ]
  }), "utf8");

  const tracker = new ErrorTracker({ workspaceRoot: workspace });

  assert.equal(tracker.query({ limit: 1 })[0].code, "LEGACY");
});
