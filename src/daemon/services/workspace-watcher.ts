"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { shouldIgnoreProjectDiscoveryPath } = require("../project-discovery");

class WorkspaceWatcher {
  app: any;
  logSync: (event: string, details?: Record<string, unknown>) => void;
  eventDebounceMs: number;

  constructor(options: { app: any; logSync: (event: string, details?: Record<string, unknown>) => void; eventDebounceMs: number }) {
    this.app = options.app;
    this.logSync = options.logSync;
    this.eventDebounceMs = options.eventDebounceMs;
  }

  start() {
    let configRefreshTimer: NodeJS.Timeout | null = null;
    let configRefreshTarget: string | null = null;
    let eventFlushTimer: NodeJS.Timeout | null = null;
    const pendingEvents = new Map<string, { eventType: string; normalized: string }>();

    const scheduleConfigRefresh = (normalized: string) => {
      if (normalized.endsWith(".project.json")) {
        configRefreshTarget = normalized;
      }
      if (configRefreshTimer) {
        clearTimeout(configRefreshTimer);
      }
      configRefreshTimer = setTimeout(() => {
        if (this.app.shuttingDown) {
          return;
        }
        const refreshTarget = configRefreshTarget;
        configRefreshTimer = null;
        configRefreshTarget = null;
        this.app.refreshWorkspace();
        if (refreshTarget) {
          this.app.handleProjectDefinitionChanged(refreshTarget);
        }
      }, 200);
      if (typeof configRefreshTimer.unref === "function") {
        configRefreshTimer.unref();
      }
    };

    const isRelevantWorkspaceFile = (normalized: string) => (
      normalized.endsWith(".lua")
      || normalized.endsWith(".luau")
      || normalized.endsWith(".meta.json")
      || normalized.endsWith(".model.json")
      || normalized.endsWith(".rbxm")
      || normalized.endsWith(".rbxmx")
      || normalized.endsWith(".project.json")
    );

    const flushWorkspaceEvents = () => {
      eventFlushTimer = null;
      if (this.app.shuttingDown) {
        pendingEvents.clear();
        return;
      }
      const events = Array.from(pendingEvents.values());
      pendingEvents.clear();

      for (const event of events) {
        const normalized = event.normalized;
        if (normalized === "argon.toml" || normalized === ".pluginroblox.json" || normalized.endsWith(".project.json")) {
          scheduleConfigRefresh(normalized);
        }

        if (isRelevantWorkspaceFile(normalized)) {
          this.app.onWorkspaceFileChanged(path.join(this.app.workspaceRoot, normalized), event.eventType);
        }
      }
    };

    const queueWorkspaceEvent = (eventType, fileName) => {
      if (!fileName) {
        return;
      }
      const normalized = String(fileName).replace(/\\/g, "/").replace(/^\.\//, "");
      if (!normalized || shouldIgnoreProjectDiscoveryPath(normalized)) {
        return;
      }

      pendingEvents.set(normalized, {
        eventType: String(eventType || "change"),
        normalized
      });
      if (eventFlushTimer) {
        clearTimeout(eventFlushTimer);
      }
      eventFlushTimer = setTimeout(flushWorkspaceEvents, this.eventDebounceMs);
      if (typeof eventFlushTimer.unref === "function") {
        eventFlushTimer.unref();
      }
    };

    try {
      const watcher = fs.watch(this.app.workspaceRoot, { recursive: true }, queueWorkspaceEvent);
      watcher.on("error", (error) => {
        this.app.recordError({
          component: "daemon",
          severity: "warning",
          code: "WATCHER-ERROR",
          message: error.message,
          context: { workspaceRoot: this.app.workspaceRoot },
          stack: error.stack
        });
      });
      this.app.fileWatchers.push(watcher);
    } catch (error) {
      this.app.recordError({
        component: "daemon",
        severity: "warning",
        code: "WATCHER-START",
        message: error.message,
        context: { workspaceRoot: this.app.workspaceRoot },
        stack: error.stack
      });
    }
  }
}

module.exports = {
  WorkspaceWatcher
};
