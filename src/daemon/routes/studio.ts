"use strict";

const { performance } = require("node:perf_hooks");
const { patchStudioFileSource } = require("../project");
const {
  SESSION_TOKEN_HEADER,
  STUDIO_SYNC_MAX_JSON_BODY_BYTES,
  jsonBodyByteLength,
  jsonResponse,
  readJsonBody,
  requestContentLength
} = require("../http-utils");

const INITIAL_STUDIO_SYNC_REASON = "initial_accept";

function requestHasSessionToken(request) {
  const token = request.headers?.[SESSION_TOKEN_HEADER];
  return typeof token === "string" && token.trim().length > 0;
}

function syncTargetsFromPollParams(searchParams) {
  const workspaceValue = searchParams.get("syncTargets.Workspace")
    ?? searchParams.get("syncTargetsWorkspace")
    ?? searchParams.get("workspaceSyncEnabled");
  return workspaceValue === null ? {} : { Workspace: workspaceValue };
}

function recordStudioPollDuration(app, startedAt) {
  if (typeof app.recordPerformance === "function") {
    app.recordPerformance("studio.poll.duration", performance.now() - startedAt);
  }
}

function recordStudioSnapshotFailure(app, session, body, statusCode, code, message, request) {
  if (session) {
    session.lastCommandError = message;
  }
  app.recordError({
    component: "studio",
    severity: "error",
    code,
    message,
    sessionId: session?.id || body?.sessionId || null,
    projectId: session?.projectId || null,
    context: {
      route: "/studio/snapshot",
      statusCode,
      reason: body?.reason || null,
      truthSource: session?.truthSource || null,
      connectionState: session?.connectionState || null,
      hasSessionToken: requestHasSessionToken(request),
      pluginVersion: body?.pluginVersion || null,
      pluginProtocolVersion: body?.pluginProtocolVersion || null,
      initialStudioSync: body?.reason === INITIAL_STUDIO_SYNC_REASON
    }
  });
}

async function handleStudioRoutes(app, request, response, requestUrl) {
  if (request.method === "GET" && requestUrl.pathname === "/studio/poll") {
    const pollStartedAt = performance.now();
    const sessionId = requestUrl.searchParams.get("sessionId");
    if (!sessionId) {
      recordStudioPollDuration(app, pollStartedAt);
      jsonResponse(response, 200, {
        ok: true,
        mode: "offer",
        offer: app.connectionOffer && app.connectionOffer.status === "pending"
          ? app.connectionOfferSummary()
          : null
      });
      return true;
    }

    const session = app.sessions.get(sessionId);
    if (!session) {
      recordStudioPollDuration(app, pollStartedAt);
      jsonResponse(response, 404, { ok: false, error: "Session not found." });
      return true;
    }
    if (!app.isSessionRequestAuthorized(request, session)) {
      recordStudioPollDuration(app, pollStartedAt);
      jsonResponse(response, 401, { ok: false, code: "UNAUTHORIZED", error: "Missing or invalid Studio session token." }, request);
      return true;
    }
    app.updateSessionPluginVersion(session, {
      pluginVersion: requestUrl.searchParams.get("pluginVersion"),
      pluginProtocolVersion: requestUrl.searchParams.get("pluginProtocolVersion"),
      privilegedActionConfirmationEnabled: requestUrl.searchParams.get("privilegedActionConfirmationEnabled"),
      detectModels: requestUrl.searchParams.get("detectModels"),
      syncTargets: syncTargetsFromPollParams(requestUrl.searchParams)
    });
    app.updateDestructiveConfirmationState(session, {
      destructiveConfirmationPending: requestUrl.searchParams.get("destructiveConfirmationPending"),
      destructiveConfirmationType: requestUrl.searchParams.get("destructiveConfirmationType"),
      destructiveConfirmationSinceAt: requestUrl.searchParams.get("destructiveConfirmationSinceAt")
    });
    app.markStudioSessionContact(session);

    if (session.pendingCommands.length > 0) {
      const data = app.dequeueCommands(sessionId);
      recordStudioPollDuration(app, pollStartedAt);
      jsonResponse(response, 200, { ok: true, ...data });
      return true;
    }

    const LONG_POLL_TIMEOUT = 25000;
    let resolved = false;
    const respond = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (session._pollWaiter === respond) {
        session._pollWaiter = null;
      }
      try {
        const data = app.dequeueCommands(sessionId);
        recordStudioPollDuration(app, pollStartedAt);
        jsonResponse(response, 200, { ok: true, ...data });
      } catch (_error) {
        recordStudioPollDuration(app, pollStartedAt);
        jsonResponse(response, 200, { ok: true, commands: [] });
      }
    };

    const timer = setTimeout(respond, LONG_POLL_TIMEOUT);
    session._pollWaiter = respond;
    request.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (session._pollWaiter === respond) {
          session._pollWaiter = null;
        }
      }
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/studio/complete") {
    const body = await readJsonBody(request, { maxBytes: STUDIO_SYNC_MAX_JSON_BODY_BYTES });
    const session = app.sessions.get(body.sessionId);
    if (session && !app.isSessionRequestAuthorized(request, session)) {
      jsonResponse(response, 401, { ok: false, code: "UNAUTHORIZED", error: "Missing or invalid Studio session token." }, request);
      return true;
    }
    app.updateSessionPluginVersion(session, body);
    app.updateDestructiveConfirmationState(session, body);
    app.markStudioSessionContact(session);
    if (body.ok || body.blocked === true || body.declined === true) {
      app.completeCommand(body.sessionId, body.commandId, body);
    } else {
      app.rejectCommand(body.sessionId, body.commandId, body.error || "Studio reported an error.");
    }
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/studio/snapshot") {
    const body = await readJsonBody(request, { maxBytes: STUDIO_SYNC_MAX_JSON_BODY_BYTES });
    const requestByteLength = requestContentLength(request) ?? jsonBodyByteLength(body);
    const session = app.sessions.get(body.sessionId);
    if (!session) {
      const message = "Studio session not found for snapshot.";
      recordStudioSnapshotFailure(app, null, body, 404, "STUDIO-SNAPSHOT-SESSION", message, request);
      jsonResponse(response, 404, { ok: false, code: "SESSION_NOT_FOUND", error: message }, request);
      return true;
    }
    if (!app.isSessionRequestAuthorized(request, session)) {
      const message = "Missing or invalid Studio session token.";
      recordStudioSnapshotFailure(app, session, body, 401, "STUDIO-SNAPSHOT-AUTH", message, request);
      jsonResponse(response, 401, { ok: false, code: "UNAUTHORIZED", error: message }, request);
      return true;
    }
    app.updateSessionPluginVersion(session, body);
    app.updateDestructiveConfirmationState(session, body);
    app.markStudioSessionContact(session);
    if (app.isSessionVersionBlocked(session)) {
      const message = app.syncBlockedReason(session);
      recordStudioSnapshotFailure(app, session, body, 409, "STUDIO-SNAPSHOT-BLOCKED", message, request);
      jsonResponse(response, 409, {
        ok: false,
        error: message,
        session: app.sessionSummary(session)
      });
      return true;
    }
    try {
      app.updateStudioSnapshot(body.sessionId, body.snapshot, body.reason || "auto", { requestByteLength });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      const code = error.code || "STUDIO-SNAPSHOT";
      const message = error.message || "Studio snapshot could not be applied.";
      recordStudioSnapshotFailure(app, session, body, statusCode, code, message, request);
      jsonResponse(response, statusCode, { ok: false, code, error: message }, request);
      return true;
    }
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/studio/patch-source") {
    const body = await readJsonBody(request, { maxBytes: STUDIO_SYNC_MAX_JSON_BODY_BYTES });
    const sessionId = body.sessionId;
    const session = app.sessions.get(sessionId);
    if (!session) {
      jsonResponse(response, 404, { ok: false, error: "Session not found." });
      return true;
    }
    if (!app.isSessionRequestAuthorized(request, session)) {
      jsonResponse(response, 401, { ok: false, code: "UNAUTHORIZED", error: "Missing or invalid Studio session token." }, request);
      return true;
    }
    app.updateSessionPluginVersion(session, body);
    app.updateDestructiveConfirmationState(session, body);
    app.markStudioSessionContact(session);
    if (app.isSessionVersionBlocked(session)) {
      jsonResponse(response, 409, {
        ok: false,
        error: app.syncBlockedReason(session),
        session: app.sessionSummary(session)
      });
      return true;
    }
    const project = app.getProjectById(session.projectId);
    if (!project) {
      jsonResponse(response, 404, { ok: false, error: "Project not found." });
      return true;
    }

    if (app.isInstancePathSyncEnabled && !app.isInstancePathSyncEnabled(session, body.path)) {
      jsonResponse(response, 200, {
        ok: true,
        skipped: true,
        reason: "sync_target_disabled"
      });
      return true;
    }

    if (app.isInstancePathBlacklisted && app.isInstancePathBlacklisted(session, body.path)) {
      jsonResponse(response, 200, {
        ok: true,
        skipped: true,
        reason: "sync_blacklist"
      });
      return true;
    }

    app.lastDiskWriteTime = Date.now();
    const result = patchStudioFileSource(project, body.path, body.source, {
      project,
      onFileChange: (change) => {
        app.recordActivity(change, {
          direction: "studio_to_pc",
          source: "studio_patch",
          reason: "script_patch",
          sessionId
        });
      }
    });
    if (!result.ok) {
      app.recordError({
        component: "daemon",
        severity: "warning",
        code: "STUDIO-PATCH",
        message: result.error || "Studio patch could not be written to disk.",
        sessionId,
        projectId: project.id,
        context: { path: body.path }
      });
    }
    if (result.ok) {
      app.recordPatchedStudioSource(session, body.path, body.source);
    }
    jsonResponse(response, 200, result);
    return true;
  }

  return false;
}

module.exports = {
  handleStudioRoutes
};
