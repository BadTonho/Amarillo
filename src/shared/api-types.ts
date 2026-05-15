"use strict";

// ===== Shared API Types =====
// HTTP payload contracts exchanged between the VS Code extension and the
// Amarillo daemon. This file is the source of truth for both sides.

// ----- Base types -----

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

// ----- Connection -----

export type TruthSource = "pc" | "studio";
export type ConnectionOfferStatus = "pending" | "accepted" | "declined" | "ready";

export interface ConnectionOfferPayload {
  offerId?: string;
  status?: string;
  requestedBy?: string;
  createdAt?: string;
  updatedAt?: string;
  resolvedAt?: string | null;
  declinedAt?: string | null;
  acceptedAt?: string | null;
  acceptedStudioInstanceId?: string | null;
  declinedStudioInstanceId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  truthSource?: TruthSource | null;
  [key: string]: unknown;
}

// ----- MCP -----

export interface McpShieldPayload {
  state?: string;
  message?: string;
  toolCount?: number;
  fallback?: { callUrl?: string; [key: string]: unknown };
  config?: { status?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface McpStatusPayload {
  mcp?: McpShieldPayload;
  [key: string]: unknown;
}

export interface McpProbePayload extends McpStatusPayload {
  parsed?: {
    workspaceRoot?: string;
    sessions?: unknown[];
    [key: string]: unknown;
  };
}

// ----- Session -----

export interface BridgeSessionPayload {
  id: string;
  projectId?: string;
  projectName?: string;
  projectPath?: string | null;
  placeId?: number;
  connectionState?: string;
  truthSource?: TruthSource | null;
  studioInstanceId?: string | null;
  pluginVersion?: string | null;
  pluginProtocolVersion?: number | null;
  lastPluginVersionSeenAt?: string | null;
  versionState?: string;
  versionMessage?: string;
  requiresPluginUpdate?: boolean;
  syncBlockedReason?: string | null;
  projectSelectionReason?: string | null;
  projectSelectionMessage?: string | null;
  lastStudioContactAt?: string | null;
  lastStudioSeenAt?: string | null;
  studioContactState?: string;
  studioContactAgeMs?: number;
  studioContactMessage?: string;
  lastAppliedAt?: string | null;
  pendingCommands?: number;
  inFlightCommands?: number;
  syncState?: string;
  syncMessage?: string;
  lastAckAt?: string | null;
  lastVerifiedAt?: string | null;
  lastSyncError?: string | null;
  requiresManualResync?: boolean;
  lastCommandError?: string | null;
  destructiveActionsAllowed?: boolean;
  destructiveActionReasonCode?: string | null;
  destructiveActionMessage?: string | null;
  privilegedActionsAllowed?: boolean;
  privilegedActionReasonCode?: string | null;
  privilegedActionMessage?: string | null;
  privilegedActionConfirmationEnabled?: boolean | null;
  destructiveConfirmationPending?: boolean;
  destructiveConfirmationType?: string | null;
  destructiveConfirmationSinceAt?: string | null;
  destructiveConfirmationAgeMs?: number | null;
  [key: string]: unknown;
}

export interface SessionCommandResponse {
  ok?: boolean;
  error?: string;
  result?: unknown;
  snapshot?: unknown;
  [key: string]: unknown;
}

// ----- Health -----

export interface BridgeHealthPayload {
  ok?: boolean;
  workspaceRoot?: string;
  host?: string;
  port?: number;
  versions?: Record<string, unknown>;
  autoSyncToStudio?: boolean;
  projectCount?: number;
  defaultProjectId?: string | null;
  defaultProjectPath?: string | null;
  connectionOffer?: ConnectionOfferPayload | null;
  sessions?: BridgeSessionPayload[];
  mcpShield?: McpShieldPayload | null;
  refreshedAt?: string | null;
  [key: string]: unknown;
}

// ----- Doctor -----

export interface DoctorReportPayload {
  ok?: boolean;
  status?: string;
  generatedAt?: string;
  summary?: {
    message?: string;
    sessionCount?: number;
    blockedReasons?: string[];
    warnings?: string[];
    projectCount?: number;
    syncBlockedSessionCount?: number;
    unresolvedErrorCount?: number;
    initialSyncStuckSessionCount?: number;
    mcpAuditCount?: number;
    [key: string]: unknown;
  };
  versions?: {
    daemon?: { version?: string; protocolVersion?: string | number; [key: string]: unknown };
    extension?: { version?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  workspace?: { root?: string; projectCount?: number; [key: string]: unknown };
  sessions?: BridgeSessionPayload[];
  sync?: Record<string, unknown>;
  mcp?: McpShieldPayload;
  errors?: {
    total?: number;
    unresolved?: number;
    recent?: Record<string, unknown>[];
    recentUnresolved?: Record<string, unknown>[];
    [key: string]: unknown;
  };
  activity?: Record<string, unknown>;
  mcpAudit?: Record<string, unknown>;
  compatibility?: Record<string, unknown>;
  recommendations?: string[];
  [key: string]: unknown;
}

// ----- Activity -----

export interface ActivityDetailPayload {
  oldText?: string | null;
  newText?: string | null;
  oldTextAvailable?: boolean;
  newTextAvailable?: boolean;
  oldHash?: string | null;
  newHash?: string | null;
  [key: string]: unknown;
}

export interface ActivityEntryPayload {
  id?: string;
  timestamp?: string;
  action?: string;
  path?: string | null;
  relativePath?: string | null;
  direction?: string | null;
  reason?: string | null;
  source?: string | null;
  oldHash?: string | null;
  newHash?: string | null;
  oldSize?: number | null;
  newSize?: number | null;
  hasTextSnapshot?: boolean;
  canRevert?: boolean;
  detail?: ActivityDetailPayload | null;
  [key: string]: unknown;
}

export interface ActivityListResponse {
  entries?: ActivityEntryPayload[];
  [key: string]: unknown;
}

export interface ActivityEntryResponse {
  entry?: ActivityEntryPayload;
  [key: string]: unknown;
}

// ----- Connection Request/Response -----

export interface ConnectionRequestResponse {
  offer?: ConnectionOfferPayload | null;
  [key: string]: unknown;
}

// ----- Workspace -----

export interface WorkspaceFilesChangedResponse {
  accepted?: number;
  ignored?: number;
  [key: string]: unknown;
}

// ----- Project -----

export interface ProjectPayload {
  id: string;
  name: string;
  projectPath?: string;
  enabled?: boolean;
  abstract?: boolean;
  extendsProjectId?: string | null;
  extendsProjectPath?: string | null;
  placeIds?: number[];
  mountCount?: number;
  mounts?: {
    id: string;
    path?: string;
    relativePath?: string;
    keepUnknowns?: boolean;
    [key: string]: unknown;
  }[];
  [key: string]: unknown;
}
