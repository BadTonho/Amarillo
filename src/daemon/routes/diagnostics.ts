"use strict";

import type { DiagnosticErrorEntry, HealthPayload } from "../contracts/diagnostics";

const { mcpShieldSummary } = require("../mcp-shield");
const { jsonResponse, readJsonBody } = require("../http-utils");

function sessionSyncDebugPayload(app, session) {
  const project = app.getProjectById(session.projectId);
  const sync = app.ensureSessionSyncState(session);
  return {
    id: session.id,
    projectId: session.projectId,
    projectName: project ? project.name : "unknown",
    placeId: session.placeId,
    connectionState: session.connectionState || "ready",
    truthSource: session.truthSource || null,
    syncState: sync.state,
    syncMessage: app.syncMessage(session),
    lastAckAt: sync.lastAckAt,
    lastVerifiedAt: sync.lastVerifiedAt,
    lastFailure: sync.lastFailure,
    lastExpectedHash: sync.lastExpectedHash,
    lastObservedHash: sync.lastObservedHash,
    degradedReason: sync.degradedReason,
    requiresManualResync: sync.state === "degraded",
    lastStudioContactAt: session.lastStudioContactAt,
    lastStudioSeenAt: session.lastStudioSeenAt,
    lastAppliedAt: session.lastAppliedAt,
    lastStudioHash: session.lastStudioHash,
    hasSnapshot: !!session.lastStudioSnapshot,
    pendingCommandCount: session.pendingCommands.length,
    pendingCommandTypes: session.pendingCommands.map((command) => command.type)
  };
}

async function handleDiagnosticsRoutes(app, request, response, requestUrl) {
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    const payload: HealthPayload = {
      ok: true,
      workspaceRoot: app.workspaceRoot,
      host: app.host,
      port: app.port,
      versions: app.versionPayload(),
      autoSyncToStudio: app.autoSyncToStudio,
      projectCount: app.projects.length,
      defaultProjectId: app.defaultProjectId,
      defaultProjectPath: app.defaultProjectId
        ? (app.getProjectById(app.defaultProjectId)?.id || null)
        : null,
      connectionOffer: app.connectionOfferSummary(),
      sessions: Array.from(app.sessions.values()).map((session) => app.sessionSummary(session)),
      mcpShield: mcpShieldSummary(app),
      refreshedAt: app.lastWorkspaceRefresh
    };
    jsonResponse(response, 200, payload);
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/doctor") {
    jsonResponse(response, 200, app.doctorReport());
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/diagnostics/perf") {
    jsonResponse(response, 200, app.performanceReport());
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/projects") {
    jsonResponse(response, 200, {
      ok: true,
      projects: app.listProjects(),
      defaultProjectId: app.defaultProjectId
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/project/active") {
    const body = await readJsonBody(request);
    const project = await app.setActiveProject(body.projectId);
    jsonResponse(response, 200, {
      ok: true,
      project
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/settings/auto-sync-to-studio") {
    const body = await readJsonBody(request);
    jsonResponse(response, 200, app.setAutoSyncToStudio(body.enabled === true));
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/workspace/files-changed") {
    const body = await readJsonBody(request);
    const result = app.handleWorkspaceFileEvents(body.events || [body]);
    jsonResponse(response, 200, {
      ok: true,
      ...result
    });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/debug/sync-state") {
    const sessionId = requestUrl.searchParams.get("sessionId");
    const session = sessionId ? app.sessions.get(sessionId) : null;
    if (sessionId && !session) {
      jsonResponse(response, 404, { ok: false, error: "Session not found" });
      return true;
    }
    if (session) {
      const single = sessionSyncDebugPayload(app, session);
      jsonResponse(response, 200, {
        ok: true,
        mode: "single_session",
        timestamp: new Date().toISOString(),
        session: {
          ...single,
          snapshotSize: session.lastStudioSnapshot ? JSON.stringify(session.lastStudioSnapshot).length : 0,
          pendingCommands: session.pendingCommands.map((command: any) => ({
            id: command.id,
            type: command.type,
            expectedHash: command.expectedHash || null
          })),
          inFlightCommandCount: session.inFlightCommands.size,
          inFlightCommands: Array.from(session.inFlightCommands.values()).map((command: any) => ({
            id: command.id,
            type: command.type,
            expectedHash: command.expectedHash || null
          })),
          fileChangeTimerActive: !!session.fileChangeTimer
        },
        lastDiskWriteTime: app.lastDiskWriteTime,
        autoSyncToStudio: app.autoSyncToStudio
      });
      return true;
    }
    jsonResponse(response, 200, {
      ok: true,
      mode: "all_sessions",
      timestamp: new Date().toISOString(),
      daemon: {
        workspaceRoot: app.workspaceRoot,
        projectCount: app.projects.length,
        sessionCount: app.sessions.size,
        autoSyncToStudio: app.autoSyncToStudio,
        lastDiskWriteTime: app.lastDiskWriteTime,
        connectionOffer: app.connectionOfferSummary()
      },
      sessions: Array.from(app.sessions.values()).map((candidate) => sessionSyncDebugPayload(app, candidate))
    });
    return true;
  }

  const activityRevertMatch = requestUrl.pathname.match(/^\/activity\/([^/]+)\/revert$/);
  if (request.method === "POST" && activityRevertMatch) {
    try {
      const result = app.revertActivityEntry(decodeURIComponent(activityRevertMatch[1]));
      jsonResponse(response, 200, result);
    } catch (error) {
      jsonResponse(response, error.statusCode || 500, {
        ok: false,
        code: error.code || "ACTIVITY_REVERT_FAILED",
        error: error.message
      });
    }
    return true;
  }

  const activityEntryMatch = requestUrl.pathname.match(/^\/activity\/([^/]+)$/);
  if (request.method === "GET" && activityEntryMatch && activityEntryMatch[1] !== "summary") {
    const entry = app.activityLog.get(decodeURIComponent(activityEntryMatch[1]), { includeDetails: true });
    if (!entry) {
      jsonResponse(response, 404, { ok: false, error: "Activity entry not found." });
      return true;
    }
    jsonResponse(response, 200, { ok: true, entry });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/activity") {
    jsonResponse(response, 200, {
      ok: true,
      entries: app.activityLog.query({
        limit: Number(requestUrl.searchParams.get("limit") || 100),
        action: requestUrl.searchParams.get("action") || null,
        direction: requestUrl.searchParams.get("direction") || null,
        projectId: requestUrl.searchParams.get("projectId") || null,
        includeDetails: requestUrl.searchParams.get("includeDetails") === "true"
      })
    });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/activity/summary") {
    jsonResponse(response, 200, {
      ok: true,
      summary: app.activityLog.summary()
    });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/errors") {
    const filters: any = {};
    const severity = requestUrl.searchParams.get("severity");
    const component = requestUrl.searchParams.get("component");
    const resolved = requestUrl.searchParams.get("resolved");
    const code = requestUrl.searchParams.get("code");
    const limit = requestUrl.searchParams.get("limit");
    const since = requestUrl.searchParams.get("since");
    const sessionIdFilter = requestUrl.searchParams.get("sessionId");

    if (severity) filters.severity = severity;
    if (component) filters.component = component;
    if (resolved !== null && resolved !== undefined && resolved !== "") {
      filters.resolved = resolved === "true";
    }
    if (code) filters.code = code;
    if (limit) filters.limit = Number(limit);
    if (since) filters.since = since;
    if (sessionIdFilter) filters.sessionId = sessionIdFilter;

    const entries: DiagnosticErrorEntry[] = app.errorTracker.query(filters);
    jsonResponse(response, 200, {
      ok: true,
      totalEntries: entries.length,
      entries
    });
    return true;
  }

  if (request.method === "GET" && requestUrl.pathname === "/errors/summary") {
    jsonResponse(response, 200, {
      ok: true,
      summary: app.errorTracker.summary()
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/errors/add") {
    const body = await readJsonBody(request);
    const record = app.recordError(body);
    jsonResponse(response, 200, {
      ok: true,
      entry: record
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/errors/resolve") {
    const body = await readJsonBody(request);
    if (body.all === true) {
      const count = app.errorTracker.resolveAll();
      jsonResponse(response, 200, { ok: true, resolvedCount: count });
      return true;
    }
    const entry = app.errorTracker.resolve(body.id);
    if (!entry) {
      jsonResponse(response, 404, { ok: false, error: "Entry not found." });
      return true;
    }
    jsonResponse(response, 200, { ok: true, entry });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/errors/clear") {
    app.errorTracker.clear();
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = {
  handleDiagnosticsRoutes
};

