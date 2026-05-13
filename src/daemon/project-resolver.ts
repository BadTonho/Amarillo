"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isIgnoredProjectDiscoveryDirectoryName } = require("./project-discovery");

const PROJECT_SUFFIX = ".project.json";

function normalizeSlashes(value) {
  return String(value).replace(/\\/g, "/");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function errorMessage(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
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
  const issues = [];
  let argon = {};
  let plugin = {};

  if (fs.existsSync(argonPath)) {
    try {
      argon = parseSimpleToml(argonPath);
    } catch (error) {
      issues.push(createConfigIssue(
        "ARGON_CONFIG_INVALID",
        argonPath,
        workspaceRoot,
        `argon.toml could not be read: ${errorMessage(error)}.`,
        { error: errorMessage(error) }
      ));
    }
  }

  if (fs.existsSync(pluginPath)) {
    try {
      const parsed = parseJsonFile(pluginPath);
      if (isPlainObject(parsed)) {
        plugin = parsed;
      } else {
        issues.push(createConfigIssue(
          "PLUGIN_CONFIG_INVALID",
          pluginPath,
          workspaceRoot,
          ".pluginroblox.json must contain a JSON object.",
          { error: "Expected a JSON object." }
        ));
      }
    } catch (error) {
      issues.push(createConfigIssue(
        "PLUGIN_CONFIG_INVALID",
        pluginPath,
        workspaceRoot,
        `.pluginroblox.json is invalid and was ignored: ${errorMessage(error)}.`,
        { error: errorMessage(error) }
      ));
    }
  }

  return {
    argon,
    plugin,
    issues
  };
}

function createConfigIssue(code, filePath, workspaceRoot, message, details: any = {}) {
  const absoluteFilePath = path.resolve(filePath);
  const relativeFilePath = normalizeRelativeWorkspacePath(workspaceRoot, absoluteFilePath);
  return {
    key: `${code}:workspace:${relativeFilePath}`,
    code,
    projectId: null,
    projectPath: null,
    filePath: absoluteFilePath,
    message,
    ...details
  };
}

function collectProjectFiles(rootDir, results = []) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredProjectDiscoveryDirectoryName(entry.name)) {
        continue;
      }
      collectProjectFiles(fullPath, results);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(PROJECT_SUFFIX)) {
      results.push(fullPath);
    }
  }
  return results;
}

function cloneJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item));
  }
  if (isPlainObject(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = cloneJson(item);
    }
    return output;
  }
  return value;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function projectIdFromPath(projectPath, workspaceRoot) {
  return path.relative(workspaceRoot, projectPath).replace(/\\/g, "/");
}

function normalizeRelativeWorkspacePath(workspaceRoot, absolutePath) {
  return normalizeSlashes(path.relative(workspaceRoot, absolutePath));
}

function normalizeTreePaths(node, projectDir, workspaceRoot) {
  if (!isPlainObject(node)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$path" && typeof value === "string") {
      const absolutePath = path.resolve(projectDir, value);
      normalized[key] = normalizeRelativeWorkspacePath(workspaceRoot, absolutePath);
      continue;
    }

    if (!key.startsWith("$") && isPlainObject(value)) {
      normalized[key] = normalizeTreePaths(value, projectDir, workspaceRoot);
      continue;
    }

    normalized[key] = cloneJson(value);
  }
  return normalized;
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

function mergeTreeNodes(parentNode, childNode) {
  const merged = cloneJson(isPlainObject(parentNode) ? parentNode : {});
  for (const [key, value] of Object.entries(isPlainObject(childNode) ? childNode : {})) {
    if (key.startsWith("$")) {
      merged[key] = cloneJson(value);
      continue;
    }

    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeTreeNodes(merged[key], value);
      continue;
    }

    merged[key] = cloneJson(value);
  }
  return merged;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];
}

function extractPlaceIds(raw) {
  const explicit = hasOwn(raw, "placeIds")
    || hasOwn(raw, "place_ids")
    || hasOwn(raw, "servePlaceIds")
    || hasOwn(raw, "placeId");
  if (!explicit) {
    return {
      explicit: false,
      value: []
    };
  }

  let values = [];
  if (Array.isArray(raw.placeIds)) {
    values = raw.placeIds;
  } else if (Array.isArray(raw.place_ids)) {
    values = raw.place_ids;
  } else if (Array.isArray(raw.servePlaceIds)) {
    values = raw.servePlaceIds;
  } else if (Number.isInteger(raw.placeId)) {
    values = [raw.placeId];
  }

  return {
    explicit: true,
    value: values
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry))
  };
}

function normalizeSyncback(rawSyncback) {
  return {
    ignoreGlobs: normalizeStringArray(rawSyncback?.ignoreGlobs),
    ignoreNames: normalizeStringArray(rawSyncback?.ignoreNames),
    ignoreClasses: normalizeStringArray(rawSyncback?.ignoreClasses),
    ignoreProperties: normalizeStringArray(rawSyncback?.ignoreProperties)
  };
}

function concatSyncback(parentSyncback, childSyncback) {
  return {
    ignoreGlobs: [...(parentSyncback?.ignoreGlobs || []), ...(childSyncback?.ignoreGlobs || [])],
    ignoreNames: [...(parentSyncback?.ignoreNames || []), ...(childSyncback?.ignoreNames || [])],
    ignoreClasses: [...(parentSyncback?.ignoreClasses || []), ...(childSyncback?.ignoreClasses || [])],
    ignoreProperties: [...(parentSyncback?.ignoreProperties || []), ...(childSyncback?.ignoreProperties || [])]
  };
}

function createProjectDescriptor(projectPath, workspaceRoot) {
  const raw = parseJsonFile(projectPath);
  if (!isPlainObject(raw)) {
    throw new Error("Project file must contain a JSON object.");
  }
  const projectDir = path.dirname(projectPath);
  const extendsValue = typeof raw.extends === "string" && raw.extends.trim()
    ? raw.extends.trim()
    : null;
  const placeIds = extractPlaceIds(raw);
  const legacyScriptsExplicit = hasOwn(raw, "legacyScripts") || hasOwn(raw, "emitLegacyScripts");

  return {
    id: projectIdFromPath(projectPath, workspaceRoot),
    projectPath: path.resolve(projectPath),
    projectDir,
    workspaceRoot,
    raw,
    rawName: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
    hasName: typeof raw.name === "string" && raw.name.trim().length > 0,
    nameFallback: path.basename(projectPath, PROJECT_SUFFIX),
    enabled: raw.enabled !== false,
    abstract: raw.abstract === true,
    extendsRaw: extendsValue,
    extendsAbsolutePath: extendsValue ? path.resolve(projectDir, extendsValue) : null,
    tree: normalizeTreePaths(raw.tree || {}, projectDir, workspaceRoot),
    placeIds,
    ignoreGlobs: normalizeStringArray(raw.ignoreGlobs || raw.globIgnorePaths),
    syncRules: Array.isArray(raw.syncRules) ? cloneJson(raw.syncRules) : [],
    syncback: normalizeSyncback(raw.syncback),
    legacyScriptsExplicit,
    legacyScripts: legacyScriptsExplicit
      ? Boolean(raw.legacyScripts ?? raw.emitLegacyScripts)
      : null,
    resolutionState: "pending",
    resolvedProject: null
  };
}

function createIssue(code, descriptor, message, details: any = {}) {
  return {
    key: `${code}:${descriptor ? descriptor.id : "workspace"}:${details.baseProjectId || details.cycle || ""}`,
    code,
    projectId: descriptor ? descriptor.id : null,
    projectPath: descriptor ? descriptor.id : null,
    message,
    ...details
  };
}

function createProjectFileIssue(code, projectPath, workspaceRoot, message, details: any = {}) {
  const absoluteProjectPath = path.resolve(projectPath);
  const projectId = projectIdFromPath(absoluteProjectPath, workspaceRoot);
  return {
    key: `${code}:${projectId}`,
    code,
    projectId,
    projectPath: projectId,
    filePath: absoluteProjectPath,
    message,
    ...details
  };
}

function buildResolvedProject(descriptor, parentProject, workspaceRoot) {
  const mergedTree = mergeTreeNodes(parentProject?.tree || {}, descriptor.tree || {});
  const mounts = collectMounts(mergedTree);

  return {
    id: descriptor.id,
    name: descriptor.hasName ? descriptor.rawName : (parentProject?.name || descriptor.nameFallback),
    projectPath: descriptor.projectPath,
    projectDir: descriptor.projectDir,
    enabled: descriptor.enabled,
    abstract: descriptor.abstract,
    extendsProjectId: parentProject ? parentProject.id : null,
    extendsProjectPath: parentProject ? parentProject.id : null,
    inheritanceIds: parentProject
      ? parentProject.inheritanceIds.concat(parentProject.id)
      : [],
    tree: mergedTree,
    placeIds: descriptor.placeIds.explicit
      ? descriptor.placeIds.value.slice()
      : (parentProject?.placeIds.slice() || []),
    mounts: mounts.map((mount) => ({
      ...mount,
      absolutePath: path.resolve(workspaceRoot, mount.relativePath)
    })),
    legacyScripts: descriptor.legacyScriptsExplicit
      ? descriptor.legacyScripts
      : (parentProject?.legacyScripts ?? true),
    ignoreGlobs: [...(parentProject?.ignoreGlobs || []), ...descriptor.ignoreGlobs],
    syncback: concatSyncback(parentProject?.syncback, descriptor.syncback),
    syncRules: [...(parentProject?.syncRules || []), ...descriptor.syncRules],
    raw: cloneJson(descriptor.raw)
  };
}

function loadWorkspaceProjectCatalog(workspaceRoot) {
  const issues = [];
  const issueKeys = new Set();

  function addIssue(issue) {
    if (!issue || issueKeys.has(issue.key)) {
      return;
    }
    issueKeys.add(issue.key);
    issues.push(issue);
  }

  let projectFiles = collectProjectFiles(workspaceRoot);
  if (projectFiles.length === 0) {
    createDefaultProject(workspaceRoot);
    projectFiles = collectProjectFiles(workspaceRoot);
  }

  const descriptors = [];
  for (const projectPath of projectFiles) {
    try {
      descriptors.push(createProjectDescriptor(projectPath, workspaceRoot));
    } catch (error) {
      const projectId = projectIdFromPath(path.resolve(projectPath), workspaceRoot);
      addIssue(createProjectFileIssue(
        "PROJECT_JSON_INVALID",
        projectPath,
        workspaceRoot,
        `Project '${projectId}' is invalid and was ignored: ${errorMessage(error)}.`,
        { error: errorMessage(error) }
      ));
    }
  }
  descriptors.sort((left, right) => left.id.localeCompare(right.id));
  const descriptorByPath = new Map(descriptors.map((descriptor) => [descriptor.projectPath, descriptor]));

  function markCycle(cycleDescriptors) {
    const cycleIds = cycleDescriptors.map((descriptor) => descriptor.id);
    const cycleLabel = cycleIds.concat(cycleIds[0]).join(" -> ");
    for (const cycleDescriptor of cycleDescriptors) {
      cycleDescriptor.resolutionState = "invalid";
      cycleDescriptor.resolvedProject = null;
    }
    addIssue(createIssue(
      "PROJECT_EXTENDS_CYCLE",
      cycleDescriptors[0],
      `Project '${cycleDescriptors[0].id}' has an inheritance cycle: ${cycleLabel}.`,
      { cycle: cycleLabel }
    ));
  }

  function resolveDescriptor(descriptor, stack = []) {
    if (descriptor.resolutionState === "resolved") {
      return descriptor.resolvedProject;
    }
    if (descriptor.resolutionState === "invalid") {
      return null;
    }
    if (descriptor.resolutionState === "resolving") {
      const cycleStart = stack.findIndex((entry) => entry.projectPath === descriptor.projectPath);
      const cycleDescriptors = (cycleStart >= 0 ? stack.slice(cycleStart) : stack).concat(descriptor);
      markCycle(cycleDescriptors);
      return null;
    }

    descriptor.resolutionState = "resolving";

    let parentProject = null;
    if (descriptor.extendsAbsolutePath) {
      const parentDescriptor = descriptorByPath.get(descriptor.extendsAbsolutePath);
      if (!parentDescriptor) {
        descriptor.resolutionState = "invalid";
        addIssue(createIssue(
          "PROJECT_EXTENDS_NOT_FOUND",
          descriptor,
          `Project '${descriptor.id}' references a missing base at '${normalizeSlashes(descriptor.extendsRaw)}'.`,
          { extendsProjectPath: normalizeSlashes(descriptor.extendsRaw) }
        ));
        return null;
      }

      parentProject = resolveDescriptor(parentDescriptor, stack.concat(descriptor));
      if (!parentProject) {
        descriptor.resolutionState = "invalid";
        addIssue(createIssue(
          "PROJECT_EXTENDS_INVALID",
          descriptor,
          `Project '${descriptor.id}' depends on an invalid base: '${parentDescriptor.id}'.`,
          { baseProjectId: parentDescriptor.id }
        ));
        return null;
      }
    }

    descriptor.resolvedProject = buildResolvedProject(descriptor, parentProject, workspaceRoot);
    descriptor.resolutionState = "resolved";
    return descriptor.resolvedProject;
  }

  const allProjects = descriptors
    .map((descriptor) => resolveDescriptor(descriptor))
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));

  const selectableProjects = allProjects
    .filter((project) => project.enabled !== false && project.abstract !== true)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    projectFiles: projectFiles.map((projectPath) => path.resolve(projectPath)),
    allProjects,
    selectableProjects,
    issues
  };
}

function loadWorkspaceProjects(workspaceRoot) {
  return loadWorkspaceProjectCatalog(workspaceRoot).selectableProjects;
}

function parseProjectFile(projectPath, workspaceRoot) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const catalog = loadWorkspaceProjectCatalog(resolvedWorkspaceRoot);
  const targetId = projectIdFromPath(path.resolve(projectPath), resolvedWorkspaceRoot);
  const project = catalog.allProjects.find((entry) => entry.id === targetId) || null;
  if (!project) {
    throw new Error(`Project '${targetId}' could not be resolved in the workspace.`);
  }
  return project;
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
  const selectableProjects = (projects || [])
    .filter((project) => project && project.enabled !== false && project.abstract !== true)
    .sort((left, right) => left.id.localeCompare(right.id));

  const numericPlaceId = Number(placeId || 0);
  const exactMatch = selectableProjects.find((project) => project.placeIds.includes(numericPlaceId));
  if (exactMatch) {
    return {
      project: exactMatch,
      reason: "place_match",
      message: buildProjectSelectionMessage("place_match", exactMatch, numericPlaceId)
    };
  }

  if (configuredDefaultId) {
    const configuredProject = selectableProjects.find((project) => project.id === configuredDefaultId);
    if (configuredProject) {
      return {
        project: configuredProject,
        reason: "configured_default",
        message: buildProjectSelectionMessage("configured_default", configuredProject, numericPlaceId)
      };
    }
  }

  const noPlaceFilter = selectableProjects.find((project) => project.placeIds.length === 0);
  if (noPlaceFilter) {
    return {
      project: noPlaceFilter,
      reason: "no_place_filter",
      message: buildProjectSelectionMessage("no_place_filter", noPlaceFilter, numericPlaceId)
    };
  }

  const firstProject = selectableProjects[0] || null;
  return {
    project: firstProject,
    reason: firstProject ? "first_available" : "not_found",
    message: buildProjectSelectionMessage(firstProject ? "first_available" : "not_found", firstProject || { name: "-" }, numericPlaceId)
  };
}

function resolveProjectForPlace(projects, placeId, configuredDefaultId = null) {
  return resolveProjectSelectionForPlace(projects, placeId, configuredDefaultId).project;
}

module.exports = {
  collectProjectFiles,
  loadWorkspaceProjectCatalog,
  loadWorkspaceProjects,
  parseProjectFile,
  readWorkspaceConfig,
  resolveProjectForPlace,
  resolveProjectSelectionForPlace
};

