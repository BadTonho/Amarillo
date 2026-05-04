"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_JSONL_FILE = "activity.jsonl";
const DEFAULT_MARKDOWN_FILE = "activity.md";
const DEFAULT_LOG_DIRECTORY = "activity";

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function hashValue(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function fileHash(filePath) {
  return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
}

function getFileInfo(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return null;
    }
    return {
      size: stats.size,
      hash: fileHash(filePath)
    };
  } catch (_error) {
    return null;
  }
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function dateKeyFromTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
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

class ActivityLog {
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

  get legacyJsonlPath() {
    return path.join(this.directoryPath, this.jsonlFileName);
  }

  get legacyMarkdownPath() {
    return path.join(this.directoryPath, this.markdownFileName);
  }

  dailyDirectoryPath(timestamp = new Date().toISOString()) {
    return path.join(this.logRootPath, dateKeyFromTimestamp(timestamp));
  }

  get jsonlPath() {
    return path.join(this.dailyDirectoryPath(), this.jsonlFileName);
  }

  get markdownPath() {
    return path.join(this.dailyDirectoryPath(), this.markdownFileName);
  }

  jsonlPathForTimestamp(timestamp) {
    return path.join(this.dailyDirectoryPath(timestamp), this.jsonlFileName);
  }

  markdownPathForTimestamp(timestamp) {
    return path.join(this.dailyDirectoryPath(timestamp), this.markdownFileName);
  }

  collectJsonlPaths() {
    const paths = [];
    if (fs.existsSync(this.logRootPath)) {
      for (const dayEntry of fs.readdirSync(this.logRootPath, { withFileTypes: true })) {
        if (!dayEntry.isDirectory()) {
          continue;
        }
        const filePath = path.join(this.logRootPath, dayEntry.name, this.jsonlFileName);
        if (fs.existsSync(filePath)) {
          paths.push(filePath);
        }
      }
    }
    if (fs.existsSync(this.legacyJsonlPath)) {
      paths.push(this.legacyJsonlPath);
    }
    return paths;
  }

  add(entry = {}) {
    const timestamp = entry.timestamp || new Date().toISOString();
    const absolutePath = entry.path ? path.resolve(entry.path) : null;
    const relativePath = entry.relativePath
      || (absolutePath ? path.relative(this.workspaceRoot, absolutePath) : null);
    const record = {
      id: entry.id || `${Date.now().toString(36)}-${hashValue(`${timestamp}:${entry.path}:${Math.random()}`).slice(0, 8)}`,
      timestamp,
      action: entry.action || "modify",
      path: absolutePath ? normalizeSlashes(absolutePath) : null,
      relativePath: relativePath ? normalizeSlashes(relativePath) : null,
      projectId: entry.projectId || null,
      mountId: entry.mountId || null,
      direction: entry.direction || null,
      source: entry.source || null,
      reason: entry.reason || null,
      sessionId: entry.sessionId || null,
      size: Number.isFinite(entry.size) ? entry.size : null,
      hash: entry.hash || null
    };

    fs.mkdirSync(this.dailyDirectoryPath(record.timestamp), { recursive: true });
    fs.appendFileSync(this.jsonlPathForTimestamp(record.timestamp), `${JSON.stringify(record)}\n`, "utf8");
    this.appendMarkdown(record);
    return record;
  }

  appendMarkdown(record) {
    const header = "| Timestamp | Action | Path | Direction | Project | Session | Reason |\n| --- | --- | --- | --- | --- | --- | --- |\n";
    const markdownPath = this.markdownPathForTimestamp(record.timestamp);
    if (!fs.existsSync(markdownPath)) {
      fs.writeFileSync(markdownPath, header, "utf8");
    }
    const line = [
      record.timestamp,
      record.action,
      record.relativePath || record.path || "",
      record.direction || "",
      record.projectId || "",
      record.sessionId || "",
      record.reason || ""
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
      if (options.action && record.action !== options.action) {
        continue;
      }
      if (options.direction && record.direction !== options.direction) {
        continue;
      }
      if (options.projectId && record.projectId !== options.projectId) {
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
      byAction: { create: 0, modify: 0, delete: 0 },
      byDirection: {},
      recent: records.slice(0, 10)
    };
    for (const record of records) {
      summary.byAction[record.action] = (summary.byAction[record.action] || 0) + 1;
      const direction = record.direction || "unknown";
      summary.byDirection[direction] = (summary.byDirection[direction] || 0) + 1;
    }
    return summary;
  }
}

module.exports = {
  ActivityLog,
  getFileInfo
};
