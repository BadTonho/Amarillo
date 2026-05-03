$ErrorActionPreference = "Stop"

$sourcePath = Join-Path $PSScriptRoot "..\src\plugin\Amarillo.lua"
$pluginsDir = Join-Path $env:LOCALAPPDATA "Roblox\Plugins"
$targetPath = Join-Path $pluginsDir "Amarillo.lua"

if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Arquivo do plugin nao encontrado em: $sourcePath"
}

New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force

Write-Host "[install-plugin] Amarillo copiado para $targetPath"
Write-Host "[install-plugin] Reinicie o Roblox Studio ou use Reload Plugins."
