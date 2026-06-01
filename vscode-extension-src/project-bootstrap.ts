"use strict";

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_PROJECT_ROOT = "src";
const PROJECT_ROOT_CANDIDATES = Object.freeze(["src", "sync"]);
const DEFAULT_PROJECT_SERVICE_DIRECTORIES = Object.freeze([
  "ReplicatedStorage",
  "ServerScriptService",
  "StarterPlayer/StarterPlayerScripts",
  "StarterGui"
]);
const PROJECT_SERVICE_PATHS = Object.freeze([
  ...DEFAULT_PROJECT_SERVICE_DIRECTORIES,
  "ServerStorage",
  "StarterPlayer/StarterCharacterScripts",
  "Workspace"
]);

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeProjectRootName(value) {
  const rootName = normalizeSlashes(value).replace(/^\.?\//, "").split("/").filter(Boolean)[0] || "";
  return PROJECT_ROOT_CANDIDATES.includes(rootName) ? rootName : null;
}

function directoryExists(dirPath) {
  try {
    return fsSync.statSync(dirPath).isDirectory();
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
      entries = fsSync.readdirSync(currentPath, { withFileTypes: true });
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

function scoreWorkspaceProjectRoot(workspaceRoot, rootName) {
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

function resolveDefaultProjectRoot(workspaceRoot, fallback = DEFAULT_PROJECT_ROOT) {
  const fallbackRoot = normalizeProjectRootName(fallback) || DEFAULT_PROJECT_ROOT;
  const existing = PROJECT_ROOT_CANDIDATES
    .map((candidate) => scoreWorkspaceProjectRoot(workspaceRoot, candidate))
    .filter((score) => score.exists);

  if (existing.length === 0) {
    return fallbackRoot;
  }

  existing.sort((left, right) => {
    if (right.fileCount !== left.fileCount) {
      return right.fileCount - left.fileCount;
    }
    if (right.serviceDirectoryCount !== left.serviceDirectoryCount) {
      return right.serviceDirectoryCount - left.serviceDirectoryCount;
    }
    if (left.rootName === fallbackRoot) {
      return -1;
    }
    if (right.rootName === fallbackRoot) {
      return 1;
    }
    return PROJECT_ROOT_CANDIDATES.indexOf(left.rootName) - PROJECT_ROOT_CANDIDATES.indexOf(right.rootName);
  });
  return existing[0].rootName;
}

function projectPath(projectRoot, servicePath) {
  return `${projectRoot}/${normalizeSlashes(servicePath).replace(/^\/+/, "")}`;
}

function defaultProjectDirectories(projectRoot) {
  return DEFAULT_PROJECT_SERVICE_DIRECTORIES.map((servicePath) => path.join(projectRoot, ...servicePath.split("/")));
}

function workspaceProjectName(workspaceRoot) {
  return path.basename(path.resolve(workspaceRoot)) || "Game";
}

function buildDefaultProjectTemplate(workspaceRoot, projectRoot = resolveDefaultProjectRoot(workspaceRoot)) {
  return {
    name: workspaceProjectName(workspaceRoot),
    tree: {
      $className: "DataModel",
      ReplicatedStorage: {
        $path: projectPath(projectRoot, "ReplicatedStorage")
      },
      ServerScriptService: {
        $path: projectPath(projectRoot, "ServerScriptService")
      },
      StarterPlayer: {
        StarterPlayerScripts: {
          $path: projectPath(projectRoot, "StarterPlayer/StarterPlayerScripts")
        }
      },
      StarterGui: {
        $path: projectPath(projectRoot, "StarterGui")
      },
      Workspace: {
        $path: projectPath(projectRoot, "Workspace")
      }
    }
  };
}

function buildDefaultProjectPath(workspaceRoot) {
  return path.join(workspaceRoot, `${workspaceProjectName(workspaceRoot)}.project.json`);
}

async function ensureWorkspaceProjectFile(workspaceRoot, collectProjectFiles) {
  const projectFiles = collectProjectFiles(workspaceRoot);
  if (projectFiles.length > 0) {
    return {
      created: false,
      projectFilePath: null,
      projectFiles
    };
  }

  const projectFilePath = buildDefaultProjectPath(workspaceRoot);
  const projectRoot = resolveDefaultProjectRoot(workspaceRoot);
  const projectTemplate = buildDefaultProjectTemplate(workspaceRoot, projectRoot);

  await Promise.all(
    defaultProjectDirectories(projectRoot).map((relativeDir) => fs.mkdir(path.join(workspaceRoot, relativeDir), { recursive: true }))
  );
  await fs.writeFile(projectFilePath, `${JSON.stringify(projectTemplate, null, 2)}\n`, "utf8");

  return {
    created: true,
    projectFilePath,
    projectFiles: [projectFilePath]
  };
}

module.exports = {
  buildDefaultProjectPath,
  buildDefaultProjectTemplate,
  ensureWorkspaceProjectFile,
  resolveDefaultProjectRoot
};
