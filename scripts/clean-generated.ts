"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const generatedRoots = [
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

function collectJavaScriptFiles(rootPath, results = []) {
  if (!fs.existsSync(rootPath)) {
    return results;
  }
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      collectJavaScriptFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(fullPath);
    }
  }
  return results;
}

function main() {
  const files = generatedRoots.flatMap((rootPath) => collectJavaScriptFiles(rootPath));
  for (const filePath of files) {
    const allowed = generatedRoots.some((rootPath) => isInside(filePath, rootPath));
    if (!allowed) {
      throw new Error(`Refusing to remove outside generated roots: ${filePath}`);
    }
  }
  for (const filePath of files) {
    fs.rmSync(filePath, { force: true });
  }
  process.stdout.write(`[clean-generated] Removed ${files.length} generated JavaScript file(s).\n`);
}

main();
