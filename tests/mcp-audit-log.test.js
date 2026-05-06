"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { McpAuditLog } = require("../src/daemon/lib/mcp-audit-log");

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amarillo-mcp-audit-"));
}

test("McpAuditLog writes daily JSONL and Markdown audit files", () => {
  const workspace = createTempWorkspace();
  const log = new McpAuditLog({ workspaceRoot: workspace });

  const record = log.add({
    timestamp: "2026-05-04T10:00:00.000Z",
    tool: "modify_property",
    source: "http_fallback",
    sessionId: "session-1",
    args: {
      path: "game.ServerScriptService.Hello",
      property: "Disabled"
    },
    result: {
      ok: false,
      blocked: true
    },
    ok: false,
    blocked: true,
    declined: false,
    confirmed: false,
    reasonCode: "STUDIO_CONTACT_CRITICAL",
    error: "delete blocked",
    durationMs: 42
  });

  assert.equal(record.tool, "modify_property");
  assert.equal(record.blocked, true);

  const jsonlPath = path.join(workspace, ".amarillo", "activity", "2026-05-04", "mcp.jsonl");
  const markdownPath = path.join(workspace, ".amarillo", "activity", "2026-05-04", "mcp.md");
  assert.equal(fs.existsSync(jsonlPath), true);
  assert.equal(fs.existsSync(markdownPath), true);
  assert.match(fs.readFileSync(markdownPath, "utf8"), /modify_property/);
  assert.match(fs.readFileSync(markdownPath, "utf8"), /STUDIO_CONTACT_CRITICAL/);

  const parsed = JSON.parse(fs.readFileSync(jsonlPath, "utf8").trim());
  assert.equal(parsed.source, "http_fallback");
  assert.equal(parsed.reasonCode, "STUDIO_CONTACT_CRITICAL");
});

test("McpAuditLog summary tracks outcomes and the last failure or decline", () => {
  const workspace = createTempWorkspace();
  const log = new McpAuditLog({ workspaceRoot: workspace });

  log.add({
    timestamp: "2026-05-04T10:00:00.000Z",
    tool: "health",
    source: "native_stdio",
    ok: true,
    result: {
      sessionCount: 1
    },
    durationMs: 5
  });
  log.add({
    timestamp: "2026-05-05T10:00:00.000Z",
    tool: "delete_instance",
    source: "proxy_http",
    sessionId: "session-2",
    ok: false,
    declined: true,
    confirmed: false,
    reasonCode: "DECLINED_BY_USER",
    error: "declined",
    durationMs: 8
  });

  const summary = log.summary();
  assert.equal(summary.total, 2);
  assert.equal(summary.byOutcome.success, 1);
  assert.equal(summary.byOutcome.declined, 1);
  assert.equal(summary.bySource.proxy_http, 1);
  assert.equal(summary.lastTool.tool, "delete_instance");
  assert.equal(summary.lastFailureOrDecline.reasonCode, "DECLINED_BY_USER");
});
