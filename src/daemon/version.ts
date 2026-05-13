"use strict";

const DAEMON_VERSION = "1.0.28";
const AMARILLO_PROTOCOL_VERSION = 1;

function normalizeVersion(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function normalizeProtocolVersion(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

module.exports = {
  AMARILLO_PROTOCOL_VERSION,
  DAEMON_VERSION,
  normalizeProtocolVersion,
  normalizeVersion
};
