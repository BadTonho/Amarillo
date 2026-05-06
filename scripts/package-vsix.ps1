param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$compiledScript = Join-Path $repoRoot "scripts\package-vsix.js"

if (-not (Test-Path -LiteralPath $compiledScript)) {
    & npm.cmd run build:scripts
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

& node $compiledScript
exit $LASTEXITCODE
