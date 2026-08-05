"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const extensionSource = path.join(repoRoot, "vscode-extension");
const outputDir = path.join(repoRoot, "dist");
const stagingRoot = path.join(outputDir, "amarillo-vsix");
const stagingExtension = path.join(stagingRoot, "extension");
const runtimeDaemon = path.join(stagingExtension, "runtime", "daemon");
const runtimeMcpProxy = path.join(stagingExtension, "runtime", "mcp-proxy");
const runtimePlugin = path.join(stagingExtension, "runtime", "plugin");
const mediaDir = path.join(stagingExtension, "media");
const mcpDir = path.join(stagingExtension, "mcp");
const schemasDir = path.join(stagingExtension, "schemas");
const codexPluginDir = path.join(stagingExtension, ".codex-plugin");
const extensionFiles = [
  "package.json",
  "extension.js",
  "api-types.js",
  "bridge-state.js",
  "codex-mcp.js",
  "mcp-config.js",
  "project-bootstrap.js",
  "project-discovery.js",
  "sidebar.js",
  "sidebar-activity.js",
  "sidebar-render.js",
  "sidebar-state.js",
  "sidebar-styles.js",
  "sourcemap.js"
];

function ensurePathExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found at: ${targetPath}`);
  }
}

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(sourcePath, targetPath) {
  mkdirp(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

function copyDirectory(sourcePath, targetPath) {
  mkdirp(targetPath);
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
}

function copyRuntimeDirectory(sourcePath, targetPath, allowedExtensions = new Set([".js"])) {
  mkdirp(targetPath);
  for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const targetEntry = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      copyRuntimeDirectory(sourceEntry, targetEntry, allowedExtensions);
      continue;
    }
    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) {
      copyFile(sourceEntry, targetEntry);
    }
  }
}

function collectFiles(dirPath, results = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, results);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function assertPortablePackage(stagedExtensionPath) {
  const forbiddenPatterns = [
    /\b[A-Za-z]:[\\/]Users[\\/]/i,
    /[\\/]Users[\\/][^\\/]+[\\/]\.vscode[\\/]extensions[\\/]/i,
    /[\\/]Users[\\/][^\\/]+[\\/]\.antigravity[\\/]extensions[\\/]/i,
    /rbx-studio-mcp\.exe/i
  ];
  const files = collectFiles(stagedExtensionPath);

  for (const filePath of files) {
    if (filePath.startsWith(runtimeDaemon) && path.extname(filePath) === ".ts") {
      throw new Error(`VSIX runtime must not include TypeScript source: ${path.relative(stagedExtensionPath, filePath)}`);
    }

    const content = fs.readFileSync(filePath, "utf8");
    const matchedPattern = forbiddenPatterns.find((pattern) => pattern.test(content));
    if (matchedPattern) {
      throw new Error(`Local machine reference found in VSIX payload: ${path.relative(stagedExtensionPath, filePath)} (${matchedPattern})`);
    }
  }
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function writeVsixArchive(sourcePaths, zipPath, vsixPath) {
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath, { force: true });
  }
  if (fs.existsSync(vsixPath)) {
    fs.rmSync(vsixPath, { force: true });
  }
  const sourceList = sourcePaths.map(psQuote).join(", ");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$archive = [System.IO.Compression.ZipFile]::Open(${psQuote(zipPath)}, [System.IO.Compression.ZipArchiveMode]::Create)`,
    "try {",
    `  foreach ($sourcePath in @(${sourceList})) {`,
    "    $resolvedSource = [System.IO.Path]::GetFullPath($sourcePath)",
    "    if ([System.IO.Directory]::Exists($resolvedSource)) {",
    "      $rootName = [System.IO.Path]::GetFileName($resolvedSource.TrimEnd('\\'))",
    "      Get-ChildItem -LiteralPath $resolvedSource -File -Recurse | ForEach-Object {",
    "        $relativePath = $_.FullName.Substring($resolvedSource.Length).TrimStart('\\', '/')",
    "        $entryName = ($rootName + '/' + $relativePath).Replace('\\', '/')",
    "        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null",
    "      }",
    "    } else {",
    "      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $resolvedSource, [System.IO.Path]::GetFileName($resolvedSource), [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null",
    "    }",
    "  }",
    "} finally {",
    "  $archive.Dispose()",
    "}",
    `Move-Item -LiteralPath ${psQuote(zipPath)} -Destination ${psQuote(vsixPath)} -Force`
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || result.error?.message || "Failed to create VSIX archive.");
  }
}

function main() {
  ensurePathExists(extensionSource, "VS Code extension");
  const pluginSourcePath = path.join(repoRoot, "src", "plugin", "Amarillo.lua");
  ensurePathExists(pluginSourcePath, "Generated Roblox Studio plugin");
  const pluginSource = fs.readFileSync(pluginSourcePath, "utf8");
  if (!pluginSource.includes("generated by scripts/build-plugin.ts")) {
    throw new Error("Generated Roblox Studio plugin is missing the build-plugin banner. Run npm run build:plugin.");
  }

  mkdirp(outputDir);
  if (fs.existsSync(stagingRoot)) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }

  for (const dirPath of [stagingExtension, runtimeDaemon, runtimeMcpProxy, runtimePlugin, mediaDir, mcpDir, schemasDir, codexPluginDir]) {
    mkdirp(dirPath);
  }

  for (const fileName of extensionFiles) {
    copyFile(path.join(extensionSource, fileName), path.join(stagingExtension, fileName));
  }
  copyFile(path.join(extensionSource, "README.md"), path.join(stagingExtension, "readme.md"));
  copyFile(path.join(extensionSource, "CHANGELOG.md"), path.join(stagingExtension, "changelog.md"));
  copyFile(path.join(extensionSource, ".mcp.json"), path.join(stagingExtension, ".mcp.json"));
  copyFile(path.join(extensionSource, ".codex-plugin", "plugin.json"), path.join(codexPluginDir, "plugin.json"));
  copyFile(path.join(repoRoot, "amarillo-version.json"), path.join(stagingExtension, "amarillo-version.json"));
  copyFile(path.join(extensionSource, "media", "amarillo.svg"), path.join(mediaDir, "amarillo.svg"));
  copyFile(path.join(extensionSource, "media", "icon.png"), path.join(mediaDir, "icon.png"));
  copyFile(path.join(extensionSource, "schemas", "meta.json"), path.join(schemasDir, "meta.json"));
  copyFile(path.join(extensionSource, "schemas", "project.json"), path.join(schemasDir, "project.json"));
  copyDirectory(path.join(extensionSource, "mcp"), mcpDir);

  copyRuntimeDirectory(path.join(repoRoot, "src", "daemon"), runtimeDaemon);
  copyFile(path.join(repoRoot, "src", "mcp-proxy", "index.js"), path.join(runtimeMcpProxy, "index.js"));
  copyFile(pluginSourcePath, path.join(runtimePlugin, "Amarillo.lua"));

  const extensionPackage = JSON.parse(fs.readFileSync(path.join(extensionSource, "package.json"), "utf8"));
  const extensionId = extensionPackage.name;
  const tags = Array.isArray(extensionPackage.keywords) ? extensionPackage.keywords.join(",") : "";
  const engineVersion = String(extensionPackage.engines?.vscode || "");

  const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(extensionId)}" Version="${xmlEscape(extensionPackage.version)}" Publisher="${xmlEscape(extensionPackage.publisher)}" />
    <DisplayName>${xmlEscape(extensionPackage.displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(extensionPackage.description)}</Description>
    <Tags>${xmlEscape(tags)}</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Icon>extension/media/icon.png</Icon>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(engineVersion)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;

  const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="xml" ContentType="text/xml" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="lua" ContentType="text/plain" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="png" ContentType="image/png" />
</Types>
`;

  fs.writeFileSync(path.join(stagingRoot, "extension.vsixmanifest"), vsixManifest, "utf8");
  fs.writeFileSync(path.join(stagingRoot, "[Content_Types].xml"), contentTypes, "utf8");
  assertPortablePackage(stagingExtension);

  const zipPath = path.join(outputDir, `amarillo-vscode-${extensionPackage.version}.zip`);
  const vsixPath = path.join(outputDir, `amarillo-vscode-${extensionPackage.version}.vsix`);
  writeVsixArchive([
    path.join(stagingRoot, "[Content_Types].xml"),
    path.join(stagingRoot, "extension.vsixmanifest"),
    path.join(stagingRoot, "extension")
  ], zipPath, vsixPath);

  process.stdout.write(`[package-vsix] VSIX generated at: ${vsixPath}\n`);
}

main();
