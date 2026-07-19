"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Structured error tracking for Amarillo.
 *
 * Records contextual errors and persists them as JSON for HTTP and CLI diagnostics.
 *
 * Severity levels:
 *   "critical" - Failure that prevents the system from working.
 *   "error" - Operation failed, but the system can continue.
 *   "warning" - Unexpected behavior that does not block operation.
 *   "info" - Useful debug information.
 */

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_LOG_FILE = "error-tracker.json";
const DEFAULT_LOG_DIRECTORY = "errors";
const DEFAULT_TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (_error) {
    return "UTC";
  }
})();

function resolveTimeZone(timeZone) {
  const candidate = timeZone || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch (_error) {
    return "UTC";
  }
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts: any = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }
  return parts;
}

function timeZoneOffsetMinutes(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    date.getMilliseconds()
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function formatOffset(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function formatTimestamp(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const resolvedTimeZone = resolveTimeZone(timeZone);
  const parts = getTimeZoneParts(date, resolvedTimeZone);
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}${formatOffset(timeZoneOffsetMinutes(date, resolvedTimeZone))}`;
}

function dateKeyFromTimestamp(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  const parsed = new Date(timestamp);
  const resolvedTimeZone = resolveTimeZone(timeZone);
  if (!Number.isFinite(parsed.getTime())) {
    const parts = getTimeZoneParts(new Date(), resolvedTimeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const parts = getTimeZoneParts(parsed, resolvedTimeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function readEntriesFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

class ErrorTracker {
  [key: string]: any;

  /**
   * @param {object} options
   * @param {string} options.workspaceRoot - Base directory for persisted logs.
   * @param {number} [options.maxEntries] - Maximum entries to keep (FIFO).
   * @param {string} [options.logFileName] - Log file name.
   * @param {boolean} [options.persistOnAdd] - When true, persist after each added error.
   */
  constructor(options: any = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.logFileName = options.logFileName || DEFAULT_LOG_FILE;
    this.logDirectoryName = options.logDirectoryName || DEFAULT_LOG_DIRECTORY;
    this.timeZone = resolveTimeZone(options.timeZone || process.env.AMARILLO_TIME_ZONE || process.env.TZ || DEFAULT_TIME_ZONE);
    this.persistOnAdd = options.persistOnAdd !== false;
    this.entries = [];
    this._listeners = [];
    this.persistenceFailureReported = false;
    this._loadExisting();
  }

  /**
   * Full path for the active log file.
   */
  get logFilePath() {
    return path.join(this.dailyDirectoryPath(), this.logFileName);
  }

  get legacyLogFilePath() {
    return path.join(this.workspaceRoot, ".amarillo", this.logFileName);
  }

  get logRootPath() {
    return path.join(this.workspaceRoot, ".amarillo", this.logDirectoryName);
  }

  dailyDirectoryPath(timestamp = this.nowTimestamp()) {
    return path.join(this.logRootPath, dateKeyFromTimestamp(timestamp, this.timeZone));
  }

  logFilePathForTimestamp(timestamp) {
    return path.join(this.dailyDirectoryPath(timestamp), this.logFileName);
  }

  collectDailyLogFilePaths() {
    if (!fs.existsSync(this.logRootPath)) {
      return [];
    }
    const paths = [];
    for (const dayEntry of fs.readdirSync(this.logRootPath, { withFileTypes: true })) {
      if (!dayEntry.isDirectory()) {
        continue;
      }
      const filePath = path.join(this.logRootPath, dayEntry.name, this.logFileName);
      if (fs.existsSync(filePath)) {
        paths.push(filePath);
      }
    }
    return paths;
  }

  /**
   * Records a new error.
   *
   * @param {object} entry
   * @param {string} entry.component - Source component (daemon, plugin, mcp-proxy, extension).
   * @param {string} entry.severity - "critical" | "error" | "warning" | "info".
   * @param {string} entry.code - Unique error code (for example "ERR-001").
   * @param {string} entry.message - Error description.
   * @param {string} [entry.file] - File where the error happened.
   * @param {number} [entry.line] - Error line.
   * @param {string} [entry.sessionId] - Associated Studio session, when applicable.
   * @param {string} [entry.projectId] - Associated project, when applicable.
   * @param {object} [entry.context] - Additional context.
   * @param {string} [entry.suggestion] - Suggested fix.
   * @param {boolean} [entry.resolved] - Whether the error is already resolved.
   * @returns {object} Created record.
   */
  add(entry) {
    const eventId = typeof entry.eventId === "string" && entry.eventId.trim().length > 0
      ? entry.eventId.trim()
      : null;
    if (eventId) {
      const existing = this.entries.find((candidate) => candidate.eventId === eventId);
      if (existing) {
        return existing;
      }
    }
    const record = {
      id: this._generateId(),
      timestamp: this.nowTimestamp(),
      component: entry.component || "unknown",
      severity: this._normalizeSeverity(entry.severity),
      code: entry.code || null,
      eventId,
      message: String(entry.message || "Unknown error"),
      file: entry.file || null,
      line: entry.line || null,
      sessionId: entry.sessionId || null,
      projectId: entry.projectId || null,
      context: entry.context || null,
      suggestion: entry.suggestion || null,
      resolved: entry.resolved === true,
      resolvedAt: null,
      stack: entry.stack || null
    };

    this.entries.unshift(record);

    // Trim old entries.
    while (this.entries.length > this.maxEntries) {
      this.entries.pop();
    }

    // Notify listeners.
    for (const listener of this._listeners) {
      try {
        listener(record);
      } catch (_error) {
        // Listener failures must not crash the tracker.
      }
    }

    if (this.persistOnAdd) {
      this._persist();
    }

    return record;
  }

  /**
   * Convenience helper for recording from an Error object.
   */
  addFromError(error, options: any = {}) {
    return this.add({
      component: options.component || "daemon",
      severity: options.severity || "error",
      code: options.code || null,
      eventId: options.eventId || null,
      message: error.message || String(error),
      stack: error.stack || null,
      file: options.file || null,
      line: options.line || null,
      sessionId: options.sessionId || null,
      projectId: options.projectId || null,
      context: options.context || null,
      suggestion: options.suggestion || null
    });
  }

  /**
   * Marks one error as resolved.
   */
  resolve(entryId) {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) {
      return null;
    }
    entry.resolved = true;
    entry.resolvedAt = this.nowTimestamp();
    if (this.persistOnAdd) {
      this._persist();
    }
    return entry;
  }

  /**
   * Marks all unresolved errors as resolved.
   */
  resolveAll() {
    const now = this.nowTimestamp();
    let count = 0;
    for (const entry of this.entries) {
      if (!entry.resolved) {
        entry.resolved = true;
        entry.resolvedAt = now;
        count += 1;
      }
    }
    if (count > 0 && this.persistOnAdd) {
      this._persist();
    }
    return count;
  }

  /**
   * Removes every entry.
   */
  clear() {
    this.entries = [];
    if (this.persistOnAdd) {
      this._clearPersisted();
    }
  }

  /**
   * Returns filtered entries.
   *
   * @param {object} [filters]
   * @param {string} [filters.severity] - Filter by severity.
   * @param {string} [filters.component] - Filter by component.
   * @param {boolean} [filters.resolved] - Filter by resolution status.
   * @param {string} [filters.code] - Filter by error code.
   * @param {string} [filters.sessionId] - Filter by session.
   * @param {number} [filters.limit] - Limit result count.
   * @param {string} [filters.since] - Filter by timestamp (ISO string).
   * @returns {object[]}
   */
  query(filters: any = {}) {
    let results = this.entries;

    if (filters.severity) {
      results = results.filter((e) => e.severity === filters.severity);
    }
    if (filters.component) {
      results = results.filter((e) => e.component === filters.component);
    }
    if (filters.resolved !== undefined) {
      results = results.filter((e) => e.resolved === filters.resolved);
    }
    if (filters.code) {
      results = results.filter((e) => e.code === filters.code);
    }
    if (filters.sessionId) {
      results = results.filter((e) => e.sessionId === filters.sessionId);
    }
    if (filters.since) {
      const sinceMs = Date.parse(filters.since);
      if (Number.isFinite(sinceMs)) {
        results = results.filter((e) => Date.parse(e.timestamp) >= sinceMs);
      }
    }
    if (filters.limit && filters.limit > 0) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }

  /**
   * Returns summary stats.
   */
  summary() {
    const stats = {
      total: this.entries.length,
      unresolved: 0,
      resolved: 0,
      bySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      byComponent: {},
      recent: this.entries.slice(0, 10)
    };

    for (const entry of this.entries) {
      if (entry.resolved) {
        stats.resolved += 1;
      } else {
        stats.unresolved += 1;
      }
      stats.bySeverity[entry.severity] = (stats.bySeverity[entry.severity] || 0) + 1;
      stats.byComponent[entry.component] = (stats.byComponent[entry.component] || 0) + 1;
    }

    return stats;
  }

  /**
   * Registers a listener for new errors.
   */
  onError(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter((listener) => listener !== callback);
    };
  }

  /**
   * Saves entries to disk.
   */
  persist() {
    this._persist();
  }

  // --- Internals ---

  nowTimestamp(date = new Date()) {
    return formatTimestamp(date, this.timeZone);
  }

  _normalizeSeverity(severity) {
    const valid = ["critical", "error", "warning", "info"];
    return valid.includes(severity) ? severity : "error";
  }

  _generateId() {
    return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  }

  _loadExisting() {
    try {
      const dailyFiles = this.collectDailyLogFilePaths();
      const entries = [];
      const seenIds = new Set();
      const loadFile = (filePath) => {
        try {
          for (const entry of readEntriesFile(filePath)) {
            if (entry && entry.id && !seenIds.has(entry.id)) {
              seenIds.add(entry.id);
              entries.push(entry);
            }
          }
        } catch (error) {
          this._reportDiagnostic("ERROR-LOG-LOAD", filePath, error);
        }
      };

      for (const filePath of dailyFiles) {
        loadFile(filePath);
      }
      if (fs.existsSync(this.legacyLogFilePath)) {
        loadFile(this.legacyLogFilePath);
      }
      this.entries = entries
        .sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0))
        .slice(0, this.maxEntries);
    } catch (error) {
      this._reportDiagnostic("ERROR-LOG-DISCOVERY", this.logRootPath, error);
      this.entries = [];
    }
  }

  _persist() {
    try {
      fs.mkdirSync(this.logRootPath, { recursive: true });
      const persistedEntries = new Map();
      const existingFiles = this.collectDailyLogFilePaths();
      if (fs.existsSync(this.legacyLogFilePath)) {
        existingFiles.push(this.legacyLogFilePath);
      }
      for (const filePath of existingFiles) {
        try {
          for (const entry of readEntriesFile(filePath)) {
            if (entry && entry.id && !persistedEntries.has(entry.id)) {
              persistedEntries.set(entry.id, entry);
            }
          }
        } catch (error) {
          this._reportDiagnostic("ERROR-LOG-PERSIST-LOAD", filePath, error);
        }
      }
      for (const entry of this.entries) {
        if (entry && entry.id) {
          persistedEntries.set(entry.id, entry);
        }
      }

      const grouped = new Map();
      for (const entry of persistedEntries.values()) {
        const day = dateKeyFromTimestamp(entry.timestamp, this.timeZone);
        const bucket = grouped.get(day) || [];
        bucket.push(entry);
        grouped.set(day, bucket);
      }

      if (grouped.size === 0) {
        this._writeEntriesFile(this.logFilePath, []);
      }

      for (const [day, entries] of grouped.entries()) {
        entries.sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0));
        this._writeEntriesFile(path.join(this.logRootPath, day, this.logFileName), entries);
      }
    } catch (error) {
      this._reportDiagnostic("ERROR-LOG-PERSIST", this.logRootPath, error);
    }
  }

  _clearPersisted() {
    try {
      const files = this.collectDailyLogFilePaths();
      if (fs.existsSync(this.legacyLogFilePath)) {
        files.push(this.legacyLogFilePath);
      }
      for (const filePath of files) {
        this._writeEntriesFile(filePath, []);
      }
      if (files.length === 0) {
        this._writeEntriesFile(this.logFilePath, []);
      }
    } catch (error) {
      this._reportDiagnostic("ERROR-LOG-PERSIST", this.logRootPath, error);
    }
  }

  _reportDiagnostic(code, filePath, error) {
    if (this.persistenceFailureReported && code === "ERROR-LOG-PERSIST") {
      return;
    }
    if (code === "ERROR-LOG-PERSIST") {
      this.persistenceFailureReported = true;
    }
    const message = error && typeof error.message === "string" ? error.message : String(error || "Unknown error");
    process.stderr.write(`[amarillo] ${code} (${path.basename(filePath || this.logRootPath)}): ${message}\n`);
  }

  _writeEntriesFile(filePath, entries) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data = {
      version: 1,
      generatedAt: this.nowTimestamp(),
      timeZone: this.timeZone,
      totalEntries: entries.length,
      entries
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }
}

module.exports = { ErrorTracker, formatTimestamp };

