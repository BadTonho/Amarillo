"use strict";

const { patchStudioFileSource } = require("../project");
const { jsonResponse, readJsonBody } = require("../http-utils");

async function handleStudioRoutes(app, request, response, requestUrl) {
  if (request.method === "GET" && requestUrl.pathname === "/studio/poll") {
    const sessionId = requestUrl.searchParams.get("sessionId");
    if (!sessionId) {
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
      jsonResponse(response, 404, { ok: false, error: "Session not found." });
      return true;
    }
    if (!app.isSessionRequestAuthorized(request, session)) {
      jsonResponse(response, 401, { ok: false, code: "UNAUTHORIZED", error: "Missing or invalid Studio session token." }, request);
      return true;
    }
    app.updateSessionPluginVersion(session, {
      pluginVersion: requestUrl.searchParams.get("pluginVersion"),
      pluginProtocolVersion: requestUrl.searchParams.get("pluginProtocolVersion")
    });
    app.markStudioSessionContact(session);

    if (session.pendingCommands.length > 0) {
      const data = app.dequeueCommands(sessionId);
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
        jsonResponse(response, 200, { ok: true, ...data });
      } catch (_error) {
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
    const body = await readJsonBody(request);
    const session = app.sessions.get(body.sessionId);
    if (session && !app.isSessionRequestAuthorized(request, session)) {
      jsonResponse(response, 401, { ok: false, code: "UNAUTHORIZED", error: "Missing or invalid Studio session token." }, request);
      return true;
    }
    app.updateSessionPluginVersion(session, body);
    app.markStudioSessionContact(session);
    if (body.ok) {
      app.completeCommand(body.sessionId, body.commandId, body);
    } else {
      app.rejectCommand(body.sessionId, body.commandId, body.error || "Studio reported an error.");
    }
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/studio/snapshot") {
    const body = await readJsonBody(request);
    const session = app.sessions.get(body.sessionId);
    if (session && !app.isSessionRequestAuthorized(request, session)) {
      jsonResponse(response, 401, { ok: false, code: "UNAUTHORIZED", error: "Missing or invalid Studio session token." }, request);
      return true;
    }
    app.updateSessionPluginVersion(session, body);
    app.markStudioSessionContact(session);
    if (session && app.isSessionVersionBlocked(session)) {
      jsonResponse(response, 409, {
        ok: false,
        error: app.syncBlockedReason(session),
        session: app.sessionSummary(session)
      });
      return true;
    }
    app.updateStudioSnapshot(body.sessionId, body.snapshot, body.reason || "auto");
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/studio/patch-source") {
    const body = await readJsonBody(request);
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
