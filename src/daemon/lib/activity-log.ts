"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_JSONL_FILE = "activity.jsonl";
const DEFAULT_MARKDOWN_FILE = "activity.md";
const DEFAULT_LOG_DIRECTORY = "activity";
const DEFAULT_MAX_SNAPSHOT_BYTES = 128 * 1024;
const JSONL_QUERY_CACHE_TTL_MS = 250;
const JSONL_QUERY_CACHE_MAX_RECORDS = 5000;

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isProbablyText(buffer) {
  if (!buffer || buffer.length === 0) {
    return true;
  }
  if (buffer.includes(0)) {
    return false;
  }
  const sampleLength = Math.min(buffer.length, 4096);
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index++) {
    const value = buffer[index];
    const isAllowedControl = value === 9 || value === 10 || value === 13;
    if (value < 32 && !isAllowedControl) {
      suspicious++;
    }
  }
  return suspicious / sampleLength < 0.02;
}

function getFileInfo(filePath, options: any = {}) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return null;
    }
    const buffer = fs.readFileSync(filePath);
    const info: any = {
      size: buffer.length,
      hash: crypto.createHash("sha1").update(buffer).digest("hex")
    };
    const maxSnapshotBytes = Number(options.maxSnapshotBytes || DEFAULT_MAX_SNAPSHOT_BYTES);
    if (options.includeText === true && buffer.length <= maxSnapshotBytes) {
      if (isProbablyText(buffer)) {
        info.text = buffer.toString("utf8");
        info.textTruncated = false;
      }
    }
    return info;
  } catch (_error) {
    return null;
  }
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
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
  [key: string]: any;

  constructor(options: any = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.jsonlFileName = options.jsonlFileName || DEFAULT_JSONL_FILE;
    this.markdownFileName = options.markdownFileName || DEFAULT_MARKDOWN_FILE;
    this.logDirectoryName = options.logDirectoryName || DEFAULT_LOG_DIRECTORY;
    this.maxSnapshotBytes = Number(options.maxSnapshotBytes || DEFAULT_MAX_SNAPSHOT_BYTES);
    this.recordsCache = null;
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

  detailsDirectoryPath(timestamp = new Date().toISOString()) {
    return path.join(this.dailyDirectoryPath(timestamp), "details");
  }

  detailPathForRecord(record) {
    return path.join(this.detailsDirectoryPath(record.timestamp), `${record.id}.json`);
  }

  detailRelativePathForRecord(record) {
    return normalizeSlashes(path.relative(this.workspaceRoot, this.detailPathForRecord(record)));
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

  readRecords() {
    const paths = this.collectJsonlPaths();
    const fingerprint = paths.map((filePath) => {
      try {
        const stats = fs.statSync(filePath);
        return `${filePath}:${stats.mtimeMs}:${stats.size}`;
      } catch (_error) {
        return `${filePath}:missing`;
      }
    }).join("|");
    const now = Date.now();
    if (this.recordsCache
      && this.recordsCache.fingerprint === fingerprint
      && now - this.recordsCache.createdAt < JSONL_QUERY_CACHE_TTL_MS) {
      return this.recordsCache.records;
    }
    const records = paths
      .flatMap((filePath) => readJsonlRecords(filePath))
      .sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0));
    this.recordsCache = records.length <= JSONL_QUERY_CACHE_MAX_RECORDS
      ? { createdAt: now, fingerprint, records }
      : null;
    return records;
  }

  writeDetail(record, entry: any = {}) {
    const detail: any = {
      id: record.id,
      timestamp: record.timestamp,
      action: record.action,
      path: record.path,
      relativePath: record.relativePath,
      oldHash: entry.oldHash ?? record.oldHash ?? null,
      newHash: entry.newHash ?? record.newHash ?? (record.action === "delete" ? null : (record.hash ?? null)),
      oldSize: Number.isFinite(entry.oldSize) ? entry.oldSize : record.oldSize,
      newSize: Number.isFinite(entry.newSize) ? entry.newSize : record.newSize,
      oldText: typeof entry.oldText === "string" ? entry.oldText : null,
      newText: typeof entry.newText === "string" ? entry.newText : null,
      oldTextAvailable: typeof entry.oldText === "string",
      newTextAvailable: typeof entry.newText === "string",
      snapshotLimitBytes: this.maxSnapshotBytes
    };
    const hasUsefulDetail = detail.oldHash
      || detail.newHash
      || detail.oldTextAvailable
      || detail.newTextAvailable
      || record.action === "create";
    if (!hasUsefulDetail) {
      return null;
    }
    fs.mkdirSync(this.detailsDirectoryPath(record.timestamp), { recursive: true });
    fs.writeFileSync(this.detailPathForRecord(record), `${JSON.stringify(detail, null, 2)}\n`, "utf8");
    return detail;
  }

  withDetail(record) {
    if (!record?.detailPath) {
      return record;
    }
    const absoluteDetailPath = path.resolve(this.workspaceRoot, record.detailPath);
    if (!fs.existsSync(absoluteDetailPath)) {
      return record;
    }
    try {
      return {
        ...record,
        detail: JSON.parse(fs.readFileSync(absoluteDetailPath, "utf8"))
      };
    } catch (_error) {
      return record;
    }
  }

  add(entry: any = {}) {
    const timestamp = entry.timestamp || new Date().toISOString();
    const action = entry.action || "modify";
    const absolutePath = entry.path ? path.resolve(entry.path) : null;
    const relativePath = entry.relativePath
      || (absolutePath ? path.relative(this.workspaceRoot, absolutePath) : null);
    const oldHash = entry.oldHash ?? (action === "delete" ? (entry.hash ?? null) : null);
    const newHash = action === "delete" ? null : (entry.newHash ?? entry.hash ?? null);
    const canRevert = entry.canRevert !== undefined
      ? entry.canRevert === true
      : (
        (action === "create" && Boolean(newHash))
        || (action === "delete" && typeof entry.oldText === "string")
        || (action === "modify" && typeof entry.oldText === "string" && Boolean(newHash))
      );
    const record: any = {
      id: entry.id || `${Date.now().toString(36)}-${crypto.randomUUID()}`,
      timestamp,
      action,
      path: absolutePath ? normalizeSlashes(absolutePath) : null,
      relativePath: relativePath ? normalizeSlashes(relativePath) : null,
      projectId: entry.projectId || null,
      mountId: entry.mountId || null,
      direction: entry.direction || null,
      source: entry.source || null,
      reason: entry.reason || null,
      sessionId: entry.sessionId || null,
      size: Number.isFinite(entry.size) ? entry.size : null,
      hash: entry.hash || newHash || oldHash || null,
      oldHash,
      newHash,
      oldSize: Number.isFinite(entry.oldSize) ? entry.oldSize : (action === "delete" && Number.isFinite(entry.size) ? entry.size : null),
      newSize: Number.isFinite(entry.newSize) ? entry.newSize : (action === "delete" ? null : (Number.isFinite(entry.size) ? entry.size : null)),
      hasTextSnapshot: typeof entry.oldText === "string" || typeof entry.newText === "string",
      canRevert
    };

    fs.mkdirSync(this.dailyDirectoryPath(record.timestamp), { recursive: true });
    const detail = this.writeDetail(record, entry);
    if (detail) {
      record.detailPath = this.detailRelativePathForRecord(record);
    }
    fs.appendFileSync(this.jsonlPathForTimestamp(record.timestamp), `${JSON.stringify(record)}\n`, "utf8");
    this.appendMarkdown(record);
    this.recordsCache = null;
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

  query(options: any = {}) {
    const limit = Number(options.limit || 0);
    const records = this.readRecords();
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
      filtered.push(options.includeDetails ? this.withDetail(record) : record);
      if (limit > 0 && filtered.length >= limit) {
        break;
      }
    }
    return filtered;
  }

  get(id, options: any = {}) {
    const record = this.query({ includeDetails: options.includeDetails === true })
      .find((candidate) => candidate.id === id);
    if (!record) {
      return null;
    }
    return record;
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

