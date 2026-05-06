param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$extensionSource = Join-Path $repoRoot "vscode-extension"
$outputDir = Join-Path $repoRoot "dist"
$stagingRoot = Join-Path $outputDir "amarillo-vsix"
$stagingExtension = Join-Path $stagingRoot "extension"
$runtimeDaemon = Join-Path $stagingExtension "runtime\\daemon"
$runtimeMcpProxy = Join-Path $stagingExtension "runtime\\mcp-proxy"
$runtimePlugin = Join-Path $stagingExtension "runtime\\plugin"
$mediaDir = Join-Path $stagingExtension "media"
$schemasDir = Join-Path $stagingExtension "schemas"

if (-not (Test-Path -LiteralPath $extensionSource)) {
    throw "Extensao VS Code nao encontrada em: $extensionSource"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $stagingExtension | Out-Null
New-Item -ItemType Directory -Force -Path $runtimeDaemon | Out-Null
New-Item -ItemType Directory -Force -Path $runtimeMcpProxy | Out-Null
New-Item -ItemType Directory -Force -Path $runtimePlugin | Out-Null
New-Item -ItemType Directory -Force -Path $mediaDir | Out-Null
New-Item -ItemType Directory -Force -Path $schemasDir | Out-Null

Copy-Item -LiteralPath (Join-Path $extensionSource "package.json") -Destination (Join-Path $stagingExtension "package.json") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "extension.js") -Destination (Join-Path $stagingExtension "extension.js") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "mcp-config.js") -Destination (Join-Path $stagingExtension "mcp-config.js") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "project-bootstrap.js") -Destination (Join-Path $stagingExtension "project-bootstrap.js") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "sourcemap.js") -Destination (Join-Path $stagingExtension "sourcemap.js") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "README.md") -Destination (Join-Path $stagingExtension "README.md") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "CHANGELOG.md") -Destination (Join-Path $stagingExtension "CHANGELOG.md") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "amarillo-version.json") -Destination (Join-Path $stagingExtension "amarillo-version.json") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "media\\amarillo.svg") -Destination (Join-Path $mediaDir "amarillo.svg") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "schemas\\meta.json") -Destination (Join-Path $schemasDir "meta.json") -Force
Copy-Item -LiteralPath (Join-Path $extensionSource "schemas\\project.json") -Destination (Join-Path $schemasDir "project.json") -Force

Copy-Item -Path (Join-Path $repoRoot "src\\daemon\\*") -Destination $runtimeDaemon -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "src\\mcp-proxy\\index.js") -Destination (Join-Path $runtimeMcpProxy "index.js") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "src\\plugin\\Amarillo.lua") -Destination (Join-Path $runtimePlugin "Amarillo.lua") -Force

$package = Get-Content (Join-Path $extensionSource "package.json") | ConvertFrom-Json
$extensionId = "$($package.publisher).$($package.name)"
$tags = ($package.keywords -join ",")
$description = [System.Security.SecurityElement]::Escape([string]$package.description)
$displayName = [System.Security.SecurityElement]::Escape([string]$package.displayName)
$engineVersion = [string]$package.engines.vscode

$vsixManifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$extensionId" Version="$($package.version)" Publisher="$($package.publisher)" />
    <DisplayName>$displayName</DisplayName>
    <Description xml:space="preserve">$description</Description>
    <Tags>$tags</Tags>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engineVersion" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" Version="$engineVersion" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="xml" ContentType="text/xml" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="lua" ContentType="text/plain" />
  <Default Extension="svg" ContentType="image/svg+xml" />
</Types>
"@

Set-Content -LiteralPath (Join-Path $stagingRoot "extension.vsixmanifest") -Value $vsixManifest -Encoding utf8
Set-Content -LiteralPath (Join-Path $stagingRoot "[Content_Types].xml") -Value $contentTypes -Encoding utf8

$zipPath = Join-Path $outputDir "amarillo-vscode-$($package.version).zip"
$vsixPath = Join-Path $outputDir "amarillo-vscode-$($package.version).vsix"

if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

if (Test-Path -LiteralPath $vsixPath) {
    Remove-Item -LiteralPath $vsixPath -Force
}

Compress-Archive -LiteralPath @(
    (Join-Path $stagingRoot "[Content_Types].xml"),
    (Join-Path $stagingRoot "extension.vsixmanifest"),
    (Join-Path $stagingRoot "extension")
) -DestinationPath $zipPath -Force

Move-Item -LiteralPath $zipPath -Destination $vsixPath -Force
Write-Host "[package-vsix] VSIX gerado em: $vsixPath"
