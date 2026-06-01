"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PROJECT_ROOT = "src";
const PROJECT_ROOT_CANDIDATES = Object.freeze(["src", "sync"]);
const PROJECT_SERVICE_PATHS = Object.freeze([
  "ReplicatedStorage",
  "ServerScriptService",
  "ServerStorage",
  "StarterGui",
  "StarterPlayer/StarterCharacterScripts",
  "StarterPlayer/StarterPlayerScripts",
  "Workspace"
]);

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeRelativePath(value) {
  return normalizeSlashes(value).replace(/^\.?\//, "").replace(/\/+$/, "");
}

function normalizeProjectRootName(value) {
  const rootName = normalizeRelativePath(value).split("/").filter(Boolean)[0] || "";
  return PROJECT_ROOT_CANDIDATES.includes(rootName) ? rootName : null;
}

function directoryExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (_error) {
    return false;
  }
}

function countFilesRecursive(dirPath, limit = 1000) {
  let total = 0;
  function walk(currentPath) {
    if (total >= limit) {
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      if (total >= limit) {
        return;
      }
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isFile()) {
        total += 1;
      } else if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  }
  walk(dirPath);
  return total;
}

function scoreWorkspaceRoot(workspaceRoot, rootName) {
  const rootPath = path.join(workspaceRoot, rootName);
  const exists = directoryExists(rootPath);
  if (!exists) {
    return {
      rootName,
      exists: false,
      fileCount: 0,
      serviceDirectoryCount: 0
    };
  }

  const serviceDirectoryCount = PROJECT_SERVICE_PATHS
    .filter((servicePath) => directoryExists(path.join(rootPath, ...servicePath.split("/"))))
    .length;

  return {
    rootName,
    exists: true,
    fileCount: countFilesRecursive(rootPath),
    serviceDirectoryCount
  };
}

function normalizeCandidateRoots(value) {
  const source = Array.isArray(value) && value.length > 0 ? value : PROJECT_ROOT_CANDIDATES;
  const roots = [];
  for (const item of source) {
    const rootName = normalizeProjectRootName(item);
    if (rootName && !roots.includes(rootName)) {
      roots.push(rootName);
    }
  }
  return roots.length > 0 ? roots : PROJECT_ROOT_CANDIDATES.slice();
}

function resolveWorkspaceProjectRoot(workspaceRoot, options: any = {}) {
  const fallback = normalizeProjectRootName(options.fallback) || DEFAULT_PROJECT_ROOT;
  const candidates = normalizeCandidateRoots(options.candidates);
  const existing = candidates
    .map((candidate) => scoreWorkspaceRoot(workspaceRoot, candidate))
    .filter((score) => score.exists);

  if (existing.length === 0) {
    return fallback;
  }

  existing.sort((left, right) => {
    if (right.fileCount !== left.fileCount) {
      return right.fileCount - left.fileCount;
    }
    if (right.serviceDirectoryCount !== left.serviceDirectoryCount) {
      return right.serviceDirectoryCount - left.serviceDirectoryCount;
    }
    if (left.rootName === fallback) {
      return -1;
    }
    if (right.rootName === fallback) {
      return 1;
    }
    return candidates.indexOf(left.rootName) - candidates.indexOf(right.rootName);
  });
  return existing[0].rootName;
}

function projectRootFromRelativePath(value) {
  return normalizeProjectRootName(value);
}

function pathInsideProjectRoot(rootName, relativePath) {
  const normalizedRoot = normalizeProjectRootName(rootName) || DEFAULT_PROJECT_ROOT;
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  return normalizedRelativePath ? `${normalizedRoot}/${normalizedRelativePath}` : normalizedRoot;
}

module.exports = {
  DEFAULT_PROJECT_ROOT,
  PROJECT_ROOT_CANDIDATES,
  pathInsideProjectRoot,
  projectRootFromRelativePath,
  resolveWorkspaceProjectRoot
};
