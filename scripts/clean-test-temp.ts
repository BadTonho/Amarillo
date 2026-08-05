"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;
const SAFE_PREFIXES = [
  "amarillo-activity-",
  "amarillo-bootstrap-",
  "amarillo-daemon-",
  "amarillo-errors-",
  "amarillo-instructions-",
  "amarillo-mcp-audit-",
  "amarillo-mcp-config-",
  "amarillo-mcp-proxy-",
  "amarillo-profile-",
  "amarillo-sourcemap-",
  "amarillo-"
];

function isManagedTestTempDirectoryName(name) {
  return SAFE_PREFIXES.some((prefix) => {
    if (!name.startsWith(prefix)) {
      return false;
    }
    return TEMP_SUFFIX.test(name.slice(prefix.length));
  });
}

function removeDirectory(directoryPath) {
  fs.rmSync(directoryPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50
  });
}

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const tempRoot = path.resolve(os.tmpdir());
  const entries = fs.readdirSync(tempRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isManagedTestTempDirectoryName(entry.name))
    .map((entry) => path.resolve(tempRoot, entry.name))
    .filter((directoryPath) => path.dirname(directoryPath) === tempRoot);

  if (dryRun) {
    for (const directoryPath of candidates) {
      process.stdout.write(`[clean-test-temp] Would remove ${directoryPath}\n`);
    }
  } else {
    for (const directoryPath of candidates) {
      removeDirectory(directoryPath);
    }
  }

  process.stdout.write(
    `[clean-test-temp] ${dryRun ? "Found" : "Removed"} ${candidates.length} safe test temporary director${candidates.length === 1 ? "y" : "ies"} under ${tempRoot}.\n`
  );
  return candidates.length;
}

if (require.main === module) {
  main();
}

module.exports = {
  SAFE_PREFIXES,
  isManagedTestTempDirectoryName,
  main
};
