"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SOURCEMAP_FILE_NAME = "sourcemap.json";
const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_SETTINGS = {
  "luau-lsp.sourcemap.enabled": true,
  "luau-lsp.sourcemap.autogenerate": true,
  "luau-lsp.sourcemap.includeNonScripts": true,
  "luau-lsp.sourcemap.sourcemapFile": SOURCEMAP_FILE_NAME
};

function normalizeRelative(filePath, workspaceRoot) {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveSourcemapProjectFile(workspaceRoot, projectFiles, preferredProjectFilePath = null) {
  const normalizedFiles = (projectFiles || [])
    .map((projectFilePath) => path.resolve(projectFilePath))
    .filter((projectFilePath, index, values) => values.indexOf(projectFilePath) === index);

  if (preferredProjectFilePath) {
    const preferredResolved = path.resolve(preferredProjectFilePath);
    if (normalizedFiles.includes(preferredResolved)) {
      return preferredResolved;
    }
  }

  if (normalizedFiles.length === 0) {
    return null;
  }

  const workspaceNameProject = path.resolve(workspaceRoot, `${path.basename(path.resolve(workspaceRoot))}.project.json`);
  if (normalizedFiles.includes(workspaceNameProject)) {
    return workspaceNameProject;
  }

  const defaultProject = path.resolve(workspaceRoot, "default.project.json");
  if (normalizedFiles.includes(defaultProject)) {
    return defaultProject;
  }

  const rootLevelProject = normalizedFiles
    .filter((projectFilePath) => path.dirname(projectFilePath) === path.resolve(workspaceRoot))
    .sort((left, right) => left.localeCompare(right))[0];
  if (rootLevelProject) {
    return rootLevelProject;
  }

  return normalizedFiles.sort((left, right) => left.localeCompare(right))[0];
}

function sourcemapNeedsGeneration(sourcemapPath) {
  if (!fs.existsSync(sourcemapPath)) {
    return true;
  }

  try {
    const parsed = readJsonFile(sourcemapPath);
    return !parsed || typeof parsed !== "object";
  } catch (_error) {
    return true;
  }
}

async function ensureLuauSourcemapSettings(workspaceRoot, projectFilePath) {
  const vscodeDir = path.join(workspaceRoot, ".vscode");
  const settingsPath = path.join(vscodeDir, "settings.json");
  const resolvedProjectFilePath = path.resolve(projectFilePath);
  const nextSettings = {
    ...DEFAULT_SETTINGS,
    "luau-lsp.sourcemap.rojoProjectFile": normalizeRelative(resolvedProjectFilePath, workspaceRoot)
  };

  let currentSettings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      currentSettings = readJsonFile(settingsPath);
    } catch (error) {
      return {
        updated: false,
        settingsPath,
        error: `Could not update ${settingsPath}: ${error.message}`,
        projectChanged: false
      };
    }
  }

  const currentProjectSetting = typeof currentSettings["luau-lsp.sourcemap.rojoProjectFile"] === "string"
    ? path.resolve(workspaceRoot, currentSettings["luau-lsp.sourcemap.rojoProjectFile"])
    : null;
  const projectChanged = currentProjectSetting !== null && currentProjectSetting !== resolvedProjectFilePath;

  const mergedSettings = {
    ...currentSettings,
    ...nextSettings
  };

  const changed = JSON.stringify(currentSettings) !== JSON.stringify(mergedSettings);
  if (!changed) {
    return {
      updated: false,
      settingsPath,
      error: null,
      projectChanged
    };
  }

  await fsp.mkdir(vscodeDir, { recursive: true });
  await fsp.writeFile(settingsPath, `${JSON.stringify(mergedSettings, null, 2)}\n`, "utf8");
  return {
    updated: true,
    settingsPath,
    error: null,
    projectChanged
  };
}

function buildRojoSourcemapArgs(workspaceRoot, projectFilePath, sourcemapPath) {
  return [
    "sourcemap",
    "--include-non-scripts",
    normalizeRelative(projectFilePath, workspaceRoot),
    "--output",
    normalizeRelative(sourcemapPath, workspaceRoot)
  ];
}

function appendLimitedOutput(current, chunk, maxBytes) {
  const currentBytes = Buffer.byteLength(current, "utf8");
  const remainingBytes = maxBytes - currentBytes;
  if (remainingBytes <= 0) {
    return { value: current, truncated: true };
  }
  const chunkBuffer = Buffer.from(String(chunk), "utf8");
  if (chunkBuffer.length <= remainingBytes) {
    return { value: current + chunkBuffer.toString("utf8"), truncated: false };
  }
  return {
    value: current + chunkBuffer.subarray(0, remainingBytes).toString("utf8"),
    truncated: true
  };
}

interface ProcessError extends Error {
  code?: number | string | null;
}

function defaultRunCommand(command, args, options: any = {}) {
  return new Promise((resolve, reject) => {
    const maxOutputBytes = Number(options.maxOutputBytes) > 0
      ? Number(options.maxOutputBytes)
      : DEFAULT_MAX_PROCESS_OUTPUT_BYTES;
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    child.stdout.on("data", (chunk) => {
      const result = appendLimitedOutput(stdout, chunk, maxOutputBytes);
      stdout = result.value;
      outputTruncated ||= result.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const result = appendLimitedOutput(stderr, chunk, maxOutputBytes);
      stderr = result.value;
      outputTruncated ||= result.truncated;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
          outputTruncated
        });
        return;
      }
      const runError = new Error(stderr.trim() || stdout.trim() || `Command exited with code ${code}`) as ProcessError;
      runError.code = code;
      reject(runError);
    });
  });
}

function rojoCommandCandidates(userProfile = process.env.USERPROFILE || "") {
  const candidates = ["rojo"];
  if (userProfile) {
    candidates.push(path.join(userProfile, ".aftman", "bin", "rojo.exe"));
    candidates.push(path.join(userProfile, ".aftman", "bin", "rojo"));
  }
  return candidates.filter((value, index, values) => values.indexOf(value) === index);
}

async function generateSourcemap(workspaceRoot, projectFilePath, sourcemapPath, options: any = {}) {
  const runCommand = options.runCommand || defaultRunCommand;
  const candidates = options.commandCandidates || rojoCommandCandidates(options.userProfile);
  const args = buildRojoSourcemapArgs(workspaceRoot, projectFilePath, sourcemapPath);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      await runCommand(candidate, args, { cwd: workspaceRoot });
      return {
        generated: true,
        command: candidate,
        args
      };
    } catch (error) {
      lastError = error;
      // If the candidate executable is missing (ENOENT/UNKNOWN), try the next candidate.
      if (error && ((error as ProcessError).code === "ENOENT" || (error as ProcessError).code === "UNKNOWN")) {
        // noop
      }
    }
  }

  throw lastError || new Error("Rojo was not found to generate the sourcemap.");
}

async function ensureWorkspaceSourcemap(workspaceRoot, options: any = {}) {
  const projectFilePath = resolveSourcemapProjectFile(
    workspaceRoot,
    options.projectFiles || [],
    options.projectFilePath || null
  );

  if (!projectFilePath) {
    return {
      projectFilePath: null,
      sourcemapPath: path.join(workspaceRoot, SOURCEMAP_FILE_NAME),
      settingsUpdated: false,
      sourcemapGenerated: false,
      settingsError: null
    };
  }

  const sourcemapPath = path.join(workspaceRoot, SOURCEMAP_FILE_NAME);
  const settingsResult = await ensureLuauSourcemapSettings(workspaceRoot, projectFilePath);

  let sourcemapGenerated = false;
  if (sourcemapNeedsGeneration(sourcemapPath) || settingsResult.projectChanged || options.forceGenerate === true) {
    const generationResult = await generateSourcemap(workspaceRoot, projectFilePath, sourcemapPath, options);
    sourcemapGenerated = generationResult.generated === true;
  }

  return {
    projectFilePath,
    sourcemapPath,
    settingsUpdated: settingsResult.updated,
    sourcemapGenerated,
    settingsError: settingsResult.error,
    projectChanged: settingsResult.projectChanged
  };
}

module.exports = {
  SOURCEMAP_FILE_NAME,
  buildRojoSourcemapArgs,
  ensureLuauSourcemapSettings,
  ensureWorkspaceSourcemap,
  generateSourcemap,
  resolveSourcemapProjectFile,
  rojoCommandCandidates,
  sourcemapNeedsGeneration
};


