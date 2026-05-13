"use strict";

const PROJECT_DISCOVERY_IGNORED_DIRECTORIES = Object.freeze([
  ".git",
  "node_modules",
  ".agent",
  ".amarillo",
  ".vscode",
  "dist",
  "build"
]);
const PROJECT_DISCOVERY_IGNORED_DIRECTORY_SET = new Set(PROJECT_DISCOVERY_IGNORED_DIRECTORIES);

function normalizeProjectDiscoveryPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.?\//, "");
}

function projectDiscoveryPathSegments(value) {
  return normalizeProjectDiscoveryPath(value).split("/").filter(Boolean);
}

function isIgnoredProjectDiscoveryDirectoryName(name) {
  return PROJECT_DISCOVERY_IGNORED_DIRECTORY_SET.has(String(name));
}

function shouldIgnoreProjectDiscoveryPath(relativePath) {
  return projectDiscoveryPathSegments(relativePath).some((segment) => isIgnoredProjectDiscoveryDirectoryName(segment));
}

module.exports = {
  PROJECT_DISCOVERY_IGNORED_DIRECTORIES,
  isIgnoredProjectDiscoveryDirectoryName,
  shouldIgnoreProjectDiscoveryPath
};
