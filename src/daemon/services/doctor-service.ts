"use strict";

const { mcpShieldSummary } = require("../mcp-shield");
const { AMARILLO_PROTOCOL_VERSION } = require("../version");

function recentTimestamp(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => Date.parse(entry.timestamp || entry.at || entry.createdAt || ""))
    .filter((timestamp) => Number.isFinite(timestamp))
    .sort((left, right) => right - left)[0] || null;
}

function isInitialStudioSyncPending(session) {
  return (session?.connectionState || "ready") !== "ready"
    && session?.truthSource === "studio"
    && !session?.lastAppliedAt;
}

class DoctorService {
  app: any;

  constructor(app) {
    this.app = app;
  }

  report() {
    const sessions = Array.from(this.app.sessions.values()).map((session) => this.app.sessionSummary(session));
    const versions = this.app.versionPayload();
    const mcp = mcpShieldSummary(this.app);
    const errors = this.app.errorTracker.summary();
    const recentUnresolvedErrors = this.app.errorTracker.query({ resolved: false, limit: 5 });
    const activity = this.app.activityLog.summary();
    const mcpAudit = this.app.mcpAuditLog.summary();
    const blockedReasons = [];
    const warnings = [];

    if (this.app.projects.length === 0) {
      blockedReasons.push("No enabled .project.json was found in this workspace.");
    }
    if (versions.extension.state === "blocked") {
      blockedReasons.push(versions.extension.message);
    }
    for (const session of sessions) {
      if (isInitialStudioSyncPending(session)) {
        warnings.push(`${session.projectName}: initial Studio sync is still accepted but no Studio snapshot has been applied yet.`);
      }
      if (session.requiresPluginUpdate) {
        blockedReasons.push(`${session.projectName}: ${session.versionMessage}`);
      }
      if (session.requiresManualResync) {
        blockedReasons.push(`${session.projectName}: ${session.lastSyncError || "Sync degraded."}`);
      }
      if (session.studioContactState === "stale" || session.studioContactState === "critical") {
        warnings.push(`${session.projectName}: ${session.studioContactMessage}`);
      }
      if (session.privilegedActionConfirmationEnabled === false) {
        warnings.push(`${session.projectName}: privileged action confirmation is disabled; run_code and destructive Studio actions can execute without an in-Studio prompt.`);
      }
    }

    if (sessions.length === 0) {
      warnings.push("No active Studio session is connected.");
    }
    if (mcp.state !== "ready") {
      warnings.push(`MCP is ${mcp.state}: ${mcp.message}`);
    }
    if (errors.unresolved > 0 && blockedReasons.length === 0) {
      warnings.push(`${errors.unresolved} unresolved diagnostic error(s) are recorded.`);
    }

    const status = blockedReasons.length > 0
      ? "blocked"
      : (warnings.length > 0 ? "warning" : "ok");
    const recommendations = [];
    if (sessions.some((session) => session.requiresPluginUpdate)) {
      recommendations.push("Run Amarillo: Install Roblox Studio Plugin, then reload the plugin in Roblox Studio.");
    }
    if (sessions.some((session) => session.requiresManualResync)) {
      recommendations.push("Run a manual resync after checking the sync paused message.");
    }
    if (this.app.projects.length === 0) {
      recommendations.push("Create or select a valid .project.json for this workspace.");
    }
    if (mcp.state !== "ready") {
      recommendations.push("Run Amarillo: Configure MCP for Workspace and reopen the AI/MCP client session.");
    }
    if (sessions.length === 0) {
      recommendations.push("Open Roblox Studio and connect the Amarillo plugin.");
    }
    if (sessions.some((session) => session.privilegedActionConfirmationEnabled === false)) {
      recommendations.push("Enable privileged action confirmation in the Amarillo plugin settings.");
    }
    if (recommendations.length === 0) {
      recommendations.push("No action required.");
    }

    return {
      ok: status !== "blocked",
      status,
      generatedAt: new Date().toISOString(),
      summary: {
        message: status === "ok"
          ? "Amarillo Doctor did not find blocking issues."
          : (status === "blocked" ? "Amarillo Doctor found blocking issues." : "Amarillo Doctor found warnings."),
        blockedReasons,
        warnings,
        projectCount: this.app.projects.length,
        sessionCount: sessions.length,
        syncBlockedSessionCount: sessions.filter((session) => session.syncBlockedReason).length,
        unresolvedErrorCount: errors.unresolved,
        initialSyncStuckSessionCount: sessions.filter(isInitialStudioSyncPending).length,
        mcpAuditCount: mcpAudit.total
      },
      versions,
      compatibility: {
        protocolVersion: AMARILLO_PROTOCOL_VERSION,
        extensionState: versions.extension.state,
        blockedSessionIds: sessions.filter((session) => session.requiresPluginUpdate).map((session) => session.id)
      },
      workspace: {
        root: this.app.workspaceRoot,
        host: this.app.host,
        port: this.app.port,
        projectCount: this.app.projects.length,
        defaultProjectId: this.app.defaultProjectId,
        refreshedAt: this.app.lastWorkspaceRefresh
      },
      sessions,
      sync: {
        autoSyncToStudio: this.app.autoSyncToStudio,
        lastDiskWriteTime: this.app.lastDiskWriteTime,
        degradedSessionIds: sessions.filter((session) => session.requiresManualResync).map((session) => session.id),
        blockedSessionIds: sessions.filter((session) => session.syncBlockedReason).map((session) => session.id)
      },
      mcp,
      errors: {
        ...errors,
        recentUnresolved: recentUnresolvedErrors,
        lastErrorAt: recentTimestamp(errors.recent)
      },
      activity: {
        ...activity,
        lastActivityAt: recentTimestamp(activity.recent)
      },
      mcpAudit: {
        ...mcpAudit,
        lastToolAt: mcpAudit.lastTool?.timestamp || null,
        lastFailureOrDeclineAt: mcpAudit.lastFailureOrDecline?.timestamp || null
      },
      performance: typeof this.app.performanceSummary === "function"
        ? this.app.performanceSummary()
        : {},
      recommendations
    };
  }
}

module.exports = {
  DoctorService
};
