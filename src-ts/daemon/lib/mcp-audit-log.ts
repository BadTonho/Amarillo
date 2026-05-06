"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_JSONL_FILE = "mcp.jsonl";
const DEFAULT_MARKDOWN_FILE = "mcp.md";
const DEFAULT_LOG_DIRECTORY = "activity";

function hashValue(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function dateKeyFromTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function readJsonlRecords(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch (_error) {
        return [];
      }
    });
}

function auditOutcome(record) {
  if (record.blocked) {
    return "blocked";
  }
  if (record.declined) {
    return "declined";
  }
  if (record.ok === false || record.error) {
    return "error";
  }
  return "success";
}

class McpAuditLog {
  constructor(options = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.jsonlFileName = options.jsonlFileName || DEFAULT_JSONL_FILE;
    this.markdownFileName = options.markdownFileName || DEFAULT_MARKDOWN_FILE;
    this.logDirectoryName = options.logDirectoryName || DEFAULT_LOG_DIRECTORY;
  }

  get directoryPath() {
    return path.join(this.workspaceRoot, ".amarillo");
  }

  get logRootPath() {
    return path.join(this.directoryPath, this.logDirectoryName);
  }

  dailyDirectoryPath(timestamp = new Date().toISOString()) {
    return path.join(this.logRootPath, dateKeyFromTimestamp(timestamp));
  }

  jsonlPathForTimestamp(timestamp) {
    return path.join(this.dailyDirectoryPath(timestamp), this.jsonlFileName);
  }

  markdownPathForTimestamp(timestamp) {
    return path.join(this.dailyDirectoryPath(timestamp), this.markdownFileName);
  }

  collectJsonlPaths() {
    const paths = [];
    if (!fs.existsSync(this.logRootPath)) {
      return paths;
    }
    for (const dayEntry of fs.readdirSync(this.logRootPath, { withFileTypes: true })) {
      if (!dayEntry.isDirectory()) {
        continue;
      }
      const filePath = path.join(this.logRootPath, dayEntry.name, this.jsonlFileName);
      if (fs.existsSync(filePath)) {
        paths.push(filePath);
      }
    }
    return paths;
  }

  add(entry = {}) {
    const timestamp = entry.timestamp || new Date().toISOString();
    const record = {
      id: entry.id || `${Date.now().toString(36)}-${hashValue(`${timestamp}:${entry.tool}:${Math.random()}`).slice(0, 8)}`,
      timestamp,
      tool: entry.tool || "unknown",
      source: entry.source || "unknown",
      sessionId: entry.sessionId || null,
      args: entry.args && typeof entry.args === "object" ? entry.args : {},
      result: entry.result && typeof entry.result === "object" ? entry.result : null,
      ok: entry.ok !== undefined ? Boolean(entry.ok) : !entry.error,
      blocked: entry.blocked === true,
      declined: entry.declined === true,
      confirmed: entry.confirmed === true,
      reasonCode: entry.reasonCode || null,
      error: entry.error || null,
      durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : null
    };

    fs.mkdirSync(this.dailyDirectoryPath(record.timestamp), { recursive: true });
    fs.appendFileSync(this.jsonlPathForTimestamp(record.timestamp), `${JSON.stringify(record)}\n`, "utf8");
    this.appendMarkdown(record);
    return record;
  }

  appendMarkdown(record) {
    const header = "| Timestamp | Tool | Source | Session | Outcome | Reason | Duration |\n| --- | --- | --- | --- | --- | --- | --- |\n";
    const markdownPath = this.markdownPathForTimestamp(record.timestamp);
    if (!fs.existsSync(markdownPath)) {
      fs.writeFileSync(markdownPath, header, "utf8");
    }
    const line = [
      record.timestamp,
      record.tool,
      record.source,
      record.sessionId || "",
      auditOutcome(record),
      record.reasonCode || (record.error ? "ERROR" : ""),
      record.durationMs === null ? "" : `${record.durationMs}ms`
    ].map(markdownCell).join(" | ");
    fs.appendFileSync(markdownPath, `| ${line} |\n`, "utf8");
  }

  query(options = {}) {
    const limit = Number(options.limit || 0);
    const records = this.collectJsonlPaths()
      .flatMap((filePath) => readJsonlRecords(filePath))
      .sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0));
    const filtered = [];
    for (const record of records) {
      if (options.tool && record.tool !== options.tool) {
        continue;
      }
      if (options.source && record.source !== options.source) {
        continue;
      }
      if (options.sessionId && record.sessionId !== options.sessionId) {
        continue;
      }
      filtered.push(record);
      if (limit > 0 && filtered.length >= limit) {
        break;
      }
    }
    return filtered;
  }

  summary() {
    const records = this.query();
    const summary = {
      total: records.length,
      bySource: {},
      byOutcome: {
        success: 0,
        blocked: 0,
        declined: 0,
        error: 0
      },
      recent: records.slice(0, 10),
      lastTool: records[0] || null,
      lastFailureOrDecline: records.find((record) => auditOutcome(record) !== "success") || null
    };
    for (const record of records) {
      const source = record.source || "unknown";
      summary.bySource[source] = (summary.bySource[source] || 0) + 1;
      const outcome = auditOutcome(record);
      summary.byOutcome[outcome] = (summary.byOutcome[outcome] || 0) + 1;
    }
    return summary;
  }
}

module.exports = {
  McpAuditLog
};
