"use strict";

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ConnectionAcceptBody,
  ConnectionDeclineBody,
  ConnectionDiffBody,
  ConnectionOfferSummary,
  ConnectionRequestBody,
  NormalizedConnectionAccept,
  ProjectPayloadForConnection,
  SessionSummaryForConnection,
  StudioSnapshot,
  TruthSource
} from "../contracts/connection";
import {
  normalizeConnectionAcceptBody,
  normalizeConnectionDeclineBody,
  normalizeConnectionDiffBody,
  normalizeConnectionRequestBody
} from "../contracts/connection";
import { STUDIO_SYNC_MAX_JSON_BODY_BYTES, jsonResponse, readJsonBody } from "../http-utils";

const { readLocalProjectStateAsync } = require("../project");

interface ConnectionProject {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

interface ConnectionAcceptResult {
  ok: boolean;
  error?: string;
  offer: ConnectionOfferSummary | null;
  session?: unknown;
  project?: ConnectionProject;
}

interface ConnectionApp {
  beginConnectionOffer(requestedBy: string): ConnectionOfferSummary | null;
  declineConnectionOffer(offerId: string | null, studioInstanceId: string | null): { ok: boolean; offer: ConnectionOfferSummary | null; error?: string };
  acceptConnection(options: NormalizedConnectionAccept & { requirePluginVersion: true }): ConnectionAcceptResult;
  sessionSummary(session: unknown, options: { includeSessionToken: true }): SessionSummaryForConnection;
  projectPayload(project: ConnectionProject | undefined): ProjectPayloadForConnection | null;
  getProjectById(projectId: string | null): ConnectionProject | null;
  resolveProject(placeId: number, preferredProjectId?: string | null): ConnectionProject | null;
  calculateDiff(studioSnapshot: StudioSnapshot, pcSnapshot: StudioSnapshot, truthSource: TruthSource): string[];
  readLocalProjectStateAsyncWithPerf?(project: ConnectionProject): Promise<StudioSnapshot>;
}

async function handleConnectionRoutes(
  app: ConnectionApp,
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL
): Promise<boolean> {
  if (request.method === "POST" && requestUrl.pathname === "/connection/request") {
    const body = normalizeConnectionRequestBody(await readJsonBody<ConnectionRequestBody>(request));
    jsonResponse(response, 200, {
      ok: true,
      offer: app.beginConnectionOffer(body.requestedBy)
    });
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/connection/decline") {
    const body = normalizeConnectionDeclineBody(await readJsonBody<ConnectionDeclineBody>(request));
    const result = app.declineConnectionOffer(body.offerId, body.studioInstanceId);
    jsonResponse(response, result.ok ? 200 : 409, result);
    return true;
  }

  if (request.method === "POST" && requestUrl.pathname === "/connection/accept") {
    const body = normalizeConnectionAcceptBody(await readJsonBody<ConnectionAcceptBody>(request));
    const result = app.acceptConnection({
      ...body,
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
    const body = normalizeConnectionDiffBody(await readJsonBody<ConnectionDiffBody>(request, { maxBytes: STUDIO_SYNC_MAX_JSON_BODY_BYTES }));
    let project = body.projectId
      ? app.getProjectById(body.projectId)
      : null;
    if (!project && !body.projectId) {
      try {
        project = app.resolveProject(body.placeId, null);
      } catch (_error) {
        project = null;
      }
    }
    if (!project) {
      jsonResponse(response, 404, { ok: false, error: "Project not found" });
      return true;
    }
    const pcSnapshot = app.readLocalProjectStateAsyncWithPerf
      ? await app.readLocalProjectStateAsyncWithPerf(project)
      : await readLocalProjectStateAsync(project) as StudioSnapshot;
    const studioSnapshot = body.studioSnapshot;
    const changes = app.calculateDiff(studioSnapshot, pcSnapshot, body.truthSource);
    jsonResponse(response, 200, {
      ok: true,
      changes
    });
    return true;
  }

  return false;
}

export {
  handleConnectionRoutes
};
