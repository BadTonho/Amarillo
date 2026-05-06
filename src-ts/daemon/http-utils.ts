"use strict";

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const BRIDGE_TOKEN_HEADER = "x-amarillo-bridge-token";
const SESSION_TOKEN_HEADER = "x-amarillo-session-token";

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function corsHeaders(request = null) {
  const headers = {
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

function jsonResponse(response, statusCode, payload, request = null) {
  response.writeHead(statusCode, corsHeaders(request));
  response.end(JSON.stringify(payload));
}

function errorResponse(response, error, request = null) {
  const statusCode = error?.statusCode || 500;
  jsonResponse(response, statusCode, {
    ok: false,
    code: error?.code || "INTERNAL_ERROR",
    error: error?.message || "Internal error."
  }, request);
}

async function readJsonBody(request, options = {}) {
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_JSON_BODY_BYTES);
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, "BODY_TOO_LARGE", `JSON body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_error) {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function normalizeToken(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function timingSafeEqualString(left, right) {
  const leftToken = normalizeToken(left);
  const rightToken = normalizeToken(right);
  if (!leftToken || !rightToken) {
    return false;
  }
  const leftBuffer = Buffer.from(leftToken, "utf8");
  const rightBuffer = Buffer.from(rightToken, "utf8");
  return leftBuffer.length === rightBuffer.length && require("node:crypto").timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
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
