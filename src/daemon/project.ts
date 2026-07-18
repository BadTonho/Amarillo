"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const projectResolver = require("./project-resolver");
const { resolveWorkspaceProjectRoot } = require("./project-roots");

const PROJECT_SUFFIX = ".project.json";
const META_SUFFIX = ".meta.json";
const AMARILLO_ID_ATTRIBUTE = "AmarilloId";
const DUPLICATE_FS_SUFFIX = ".amarillo-";
const DUPLICATE_MOUNT_ROOT_CODE = "DUPLICATE_MOUNT_ROOT";
const WINDOWS_RESERVED_FS_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
]);

// ===== Lightweight glob matching (no external dependency) =====
function globToRegex(glob) {
  const normalizedGlob = normalizeSlashes(glob);
  let regex = "";
  let i = 0;
  const len = normalizedGlob.length;
  while (i < len) {
    const ch = normalizedGlob[i];
    if (ch === "*") {
      if (normalizedGlob[i + 1] === "*") {
        // ** matches any path
        regex += ".*";
        i += 2;
        if (normalizedGlob[i] === "/") { i++; } // skip trailing slash after **
        continue;
      }
      regex += "[^/]*";
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (ch === ".") {
      regex += "\\.";
    } else if (ch === "/") {
      regex += "/";
    } else if ("\\^$+()[]{}|".includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i++;
  }
  return new RegExp(`^${regex}$`, "i");
}

function matchesAnyGlob(relativePath, globs) {
  if (!globs || globs.length === 0) {
    return false;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  for (const glob of globs) {
    if (globToRegex(glob).test(normalized)) {
      return true;
    }
    // Also test basename only for simple patterns like "*.spec.lua"
    if (!glob.includes("/")) {
      const basename = path.basename(normalized);
      if (globToRegex(glob).test(basename)) {
        return true;
      }
    }
  }
  return false;
}


function normalizeSlashes(value) {
  return String(value).replace(/\\/g, "/");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReservedAttributeName(attributeName) {
  return typeof attributeName === "string"
    && (attributeName.startsWith("RBX") || attributeName === AMARILLO_ID_ATTRIBUTE);
}

function sanitizeSyncAttributes(attributes) {
  if (!isPlainObject(attributes)) {
    return {};
  }
  return Object.entries(attributes).reduce((next, [key, value]) => {
    if (!isReservedAttributeName(key)) {
      next[key] = value;
    }
    return next;
  }, {});
}

function sanitizeSyncProperties(properties) {
  if (!isPlainObject(properties)) {
    return {};
  }
  const sanitized = { ...properties };
  if (isPlainObject(sanitized.Attributes)) {
    const attributes = sanitizeSyncAttributes(sanitized.Attributes);
    if (Object.keys(attributes).length > 0) {
      sanitized.Attributes = attributes;
    } else {
      delete sanitized.Attributes;
    }
  }
  return sanitized;
}

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner
      .split(",")
      .map((item) => parseTomlValue(item));
  }
  return value;
}

function parseSimpleToml(filePath) {
  const result = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1);
    result[key] = parseTomlValue(value);
  }
  return result;
}

function readWorkspaceConfig(workspaceRoot) {
  const argonPath = path.join(workspaceRoot, "argon.toml");
  const pluginPath = path.join(workspaceRoot, ".pluginroblox.json");
  return {
    argon: fs.existsSync(argonPath) ? parseSimpleToml(argonPath) : {},
    plugin: fs.existsSync(pluginPath) ? parseJsonFile(pluginPath) : {}
  };
}

function collectProjectFiles(rootDir, results = []) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".agent") {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectProjectFiles(fullPath, results);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(PROJECT_SUFFIX)) {
      results.push(fullPath);
    }
  }
  return results;
}

function collectMounts(treeNode, parentSegments = []) {
  const mounts = [];
  for (const [name, value] of Object.entries(treeNode || {}) as any) {
    if (name.startsWith("$") || !isPlainObject(value)) {
      continue;
    }
    const nextSegments = parentSegments.concat(name);
    if (typeof value.$path === "string") {
      mounts.push({
        id: nextSegments.join("."),
        segments: nextSegments.slice(),
        relativePath: normalizeSlashes(value.$path),
        keepUnknowns: value.$keepUnknowns
      });
    }
    mounts.push(...collectMounts(value, nextSegments));
  }
  return mounts;
}

function parseProjectFile(projectPath, workspaceRoot) {
  const raw = parseJsonFile(projectPath);
  const mounts = collectMounts(raw.tree || {});
  const placeIds = raw.placeIds || raw.place_ids || [];
  const projectDir = path.dirname(projectPath);
  return {
    id: path.relative(workspaceRoot, projectPath).replace(/\\/g, "/"),
    name: raw.name || path.basename(projectPath, PROJECT_SUFFIX),
    projectPath,
    projectDir,
    enabled: raw.enabled !== false,
    placeIds: Array.isArray(placeIds) ? placeIds : [],
    mounts: mounts.map((mount) => ({
      ...mount,
      absolutePath: path.resolve(projectDir, mount.relativePath)
    })),
    legacyScripts: raw.legacyScripts ?? raw.emitLegacyScripts ?? true,
    ignoreGlobs: raw.ignoreGlobs || raw.globIgnorePaths || [],
    syncback: {
      ignoreGlobs: raw.syncback?.ignoreGlobs || [],
      ignoreNames: raw.syncback?.ignoreNames || [],
      ignoreClasses: raw.syncback?.ignoreClasses || [],
      ignoreProperties: raw.syncback?.ignoreProperties || []
    },
    syncRules: raw.syncRules || [],
    raw
  };
}

function createDefaultProject(workspaceRoot) {
  const projectPath = path.join(workspaceRoot, "default.project.json");
  if (fs.existsSync(projectPath)) {
    return;
  }
  const projectRoot = resolveWorkspaceProjectRoot(workspaceRoot, { fallback: "src" });
  ensureDirectory(path.join(workspaceRoot, projectRoot));
  
  const defaultProject = {
    name: "Default Project",
    placeIds: [],
    tree: {
      ServerScriptService: {
        $path: projectRoot
      }
    }
  };
  
  writeJsonFile(projectPath, defaultProject);
}

function loadWorkspaceProjects(workspaceRoot) {
  const projectFiles = collectProjectFiles(workspaceRoot);
  
  if (projectFiles.length === 0) {
    createDefaultProject(workspaceRoot);
    return collectProjectFiles(workspaceRoot)
      .map((projectPath) => parseProjectFile(projectPath, workspaceRoot))
      .filter((project) => project.enabled)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
  
  return projectFiles
    .map((projectPath) => parseProjectFile(projectPath, workspaceRoot))
    .filter((project) => project.enabled)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function detectScriptFileType(fileName) {
  if (/\.server\.lua[u]?$/i.test(fileName)) {
    return {
      className: "Script",
      fileKind: "server",
      ext: fileName.match(/\.server\.(lua|luau)$/i)[0]
    };
  }
  if (/\.client\.lua[u]?$/i.test(fileName)) {
    return {
      className: "LocalScript",
      fileKind: "client",
      ext: fileName.match(/\.client\.(lua|luau)$/i)[0]
    };
  }
  if (/\.lua[u]?$/i.test(fileName)) {
    return {
      className: "ModuleScript",
      fileKind: "module",
      ext: fileName.match(/\.(lua|luau)$/i)[0]
    };
  }
  return null;
}

function stripScriptSuffix(fileName) {
  return fileName
    .replace(/\.server\.lua[u]?$/i, "")
    .replace(/\.client\.lua[u]?$/i, "")
    .replace(/\.lua[u]?$/i, "");
}

function mountSegmentsForValidation(mount) {
  if (Array.isArray(mount?.segments)) {
    return mount.segments.filter((segment) => typeof segment === "string" && segment.length > 0);
  }
  if (typeof mount?.path === "string") {
    return mount.path.split(".").filter(Boolean);
  }
  if (typeof mount?.id === "string") {
    return mount.id.split(".").filter(Boolean);
  }
  return [];
}

function duplicateMountRootName(mount) {
  const segments = mountSegmentsForValidation(mount);
  return segments.length > 1 ? segments[segments.length - 1] : null;
}

function instancePathLabel(segments) {
  return Array.isArray(segments) && segments.length > 0
    ? `game.${segments.join(".")}`
    : "game";
}

function pathSegmentsHavePrefix(segments, prefix) {
  return Array.isArray(segments)
    && Array.isArray(prefix)
    && prefix.length <= segments.length
    && prefix.every((segment, index) => segments[index] === segment);
}

function duplicateMountRootIssue(mount, options: any = {}) {
  const segments = mountSegmentsForValidation(mount);
  const childName = duplicateMountRootName(mount);
  const expectedMountPath = instancePathLabel(segments);
  const pathSegments = segments.concat(childName || []);
  const mountId = mount?.id || segments.join(".");
  const relativePath = options.relativePath
    || (mount?.relativePath && childName ? normalizeSlashes(`${mount.relativePath}/${childName}`) : childName);
  return {
    code: DUPLICATE_MOUNT_ROOT_CODE,
    mountId,
    path: options.path || instancePathLabel(pathSegments),
    expectedMountPath,
    relativePath,
    filePath: options.filePath || null,
    fileName: options.fileName || childName,
    message: `Duplicate mount root '${childName}' found inside '${expectedMountPath}'. Put children directly under '${expectedMountPath}' instead.`
  };
}

function entryMapsToDuplicateMountRoot(mount, entry) {
  const childName = duplicateMountRootName(mount);
  if (!childName || !entry) {
    return false;
  }
  if (entry.name === childName) {
    return true;
  }
  if (entry.isFile && entry.isFile() && detectScriptFileType(entry.name)) {
    return stripScriptSuffix(entry.name) === childName;
  }
  return false;
}

function findDuplicateMountRootPathIssue(project, targetSegments) {
  const segments = Array.isArray(targetSegments)
    ? targetSegments.filter((segment) => typeof segment === "string" && segment.length > 0)
    : [];
  for (const mount of project?.mounts || []) {
    const mountSegments = mountSegmentsForValidation(mount);
    const childName = duplicateMountRootName(mount);
    if (!childName || !pathSegmentsHavePrefix(segments, mountSegments)) {
      continue;
    }
    if (segments.length > mountSegments.length && segments[mountSegments.length] === childName) {
      return duplicateMountRootIssue(mount, {
        path: instancePathLabel(segments),
        relativePath: mount.relativePath
          ? normalizeSlashes(`${mount.relativePath}/${segments.slice(mountSegments.length).join("/")}`)
          : segments.slice(mountSegments.length).join("/")
      });
    }
  }
  return null;
}

function normalizeResolvedPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function isPathInside(childPath, parentPath) {
  const child = normalizeResolvedPath(childPath);
  const parent = normalizeResolvedPath(parentPath).replace(/\/+$/, "");
  return child === parent || child.startsWith(`${parent}/`);
}

function pathTraversalBlockedError(action, targetPath, rootPath) {
  const relativePath = normalizeSlashes(path.relative(rootPath, targetPath));
  const error = new Error(`Path traversal blocked while ${action}: '${relativePath}'.`) as Error & { code?: string };
  error.code = "PATH_TRAVERSAL_BLOCKED";
  return error;
}

function writeRootFromOptions(options: any = {}) {
  return options.writeRoot || options.mount?.absolutePath || options.mount?.rootPath || null;
}

function assertPathInsideWriteRoot(targetPath, options: any = {}, action = "accessing path") {
  const resolvedTarget = path.resolve(targetPath);
  const writeRoot = writeRootFromOptions(options);
  if (!writeRoot) {
    return resolvedTarget;
  }
  const resolvedRoot = path.resolve(writeRoot);
  if (!isPathInside(resolvedTarget, resolvedRoot)) {
    throw pathTraversalBlockedError(action, resolvedTarget, resolvedRoot);
  }
  return resolvedTarget;
}

function listDirectoryEntries(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath, { withFileTypes: true });
}

function readMetaFile(metaPath) {
  if (!fs.existsSync(metaPath)) {
    return {};
  }
  try {
    const parsed = parseJsonFile(metaPath);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function isOpaqueModelNode(node) {
  return node?.className === "Model";
}

function isModelAssetFileName(fileName) {
  return /\.model\.json$/i.test(fileName) || /\.(rbxm|rbxmx)$/i.test(fileName);
}

function isInitModelAssetFileName(fileName) {
  return /^init(\.model\.json|\.rbxm|\.rbxmx)$/i.test(fileName);
}

function isOpaqueModelDirectory(dirPath) {
  const metaPath = path.join(dirPath, `init${META_SUFFIX}`);
  if (fs.existsSync(metaPath)) {
    try {
      const meta = parseJsonFile(metaPath);
      if (meta?.className === "Model") {
        return true;
      }
    } catch (_error) {
      return false;
    }
  }
  return listDirectoryEntries(dirPath)
    .some((entry) => entry.isFile() && isInitModelAssetFileName(entry.name));
}

function isOpaqueModelEntry(fullPath, entryName = path.basename(fullPath)) {
  if (isModelAssetFileName(entryName)) {
    return true;
  }
  try {
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory() && isOpaqueModelDirectory(fullPath);
  } catch (_error) {
    return false;
  }
}

function applyIdentityMeta(node, meta, fsName) {
  if (!node || !isPlainObject(meta)) {
    return node;
  }
  const robloxName = typeof meta.robloxName === "string" && meta.robloxName.length > 0
    ? meta.robloxName
    : null;
  const actualFsName = typeof fsName === "string" && fsName.length > 0 ? fsName : node.name;
  if (robloxName) {
    node.name = robloxName;
  }
  if (actualFsName && actualFsName !== node.name) {
    node.fsName = actualFsName;
  }
  if (typeof meta.amarilloId === "string" && meta.amarilloId.length > 0) {
    node.amarilloId = meta.amarilloId;
  }
  if (Number.isInteger(meta.duplicateOrdinal) && meta.duplicateOrdinal > 1) {
    node.duplicateOrdinal = meta.duplicateOrdinal;
  }
  return node;
}

function isReservedWindowsFsName(value) {
  const baseName = String(value || "").split(".")[0].toUpperCase();
  return WINDOWS_RESERVED_FS_NAMES.has(baseName);
}

function safeFallbackFsSegment(fallback = "Instance") {
  let segment = String(fallback || "Instance")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/[ .]+$/g, "");
  if (!segment || segment === "." || segment === ".." || isReservedWindowsFsName(segment)) {
    segment = "Instance";
  }
  return segment;
}

function safeFsSegment(value, fallback = "Instance") {
  let segment = typeof value === "string" ? value : String(value ?? "");
  segment = segment
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/[ .]+$/g, "");
  if (!segment || segment === "." || segment === ".." || isReservedWindowsFsName(segment)) {
    return safeFallbackFsSegment(fallback);
  }
  return segment;
}

function nodeFsName(node) {
  if (typeof node?.fsName === "string" && node.fsName.length > 0) {
    return safeFsSegment(node.fsName);
  }
  return safeFsSegment(typeof node?.name === "string" ? node.name : "");
}

function duplicateBaseName(value) {
  return String(value || "");
}

function makeDuplicateFsName(baseName, ordinal) {
  return `${baseName}${DUPLICATE_FS_SUFFIX}${ordinal}`;
}

function stableAmarilloId(parts) {
  return `amarillo-${crypto.createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16)}`;
}

function reserveUniqueAmarilloId(node, identityKey, seen) {
  const currentId = typeof node?.amarilloId === "string" && node.amarilloId.length > 0
    ? node.amarilloId
    : null;
  if (!currentId) {
    return null;
  }
  if (!seen.has(currentId)) {
    seen.set(currentId, identityKey);
    return currentId;
  }

  let ordinal = 2;
  let candidate = stableAmarilloId(["duplicate-amarillo-id", identityKey, currentId, String(ordinal)]);
  while (seen.has(candidate)) {
    ordinal++;
    candidate = stableAmarilloId(["duplicate-amarillo-id", identityKey, currentId, String(ordinal)]);
  }
  seen.set(candidate, identityKey);
  return candidate;
}

function normalizeNodeAmarilloIds(node, parentKey, index, seen) {
  const next = { ...(node || {}) };
  const fsName = nodeFsName(next) || safeFsSegment(next.name || `Instance${index + 1}`);
  const identityKey = `${parentKey}/${fsName}#${index + 1}#${next.name || ""}#${next.className || ""}`;
  const amarilloId = reserveUniqueAmarilloId(next, identityKey, seen);
  if (amarilloId && amarilloId !== next.amarilloId) {
    next.amarilloId = amarilloId;
  }
  if (Array.isArray(next.children)) {
    next.children = next.children.map((child, childIndex) => normalizeNodeAmarilloIds(child, identityKey, childIndex, seen));
  }
  return next;
}

function normalizeSnapshotAmarilloIds(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.mounts)) {
    return snapshot;
  }
  const seen = new Map();
  return {
    ...snapshot,
    mounts: snapshot.mounts.map((mount, mountIndex) => {
      const mountKey = `${snapshot.projectId || "project"}/${mount?.id || mountIndex}`;
      return {
        ...mount,
        children: (mount?.children || []).map((child, childIndex) => normalizeNodeAmarilloIds(child, mountKey, childIndex, seen))
      };
    })
  };
}

function cloneNodeForFs(node, fsName, duplicateOrdinal, identityKey, isDuplicate = false) {
  const next = {
    ...(node || {}),
    fsName
  };
  if (isDuplicate || duplicateOrdinal > 1) {
    if (!next.amarilloId) {
      next.amarilloId = stableAmarilloId([identityKey, node?.name || "", node?.className || "", String(Math.max(1, duplicateOrdinal))]);
    }
  }
  if (duplicateOrdinal > 1) {
    next.duplicateOrdinal = duplicateOrdinal;
  }
  if (fsName === next.name) {
    delete next.fsName;
  }
  return next;
}

function prepareSiblingNodesForWrite(children, identityKey = "") {
  const source = Array.isArray(children) ? children : [];
  const grouped = new Map();
  for (const child of source) {
    const baseName = duplicateBaseName(nodeFsName(child) || child?.name);
    if (!grouped.has(baseName)) {
      grouped.set(baseName, []);
    }
    grouped.get(baseName).push(child);
  }

  const used = new Set();
  const prepared = [];
  for (const child of source) {
    const baseName = duplicateBaseName(nodeFsName(child) || child?.name);
    const bucket = grouped.get(baseName) || [];
    let fsName = baseName;
    let duplicateOrdinal = Number.isInteger(child?.duplicateOrdinal) && child.duplicateOrdinal > 1
      ? child.duplicateOrdinal
      : 1;

    if (bucket.length > 1) {
      const indexInBucket = bucket.indexOf(child) + 1;
      duplicateOrdinal = Math.max(duplicateOrdinal, indexInBucket);
      fsName = duplicateOrdinal === 1 && !used.has(baseName)
        ? baseName
        : makeDuplicateFsName(baseName, Math.max(2, duplicateOrdinal));
    } else if (used.has(fsName)) {
      duplicateOrdinal = 2;
      fsName = makeDuplicateFsName(baseName, duplicateOrdinal);
    }

    if (fsName !== baseName || used.has(fsName)) {
      while (used.has(fsName)) {
        duplicateOrdinal++;
        fsName = makeDuplicateFsName(baseName, duplicateOrdinal);
      }
    }

    used.add(fsName);
    prepared.push(cloneNodeForFs(child, fsName, duplicateOrdinal, `${identityKey}/${fsName}`, bucket.length > 1));
  }
  return prepared;
}

function scriptMetaNameForFile(filePath) {
  const fileName = path.basename(filePath);
  if (!detectScriptFileType(fileName)) {
    return null;
  }
  return `${stripScriptSuffix(fileName)}${META_SUFFIX}`;
}

function scriptFileExistsForMeta(metaPath) {
  const baseName = path.basename(metaPath, META_SUFFIX);
  const dirPath = path.dirname(metaPath);
  return [
    `${baseName}.server.luau`,
    `${baseName}.server.lua`,
    `${baseName}.client.luau`,
    `${baseName}.client.lua`,
    `${baseName}.luau`,
    `${baseName}.lua`
  ].some((fileName) => fs.existsSync(path.join(dirPath, fileName)));
}

function ambiguousScriptSuffixMatch(fileName) {
  return fileName.match(/^(.*)\.(server|client)\.(server|client)\.(lua|luau)$/i);
}

function suggestedScriptFileName(fileName) {
  const match = ambiguousScriptSuffixMatch(fileName);
  if (!match) {
    return null;
  }
  return `${match[1]}.${match[3]}.${match[4]}`;
}

function collectInvalidProjectTreeFilesInDir(rootDir, dirPath, options: any = {}, issues = []) {
  for (const entry of listDirectoryEntries(dirPath)) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
    if (isOpaqueModelEntry(fullPath, entry.name)) {
      continue;
    }
    if (matchesAnyGlob(relativePath, options.ignoreGlobs || [])) {
      continue;
    }
    if (entry.isDirectory()) {
      collectInvalidProjectTreeFilesInDir(rootDir, fullPath, options, issues);
      continue;
    }
    if (!entry.isFile() || !detectScriptFileType(entry.name) || !ambiguousScriptSuffixMatch(entry.name)) {
      continue;
    }
    issues.push({
      code: "AMBIGUOUS_SCRIPT_SUFFIX",
      filePath: fullPath,
      relativePath,
      fileName: entry.name,
      suggestedFileName: suggestedScriptFileName(entry.name),
      message: "Script filename contains two script kind suffixes and cannot be mapped to a stable Roblox instance name."
    });
  }
  return issues;
}

function validateProjectTreeFiles(project, options: any = {}) {
  const issues = [];
  for (const mount of project?.mounts || []) {
    if (!mount?.absolutePath) {
      continue;
    }
    for (const entry of listDirectoryEntries(mount.absolutePath)) {
      const fullPath = path.join(mount.absolutePath, entry.name);
      const relativePath = path.relative(mount.absolutePath, fullPath).replace(/\\/g, "/");
      if (matchesAnyGlob(relativePath, project.ignoreGlobs || [])) {
        continue;
      }
      if (entryMapsToDuplicateMountRoot(mount, entry)) {
        issues.push(duplicateMountRootIssue(mount, {
          filePath: fullPath,
          fileName: entry.name,
          relativePath: mount.relativePath
            ? normalizeSlashes(`${mount.relativePath}/${entry.name}`)
            : entry.name
        }));
      }
    }
    collectInvalidProjectTreeFilesInDir(mount.absolutePath, mount.absolutePath, {
      ignoreGlobs: project.ignoreGlobs || [],
      ...options
    }, issues);
  }
  return issues;
}

function validateProjectSnapshotMounts(project, snapshot, options: any = {}) {
  const issues = [];
  const mountMap = new Map((project?.mounts || []).map((mount) => [mount.id, mount]));
  for (const mountSnapshot of snapshot?.mounts || []) {
    const projectMount = mountMap.get(mountSnapshot.id);
    const mount = projectMount || mountSnapshot;
    const childName = duplicateMountRootName(mount);
    if (!childName) {
      continue;
    }
    for (const child of mountSnapshot.children || []) {
      if (child?.name !== childName) {
        continue;
      }
      issues.push(duplicateMountRootIssue(mount, {
        path: instancePathLabel(mountSegmentsForValidation(mount).concat(childName)),
        relativePath: mount.relativePath
          ? normalizeSlashes(`${mount.relativePath}/${childName}`)
          : childName,
        fileName: childName,
        ...options
      }));
    }
  }
  return issues;
}

function collectOrphanScriptMetaCandidates(rootDir, metaName, targetMetaPath, results = []) {
  for (const entry of listDirectoryEntries(rootDir)) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectOrphanScriptMetaCandidates(fullPath, metaName, targetMetaPath, results);
      continue;
    }
    if (
      entry.isFile()
      && entry.name === metaName
      && normalizeResolvedPath(fullPath) !== normalizeResolvedPath(targetMetaPath)
      && !scriptFileExistsForMeta(fullPath)
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

function collectScriptMetaRepairState(rootDir, state = { missingMetaScripts: new Map(), orphanMetas: new Map() }) {
  for (const entry of listDirectoryEntries(rootDir)) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectScriptMetaRepairState(fullPath, state);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const scriptMetaName = scriptMetaNameForFile(fullPath);
    if (scriptMetaName) {
      const metaPath = path.join(path.dirname(fullPath), scriptMetaName);
      if (!fs.existsSync(metaPath)) {
        const bucket = state.missingMetaScripts.get(scriptMetaName) || [];
        bucket.push(fullPath);
        state.missingMetaScripts.set(scriptMetaName, bucket);
      }
      continue;
    }

    if (entry.name.endsWith(META_SUFFIX) && !scriptFileExistsForMeta(fullPath)) {
      const bucket = state.orphanMetas.get(entry.name) || [];
      bucket.push(fullPath);
      state.orphanMetas.set(entry.name, bucket);
    }
  }
  return state;
}

function moveOrphanScriptMetaForFile(mount, scriptFilePath, options: any = {}) {
  const absoluteScriptPath = path.resolve(scriptFilePath);
  const mountRoot = path.resolve(mount.absolutePath || mount);
  if (!fs.existsSync(absoluteScriptPath) || !isPathInside(absoluteScriptPath, mountRoot)) {
    return { moved: false, reason: "script_not_in_mount" };
  }

  const metaName = scriptMetaNameForFile(absoluteScriptPath);
  if (!metaName) {
    return { moved: false, reason: "not_script" };
  }

  const targetMetaPath = path.join(path.dirname(absoluteScriptPath), metaName);
  if (fs.existsSync(targetMetaPath)) {
    return { moved: false, reason: "target_meta_exists", targetPath: targetMetaPath };
  }

  const candidates = collectOrphanScriptMetaCandidates(mountRoot, metaName, targetMetaPath);
  if (candidates.length !== 1) {
    return {
      moved: false,
      reason: candidates.length === 0 ? "no_orphan_meta" : "ambiguous_orphan_meta",
      candidates
    };
  }

  const sourceMetaPath = candidates[0];
  const sourceInfo = collectExistingFileInfos(sourceMetaPath)[0] || {};
  ensureDirectory(path.dirname(targetMetaPath));
  fs.renameSync(sourceMetaPath, targetMetaPath);
  notifyFileChange(options, {
    action: "delete",
    filePath: sourceMetaPath,
    size: sourceInfo.size,
    hash: sourceInfo.hash
  });
  notifyFileChange(options, {
    action: "create",
    filePath: targetMetaPath,
    size: sourceInfo.size,
    hash: sourceInfo.hash
  });
  return {
    moved: true,
    from: sourceMetaPath,
    to: targetMetaPath
  };
}

function repairOrphanScriptMetasInMount(mount, options: any = {}) {
  const mountRoot = path.resolve(mount.absolutePath || mount);
  const state = collectScriptMetaRepairState(mountRoot);
  const repaired = [];
  for (const [metaName, scriptPaths] of state.missingMetaScripts.entries()) {
    const orphanPaths = state.orphanMetas.get(metaName) || [];
    if (scriptPaths.length !== 1 || orphanPaths.length !== 1) {
      continue;
    }
    const result = moveOrphanScriptMetaForFile(mount, scriptPaths[0], options);
    if (result.moved) {
      repaired.push(result);
    }
  }
  return repaired;
}

function repairProjectOrphanScriptMetas(project, options: any = {}) {
  const repaired = [];
  for (const mount of project.mounts || []) {
    repaired.push(...repairOrphanScriptMetasInMount(mount, {
      ...options,
      project,
      mount
    }));
  }
  return repaired;
}

function buildNodeFromJsonModel(modelName, modelData) {
  const children = (modelData.Children || []).map((child) => buildNodeFromJsonModel(child.Name, child));
  return {
    name: modelName,
    className: modelData.ClassName || "Folder",
    classNameSource: "file",
    properties: sanitizeSyncProperties(modelData.Properties),
    keepUnknowns: true,
    children
  };
}

function buildNodeFromFile(filePath, explicitName = null, options: any = {}) {
  const name = path.basename(filePath);
  const scriptType = detectScriptFileType(name);
  if (scriptType) {
    const baseName = explicitName || stripScriptSuffix(name);
    const metaPath = path.join(path.dirname(filePath), `${baseName}${META_SUFFIX}`);
    const meta = readMetaFile(metaPath);
    let source = fs.readFileSync(filePath, "utf8");
    const properties = sanitizeSyncProperties(meta.properties);

    // --disable comment support (Argon pattern)
    if (source.trimStart().startsWith("--disable")) {
      properties.Disabled = true;
      source = source.replace(/^\s*--disable\s*\n?/, "");
    }

    // legacyScripts toggle (Argon pattern)
    let { className } = scriptType;
    if (options.legacyScripts === false) {
      if (scriptType.fileKind === "server") {
        className = "Script";
        properties.RunContext = "Server";
      } else if (scriptType.fileKind === "client") {
        className = "Script";
        properties.RunContext = "Client";
      }
    }

    return applyIdentityMeta({
      name: baseName,
      className,
      classNameSource: "file",
      fileKind: scriptType.fileKind,
      ext: scriptType.ext,
      source,
      properties,
      keepUnknowns: meta.keepUnknowns,
      children: []
    }, meta, baseName);
  }

  if (name.endsWith(".model.json")) {
    const baseName = explicitName || name.replace(/\.model\.json$/i, "");
    try {
      const model = parseJsonFile(filePath);
      const rootNode: any = buildNodeFromJsonModel(baseName, model);
      rootNode.sourceFile = "model.json";
      return rootNode;
    } catch (_error) {
      return null;
    }
  }

  if (name.endsWith(".rbxm") || name.endsWith(".rbxmx")) {
    const baseName = explicitName || name.replace(/\.(rbxm|rbxmx)$/i, "");
    return {
      name: baseName,
      className: "Model",
      classNameSource: "file",
      properties: {
        ExternalAssetFile: name
      },
      keepUnknowns: true,
      children: [],
      sourceFile: name.endsWith(".rbxm") ? "rbxm" : "rbxmx"
    };
  }

  // ===== FASE 2: Expanded file type support (Argon pattern) =====

  // .json -> ModuleScript (excluding .project.json, .model.json, .meta.json)
  if (name.endsWith(".json") && !name.endsWith(PROJECT_SUFFIX) && !name.endsWith(".model.json") && !name.endsWith(META_SUFFIX)) {
    const baseName = explicitName || name.replace(/\.json$/i, "");
    try {
      const rawJson = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const luauSource = `return ${jsonToLuauTable(rawJson, 0)}`;
      return {
        name: baseName,
        className: "ModuleScript",
        classNameSource: "file",
        source: luauSource,
        properties: {},
        children: [],
        sourceFile: "json"
      };
    } catch (_error) {
      return null;
    }
  }

  // .txt -> StringValue
  if (name.endsWith(".txt")) {
    const baseName = explicitName || name.replace(/\.txt$/i, "");
    const content = fs.readFileSync(filePath, "utf8");
    return {
      name: baseName,
      className: "StringValue",
      classNameSource: "file",
      properties: { Value: content },
      children: [],
      sourceFile: "txt"
    };
  }

  // .md -> StringValue (with basic Rich Text conversion)
  if (name.endsWith(".md")) {
    const baseName = explicitName || name.replace(/\.md$/i, "");
    const content = fs.readFileSync(filePath, "utf8");
    const richText = markdownToRichText(content);
    return {
      name: baseName,
      className: "StringValue",
      classNameSource: "file",
      properties: { Value: richText },
      children: [],
      sourceFile: "md"
    };
  }

  // .csv -> LocalizationTable
  if (name.endsWith(".csv")) {
    const baseName = explicitName || name.replace(/\.csv$/i, "");
    const content = fs.readFileSync(filePath, "utf8");
    return {
      name: baseName,
      className: "LocalizationTable",
      classNameSource: "file",
      properties: { Contents: content },
      children: [],
      sourceFile: "csv"
    };
  }

  return null;
}

// ===== JSON -> Luau table serializer =====
function jsonToLuauTable(value, indent) {
  const depth = indent || 0;
  const pad = "\t".repeat(depth);
  const inner = "\t".repeat(depth + 1);

  if (value === null || value === undefined) {
    return "nil";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "{}";
    }
    const items = value.map((item) => `${inner}${jsonToLuauTable(item, depth + 1)}`);
    return `{\n${items.join(",\n")}\n${pad}}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      return "{}";
    }
    const entries = keys.map((key) => {
      const luauKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
        ? key
        : `[${JSON.stringify(key)}]`;
      return `${inner}${luauKey} = ${jsonToLuauTable(value[key], depth + 1)}`;
    });
    return `{\n${entries.join(",\n")}\n${pad}}`;
  }
  return "nil";
}

// ===== Markdown -> Roblox Rich Text (basic conversion) =====
function markdownToRichText(markdown) {
  return markdown
    // Bold: **text** or __text__
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    // Italic: *text* or _text_
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/_(.+?)_/g, "<i>$1</i>")
    // Inline code: `code`
    .replace(/`(.+?)`/g, "<font family='rbxasset://fonts/families/RobotoMono.json'>$1</font>")
    // Headings: # heading
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    // Blockquotes: > text
    .replace(/^>\s+(.+)$/gm, "<i>$1</i>")
    // Unordered list: - item
    .replace(/^[-*]\s+(.+)$/gm, "<b>-</b> $1")
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, "<s>$1</s>");
}

function buildNodeFromDirectory(dirPath, options: any = {}) {
  const entries = listDirectoryEntries(dirPath);
  const dirName = path.basename(dirPath);
  const metaPath = path.join(dirPath, `init${META_SUFFIX}`);
  const meta = readMetaFile(metaPath);
  const metaProperties = sanitizeSyncProperties(meta.properties);
  const hasExplicitClassName = typeof meta.className === "string" && meta.className.length > 0;
  const initEntry = entries.find((entry) => {
    if (!entry.isFile()) {
      return false;
    }
    return /^init(\.server\.lua[u]?|\.client\.lua[u]?|\.lua[u]?|\.model\.json|\.rbxm|\.rbxmx)$/i.test(entry.name);
  });

  const baseNode = initEntry
    ? buildNodeFromFile(path.join(dirPath, initEntry.name), dirName, options)
    : {
        name: dirName,
        className: meta.className || "Folder",
        classNameSource: hasExplicitClassName ? "meta" : "defaultFolder",
        properties: metaProperties,
        keepUnknowns: meta.keepUnknowns,
        children: []
      };

  if (meta.className && !initEntry) {
    baseNode.className = meta.className;
    baseNode.classNameSource = "meta";
  }
  if (Object.keys(metaProperties).length > 0) {
    baseNode.properties = {
      ...(baseNode.properties || {}),
      ...metaProperties
    };
  }
  if (meta.keepUnknowns !== undefined) {
    baseNode.keepUnknowns = meta.keepUnknowns;
  }
  applyIdentityMeta(baseNode, meta, dirName);
  if (isOpaqueModelNode(baseNode)) {
    baseNode.children = [];
    return baseNode;
  }

  const ignoreGlobs = options.ignoreGlobs || [];
  const children = [];
  for (const entry of entries) {
    if (entry.name === `init${META_SUFFIX}`) {
      continue;
    }
    if (initEntry && entry.name === initEntry.name) {
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(META_SUFFIX)) {
      continue;
    }

    // ignoreGlobs filtering (Argon pattern)
    if (ignoreGlobs.length > 0) {
      const relativePath = path.relative(options.mountRoot || dirPath, path.join(dirPath, entry.name));
      if (matchesAnyGlob(relativePath, ignoreGlobs)) {
        continue;
      }
    }

    const fullPath = path.join(dirPath, entry.name);
    if (isOpaqueModelEntry(fullPath, entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      children.push(buildNodeFromDirectory(fullPath, options));
      continue;
    }
    if (entry.isFile()) {
      const fileNode = buildNodeFromFile(fullPath, null, options);
      if (fileNode) {
        children.push(fileNode);
      }
    }
  }

  baseNode.children = children.sort((left, right) => left.name.localeCompare(right.name));
  return baseNode;
}

function readLocalProjectState(project, extraOptions: any = {}) {
  if (extraOptions.repairOrphanScriptMetas) {
    repairProjectOrphanScriptMetas(project, extraOptions);
  }
  const options = {
    ignoreGlobs: project.ignoreGlobs || [],
    legacyScripts: project.legacyScripts,
    mountRoot: null
  };
  const snapshot = {
    projectId: project.id,
    name: project.name,
    placeIds: project.placeIds,
    mounts: project.mounts.map((mount) => {
      const mountOptions = { ...options, mountRoot: mount.absolutePath };
      const children = listDirectoryEntries(mount.absolutePath)
        .filter((entry) => !entry.isFile() || !entry.name.endsWith(META_SUFFIX))
        .filter((entry) => {
          if (mountOptions.ignoreGlobs.length === 0) return true;
          return !matchesAnyGlob(entry.name, mountOptions.ignoreGlobs);
        })
        .flatMap((entry) => {
          const fullPath = path.join(mount.absolutePath, entry.name);
          if (isOpaqueModelEntry(fullPath, entry.name)) {
            return [];
          }
          if (entry.isDirectory()) {
            return [buildNodeFromDirectory(fullPath, mountOptions)];
          }
          if (entry.isFile()) {
            const node = buildNodeFromFile(fullPath, null, mountOptions);
            return node ? [node] : [];
          }
          return [];
        })
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        id: mount.id,
        segments: mount.segments.slice(),
        relativePath: mount.relativePath,
        absolutePath: mount.absolutePath,
        keepUnknowns: mount.keepUnknowns,
        children: filterModelScriptOnlyChildren(children, mountOptions)
      };
    })
  };
  return normalizeSnapshotAmarilloIds(snapshot);
}

// OPT-006: Async version that reads script files in parallel instead of blocking the event loop
async function buildNodeFromFileAsync(filePath, explicitName = null, options: any = {}) {
  const name = path.basename(filePath);
  const scriptType = detectScriptFileType(name);
  if (scriptType) {
    const baseName = explicitName || stripScriptSuffix(name);
    const metaPath = path.join(path.dirname(filePath), `${baseName}${META_SUFFIX}`);
    const meta = readMetaFile(metaPath);
    let source = await fsp.readFile(filePath, "utf8");
    const properties = sanitizeSyncProperties(meta.properties);

    // --disable comment support
    if (source.trimStart().startsWith("--disable")) {
      properties.Disabled = true;
      source = source.replace(/^\s*--disable\s*\n?/, "");
    }

    // legacyScripts toggle
    let { className } = scriptType;
    if (options.legacyScripts === false) {
      if (scriptType.fileKind === "server") {
        className = "Script";
        properties.RunContext = "Server";
      } else if (scriptType.fileKind === "client") {
        className = "Script";
        properties.RunContext = "Client";
      }
    }

    return applyIdentityMeta({
      name: baseName,
      className,
      classNameSource: "file",
      fileKind: scriptType.fileKind,
      ext: scriptType.ext,
      source,
      properties,
      keepUnknowns: meta.keepUnknowns,
      children: []
    }, meta, baseName);
  }
  if (name.endsWith(".model.json")) {
    const baseName = explicitName || name.replace(/\.model\.json$/i, "");
    try {
      const model = JSON.parse(await fsp.readFile(filePath, "utf8"));
      const rootNode: any = buildNodeFromJsonModel(baseName, model);
      rootNode.sourceFile = "model.json";
      return rootNode;
    } catch (_error) {
      return null;
    }
  }

  if (name.endsWith(".rbxm") || name.endsWith(".rbxmx")) {
    const baseName = explicitName || name.replace(/\.(rbxm|rbxmx)$/i, "");
    return {
      name: baseName,
      className: "Model",
      classNameSource: "file",
      properties: {
        ExternalAssetFile: name
      },
      keepUnknowns: true,
      children: [],
      sourceFile: name.endsWith(".rbxm") ? "rbxm" : "rbxmx"
    };
  }

  // .json -> ModuleScript (excluding .project.json, .model.json, .meta.json)
  if (name.endsWith(".json") && !name.endsWith(PROJECT_SUFFIX) && !name.endsWith(".model.json") && !name.endsWith(META_SUFFIX)) {
    const baseName = explicitName || name.replace(/\.json$/i, "");
    try {
      const rawJson = JSON.parse(await fsp.readFile(filePath, "utf8"));
      const luauSource = `return ${jsonToLuauTable(rawJson, 0)}`;
      return {
        name: baseName,
        className: "ModuleScript",
        classNameSource: "file",
        source: luauSource,
        properties: {},
        children: [],
        sourceFile: "json"
      };
    } catch (_error) {
      return null;
    }
  }

  if (name.endsWith(".txt")) {
    const baseName = explicitName || name.replace(/\.txt$/i, "");
    const content = await fsp.readFile(filePath, "utf8");
    return {
      name: baseName,
      className: "StringValue",
      classNameSource: "file",
      properties: { Value: content },
      children: [],
      sourceFile: "txt"
    };
  }

  if (name.endsWith(".md")) {
    const baseName = explicitName || name.replace(/\.md$/i, "");
    const content = await fsp.readFile(filePath, "utf8");
    return {
      name: baseName,
      className: "StringValue",
      classNameSource: "file",
      properties: { Value: markdownToRichText(content) },
      children: [],
      sourceFile: "md"
    };
  }

  if (name.endsWith(".csv")) {
    const baseName = explicitName || name.replace(/\.csv$/i, "");
    const content = await fsp.readFile(filePath, "utf8");
    return {
      name: baseName,
      className: "LocalizationTable",
      classNameSource: "file",
      properties: { Contents: content },
      children: [],
      sourceFile: "csv"
    };
  }

  return null;
}

async function buildNodeFromDirectoryAsync(dirPath, options: any = {}) {
  const entries = listDirectoryEntries(dirPath);
  const dirName = path.basename(dirPath);
  const metaPath = path.join(dirPath, `init${META_SUFFIX}`);
  const meta = readMetaFile(metaPath);
  const metaProperties = sanitizeSyncProperties(meta.properties);
  const hasExplicitClassName = typeof meta.className === "string" && meta.className.length > 0;
  const initEntry = entries.find((entry) => {
    if (!entry.isFile()) {
      return false;
    }
    return /^init(\.server\.lua[u]?|\.client\.lua[u]?|\.lua[u]?|\.model\.json|\.rbxm|\.rbxmx)$/i.test(entry.name);
  });

  const baseNode = initEntry
    ? await buildNodeFromFileAsync(path.join(dirPath, initEntry.name), dirName, options)
    : {
        name: dirName,
        className: meta.className || "Folder",
        classNameSource: hasExplicitClassName ? "meta" : "defaultFolder",
        properties: metaProperties,
        keepUnknowns: meta.keepUnknowns,
        children: []
      };

  if (meta.className && !initEntry) {
    baseNode.className = meta.className;
    baseNode.classNameSource = "meta";
  }
  if (Object.keys(metaProperties).length > 0) {
    baseNode.properties = {
      ...(baseNode.properties || {}),
      ...metaProperties
    };
  }
  if (meta.keepUnknowns !== undefined) {
    baseNode.keepUnknowns = meta.keepUnknowns;
  }
  applyIdentityMeta(baseNode, meta, dirName);
  if (isOpaqueModelNode(baseNode)) {
    baseNode.children = [];
    return baseNode;
  }

  const childPromises = [];
  const ignoreGlobs = options.ignoreGlobs || [];
  for (const entry of entries) {
    if (entry.name === `init${META_SUFFIX}`) continue;
    if (initEntry && entry.name === initEntry.name) continue;
    if (entry.isFile() && entry.name.endsWith(META_SUFFIX)) continue;

    if (ignoreGlobs.length > 0) {
      const relativePath = path.relative(options.mountRoot || dirPath, path.join(dirPath, entry.name));
      if (matchesAnyGlob(relativePath, ignoreGlobs)) {
        continue;
      }
    }

    const fullPath = path.join(dirPath, entry.name);
    if (isOpaqueModelEntry(fullPath, entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      childPromises.push(buildNodeFromDirectoryAsync(fullPath, options));
    } else if (entry.isFile()) {
      childPromises.push(buildNodeFromFileAsync(fullPath, null, options));
    }
  }

  const children = (await Promise.all(childPromises)).filter(Boolean);
  baseNode.children = children.sort((left, right) => left.name.localeCompare(right.name));
  return baseNode;
}

async function readLocalProjectStateAsync(project, extraOptions: any = {}) {
  if (extraOptions.repairOrphanScriptMetas) {
    repairProjectOrphanScriptMetas(project, extraOptions);
  }
  const options = {
    ignoreGlobs: project.ignoreGlobs || [],
    legacyScripts: project.legacyScripts,
    mountRoot: null
  };
  const mountPromises = project.mounts.map(async (mount) => {
    const mountOptions = {
      ...options,
      mountRoot: mount.absolutePath
    };
    const entries = listDirectoryEntries(mount.absolutePath)
      .filter((entry) => !entry.isFile() || !entry.name.endsWith(META_SUFFIX))
      .filter((entry) => {
        if (mountOptions.ignoreGlobs.length === 0) {
          return true;
        }
        return !matchesAnyGlob(entry.name, mountOptions.ignoreGlobs);
      });

    const childPromises = entries.map(async (entry) => {
      const fullPath = path.join(mount.absolutePath, entry.name);
      if (isOpaqueModelEntry(fullPath, entry.name)) {
        return null;
      }
      if (entry.isDirectory()) {
        return buildNodeFromDirectoryAsync(fullPath, mountOptions);
      }
      if (entry.isFile()) {
        return buildNodeFromFileAsync(fullPath, null, mountOptions);
      }
      return null;
    });

    const children = filterModelScriptOnlyChildren((await Promise.all(childPromises))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name)), mountOptions);

    return {
      id: mount.id,
      segments: mount.segments.slice(),
      relativePath: mount.relativePath,
      absolutePath: mount.absolutePath,
      keepUnknowns: mount.keepUnknowns,
      children
    };
  });

  const snapshot = {
    projectId: project.id,
    name: project.name,
    placeIds: project.placeIds,
    mounts: await Promise.all(mountPromises)
  };
  return normalizeSnapshotAmarilloIds(snapshot);
}

function serializePropertyValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializePropertyValue(item));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = serializePropertyValue(item);
    }
    return output;
  }
  return value;
}

function ensureDirectory(dirPath, options: any = {}) {
  fs.mkdirSync(assertPathInsideWriteRoot(dirPath, options, "creating directory"), { recursive: true });
}

function hashBuffer(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function fileInfoForContent(value) {
  const buffer = Buffer.from(String(value), "utf8");
  return {
    size: buffer.length,
    hash: hashBuffer(buffer)
  };
}

function notifyFileChange(options, change) {
  if (!options || typeof options.onFileChange !== "function") {
    return;
  }
  options.onFileChange({
    ...change,
    filePath: path.resolve(change.filePath),
    projectId: options.project ? options.project.id : null,
    mountId: options.mount ? options.mount.id : null
  });
}

function writeJsonFile(filePath, value, options: any = {}) {
  return writeTextFileIfChanged(filePath, JSON.stringify(value, null, 2), options);
}

function writeTextFileIfChanged(filePath, value, options: any = {}) {
  const targetPath = assertPathInsideWriteRoot(filePath, options, "writing file");
  const existed = fs.existsSync(targetPath);
  if (existed) {
    const current = fs.readFileSync(targetPath, "utf8");
    if (current === value) {
      return false;
    }
  }
  fs.writeFileSync(targetPath, value, "utf8");
  notifyFileChange(options, {
    action: existed ? "modify" : "create",
    filePath: targetPath,
    ...fileInfoForContent(value)
  });
  return true;
}

function collectExistingFileInfos(targetPath, results = []) {
  if (!fs.existsSync(targetPath)) {
    return results;
  }
  const stats = fs.lstatSync(targetPath);
  if (stats.isFile()) {
    results.push({
      filePath: targetPath,
      size: stats.size,
      hash: hashBuffer(fs.readFileSync(targetPath))
    });
    return results;
  }
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      collectExistingFileInfos(path.join(targetPath, entry.name), results);
    }
  }
  return results;
}

function removePath(targetPath, options: any = {}) {
  const resolvedTarget = assertPathInsideWriteRoot(targetPath, options, "removing path");
  const removedFiles = collectExistingFileInfos(resolvedTarget);
  if (removedFiles.length === 0 && !fs.existsSync(resolvedTarget)) {
    return;
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
  for (const file of removedFiles) {
    notifyFileChange(options, {
      action: "delete",
      filePath: file.filePath,
      size: file.size,
      hash: file.hash
    });
  }
}

function syncbackConfig(options: any = {}) {
  return options.syncback || {};
}

function ignoredSyncbackProperties(options: any = {}) {
  return new Set(syncbackConfig(options).ignoreProperties || []);
}

function filterSyncbackProperties(properties, options: any = {}) {
  const sanitized = sanitizeSyncProperties(properties);
  if (Object.keys(sanitized).length === 0) {
    return {};
  }
  if (isPlainObject(sanitized.Attributes)) {
    delete sanitized.Attributes[AMARILLO_ID_ATTRIBUTE];
    if (Object.keys(sanitized.Attributes).length === 0) {
      delete sanitized.Attributes;
    }
  }
  const ignored = ignoredSyncbackProperties(options);
  if (ignored.size === 0) {
    return sanitized;
  }
  return Object.entries(sanitized).reduce((next, [key, value]) => {
    if (!ignored.has(key)) {
      next[key] = value;
    }
    return next;
  }, {});
}

function normalizedScriptKindForNode(node) {
  if (node.fileKind === "client" || node.className === "LocalScript") {
    return "client";
  }
  if (node.fileKind === "server" || node.className === "Script") {
    return "server";
  }
  return "module";
}

function isCompatibleScriptExtension(kind, ext) {
  if (typeof ext !== "string" || !/\.(lua|luau)$/i.test(ext)) {
    return false;
  }
  if (kind === "client") {
    return /\.client\.(lua|luau)$/i.test(ext);
  }
  if (kind === "server") {
    return /\.server\.(lua|luau)$/i.test(ext);
  }
  return /^\.(lua|luau)$/i.test(ext);
}

function scriptExtensionForNode(node) {
  const kind = normalizedScriptKindForNode(node);
  if (isCompatibleScriptExtension(kind, node.ext)) {
    return node.ext;
  }
  if (kind === "client") {
    return ".client.luau";
  }
  if (kind === "server") {
    return ".server.luau";
  }
  return ".luau";
}

function isScriptNode(node) {
  return Boolean(node?.fileKind)
    || node?.className === "Script"
    || node?.className === "LocalScript"
    || node?.className === "ModuleScript";
}

function shouldUseModelScriptOnly(children, options: any = {}) {
  return options.modelScriptOnly !== false && Array.isArray(children);
}

function filterModelScriptOnlyNode(node, context: any = {}) {
  if (!node) {
    return null;
  }
  if (isOpaqueModelNode(node)) {
    return null;
  }
  const insideModel = context.insideModel === true;
  const filteredChildren = [];
  for (const child of node.children || []) {
    const filtered = filterModelScriptOnlyNode(child, { insideModel });
    if (filtered) {
      filteredChildren.push(filtered);
    }
  }

  const scriptNode = isScriptNode(node);
  if (insideModel && !scriptNode && filteredChildren.length === 0) {
    return null;
  }

  const next = {
    ...node,
    children: filteredChildren
  };
  if (insideModel && !scriptNode) {
    next.properties = {};
    next.keepUnknowns = true;
  }
  return next;
}

function filterModelScriptOnlyChildren(children, options: any = {}) {
  if (!shouldUseModelScriptOnly(children, options)) {
    return children || [];
  }
  return (children || [])
    .map((child) => filterModelScriptOnlyNode(child, { insideModel: false }))
    .filter(Boolean);
}

function matchesSyncbackGlob(fullPath, entryName, options: any = {}) {
  const syncback = syncbackConfig(options);
  if (!syncback.ignoreGlobs || syncback.ignoreGlobs.length === 0) {
    return false;
  }
  const mountRoot = options.mount?.absolutePath || options.mount?.rootPath || null;
  const relativePath = mountRoot
    ? path.relative(mountRoot, fullPath).replace(/\\/g, "/")
    : entryName;
  return matchesAnyGlob(relativePath, syncback.ignoreGlobs) || matchesAnyGlob(entryName, syncback.ignoreGlobs);
}

function shouldIgnoreSyncbackNode(node, options: any = {}, parentDir = null) {
  if (isOpaqueModelNode(node)) {
    return true;
  }
  const syncback = syncbackConfig(options);
  if ((syncback.ignoreNames || []).includes(node.name) || (syncback.ignoreClasses || []).includes(node.className)) {
    return true;
  }
  if (!parentDir) {
    return false;
  }
  const fsName = nodeFsName(node);
  if (node.fileKind && (!node.children || node.children.length === 0)) {
    const fileName = `${fsName}${scriptExtensionForNode(node)}`;
    return matchesSyncbackGlob(path.join(parentDir, fileName), fileName, options);
  }
  return matchesSyncbackGlob(path.join(parentDir, fsName), fsName, options);
}

function syncbackEntryBaseName(entryName) {
  return String(entryName)
    .replace(/\.meta\.json$/i, "")
    .replace(/(?:\.server|\.client)?\.(?:lua|luau)$/i, "");
}

function shouldPreserveSyncbackEntry(fullPath, entryName, options: any = {}) {
  if (isOpaqueModelEntry(fullPath, entryName)) {
    return true;
  }
  const syncback = syncbackConfig(options);
  const baseName = syncbackEntryBaseName(entryName);
  if ((syncback.ignoreNames || []).includes(baseName)) {
    return true;
  }
  if (matchesSyncbackGlob(fullPath, entryName, options)) {
    return true;
  }
  if ((syncback.ignoreClasses || []).length > 0 && fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    const metaPath = path.join(fullPath, `init${META_SUFFIX}`);
    if (fs.existsSync(metaPath)) {
      try {
        const meta = parseJsonFile(metaPath);
        if ((syncback.ignoreClasses || []).includes(meta.className)) {
          return true;
        }
      } catch (_error) {
        return false;
      }
    }
  }
  return false;
}

function metaForNode(node, options: any = {}) {
  const meta: any = {};
  if (node.className && !node.fileKind && (node.className !== "Folder" || node.classNameSource !== "defaultFolder")) {
    meta.className = node.className;
  }
  const fsName = nodeFsName(node);
  if (fsName && fsName !== node.name) {
    meta.robloxName = node.name;
  }
  if (typeof node.amarilloId === "string" && node.amarilloId.length > 0) {
    meta.amarilloId = node.amarilloId;
  }
  if (Number.isInteger(node.duplicateOrdinal) && node.duplicateOrdinal > 1) {
    meta.duplicateOrdinal = node.duplicateOrdinal;
  }
  const properties = filterSyncbackProperties(node.properties, options);
  if (properties && Object.keys(properties).length > 0) {
    meta.properties = serializePropertyValue(properties);
  }
  if (node.keepUnknowns !== undefined) {
    meta.keepUnknowns = node.keepUnknowns;
  }
  return meta;
}

function metaForScriptNode(node, options: any = {}) {
  const meta: any = {};
  const fsName = nodeFsName(node);
  if (fsName && fsName !== node.name) {
    meta.robloxName = node.name;
  }
  if (typeof node.amarilloId === "string" && node.amarilloId.length > 0) {
    meta.amarilloId = node.amarilloId;
  }
  if (Number.isInteger(node.duplicateOrdinal) && node.duplicateOrdinal > 1) {
    meta.duplicateOrdinal = node.duplicateOrdinal;
  }
  const properties = filterSyncbackProperties(node.properties, options);
  if (properties && Object.keys(properties).length > 0) {
    meta.properties = serializePropertyValue(properties);
  }
  if (node.keepUnknowns !== undefined) {
    meta.keepUnknowns = node.keepUnknowns;
  }
  return meta;
}

function writeScriptNode(parentDir, node, asInit = false, options: any = {}) {
  if (shouldIgnoreSyncbackNode(node, options, parentDir)) {
    return;
  }
  const safeParentDir = assertPathInsideWriteRoot(parentDir, options, "writing script parent");
  const extension = scriptExtensionForNode(node);
  const fsName = nodeFsName(node);
  const fileName = asInit ? `init${extension}` : `${fsName}${extension}`;
  writeTextFileIfChanged(path.join(safeParentDir, fileName), node.source || "", options);

  const meta = metaForScriptNode(node, options);
  if (Object.keys(meta).length > 0) {
    const metaName = asInit ? `init${META_SUFFIX}` : `${fsName}${META_SUFFIX}`;
    writeJsonFile(path.join(safeParentDir, metaName), meta, options);
  }
}

function writeFolderNode(parentDir, node, options: any = {}) {
  if (shouldIgnoreSyncbackNode(node, options, parentDir)) {
    return;
  }
  const nodeDir = assertPathInsideWriteRoot(path.join(parentDir, nodeFsName(node)), options, "creating folder");
  ensureDirectory(nodeDir, options);

  const meta = metaForNode(node, options);
  if (Object.keys(meta).length > 0) {
    writeJsonFile(path.join(nodeDir, `init${META_SUFFIX}`), meta, options);
  }

  if (Array.isArray(node.children)) {
    const children = prepareSiblingNodesForWrite(filterModelScriptOnlyChildren(node.children, options), nodeDir);
    for (const child of children) {
      writeNode(nodeDir, child, options);
    }
  }

  if (node.keepUnknowns !== true) {
    cleanupUnexpectedEntries(nodeDir, node, false, options);
  }
}

function writeNode(parentDir, node, options: any = {}) {
  if (shouldIgnoreSyncbackNode(node, options, parentDir)) {
    return;
  }
  if (node.fileKind) {
    if (Array.isArray(node.children) && node.children.length > 0) {
      const nodeDir = assertPathInsideWriteRoot(path.join(parentDir, nodeFsName(node)), options, "creating script folder");
      ensureDirectory(nodeDir, options);
      writeScriptNode(nodeDir, node, true, options);
      const children = prepareSiblingNodesForWrite(filterModelScriptOnlyChildren(node.children, options), nodeDir);
      for (const child of children) {
        writeNode(nodeDir, child, options);
      }
      if (node.keepUnknowns !== true) {
        cleanupUnexpectedEntries(nodeDir, node, true, options);
      }
      return;
    }
    writeScriptNode(parentDir, node, false, options);
    return;
  }

  writeFolderNode(parentDir, node, options);
}

function expectedEntriesForNode(node, withInitScript = false, options: any = {}, parentDir = null) {
  const expected = new Set();
  if (withInitScript && node.fileKind) {
    const extension = scriptExtensionForNode(node);
    expected.add(`init${extension}`);
  }
  if (Object.keys(metaForNode(node, options)).length > 0) {
    expected.add(`init${META_SUFFIX}`);
  }
  const children = prepareSiblingNodesForWrite(filterModelScriptOnlyChildren(node.children || [], options), parentDir || "");
  for (const child of children) {
    if (shouldIgnoreSyncbackNode(child, options, parentDir)) {
      continue;
    }
    const fsName = nodeFsName(child);
    if (child.fileKind && (!child.children || child.children.length === 0)) {
      const ext = scriptExtensionForNode(child);
      expected.add(`${fsName}${ext}`);
      const childMeta = metaForScriptNode(child, options);
      if (Object.keys(childMeta).length > 0) {
        expected.add(`${fsName}${META_SUFFIX}`);
      }
    } else {
      expected.add(fsName);
    }
  }
  return expected;
}

function cleanupUnexpectedEntries(nodeDir, node, withInitScript = false, options: any = {}) {
  const safeNodeDir = assertPathInsideWriteRoot(nodeDir, options, "cleaning directory");
  const expected = expectedEntriesForNode(node, withInitScript, options, safeNodeDir);
  for (const entry of listDirectoryEntries(safeNodeDir)) {
    const fullPath = path.join(safeNodeDir, entry.name);
    if (!expected.has(entry.name) && !shouldPreserveSyncbackEntry(fullPath, entry.name, options)) {
      removePath(fullPath, options);
    }
  }
}

function writeMountSnapshot(mount, children, options: any = {}) {
  const mountOptions = {
    ...options,
    mount,
    writeRoot: mount.absolutePath
  };
  const writableChildren = prepareSiblingNodesForWrite(filterModelScriptOnlyChildren(children || [], mountOptions), mount.absolutePath);
  ensureDirectory(mount.absolutePath, mountOptions);
  for (const child of writableChildren) {
    if (shouldIgnoreSyncbackNode(child, mountOptions, mount.absolutePath)) {
      continue;
    }
    writeNode(mount.absolutePath, child, mountOptions);
  }

  const expected = new Set();
  for (const child of writableChildren) {
    if (shouldIgnoreSyncbackNode(child, mountOptions, mount.absolutePath)) {
      continue;
    }
    const fsName = nodeFsName(child);
    if (child.fileKind && (!child.children || child.children.length === 0)) {
      const ext = scriptExtensionForNode(child);
      expected.add(`${fsName}${ext}`);
      const meta = metaForScriptNode(child, mountOptions);
      if (Object.keys(meta).length > 0) {
        expected.add(`${fsName}${META_SUFFIX}`);
      }
    } else {
      expected.add(fsName);
    }
  }

  const allEntries = listDirectoryEntries(mount.absolutePath);
  for (const entry of allEntries) {
    const fullPath = path.join(mount.absolutePath, entry.name);
    if (!expected.has(entry.name) && !shouldPreserveSyncbackEntry(fullPath, entry.name, mountOptions)) {
      removePath(fullPath, mountOptions);
    }
  }
}

function writeStudioProjectState(project, snapshot, options: any = {}) {
  const changes = [];
  const normalizedSnapshot = normalizeSnapshotAmarilloIds(snapshot || {});
  const writeOptions = {
    ...options,
    syncback: project.syncback || {},
    project,
    onFileChange: (change) => {
      changes.push(change);
      if (typeof options.onFileChange === "function") {
        options.onFileChange(change);
      }
    }
  };
  const mountMap = new Map(project.mounts.map((mount) => [mount.id, mount]));
  for (const mountSnapshot of normalizedSnapshot.mounts || []) {
    const mount = mountMap.get(mountSnapshot.id);
    if (!mount) {
      continue;
    }
    writeMountSnapshot(mount, mountSnapshot.children || [], writeOptions);
  }
  return changes;
}

async function pathExistsAsync(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function listDirectoryEntriesAsync(dirPath) {
  if (!await pathExistsAsync(dirPath)) {
    return [];
  }
  return fsp.readdir(dirPath, { withFileTypes: true });
}

async function writeTextFileIfChangedAsync(filePath, value, options: any = {}) {
  const targetPath = assertPathInsideWriteRoot(filePath, options, "writing file");
  let existed = false;
  try {
    const current = await fsp.readFile(targetPath, "utf8");
    existed = true;
    if (current === value) {
      return false;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, value, "utf8");
  notifyFileChange(options, {
    action: existed ? "modify" : "create",
    filePath: targetPath,
    ...fileInfoForContent(value)
  });
  return true;
}

function writeJsonFileAsync(filePath, value, options: any = {}) {
  return writeTextFileIfChangedAsync(filePath, JSON.stringify(value, null, 2), options);
}

async function collectExistingFileInfosAsync(targetPath, results = []) {
  let stats;
  try {
    stats = await fsp.lstat(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return results;
    }
    throw error;
  }
  if (stats.isFile()) {
    results.push({
      filePath: targetPath,
      size: stats.size,
      hash: hashBuffer(await fsp.readFile(targetPath))
    });
    return results;
  }
  if (stats.isDirectory()) {
    for (const entry of await fsp.readdir(targetPath, { withFileTypes: true })) {
      await collectExistingFileInfosAsync(path.join(targetPath, entry.name), results);
    }
  }
  return results;
}

async function removePathAsync(targetPath, options: any = {}) {
  const resolvedTarget = assertPathInsideWriteRoot(targetPath, options, "removing path");
  const removedFiles = await collectExistingFileInfosAsync(resolvedTarget);
  if (removedFiles.length === 0 && !await pathExistsAsync(resolvedTarget)) {
    return;
  }
  await fsp.rm(resolvedTarget, { recursive: true, force: true });
  for (const file of removedFiles) {
    notifyFileChange(options, {
      action: "delete",
      filePath: file.filePath,
      size: file.size,
      hash: file.hash
    });
  }
}

async function shouldPreserveSyncbackEntryAsync(fullPath, entryName, options: any = {}) {
  if (isOpaqueModelEntry(fullPath, entryName)) {
    return true;
  }
  const syncback = syncbackConfig(options);
  const baseName = syncbackEntryBaseName(entryName);
  if ((syncback.ignoreNames || []).includes(baseName)) {
    return true;
  }
  if (matchesSyncbackGlob(fullPath, entryName, options)) {
    return true;
  }
  if ((syncback.ignoreClasses || []).length > 0) {
    let stats = null;
    try {
      stats = await fsp.stat(fullPath);
    } catch (_error) {
      stats = null;
    }
    if (stats?.isDirectory()) {
      const metaPath = path.join(fullPath, `init${META_SUFFIX}`);
      try {
        const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
        if ((syncback.ignoreClasses || []).includes(meta.className)) {
          return true;
        }
      } catch (_error) {
        return false;
      }
    }
  }
  return false;
}

async function cleanupUnexpectedEntriesAsync(nodeDir, node, withInitScript = false, options: any = {}) {
  const safeNodeDir = assertPathInsideWriteRoot(nodeDir, options, "cleaning directory");
  const expected = expectedEntriesForNode(node, withInitScript, options, safeNodeDir);
  for (const entry of await listDirectoryEntriesAsync(safeNodeDir)) {
    const fullPath = path.join(safeNodeDir, entry.name);
    if (!expected.has(entry.name) && !await shouldPreserveSyncbackEntryAsync(fullPath, entry.name, options)) {
      await removePathAsync(fullPath, options);
    }
  }
}

async function writeScriptNodeAsync(parentDir, node, asInit = false, options: any = {}) {
  if (shouldIgnoreSyncbackNode(node, options, parentDir)) {
    return;
  }
  const safeParentDir = assertPathInsideWriteRoot(parentDir, options, "writing script parent");
  const extension = scriptExtensionForNode(node);
  const fsName = nodeFsName(node);
  const fileName = asInit ? `init${extension}` : `${fsName}${extension}`;
  await writeTextFileIfChangedAsync(path.join(safeParentDir, fileName), node.source || "", options);

  const meta = metaForScriptNode(node, options);
  if (Object.keys(meta).length > 0) {
    const metaName = asInit ? `init${META_SUFFIX}` : `${fsName}${META_SUFFIX}`;
    await writeJsonFileAsync(path.join(safeParentDir, metaName), meta, options);
  }
}

async function writeFolderNodeAsync(parentDir, node, options: any = {}) {
  if (shouldIgnoreSyncbackNode(node, options, parentDir)) {
    return;
  }
  const nodeDir = assertPathInsideWriteRoot(path.join(parentDir, nodeFsName(node)), options, "creating folder");
  await fsp.mkdir(nodeDir, { recursive: true });

  const meta = metaForNode(node, options);
  if (Object.keys(meta).length > 0) {
    await writeJsonFileAsync(path.join(nodeDir, `init${META_SUFFIX}`), meta, options);
  }

  if (Array.isArray(node.children)) {
    const children = prepareSiblingNodesForWrite(filterModelScriptOnlyChildren(node.children, options), nodeDir);
    for (const child of children) {
      await writeNodeAsync(nodeDir, child, options);
    }
  }

  if (node.keepUnknowns !== true) {
    await cleanupUnexpectedEntriesAsync(nodeDir, node, false, options);
  }
}

async function writeNodeAsync(parentDir, node, options: any = {}) {
  if (shouldIgnoreSyncbackNode(node, options, parentDir)) {
    return;
  }
  if (node.fileKind) {
    if (Array.isArray(node.children) && node.children.length > 0) {
      const nodeDir = assertPathInsideWriteRoot(path.join(parentDir, nodeFsName(node)), options, "creating script folder");
      await fsp.mkdir(nodeDir, { recursive: true });
      await writeScriptNodeAsync(nodeDir, node, true, options);
      const children = prepareSiblingNodesForWrite(filterModelScriptOnlyChildren(node.children, options), nodeDir);
      for (const child of children) {
        await writeNodeAsync(nodeDir, child, options);
      }
      if (node.keepUnknowns !== true) {
        await cleanupUnexpectedEntriesAsync(nodeDir, node, true, options);
      }
      return;
    }
    await writeScriptNodeAsync(parentDir, node, false, options);
    return;
  }

  await writeFolderNodeAsync(parentDir, node, options);
}

async function writeMountSnapshotAsync(mount, children, options: any = {}) {
  const mountOptions = {
    ...options,
    mount,
    writeRoot: mount.absolutePath
  };
  const writableChildren = prepareSiblingNodesForWrite(filterModelScriptOnlyChildren(children || [], mountOptions), mount.absolutePath);
  await fsp.mkdir(assertPathInsideWriteRoot(mount.absolutePath, mountOptions, "creating mount directory"), { recursive: true });
  for (const child of writableChildren) {
    if (shouldIgnoreSyncbackNode(child, mountOptions, mount.absolutePath)) {
      continue;
    }
    await writeNodeAsync(mount.absolutePath, child, mountOptions);
  }

  const expected = new Set();
  for (const child of writableChildren) {
    if (shouldIgnoreSyncbackNode(child, mountOptions, mount.absolutePath)) {
      continue;
    }
    const fsName = nodeFsName(child);
    if (child.fileKind && (!child.children || child.children.length === 0)) {
      const ext = scriptExtensionForNode(child);
      expected.add(`${fsName}${ext}`);
      const meta = metaForScriptNode(child, mountOptions);
      if (Object.keys(meta).length > 0) {
        expected.add(`${fsName}${META_SUFFIX}`);
      }
    } else {
      expected.add(fsName);
    }
  }

  for (const entry of await listDirectoryEntriesAsync(mount.absolutePath)) {
    const fullPath = path.join(mount.absolutePath, entry.name);
    if (!expected.has(entry.name) && !await shouldPreserveSyncbackEntryAsync(fullPath, entry.name, mountOptions)) {
      await removePathAsync(fullPath, mountOptions);
    }
  }
}

async function writeStudioProjectStateAsync(project, snapshot, options: any = {}) {
  const changes = [];
  const normalizedSnapshot = normalizeSnapshotAmarilloIds(snapshot || {});
  const writeOptions = {
    ...options,
    syncback: project.syncback || {},
    project,
    onFileChange: (change) => {
      changes.push(change);
      if (typeof options.onFileChange === "function") {
        options.onFileChange(change);
      }
    }
  };
  const mountMap = new Map(project.mounts.map((mount) => [mount.id, mount]));
  for (const mountSnapshot of normalizedSnapshot.mounts || []) {
    const mount = mountMap.get(mountSnapshot.id);
    if (!mount) {
      continue;
    }
    await writeMountSnapshotAsync(mount, mountSnapshot.children || [], writeOptions);
  }
  return changes;
}

function buildProjectSelectionMessage(reason, project, placeId) {
  const numericPlaceId = Number(placeId || 0);
  const placeLabel = numericPlaceId > 0
    ? `place_id ${numericPlaceId}`
    : "place sem identificador";

  if (reason === "place_match") {
    return `Project '${project.name}' was resolved by a direct match for ${placeLabel}.`;
  }
  if (reason === "configured_default") {
    return `No project uses ${placeLabel}; using the configured default project '${project.name}'.`;
  }
  if (reason === "no_place_filter") {
    return `No project uses ${placeLabel}; using '${project.name}' because it does not define place_ids.`;
  }
  if (reason === "first_available") {
    return `No project uses ${placeLabel}; using the first available project '${project.name}'.`;
  }
  return "No compatible Argon project was found in the workspace.";
}

function resolveProjectSelectionForPlace(projects, placeId, configuredDefaultId = null) {
  const numericPlaceId = Number(placeId || 0);
  const exactMatch = projects.find((project) => project.placeIds.includes(numericPlaceId));
  if (exactMatch) {
    return {
      project: exactMatch,
      reason: "place_match",
      message: buildProjectSelectionMessage("place_match", exactMatch, numericPlaceId)
    };
  }
  if (configuredDefaultId) {
    const configuredProject = projects.find((project) => project.id === configuredDefaultId);
    if (configuredProject) {
      return {
        project: configuredProject,
        reason: "configured_default",
        message: buildProjectSelectionMessage("configured_default", configuredProject, numericPlaceId)
      };
    }
  }
  const noPlaceFilter = projects.find((project) => project.placeIds.length === 0);
  if (noPlaceFilter) {
    return {
      project: noPlaceFilter,
      reason: "no_place_filter",
      message: buildProjectSelectionMessage("no_place_filter", noPlaceFilter, numericPlaceId)
    };
  }
  const firstProject = projects[0] || null;
  return {
    project: firstProject,
    reason: firstProject ? "first_available" : "not_found",
    message: buildProjectSelectionMessage(firstProject ? "first_available" : "not_found", firstProject || { name: "-" }, numericPlaceId)
  };
}

function resolveProjectForPlace(projects, placeId, configuredDefaultId = null) {
  return resolveProjectSelectionForPlace(projects, placeId, configuredDefaultId).project;
}

function invalidInstancePathSegmentReason(segment) {
  if (typeof segment !== "string" || segment.length === 0) {
    return "empty";
  }
  if (segment === "." || segment === "..") {
    return "dot_segment";
  }
  if (/[\\/]/.test(segment)) {
    return "path_separator";
  }
  if (/[\x00-\x1F]/.test(segment)) {
    return "control_character";
  }
  return null;
}

function normalizeInstancePathSegments(instancePath) {
  const rawSegments = Array.isArray(instancePath)
    ? instancePath
    : (typeof instancePath === "string" ? instancePath.split(".") : null);
  if (!rawSegments) {
    return {
      ok: false,
      segments: [],
      error: "Caminho da instancia vazio ou invalido."
    };
  }
  const segments = [];
  for (const segment of rawSegments) {
    if (segment === "game" || segment === "DataModel") {
      continue;
    }
    const invalidReason = invalidInstancePathSegmentReason(segment);
    if (invalidReason) {
      return {
        ok: false,
        segments: [],
        error: `Caminho da instancia contem segmento invalido (${invalidReason}).`
      };
    }
    segments.push(segment);
  }
  return {
    ok: segments.length > 0,
    segments,
    error: segments.length > 0 ? null : "Caminho da instancia vazio ou invalido."
  };
}

function patchStudioFileSource(project, instancePath, newSource, options: any = {}) {
  const normalizedPath = normalizeInstancePathSegments(instancePath);
  if (!normalizedPath.ok) {
    return {
      ok: false,
      code: "INVALID_INSTANCE_PATH",
      error: normalizedPath.error || "Caminho da instancia vazio ou invalido."
    };
  }
  const targetSegments = normalizedPath.segments;
  if (targetSegments.length === 0) {
    return {
      ok: false,
      code: "INVALID_INSTANCE_PATH",
      error: "Caminho da instancia vazio ou invalido."
    };
  }
  let bestMount = null;
  let bestMountMatchLength = -1;

  for (const mount of project.mounts) {
    let matches = true;
    for (let i = 0; i < mount.segments.length; i++) {
      if (mount.segments[i] !== targetSegments[i]) {
        matches = false;
        break;
      }
    }
    if (matches && mount.segments.length > bestMountMatchLength) {
      bestMount = mount;
      bestMountMatchLength = mount.segments.length;
    }
  }

  if (!bestMount) {
    return {
      ok: false,
      error: `No mount matches path '${targetSegments.join(".")}'.`
    };
  }

  const remainingSegments = targetSegments.slice(bestMountMatchLength);
  let currentPath = bestMount.absolutePath;
  const patchOptions = {
    ...options,
    mount: options.mount || bestMount,
    writeRoot: bestMount.absolutePath
  };
  
  if (remainingSegments.length === 0) {
    const initFiles = ["init.luau", "init.server.luau", "init.client.luau", "init.lua", "init.server.lua", "init.client.lua"];
    for (const f of initFiles) {
      const p = path.join(currentPath, f);
      if (!isPathInside(p, bestMount.absolutePath)) {
        return {
          ok: false,
          code: "PATH_TRAVERSAL_BLOCKED",
          error: `Resolved patch path escaped mount '${bestMount.id}'.`
        };
      }
      if (fs.existsSync(p)) {
        const changed = writeTextFileIfChanged(p, newSource, patchOptions);
        return {
          ok: true,
          filePath: p,
          changed
        };
      }
    }
    return {
      ok: false,
      error: `Init file not found for '${targetSegments.join(".")}'.`
    };
  }

  for (let i = 0; i < remainingSegments.length - 1; i++) {
    currentPath = path.join(currentPath, remainingSegments[i]);
    if (!isPathInside(currentPath, bestMount.absolutePath)) {
      return {
        ok: false,
        code: "PATH_TRAVERSAL_BLOCKED",
        error: `Resolved patch path escaped mount '${bestMount.id}'.`
      };
    }
  }
  
  const lastSegment = remainingSegments[remainingSegments.length - 1];
  const possibleFiles = [
    `${lastSegment}.luau`,
    `${lastSegment}.server.luau`,
    `${lastSegment}.client.luau`,
    `${lastSegment}.lua`,
    `${lastSegment}.server.lua`,
    `${lastSegment}.client.lua`,
    path.join(lastSegment, "init.luau"),
    path.join(lastSegment, "init.server.luau"),
    path.join(lastSegment, "init.client.luau"),
    path.join(lastSegment, "init.lua"),
    path.join(lastSegment, "init.server.lua"),
    path.join(lastSegment, "init.client.lua")
  ];
  
  for (const f of possibleFiles) {
    const p = path.join(currentPath, f);
    if (!isPathInside(p, bestMount.absolutePath)) {
      return {
        ok: false,
        code: "PATH_TRAVERSAL_BLOCKED",
        error: `Resolved patch path escaped mount '${bestMount.id}'.`
      };
    }
    if (fs.existsSync(p)) {
      const changed = writeTextFileIfChanged(p, newSource, patchOptions);
      return {
        ok: true,
        filePath: p,
        changed
      };
    }
  }
  return {
    ok: false,
    error: `No matching file was found for '${targetSegments.join(".")}'.`
  };
}

module.exports = {
  META_SUFFIX,
  buildNodeFromDirectory,
  buildNodeFromFile,
  detectScriptFileType,
  DUPLICATE_MOUNT_ROOT_CODE,
  findDuplicateMountRootPathIssue,
  loadWorkspaceProjectCatalog: projectResolver.loadWorkspaceProjectCatalog,
  loadWorkspaceProjects: projectResolver.loadWorkspaceProjects,
  matchesAnyGlob,
  moveOrphanScriptMetaForFile,
  repairProjectOrphanScriptMetas,
  jsonToLuauTable,
  markdownToRichText,
  parseProjectFile: projectResolver.parseProjectFile,
  readLocalProjectState,
  readLocalProjectStateAsync,
  readWorkspaceConfig: projectResolver.readWorkspaceConfig,
  resolveProjectSelectionForPlace: projectResolver.resolveProjectSelectionForPlace,
  resolveProjectForPlace: projectResolver.resolveProjectForPlace,
  validateProjectSnapshotMounts,
  validateProjectTreeFiles,
  writeStudioProjectState,
  writeStudioProjectStateAsync,
  patchStudioFileSource
};

