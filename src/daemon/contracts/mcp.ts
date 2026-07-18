"use strict";

import type { RuntimeProject, RuntimeSession } from "./runtime";

export type McpJsonSchemaType = "string" | "number" | "object" | "boolean" | "array" | "integer";

export interface McpToolPropertySchema {
  type?: McpJsonSchemaType;
  description?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface McpToolInputSchema {
  type: "object";
  required?: string[];
  properties?: Record<string, McpToolPropertySchema>;
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

export interface McpToolArguments extends Record<string, unknown> {
  sessionId?: string;
  projectId?: string;
  placeId?: number;
  path?: string;
  code?: string;
  query?: string;
  searchBy?: string;
  scope?: string;
  maxDepth?: number;
  count?: number;
  parentPath?: string;
  className?: string;
  name?: string;
  property?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
}

export interface McpTextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content?: McpTextContent[];
  [key: string]: unknown;
}

export interface McpHandleOptions {
  source?: string;
  [key: string]: unknown;
}

export interface McpAppLike {
  workspaceRoot: string;
  sessions: Map<string, RuntimeSession>;
  listProjects(): unknown;
  connectionOfferSummary(): unknown;
  sessionSummary(session: RuntimeSession): unknown;
  setActiveProject(projectId?: string): Promise<unknown> | unknown;
  openSession(placeId?: number, preferredProjectId?: string | null, options?: Record<string, unknown>): {
    session: RuntimeSession;
    project: RuntimeProject;
  };
  requestStudioTree(sessionId?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  requestStudioSelection(sessionId?: string): Promise<unknown>;
  runStudioCode(sessionId?: string, code?: string): Promise<unknown>;
  getProjectById(projectId: string): RuntimeProject | null;
  readLocalProjectStateAsyncWithPerf(project: RuntimeProject, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  enqueueCommand(sessionId: string | undefined, type: string, payload: Record<string, unknown>, waitForResult?: boolean): Promise<Record<string, unknown>>;
  enqueueDestructiveCommand(sessionId: string | undefined, type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  projectReadOptions(session: RuntimeSession): Record<string, unknown>;
  recordPerformance?(name: string, durationMs: number): void;
  recordMcpContact?(source: string, details: Record<string, unknown>): void;
  recordMcpFailure?(source: string, error: unknown, details: Record<string, unknown>): void;
  recordMcpAudit?(entry: Record<string, unknown>): void;
}
