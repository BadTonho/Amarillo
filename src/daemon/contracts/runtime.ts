"use strict";

import type { ConnectionOfferStatus, TruthSource } from "./connection";
import type { RuntimeSnapshotNode, StudioSnapshot } from "./studio";

export type { RuntimeSnapshotNode, StudioSnapshot } from "./studio";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface RuntimeMount {
  id: string;
  relativePath: string;
  absolutePath: string;
  segments: string[];
  children?: RuntimeSnapshotNode[];
  [key: string]: unknown;
}

export interface RuntimeProject {
  id: string;
  name: string;
  projectPath?: string;
  enabled?: boolean;
  abstract?: boolean;
  placeIds?: number[];
  mounts?: RuntimeMount[];
  inheritanceIds?: string[];
  extendsProjectId?: string | null;
  extendsProjectPath?: string | null;
  [key: string]: unknown;
}

export interface ProjectSelection {
  project: RuntimeProject | null;
  reason: string;
  message: string;
}

export interface ProjectCatalogIssue {
  key: string;
  code?: string | null;
  message: string;
  projectId?: string | null;
  projectPath?: string | null;
  filePath?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface DaemonConfig {
  argon: Record<string, unknown>;
  plugin: Record<string, unknown>;
  issues?: ProjectCatalogIssue[];
  [key: string]: unknown;
}

export interface AppOptions {
  workspaceRoot?: string;
  host?: string;
  port?: number | string;
  strictPort?: boolean;
  autoSyncToStudio?: unknown;
  syncTargets?: unknown;
  privilegedActionConfirmation?: unknown;
  bridgeToken?: string | null;
  extensionVersion?: string | null;
  extensionProtocolVersion?: string | number | null;
  initialStudioContactGraceMs?: number | string;
  studioSessionStaleMs?: number | string;
}

export interface SyncState {
  state: "ready" | "degraded" | string;
  lastAckAt: string | null;
  lastVerifiedAt: string | null;
  lastFailure: Record<string, unknown> | null;
  lastExpectedHash: string | null;
  lastObservedHash: string | null;
  degradedReason: string | null;
}

export interface SyncCommandPayload extends Record<string, unknown> {
  path?: string[];
  project?: StudioSnapshot;
  reason?: string;
}

export interface SyncCommand {
  id: string;
  type: string;
  payload: SyncCommandPayload;
  queuedAt: number;
  expectedHash?: string | null;
  syncGuardTimer?: NodeJS.Timeout | null;
}

export interface CommandDeferred {
  promise: Promise<unknown>;
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout?: NodeJS.Timeout;
}

export interface PendingStudioWrite {
  sessionId: string;
  reason: string;
  snapshotHash: string | null;
  queuedAt: number;
  updatedAt: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
  promise: Promise<void>;
  resolve: () => void;
}

export interface RuntimeSession {
  id: string;
  sessionToken: string;
  placeId: number;
  placeName: string | null;
  projectId: string;
  createdAt: string;
  lastStudioHash: string | null;
  lastStudioRawHash: string | null;
  lastStudioSnapshot: StudioSnapshot | null;
  syncTargets: Record<string, unknown>;
  lastStudioSeenAt: string | null;
  lastStudioContactAt: string | null;
  pendingCommands: SyncCommand[];
  pendingResponses: Map<string, CommandDeferred>;
  inFlightCommands: Map<string, SyncCommand>;
  fileChangeTimer: NodeJS.Timeout | null;
  filePatchTimers: Map<string, NodeJS.Timeout>;
  filePatchBatchTimer: NodeJS.Timeout | null;
  filePatchBatch: Map<string, {
    project: RuntimeProject;
    filePath: string;
    instanceSegments: string[];
  }>;
  lastAppliedAt: string | null;
  sync: SyncState;
  connectionState: string;
  truthSource: TruthSource | null;
  studioInstanceId: string | null;
  requirePluginVersion: boolean;
  pluginVersion: string | null;
  pluginProtocolVersion: number | null;
  privilegedActionConfirmationEnabled: boolean | null;
  lastPluginVersionSeenAt: string | null;
  lastCommandError: string | null;
  destructiveConfirmationPending: boolean;
  destructiveConfirmationType: string | null;
  destructiveConfirmationSinceAt: string | null;
  projectSelectionReason: string | null;
  projectSelectionMessage: string | null;
  _pollWaiter: (() => void) | null;
  [key: string]: unknown;
}

export interface SessionOpenOptions {
  connectionState?: string;
  truthSource?: TruthSource | null;
  placeName?: string | null;
  studioInstanceId?: string | null;
  requirePluginVersion?: boolean;
  pluginVersion?: string | number | null;
  pluginProtocolVersion?: string | number | null;
  privilegedActionConfirmationEnabled?: boolean | string | number | null;
  syncTargets?: unknown;
}

export interface ConnectionOfferRuntime {
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

export interface ConnectionOfferResolutionDetails {
  studioInstanceId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  truthSource?: TruthSource | null;
}

export interface ActivityFileInfo {
  size?: number;
  hash?: string;
  text?: string | null;
  [key: string]: unknown;
}

export interface ActivityChangeInput {
  action?: string | null;
  filePath?: string;
  path?: string;
  projectId?: string | null;
  mountId?: string | null;
  size?: number;
  hash?: string;
  oldInfo?: ActivityFileInfo | null;
  newInfo?: ActivityFileInfo | null;
  [key: string]: unknown;
}

export interface ActivityDefaults {
  direction?: string;
  source?: string;
  reason?: string;
  eventType?: string;
  sessionId?: string | null;
  projectId?: string | null;
  mountId?: string | null;
}

export interface TimestampedRecord extends Record<string, unknown> {
  timestamp?: string;
  at?: string;
  createdAt?: string;
}

export interface ActivitySummary extends Record<string, unknown> {
  recent: TimestampedRecord[];
}

export interface ActivityLogLike {
  add(entry: Record<string, unknown>): Record<string, unknown>;
  get?(id: string, options?: Record<string, unknown>): Record<string, unknown> | null;
  query?(options?: Record<string, unknown>): TimestampedRecord[];
  summary(): ActivitySummary;
}

export interface ErrorInput {
  component?: string;
  severity?: string;
  code?: string | null;
  message?: string;
  file?: string | null;
  line?: number | null;
  sessionId?: string | null;
  projectId?: string | null;
  context?: Record<string, unknown> | null;
  suggestion?: string | null;
  stack?: string | null;
}

export interface ErrorTrackerLike {
  add(entry: Record<string, unknown>): Record<string, unknown>;
  query(options: Record<string, unknown>): TimestampedRecord[];
  summary(): {
    unresolved: number;
    recent: TimestampedRecord[];
    [key: string]: unknown;
  };
}

export interface McpAuditSummary extends Record<string, unknown> {
  lastTool?: TimestampedRecord | null;
  lastFailureOrDecline?: TimestampedRecord | null;
}

export interface McpAuditLogLike {
  add(entry: Record<string, unknown>): Record<string, unknown>;
  summary(): McpAuditSummary;
}

export interface McpShieldState {
  state: string;
  message?: string;
  callCount: number;
  failureCount: number;
  lastFailure: Record<string, unknown> | null;
  lastTool: string | null;
  lastNativeCallAt: string | null;
  lastProxyContactAt: string | null;
  lastHttpFallbackCallAt: string | null;
  lastProbeAt: string | null;
  [key: string]: unknown;
}

export interface RateLimiterLike {
  isLimited(key: string): boolean;
  dispose(): void;
}

export interface SyncDegradedDetails {
  code?: string;
  component?: string;
  severity?: string;
  commandId?: string;
  commandType?: string;
  expectedHash?: string | null;
  observedHash?: string | null;
  [key: string]: unknown;
}

export interface DestructiveCommandResult {
  ok?: boolean;
  blocked?: boolean;
  declined?: boolean;
  confirmed?: boolean;
  reasonCode?: string | null;
  error?: string | null;
  [key: string]: unknown;
}
