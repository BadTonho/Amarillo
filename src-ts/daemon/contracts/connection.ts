"use strict";

export type TruthSource = "pc" | "studio";
export type ConnectionOfferStatus = "pending" | "accepted" | "declined" | "ready";

export interface StudioSnapshot {
  mounts: unknown[];
  [key: string]: unknown;
}

export interface ConnectionRequestBody {
  requestedBy?: unknown;
}

export interface ConnectionDeclineBody {
  offerId?: unknown;
  studioInstanceId?: unknown;
}

export interface ConnectionAcceptBody {
  offerId?: unknown;
  studioInstanceId?: unknown;
  placeId?: unknown;
  projectId?: unknown;
  truthSource?: unknown;
  pluginVersion?: unknown;
  pluginProtocolVersion?: unknown;
}

export interface ConnectionDiffBody {
  projectId?: unknown;
  studioSnapshot?: unknown;
  truthSource?: unknown;
}

export interface NormalizedConnectionRequest {
  requestedBy: string;
}

export interface NormalizedConnectionDecline {
  offerId: string | null;
  studioInstanceId: string | null;
}

export interface NormalizedConnectionAccept {
  offerId: string | null;
  studioInstanceId: string | null;
  placeId: number;
  projectId: string | null;
  truthSource: TruthSource;
  pluginVersion: string | null;
  pluginProtocolVersion: string | number | null;
}

export interface NormalizedConnectionDiff {
  projectId: string | null;
  studioSnapshot: StudioSnapshot;
  truthSource: TruthSource;
}

export interface ConnectionOfferSummary {
  offerId: string;
  status: ConnectionOfferStatus;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  declinedAt: string | null;
  acceptedAt: string | null;
  acceptedStudioInstanceId: string | null;
  declinedStudioInstanceId: string | null;
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  truthSource: TruthSource | null;
}

export interface SessionSummaryForConnection {
  id: string;
  sessionToken?: string | null;
  projectId: string;
  projectName: string;
  connectionState: string;
  truthSource: TruthSource | null;
  placeId: number;
  [key: string]: unknown;
}

export interface ProjectPayloadForConnection {
  id: string;
  name: string;
  [key: string]: unknown;
}

function optionalString(value: unknown): string | null {
  return value ? String(value) : null;
}

function stringWithFallback(value: unknown, fallback: string): string {
  return optionalString(value) || fallback;
}

function optionalVersion(value: unknown): string | number | null {
  if (!value) {
    return null;
  }
  return typeof value === "number" ? value : String(value);
}

export function normalizeTruthSource(value: unknown): TruthSource {
  return value === "studio" ? "studio" : "pc";
}

export function normalizePlaceId(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeStudioSnapshot(value: unknown): StudioSnapshot {
  if (value && typeof value === "object" && Array.isArray((value as { mounts?: unknown }).mounts)) {
    return value as StudioSnapshot;
  }
  return { mounts: [] };
}

export function normalizeConnectionRequestBody(body: ConnectionRequestBody): NormalizedConnectionRequest {
  return {
    requestedBy: stringWithFallback(body.requestedBy, "vscode")
  };
}

export function normalizeConnectionDeclineBody(body: ConnectionDeclineBody): NormalizedConnectionDecline {
  return {
    offerId: optionalString(body.offerId),
    studioInstanceId: optionalString(body.studioInstanceId)
  };
}

export function normalizeConnectionAcceptBody(body: ConnectionAcceptBody): NormalizedConnectionAccept {
  return {
    offerId: optionalString(body.offerId),
    studioInstanceId: optionalString(body.studioInstanceId),
    placeId: normalizePlaceId(body.placeId),
    projectId: optionalString(body.projectId),
    truthSource: normalizeTruthSource(body.truthSource),
    pluginVersion: optionalString(body.pluginVersion),
    pluginProtocolVersion: optionalVersion(body.pluginProtocolVersion)
  };
}

export function normalizeConnectionDiffBody(body: ConnectionDiffBody): NormalizedConnectionDiff {
  return {
    projectId: optionalString(body.projectId),
    studioSnapshot: normalizeStudioSnapshot(body.studioSnapshot),
    truthSource: normalizeTruthSource(body.truthSource)
  };
}
