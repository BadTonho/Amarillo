param(
    [string]$WorkspaceRoot = (Get-Item -Path ".\").FullName,
    [int]$Port = 8323
)

$ErrorActionPreference = "Stop"

Write-Host "Starting daemon with debug logging enabled..." -ForegroundColor Cyan
Write-Host "WorkspaceRoot: $WorkspaceRoot" -ForegroundColor Gray
Write-Host "Port: $Port" -ForegroundColor Gray
Write-Host "" -ForegroundColor Gray
Write-Host "All sync events will be logged to stderr with format:" -ForegroundColor Yellow
Write-Host '  [SYNC] {"timestamp":"...", "event":"...", ...}' -ForegroundColor Yellow
Write-Host "" -ForegroundColor Gray
Write-Host "To stop logging, set AMARILLO_DEBUG to empty or 0 before restarting." -ForegroundColor Yellow
Write-Host "" -ForegroundColor Gray

# Set environment variable for debug logging
$env:AMARILLO_DEBUG = "1"

# Start the daemon
& "$PSScriptRoot\start-daemon.ps1" -WorkspaceRoot $WorkspaceRoot -Port $Port
