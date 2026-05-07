"use strict";

import type { ConnectionOfferSummary, TruthSource } from "./connection";

export type DiagnosticSeverity = "critical" | "error" | "warning" | "info";

export interface DiagnosticErrorEntry {
  id: string;
  timestamp: string;
  component: string;
  severity: DiagnosticSeverity;
  code: string | null;
  message: string;
  file: string | null;
  line: number | null;
  sessionId: string | null;
  projectId: string | null;
  context: Record<string, unknown> | null;
  suggestion: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  stack: string | null;
}

export interface DiagnosticErrorSummary {
  total: number;
  unresolved: number;
  resolved: number;
  bySeverity: Record<DiagnosticSeverity, number>;
  byComponent: Record<string, number>;
  recent: DiagnosticErrorEntry[];
  recentUnresolved?: DiagnosticErrorEntry[];
  lastErrorAt?: number | null;
}

export interface DoctorSessionSummary {
  id: string;
  projectId: string;
  projectName: string;
  connectionState: string;
  truthSource: TruthSource | null;
  versionState: string;
  versionMessage: string;
  requiresPluginUpdate: boolean;
  studioContactState: string;
  studioContactMessage: string;
  lastStudioContactAt: string | null;
  lastStudioSeenAt: string | null;
  lastAppliedAt: string | null;
  syncState: string;
  syncMessage: string;
  lastSyncError: string | null;
  lastCommandError: string | null;
  requiresManualResync: boolean;
  syncBlockedReason: string | null;
  [key: string]: unknown;
}

export interface HealthPayload {
  ok: true;
  workspaceRoot: string;
  host: string;
  port: number;
  versions: Record<string, unknown>;
  autoSyncToStudio: boolean;
  projectCount: number;
  defaultProjectId: string | null;
  defaultProjectPath: string | null;
  connectionOffer: ConnectionOfferSummary | null;
  sessions: DoctorSessionSummary[];
  mcpShield: Record<string, unknown>;
  refreshedAt: string | null;
}

export interface DoctorReportPayload {
  ok: boolean;
  status: "ok" | "warning" | "blocked" | string;
  generatedAt: string;
  summary: {
    message: string;
    blockedReasons: string[];
    warnings: string[];
    projectCount: number;
    sessionCount: number;
    syncBlockedSessionCount: number;
    unresolvedErrorCount: number;
    initialSyncStuckSessionCount?: number;
    mcpAuditCount: number;
  };
  versions: Record<string, unknown>;
  workspace: Record<string, unknown>;
  sessions: DoctorSessionSummary[];
  errors: DiagnosticErrorSummary;
  recommendations: string[];
  [key: string]: unknown;
}
