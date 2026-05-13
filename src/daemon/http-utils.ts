"use strict";

import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const STUDIO_SYNC_MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;
const BRIDGE_TOKEN_HEADER = "x-amarillo-bridge-token";
const BRIDGE_TOKEN_HEADER_DISPLAY = "X-Amarillo-Bridge-Token";
const AUTHORIZATION_HEADER = "authorization";
const SESSION_TOKEN_HEADER = "x-amarillo-session-token";
const SESSION_TOKEN_HEADER_DISPLAY = "X-Amarillo-Session-Token";
const MCP_AUTH_HELP_PATH = "/mcp/auth-help";

function authHelpPayload() {
  return {
    expectedHeader: BRIDGE_TOKEN_HEADER_DISPLAY,
    acceptedHeaders: [
      `${BRIDGE_TOKEN_HEADER_DISPLAY}: <bridge token>`,
      "Authorization: Bearer <bridge token>"
    ],
    sessionHeader: `${SESSION_TOKEN_HEADER_DISPLAY}: <Studio session token>`,
    publicHelpUrl: MCP_AUTH_HELP_PATH,
    protectedRoutes: [
      "GET /mcp/status",
      "GET /mcp/tools",
      "POST /mcp/probe",
      "POST /mcp/call",
      "GET /doctor"
    ],
    tokenSources: [
      "Generated .amarillo/mcp-local.json after running Amarillo: Start Bridge or Amarillo: Configure MCP for Workspace.",
      "The --bridge-token argument used by the daemon or MCP proxy.",
      "The AMARILLO_BRIDGE_TOKEN environment variable when the daemon is started manually."
    ]
  };
}

interface ReadJsonBodyOptions {
  maxBytes?: number;
}

interface HttpErrorLike {
  statusCode?: number;
  code?: string;
  message?: string;
}

class HttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function errorLike(error: unknown): HttpErrorLike {
  return error && typeof error === "object" ? error as HttpErrorLike : {};
}

function corsHeaders(request: IncomingMessage | null = null): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Amarillo-Bridge-Token, X-Amarillo-Session-Token, X-Amarillo-MCP-Proxy"
  };

  const origin = request?.headers?.origin;
  if (!origin) {
    return headers;
  }

  try {
    const parsed = new URL(origin);
    if (
      parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.protocol === "vscode-webview:"
    ) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers.Vary = "Origin";
    }
  } catch (_error) {
    // Invalid origins simply do not receive a CORS allow header.
  }

  return headers;
}

function jsonResponse(response: ServerResponse, statusCode: number, payload: unknown, request: IncomingMessage | null = null): void {
  response.writeHead(statusCode, corsHeaders(request));
  response.end(JSON.stringify(payload));
}

function errorResponse(response: ServerResponse, error: unknown, request: IncomingMessage | null = null): void {
  const details = errorLike(error);
  const statusCode = details.statusCode || 500;
  jsonResponse(response, statusCode, {
    ok: false,
    code: details.code || "INTERNAL_ERROR",
    error: details.message || "Internal error."
  }, request);
}

async function readJsonBody<T = Record<string, unknown>>(request: IncomingMessage, options: ReadJsonBodyOptions = {}): Promise<T> {
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_JSON_BODY_BYTES);
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += chunkBuffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, "BODY_TOO_LARGE", `JSON body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunkBuffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch (_error) {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function normalizeToken(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function bearerTokenFromAuthorization(value: unknown): string | null {
  const authorization = normalizeToken(value);
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? normalizeToken(match[1]) : null;
}

function bridgeTokenFromHeaders(headers: IncomingHttpHeaders | undefined): string | null {
  return normalizeToken(headers?.[BRIDGE_TOKEN_HEADER])
    || bearerTokenFromAuthorization(headers?.[AUTHORIZATION_HEADER]);
}

function timingSafeEqualString(left: unknown, right: unknown): boolean {
  const leftToken = normalizeToken(left);
  const rightToken = normalizeToken(right);
  if (!leftToken || !rightToken) {
    return false;
  }
  const leftBuffer = Buffer.from(leftToken, "utf8");
  const rightBuffer = Buffer.from(rightToken, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export {
  AUTHORIZATION_HEADER,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_TOKEN_HEADER_DISPLAY,
  DEFAULT_MAX_JSON_BODY_BYTES,
  HttpError,
  MCP_AUTH_HELP_PATH,
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_HEADER_DISPLAY,
  STUDIO_SYNC_MAX_JSON_BODY_BYTES,
  authHelpPayload,
  bridgeTokenFromHeaders,
  errorResponse,
  jsonResponse,
  normalizeToken,
  readJsonBody,
  timingSafeEqualString
};
