"use strict";

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const BRIDGE_TOKEN_HEADER = "x-amarillo-bridge-token";
const SESSION_TOKEN_HEADER = "x-amarillo-session-token";

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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Amarillo-Bridge-Token, X-Amarillo-Session-Token, X-Amarillo-MCP-Proxy"
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
  BRIDGE_TOKEN_HEADER,
  DEFAULT_MAX_JSON_BODY_BYTES,
  HttpError,
  SESSION_TOKEN_HEADER,
  errorResponse,
  jsonResponse,
  normalizeToken,
  readJsonBody,
  timingSafeEqualString
};
