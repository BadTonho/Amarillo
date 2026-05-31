"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([".git", ".amarillo", "dist", "node_modules"]);
const generatedJavaScriptRoots = [
  path.join(repoRoot, "scripts"),
  path.join(repoRoot, "tests"),
  path.join(repoRoot, "src", "daemon"),
  path.join(repoRoot, "src", "mcp-proxy"),
  path.join(repoRoot, "vscode-extension")
];

function isInside(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  return child === parent || child.startsWith(parent + path.sep);
}

function isGeneratedJavaScriptRoot(filePath) {
  return generatedJavaScriptRoots.some((rootPath) => isInside(filePath, rootPath));
}

function sourcePathForGeneratedJavaScript(filePath) {
  const resolved = path.resolve(filePath);
  if (path.extname(resolved) !== ".js") {
    return null;
  }
  const extensionRoot = path.join(repoRoot, "vscode-extension");
  if (isInside(resolved, extensionRoot)) {
    const relativeSourcePath = path.relative(extensionRoot, resolved).slice(0, -3) + ".ts";
    return path.join(repoRoot, "vscode-extension-src", relativeSourcePath);
  }
  if (!isGeneratedJavaScriptRoot(resolved)) {
    return null;
  }
  return resolved.slice(0, -3) + ".ts";
}

function classifySourceFile(filePath) {
  const resolved = path.resolve(filePath);
  const extension = path.extname(resolved);
  if (extension === ".ts") {
    return "typescript-source";
  }
  if (extension !== ".js") {
    return "other";
  }
  const sourcePath = sourcePathForGeneratedJavaScript(resolved);
  if (sourcePath && fs.existsSync(sourcePath)) {
    return "generated-javascript";
  }
  if (isGeneratedJavaScriptRoot(resolved)) {
    return "generated-javascript-missing-source";
  }
  return "javascript-source";
}

function walkFiles(rootPath, results = []) {
  if (!fs.existsSync(rootPath)) {
    return results;
  }
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        walkFiles(path.join(rootPath, entry.name), results);
      }
      continue;
    }
    if (entry.isFile()) {
      results.push(path.join(rootPath, entry.name));
    }
  }
  return results;
}

function summarizeSources(rootPath = repoRoot) {
  const summary = {
    typescriptSource: [],
    generatedJavaScript: [],
    generatedJavaScriptMissingSource: [],
    javascriptSource: []
  };
  for (const filePath of walkFiles(rootPath)) {
    const kind = classifySourceFile(filePath);
    if (kind === "typescript-source") {
      summary.typescriptSource.push(filePath);
    } else if (kind === "generated-javascript") {
      summary.generatedJavaScript.push(filePath);
    } else if (kind === "generated-javascript-missing-source") {
      summary.generatedJavaScriptMissingSource.push(filePath);
    } else if (kind === "javascript-source") {
      summary.javascriptSource.push(filePath);
    }
  }
  return summary;
}

module.exports = {
  repoRoot,
  generatedJavaScriptRoots,
  sourcePathForGeneratedJavaScript,
  classifySourceFile,
  summarizeSources
};
