"use strict";

const DAEMON_VERSION = "1.2.2";
const AMARILLO_PROTOCOL_VERSION = 2;
const MIN_PLUGIN_VERSION = "1.1.2";
const CURRENT_PLUGIN_VERSION = "1.2.2";

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

function versionParts(value) {
  const normalized = normalizeVersion(value);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return null;
  }
  return [
    Number(match[1]),
    Number(match[2] || 0),
    Number(match[3] || 0)
  ];
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }
    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }
  return 0;
}

function isVersionAtLeast(version, minimumVersion) {
  const comparison = compareVersions(version, minimumVersion);
  return comparison !== null && comparison >= 0;
}

module.exports = {
  AMARILLO_PROTOCOL_VERSION,
  CURRENT_PLUGIN_VERSION,
  DAEMON_VERSION,
  MIN_PLUGIN_VERSION,
  compareVersions,
  isVersionAtLeast,
  normalizeProtocolVersion,
  normalizeVersion
};
