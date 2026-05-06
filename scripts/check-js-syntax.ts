"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const ignoredDirs = new Set([".git", ".amarillo", "dist", "node_modules"]);
const jsFiles = [];

function walk(dirPath) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        walk(path.join(dirPath, entry.name));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      jsFiles.push(path.join(dirPath, entry.name));
    }
  }
}

walk(repoRoot);

for (const filePath of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || result.error?.message || `node --check failed for ${filePath}\n`);
    process.exit(result.status || 1);
  }
}

process.stdout.write(`[check-js-syntax] ${jsFiles.length} JavaScript files passed node --check\n`);
