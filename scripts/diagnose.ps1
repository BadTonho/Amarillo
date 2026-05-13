param(
    [string]$WorkspaceRoot = (Get-Item -Path ".\").FullName,
    [int]$Port = 8323,
    [switch]$Live = $false,
    [switch]$Verbose = $false
)

$ErrorActionPreference = "Continue"

function Write-Status {
    param([string]$Message, [string]$Type = "info")
    $timestamp = Get-Date -Format "HH:mm:ss"
    switch ($Type) {
        "error" { Write-Host "[$timestamp] ERROR   : $Message" -ForegroundColor Red }
        "ok"    { Write-Host "[$timestamp] OK      : $Message" -ForegroundColor Green }
        "warn"  { Write-Host "[$timestamp] WARNING : $Message" -ForegroundColor Yellow }
        "info"  { Write-Host "[$timestamp] INFO    : $Message" -ForegroundColor Cyan }
        "debug" { if ($Verbose) { Write-Host "[$timestamp] DEBUG   : $Message" -ForegroundColor DarkGray } }
        "sync"  { Write-Host "[$timestamp] SYNC    : $Message" -ForegroundColor Magenta }
    }
}

function Get-HttpJson {
    param([string]$Url)
    try {
        $uri = [Uri]$Url
        $client = New-Object System.Net.Sockets.TcpClient($uri.Host, $uri.Port)
        $stream = $client.GetStream()
        $writer = New-Object System.IO.StreamWriter($stream)
        $writer.AutoFlush = $true
        
        $path = $uri.PathAndQuery
        if ([string]::IsNullOrEmpty($path)) { $path = "/" }
        
        $writer.WriteLine("GET $path HTTP/1.0")
        $writer.WriteLine("Host: $($uri.Host):$($uri.Port)")
        $writer.WriteLine("")
        
        $reader = New-Object System.IO.StreamReader($stream)
        $response = @()
        $bodyStart = $false
        
        while ($true) {
            $line = $reader.ReadLine()
            if ($line -eq $null) { break }
            if ($bodyStart) {
                $response += $line
            } elseif ($line -eq "") {
                $bodyStart = $true
            }
        }
        
        $client.Close()
        
        if ($response) {
            return ($response -join "`n") | ConvertFrom-Json
        }
        return $null
    } catch {
        Write-Status "HTTP Error: $_" "warn"
        return $null
    }
}

Write-Status "Bidirectional Sync Diagnostic" "info"
Write-Status "WorkspaceRoot: $WorkspaceRoot" "debug"
Write-Status "Port: $Port" "debug"

# Check whether the daemon is running.
$healthUrl = "http://localhost:$Port/health"
$health = Get-HttpJson -Url $healthUrl
if ($health -and $health.ok) {
    Write-Status "Daemon is running [$($health.projectCount) projects, $($health.sessions.Count) sessions]" "ok"
} else {
    Write-Status "Daemon is NOT running at http://localhost:$Port" "error"
    Write-Status "Start the daemon with: task 'Amarillo: Start Daemon'" "info"
    exit 1
}

# If there are sessions, use the first one for diagnostics.
$sessionId = $health.sessions[0].id
if ($sessionId) {
    Write-Status "Using session: $($health.sessions[0].projectName) [$sessionId]" "info"
} else {
    Write-Status "No active sessions. Connect the Roblox Studio plugin first." "warn"
}

# ============================================
# Function to get sync state.
# ============================================
function Get-SyncState {
    param([string]$SessionId)
    $url = "http://localhost:$Port/debug/sync-state"
    if ($SessionId) {
        $url += "?sessionId=$SessionId"
    }
    return Get-HttpJson -Url $url
}

# ============================================
# Live mode - monitor sync.
# ============================================
if ($Live -and $sessionId) {
    Write-Status "=== LIVE MONITORING MODE ===" "info"
    Write-Status "This will monitor sync events. Press Ctrl+C to stop." "info"
    Write-Status "" "info"
    
    $lastState = Get-SyncState -SessionId $sessionId
    Write-Status "Initial state:" "sync"
    Write-Status "  Pending commands: $($lastState.session.pendingCommandCount)" "debug"
    Write-Status "  Last studio seen: $($lastState.session.lastStudioSeenAt)" "debug"
    Write-Status "  Last applied: $($lastState.session.lastAppliedAt)" "debug"
    Write-Status "" "info"

    $changeDetected = $false
    $iterations = 0
    $maxIterations = 120  # 2 minutes with 1s polling.

    while ($iterations -lt $maxIterations) {
        Start-Sleep -Seconds 1
        $iterations++
        
        $currentState = Get-SyncState -SessionId $sessionId
        if (!$currentState) {
            continue
        }

        # Detect changes.
        if ($lastState.session.pendingCommandCount -ne $currentState.session.pendingCommandCount) {
            Write-Status "Pending commands changed: $($lastState.session.pendingCommandCount) -> $($currentState.session.pendingCommandCount)" "sync"
            if ($currentState.session.pendingCommands.Count -gt 0) {
                foreach ($cmd in $currentState.session.pendingCommands) {
                    Write-Status "  - Queued: $($cmd.type)" "debug"
                }
            }
            $changeDetected = $true
        }

        if ($lastState.session.lastStudioSeenAt -ne $currentState.session.lastStudioSeenAt) {
            Write-Status "Studio snapshot received! Hash: $($currentState.session.lastStudioHash)" "sync"
            $changeDetected = $true
        }

        if ($lastState.session.lastAppliedAt -ne $currentState.session.lastAppliedAt) {
            Write-Status "Snapshot written to disk! Time: $($currentState.session.lastAppliedAt)" "sync"
            $changeDetected = $true
        }

        if ($lastState.lastDiskWriteTime -ne $currentState.lastDiskWriteTime) {
            Write-Status "Disk write timestamp updated" "sync"
            $changeDetected = $true
        }

        $lastState = $currentState
    }

    if (!$changeDetected) {
        Write-Status "No sync events detected in 2 minutes. Check:" "warn"
        Write-Status "  1. Are you making changes in the Roblox Studio?" "info"
        Write-Status "  2. Are you making changes in VSCode?" "info"
        Write-Status "  3. Are plugins connected?" "info"
    }
    exit 0
}

# ============================================
# Report mode - show current state.
# ============================================
Write-Status "=== CURRENT SYNC STATE ===" "info"
Write-Status "" "info"

$state = Get-SyncState
if (!$state) {
    Write-Status "Could not retrieve sync state" "error"
    exit 1
}

if ($state.mode -eq "all_sessions") {
    Write-Status "Daemon status:" "info"
    Write-Status "  Projects loaded: $($state.daemon.projectCount)" "debug"
    Write-Status "  Active sessions: $($state.daemon.sessionCount)" "debug"
    Write-Status "  Last disk write: $($state.daemon.lastDiskWriteTime)" "debug"
    Write-Status "" "info"

    if ($state.sessions.Count -eq 0) {
        Write-Status "No active sessions. Connect from Roblox Studio first." "warn"
    } else {
        Write-Status "Sessions:" "info"
        foreach ($session in $state.sessions) {
            Write-Status "  [$($session.projectName)] ID: $($session.id)" "debug"
            Write-Status "    Last studio seen: $($session.lastStudioSeenAt)" "debug"
            Write-Status "    Last applied to disk: $($session.lastAppliedAt)" "debug"
            Write-Status "    Pending commands: $($session.pendingCommandCount)" "debug"
            if ($session.pendingCommandCount -gt 0) {
                Write-Status "    Command types: $($session.pendingCommandTypes -join ', ')" "debug"
            }
        }
    }
} else {
    Write-Status "Session details:" "info"
    $s = $state.session
    Write-Status "  Project: $($s.projectName)" "debug"
    Write-Status "  Place ID: $($s.placeId)" "debug"
    Write-Status "  Last studio seen: $($s.lastStudioSeenAt)" "debug"
    Write-Status "  Last applied to disk: $($s.lastAppliedAt)" "debug"
    Write-Status "  Snapshot size: $($s.snapshotSize) bytes" "debug"
    Write-Status "  Pending commands: $($s.pendingCommandCount)" "debug"
    if ($s.pendingCommandCount -gt 0) {
        Write-Status "  Queued commands:" "debug"
        foreach ($cmd in $s.pendingCommands) {
            Write-Status "    - $($cmd.type)" "debug"
        }
    }
    Write-Status "  File change timer active: $($s.fileChangeTimerActive)" "debug"
}

Write-Status "" "info"
Write-Status "=== RECOMMENDATIONS ===" "info"

if ($state.sessions.Count -eq 0) {
    Write-Status "1. Open a Roblox Studio with connected plugin" "info"
    Write-Status "2. Then run this script again" "info"
} else {
    Write-Status "To watch sync events in real-time, run:" "info"
    Write-Status "  .\diagnose.ps1 -Live -SessionId $sessionId" "debug"
    Write-Status "" "info"
    Write-Status "To enable detailed logging in daemon, set environment variable:" "info"
    Write-Status "  \$env:AMARILLO_DEBUG = '1'" "debug"
    Write-Status "  (then restart the daemon)" "debug"
}

Write-Status "" "info"
