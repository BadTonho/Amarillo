param(
    [string]$WorkspaceRoot = "",
    [Alias("Host")]
    [string]$DaemonHost = "127.0.0.1",
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"

function Resolve-DaemonPort {
    param(
        [string]$WorkspacePath,
        [int]$RequestedPort
    )

    if ($RequestedPort -gt 0) {
        return $RequestedPort
    }

    $configPath = Join-Path $WorkspacePath ".pluginroblox.json"
    if (Test-Path -LiteralPath $configPath) {
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            $configuredPort = [int]$config.daemonPort
            if ($configuredPort -gt 0) {
                return $configuredPort
            }
        } catch {
        }
    }

    return 8323
}

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Join-Path $PSScriptRoot ".."
}

$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$resolvedPort = Resolve-DaemonPort -WorkspacePath $resolvedWorkspace -RequestedPort $Port
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$proxyPath = Join-Path $PSScriptRoot "..\src\mcp-proxy\index.js"

if (-not (Test-Path -LiteralPath $proxyPath)) {
    Push-Location $repoRoot
    try {
        & npm.cmd run build:runtime
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $proxyPath)) {
    throw "MCP proxy not found after build: $proxyPath"
}

& node $proxyPath --workspace $resolvedWorkspace --host $DaemonHost --port $resolvedPort
