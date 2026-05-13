"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const projectResolver = require("./project-resolver");

const PROJECT_SUFFIX = ".project.json";
const META_SUFFIX = ".meta.json";

// ===== Lightweight glob matching (no external dependency) =====
function globToRegex(glob) {
  let regex = "";
  let i = 0;
  const len = glob.length;
  while (i < len) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** matches any path
        regex += ".*";
        i += 2;
        if (glob[i] === "/") { i++; } // skip trailing slash after **
        continue;
      }
      regex += "[^/]*";
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (ch === ".") {
      regex += "\\.";
    } else if (ch === "/") {
      regex += "/";
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
  const srcDir = path.join(workspaceRoot, "src");
  ensureDirectory(srcDir);
  
  const defaultProject = {
    name: "Default Project",
    placeIds: [],
    tree: {
      ServerScriptService: {
        $path: "src"
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

function normalizeResolvedPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function isPathInside(childPath, parentPath) {
  const child = normalizeResolvedPath(childPath);
  const parent = normalizeResolvedPath(parentPath).replace(/\/+$/, "");
  return child === parent || child.startsWith(`${parent}/`);
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
  return parseJsonFile(metaPath);
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
    properties: modelData.Properties || {},
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
    const properties = { ...(meta.properties || {}) };

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

    return {
      name: baseName,
      className,
      classNameSource: "file",
      fileKind: scriptType.fileKind,
      ext: scriptType.ext,
      source,
      properties,
      keepUnknowns: meta.keepUnknowns,
      children: []
    };
  }

  if (name.endsWith(".model.json")) {
    const baseName = explicitName || name.replace(/\.model\.json$/i, "");
    const model = parseJsonFile(filePath);
    const rootNode: any = buildNodeFromJsonModel(baseName, model);
    rootNode.sourceFile = "model.json";
    return rootNode;
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
        properties: meta.properties || {},
        keepUnknowns: meta.keepUnknowns,
        children: []
      };

  if (meta.className && !initEntry) {
    baseNode.className = meta.className;
    baseNode.classNameSource = "meta";
  }
  if (meta.properties) {
    baseNode.properties = {
      ...(baseNode.properties || {}),
      ...meta.properties
    };
  }
  if (meta.keepUnknowns !== undefined) {
    baseNode.keepUnknowns = meta.keepUnknowns;
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
  return {
    projectId: project.id,
    name: project.name,
    placeIds: project.placeIds,
    mounts: project.mounts.map((mount) => {
      const mountOptions = { ...options, mountRoot: mount.absolutePath };
      return {
        id: mount.id,
        segments: mount.segments.slice(),
        relativePath: mount.relativePath,
        absolutePath: mount.absolutePath,
        keepUnknowns: mount.keepUnknowns,
        children: listDirectoryEntries(mount.absolutePath)
          .filter((entry) => !entry.isFile() || !entry.name.endsWith(META_SUFFIX))
          .filter((entry) => {
            if (mountOptions.ignoreGlobs.length === 0) return true;
            return !matchesAnyGlob(entry.name, mountOptions.ignoreGlobs);
          })
          .flatMap((entry) => {
            const fullPath = path.join(mount.absolutePath, entry.name);
            if (entry.isDirectory()) {
              return [buildNodeFromDirectory(fullPath, mountOptions)];
            }
            if (entry.isFile()) {
              const node = buildNodeFromFile(fullPath, null, mountOptions);
              return node ? [node] : [];
            }
            return [];
          })
          .sort((left, right) => left.name.localeCompare(right.name))
      };
    })
  };
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
    const properties = { ...(meta.properties || {}) };

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

    return {
      name: baseName,
      className,
      classNameSource: "file",
      fileKind: scriptType.fileKind,
      ext: scriptType.ext,
      source,
      properties,
      keepUnknowns: meta.keepUnknowns,
      children: []
    };
  }
  // For non-script files, delegate to sync (they're small JSON/metadata)
  return buildNodeFromFile(filePath, explicitName, options);
}

async function buildNodeFromDirectoryAsync(dirPath, options: any = {}) {
  const entries = listDirectoryEntries(dirPath);
  const dirName = path.basename(dirPath);
  const metaPath = path.join(dirPath, `init${META_SUFFIX}`);
  const meta = readMetaFile(metaPath);
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
        properties: meta.properties || {},
        keepUnknowns: meta.keepUnknowns,
        children: []
      };

  if (meta.className && !initEntry) {
    baseNode.className = meta.className;
    baseNode.classNameSource = "meta";
  }
  if (meta.properties) {
    baseNode.properties = {
      ...(baseNode.properties || {}),
      ...meta.properties
    };
  }
  if (meta.keepUnknowns !== undefined) {
    baseNode.keepUnknowns = meta.keepUnknowns;
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
      if (entry.isDirectory()) {
        return buildNodeFromDirectoryAsync(fullPath, mountOptions);
      }
      if (entry.isFile()) {
        return buildNodeFromFileAsync(fullPath, null, mountOptions);
      }
      return null;
    });

    const children = (await Promise.all(childPromises))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));

    return {
      id: mount.id,
      segments: mount.segments.slice(),
      relativePath: mount.relativePath,
      absolutePath: mount.absolutePath,
      keepUnknowns: mount.keepUnknowns,
      children
    };
  });

  return {
    projectId: project.id,
    name: project.name,
    placeIds: project.placeIds,
    mounts: await Promise.all(mountPromises)
  };
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

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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
  const existed = fs.existsSync(filePath);
  if (existed) {
    const current = fs.readFileSync(filePath, "utf8");
    if (current === value) {
      return false;
    }
  }
  fs.writeFileSync(filePath, value, "utf8");
  notifyFileChange(options, {
    action: existed ? "modify" : "create",
    filePath,
    ...fileInfoForContent(value)
  });
  return true;
}

function collectExistingFileInfos(targetPath, results = []) {
  if (!fs.existsSync(targetPath)) {
    return results;
  }
  const stats = fs.statSync(targetPath);
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
  const removedFiles = collectExistingFileInfos(targetPath);
  if (removedFiles.length === 0 && !fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
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
  if (!properties || Object.keys(properties).length === 0) {
    return {};
  }
  const ignored = ignoredSyncbackProperties(options);
  if (ignored.size === 0) {
    return properties;
  }
  return Object.entries(properties).reduce((next, [key, value]) => {
    if (!ignored.has(key)) {
      next[key] = value;
    }
    return next;
  }, {});
}

function scriptExtensionForNode(node) {
  return node.ext || (
    node.fileKind === "server"
      ? ".server.luau"
      : node.fileKind === "client"
        ? ".client.luau"
        : ".luau"
  );
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
  const syncback = syncbackConfig(options);
  if ((syncback.ignoreNames || []).includes(node.name) || (syncback.ignoreClasses || []).includes(node.className)) {
    return true;
  }
  if (!parentDir) {
    return false;
  }
  if (node.fileKind && (!node.children || node.children.length === 0)) {
    const fileName = `${node.name}${scriptExtensionForNode(node)}`;
    return matchesSyncbackGlob(path.join(parentDir, fileName), fileName, options);
  }
  return matchesSyncbackGlob(path.join(parentDir, node.name), node.name, options);
}

function syncbackEntryBaseName(entryName) {
  return String(entryName)
    .replace(/\.meta\.json$/i, "")
    .replace(/(?:\.server|\.client)?\.(?:lua|luau)$/i, "");
}

function shouldPreserveSyncbackEntry(fullPath, entryName, options: any = {}) {
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
  if (node.className && node.className !== "Folder" && !node.fileKind) {
    meta.className = node.className;
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
  const extension = scriptExtensionForNode(node);
  const fileName = asInit ? `init${extension}` : `${node.name}${extension}`;
  writeTextFileIfChanged(path.join(parentDir, fileName), node.source || "", options);

  const meta = metaForScriptNode(node, options);
  if (Object.keys(meta).length > 0) {
    const metaName = asInit ? `init${META_SUFFIX}` : `${node.name}${META_SUFFIX}`;
    writeJsonFile(path.join(parentDir, metaName), meta, options);
  }
}

function writeFolderNode(parentDir, node, options: any = {}) {
  if (shouldIgnoreSyncbackNode(node, options, parentDir)) {
    return;
  }
  const nodeDir = path.join(parentDir, node.name);
  ensureDirectory(nodeDir);

  const meta = metaForNode(node, options);
  if (Object.keys(meta).length > 0) {
    writeJsonFile(path.join(nodeDir, `init${META_SUFFIX}`), meta, options);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
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
      const nodeDir = path.join(parentDir, node.name);
      ensureDirectory(nodeDir);
      writeScriptNode(nodeDir, node, true, options);
      for (const child of node.children) {
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
  const properties = filterSyncbackProperties(node.properties, options);
  if (node.className !== "Folder" || (properties && Object.keys(properties).length > 0) || node.keepUnknowns !== undefined) {
    expected.add(`init${META_SUFFIX}`);
  }
  for (const child of node.children || []) {
    if (shouldIgnoreSyncbackNode(child, options, parentDir)) {
      continue;
    }
    if (child.fileKind && (!child.children || child.children.length === 0)) {
      const ext = scriptExtensionForNode(child);
      expected.add(`${child.name}${ext}`);
      const childMeta = metaForScriptNode(child, options);
      if (Object.keys(childMeta).length > 0) {
        expected.add(`${child.name}${META_SUFFIX}`);
      }
    } else {
      expected.add(child.name);
    }
  }
  return expected;
}

function cleanupUnexpectedEntries(nodeDir, node, withInitScript = false, options: any = {}) {
  const expected = expectedEntriesForNode(node, withInitScript, options, nodeDir);
  for (const entry of listDirectoryEntries(nodeDir)) {
    const fullPath = path.join(nodeDir, entry.name);
    if (!expected.has(entry.name) && !shouldPreserveSyncbackEntry(fullPath, entry.name, options)) {
      removePath(fullPath, options);
    }
  }
}

function writeMountSnapshot(mount, children, options: any = {}) {
  const mountOptions = {
    ...options,
    mount
  };
  ensureDirectory(mount.absolutePath);
  for (const child of children) {
    if (shouldIgnoreSyncbackNode(child, mountOptions, mount.absolutePath)) {
      continue;
    }
    writeNode(mount.absolutePath, child, mountOptions);
  }

  const expected = new Set();
  for (const child of children) {
    if (shouldIgnoreSyncbackNode(child, mountOptions, mount.absolutePath)) {
      continue;
    }
    if (child.fileKind && (!child.children || child.children.length === 0)) {
      const ext = scriptExtensionForNode(child);
      expected.add(`${child.name}${ext}`);
      const meta = metaForScriptNode(child, mountOptions);
      if (Object.keys(meta).length > 0) {
        expected.add(`${child.name}${META_SUFFIX}`);
      }
    } else {
      expected.add(child.name);
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
  for (const mountSnapshot of snapshot.mounts || []) {
    const mount = mountMap.get(mountSnapshot.id);
    if (!mount) {
      continue;
    }
    writeMountSnapshot(mount, mountSnapshot.children || [], writeOptions);
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

function normalizeInstancePathSegments(instancePath) {
  if (Array.isArray(instancePath)) {
    return instancePath.filter((segment) => typeof segment === "string" && segment.length > 0);
  }
  if (typeof instancePath !== "string") {
    return [];
  }
  return instancePath
    .split(".")
    .filter((segment) => segment.length > 0 && segment !== "game" && segment !== "DataModel");
}

function patchStudioFileSource(project, instancePath, newSource, options: any = {}) {
  const targetSegments = normalizeInstancePathSegments(instancePath);
  if (targetSegments.length === 0) {
    return {
      ok: false,
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
  
  if (remainingSegments.length === 0) {
    const initFiles = ["init.luau", "init.server.luau", "init.client.luau", "init.lua", "init.server.lua", "init.client.lua"];
    for (const f of initFiles) {
      const p = path.join(currentPath, f);
      if (fs.existsSync(p)) {
        const changed = writeTextFileIfChanged(p, newSource, options);
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
    if (fs.existsSync(p)) {
      const changed = writeTextFileIfChanged(p, newSource, options);
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
  writeStudioProjectState,
  patchStudioFileSource
};

