"use strict";

const { readLocalProjectStateAsync } = require("../project");
const { jsonResponse, readJsonBody } = require("../http-utils");

async function handleSessionRoutes(app, request, response, requestUrl) {
  if (request.method === "POST" && requestUrl.pathname === "/session/open") {
    const body = await readJsonBody(request);
    const { session, project } = app.openSession(body.placeId || 0, body.projectId || null, {
      studioInstanceId: body.studioInstanceId || null,
      truthSource: body.truthSource || null,
      connectionState: body.connectionState || "ready",
      pluginVersion: body.pluginVersion || null,
      pluginProtocolVersion: body.pluginProtocolVersion || null,
      requirePluginVersion: body.requirePluginVersion === true
    });
    jsonResponse(response, 200, {
      ok: true,
      session: app.sessionSummary(session, { includeSessionToken: true }),
      project: app.projectPayload(project)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/session/close") {
    const body = await readJsonBody(request);
    jsonResponse(response, 200, {
      ok: app.closeSession(body.sessionId)
    });
    return true;
  }

  const sessionActionMatch = requestUrl.pathname.match(/^\/session\/([^/]+)\/(status|pull|push|resync|tree|exec|selection|playtest|properties|descendants|search|services|instance-info|output-log|modify-property|create-instance|delete-instance|insert-model)$/);
  if (!sessionActionMatch) {
    return false;
  }

  const [, sessionId, action] = sessionActionMatch;
  const session = app.sessions.get(sessionId);
  if (!session) {
    jsonResponse(response, 404, {
      ok: false,
      error: "Session not found."
    });
    return true;
  }
  const project = app.getProjectById(session.projectId);

  if (request.method === "GET" && action === "status") {
    jsonResponse(response, 200, {
      ok: true,
      session: app.sessionSummary(session),
      project: project ? { id: project.id, name: project.name } : null
    });
    return true;
  }

  if (request.method === "POST" && action === "pull") {
    const blockedReason = app.isSessionVersionBlocked(session) ? app.syncBlockedReason(session) : null;
    if (blockedReason) {
      jsonResponse(response, 409, { ok: false, error: blockedReason, session: app.sessionSummary(session) });
      return true;
    }
    const result = await app.enqueueCommand(sessionId, "apply_project_tree", {
      project: await readLocalProjectStateAsync(project, app.projectReadOptions(session)),
      reason: "manual_pull"
    }, true);
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "POST" && action === "push") {
    const blockedReason = app.isSessionVersionBlocked(session) ? app.syncBlockedReason(session) : null;
    if (blockedReason) {
      jsonResponse(response, 409, { ok: false, error: blockedReason, session: app.sessionSummary(session) });
      return true;
    }
    const snapshot = await app.requestStudioTree(sessionId);
    jsonResponse(response, 200, {
      ok: true,
      snapshot,
      snapshotHash: session.lastStudioHash
    });
    return true;
  }

  if (request.method === "POST" && action === "resync") {
    const blockedReason = app.isSessionVersionBlocked(session) ? app.syncBlockedReason(session) : null;
    if (blockedReason) {
      jsonResponse(response, 409, { ok: false, error: blockedReason, session: app.sessionSummary(session) });
      return true;
    }
    const body = await readJsonBody(request);
    const direction = body.direction === "studio_to_pc" || body.direction === "push"
      ? "studio_to_pc"
      : "pc_to_studio";
    if (direction === "studio_to_pc") {
      const snapshot = await app.requestStudioTree(sessionId);
      app.markSyncVerified(session, session.lastStudioHash);
      jsonResponse(response, 200, {
        ok: true,
        direction,
        snapshotHash: session.lastStudioHash,
        snapshot
      });
      return true;
    }
    const result = await app.enqueueCommand(sessionId, "apply_project_tree", {
      project: await readLocalProjectStateAsync(project, app.projectReadOptions(session)),
      reason: "manual_resync"
    }, true);
    jsonResponse(response, 200, {
      ok: true,
      direction,
      result,
      sync: app.ensureSessionSyncState(session)
    });
    return true;
  }

  if (request.method === "GET" && action === "tree") {
    const snapshot = session.lastStudioSnapshot || await app.requestStudioTree(sessionId);
    jsonResponse(response, 200, { ok: true, snapshot });
    return true;
  }

  if (request.method === "POST" && action === "exec") {
    const body = await readJsonBody(request);
    const result = await app.runStudioCode(sessionId, body.code || "");
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "GET" && action === "selection") {
    const selection = await app.requestStudioSelection(sessionId);
    jsonResponse(response, 200, { ok: true, selection });
    return true;
  }

  if (request.method === "POST" && action === "playtest") {
    const body = await readJsonBody(request);
    const mode = body.mode === "stop" ? "stop" : "start";
    const result = await app.enqueueCommand(sessionId, "playtest", { mode }, true);
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "POST" && action === "properties") {
    const body = await readJsonBody(request);
    const result = await app.enqueueCommand(sessionId, "get_properties", { path: body.path }, true);
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "POST" && action === "descendants") {
    const body = await readJsonBody(request);
    const result = await app.enqueueCommand(sessionId, "get_descendants", {
      path: body.path,
      maxDepth: Math.min(Math.max(Number(body.maxDepth) || 10, 1), 10),
      classFilter: body.classFilter || null
    }, true);
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "POST" && action === "search") {
    const body = await readJsonBody(request);
    const result = await app.enqueueCommand(sessionId, "search_instances", {
      query: body.query,
      searchBy: body.searchBy || "both",
      scope: body.scope || null
    }, true);
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "GET" && action === "services") {
    const result = await app.enqueueCommand(sessionId, "get_services", {}, true);
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "POST" && action === "instance-info") {
    const body = await readJsonBody(request);
    const result = await app.enqueueCommand(sessionId, "get_instance_info", { path: body.path }, true);
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "GET" && action === "output-log") {
    const count = Math.min(Math.max(Number(requestUrl.searchParams.get("count")) || 50, 1), 200);
    const result = await app.enqueueCommand(sessionId, "get_output_log", { count }, true);
    jsonResponse(response, 200, { ok: true, result });
    return true;
  }

  if (request.method === "POST" && action === "modify-property") {
    const body = await readJsonBody(request);
    const result = await app.enqueueDestructiveCommand(sessionId, "modify_property", {
      path: body.path,
      property: body.property,
      value: body.value
    });
    jsonResponse(response, result.blocked ? 409 : 200, { ok: !result.blocked, result });
    return true;
  }

  if (request.method === "POST" && action === "create-instance") {
    const body = await readJsonBody(request);
    const result = await app.enqueueDestructiveCommand(sessionId, "create_instance", {
      parentPath: body.parentPath,
      className: body.className,
      name: body.name || body.className,
      properties: body.properties || {}
    });
    jsonResponse(response, result.blocked ? 409 : 200, { ok: !result.blocked, result });
    return true;
  }

  if (request.method === "POST" && action === "delete-instance") {
    const body = await readJsonBody(request);
    const result = await app.enqueueDestructiveCommand(sessionId, "delete_instance", { path: body.path });
    jsonResponse(response, result.blocked ? 409 : 200, { ok: !result.blocked, result });
    return true;
  }

  if (request.method === "POST" && action === "insert-model") {
    const body = await readJsonBody(request);
    const result = await app.enqueueDestructiveCommand(sessionId, "insert_model", {
      query: body.query
    });
    jsonResponse(response, result.blocked ? 409 : 200, { ok: !result.blocked, result });
    return true;
  }

  return false;
}

module.exports = {
  handleSessionRoutes
};
