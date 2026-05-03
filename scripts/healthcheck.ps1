param(
    [string]$WorkspaceRoot = "",
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
$url = "http://$DaemonHost`:$resolvedPort/health"
Invoke-RestMethod -Method Get -Uri $url | ConvertTo-Json -Depth 8
