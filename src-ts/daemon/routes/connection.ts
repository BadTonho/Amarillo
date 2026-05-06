"use strict";

const { readLocalProjectStateAsync } = require("../project");
const { jsonResponse, readJsonBody } = require("../http-utils");

async function handleConnectionRoutes(app, request, response, requestUrl) {
  if (request.method === "POST" && requestUrl.pathname === "/connection/request") {
    const body = await readJsonBody(request);
    jsonResponse(response, 200, {
      ok: true,
      offer: app.beginConnectionOffer(body.requestedBy || "vscode")
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/connection/decline") {
    const body = await readJsonBody(request);
    const result = app.declineConnectionOffer(body.offerId, body.studioInstanceId || null);
    jsonResponse(response, result.ok ? 200 : 409, result);
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/connection/accept") {
    const body = await readJsonBody(request);
    const result = app.acceptConnection({
      offerId: body.offerId || null,
      studioInstanceId: body.studioInstanceId || null,
      placeId: body.placeId || 0,
      projectId: body.projectId || null,
      truthSource: body.truthSource || "pc",
      pluginVersion: body.pluginVersion || null,
      pluginProtocolVersion: body.pluginProtocolVersion || null,
      requirePluginVersion: true
    });
    if (!result.ok) {
      jsonResponse(response, 409, result);
      return true;
    }
    jsonResponse(response, 200, {
      ok: true,
      offer: result.offer,
      session: app.sessionSummary(result.session, { includeSessionToken: true }),
      project: app.projectPayload(result.project)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/connection/diff") {
    const body = await readJsonBody(request);
    const project = app.getProjectById(body.projectId);
    if (!project) {
      jsonResponse(response, 404, { ok: false, error: "Project not found" });
      return true;
    }
    const pcSnapshot = await readLocalProjectStateAsync(project);
    const studioSnapshot = body.studioSnapshot || { mounts: [] };
    const changes = app.calculateDiff(studioSnapshot, pcSnapshot, body.truthSource);
    jsonResponse(response, 200, {
      ok: true,
      changes
    });
    return true;
  }

  return false;
}

module.exports = {
  handleConnectionRoutes
};
