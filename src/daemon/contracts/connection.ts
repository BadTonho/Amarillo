"use strict";

import type { StudioSnapshot } from "./studio";
import type { SyncBlacklistEntry } from "../sync-blacklist";
const { normalizeSyncBlacklist } = require("../sync-blacklist");

export type { StudioSnapshot } from "./studio";

export type TruthSource = "pc" | "studio";
export type ConnectionOfferStatus = "pending" | "accepted" | "declined" | "ready";

export interface SyncTargetsPayload {
  Workspace?: unknown;
  workspace?: unknown;
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
  placeName?: unknown;
  projectId?: unknown;
  truthSource?: unknown;
  pluginVersion?: unknown;
  pluginProtocolVersion?: unknown;
  privilegedActionConfirmationEnabled?: unknown;
  detectModels?: unknown;
  syncTargets?: unknown;
  syncBlacklist?: unknown;
}

export interface ConnectionDiffBody {
  placeId?: unknown;
  placeName?: unknown;
  projectId?: unknown;
  studioSnapshot?: unknown;
  truthSource?: unknown;
  detectModels?: unknown;
  syncTargets?: unknown;
  syncBlacklist?: unknown;
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
  placeName: string | null;
  projectId: string | null;
  truthSource: TruthSource;
  pluginVersion: string | null;
  pluginProtocolVersion: string | number | null;
  privilegedActionConfirmationEnabled: boolean | null;
  detectModels: boolean | null;
  syncTargets: SyncTargetsPayload;
  syncBlacklist: SyncBlacklistEntry[];
}

export interface NormalizedConnectionDiff {
  placeId: number;
  placeName: string | null;
  projectId: string | null;
  studioSnapshot: StudioSnapshot;
  truthSource: TruthSource;
  detectModels: boolean | null;
  syncTargets: SyncTargetsPayload;
  syncBlacklist: SyncBlacklistEntry[];
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

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function optionalObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
    placeName: optionalString(body.placeName),
    projectId: optionalString(body.projectId),
    truthSource: normalizeTruthSource(body.truthSource),
    pluginVersion: optionalString(body.pluginVersion),
    pluginProtocolVersion: optionalVersion(body.pluginProtocolVersion),
    privilegedActionConfirmationEnabled: optionalBoolean(body.privilegedActionConfirmationEnabled),
    detectModels: optionalBoolean(body.detectModels),
    syncTargets: optionalObject(body.syncTargets),
    syncBlacklist: normalizeSyncBlacklist(body.syncBlacklist)
  };
}

export function normalizeConnectionDiffBody(body: ConnectionDiffBody): NormalizedConnectionDiff {
  return {
    placeId: normalizePlaceId(body.placeId),
    placeName: optionalString(body.placeName),
    projectId: optionalString(body.projectId),
    studioSnapshot: normalizeStudioSnapshot(body.studioSnapshot),
    truthSource: normalizeTruthSource(body.truthSource),
    detectModels: optionalBoolean(body.detectModels),
    syncTargets: optionalObject(body.syncTargets),
    syncBlacklist: normalizeSyncBlacklist(body.syncBlacklist)
  };
}
