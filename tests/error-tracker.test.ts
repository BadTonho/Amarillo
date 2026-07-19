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

test("ErrorTracker deduplicates retried reports by eventId", () => {
  const workspace = createTempWorkspace();
  const tracker = new ErrorTracker({ workspaceRoot: workspace });
  const first = tracker.add({
    component: "plugin",
    severity: "error",
    code: "PLUGIN-RETRY",
    eventId: "event-123",
    message: "first delivery"
  });
  const retry = tracker.add({
    component: "plugin",
    severity: "error",
    code: "PLUGIN-RETRY",
    eventId: "event-123",
    message: "same event delivered again"
  });

  assert.equal(retry.id, first.id);
  assert.equal(tracker.query({}).length, 1);
  assert.equal(tracker.query({})[0].message, "first delivery");
});

test("ErrorTracker keeps historical daily entries beyond the in-memory window", () => {
  const workspace = createTempWorkspace();
  const tracker = new ErrorTracker({ workspaceRoot: workspace, maxEntries: 1 });
  const first = tracker.add({
    component: "plugin",
    severity: "error",
    code: "PLUGIN-HISTORY-1",
    message: "older error"
  });
  tracker.add({
    component: "plugin",
    severity: "error",
    code: "PLUGIN-HISTORY-2",
    message: "newer error"
  });

  const day = first.timestamp.slice(0, 10);
  const dailyPath = path.join(workspace, ".amarillo", "errors", day, "error-tracker.json");
  const parsed = JSON.parse(fs.readFileSync(dailyPath, "utf8"));
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((entry) => entry.code), ["PLUGIN-HISTORY-2", "PLUGIN-HISTORY-1"]);
});
