param(
  [string]$InstallDir = "D:\Program Files\SearchToolkit",
  [string]$DataDir = "D:\ProgramData\SearchToolkit",
  [switch]$StopRunning
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$InstallDir = $InstallDir.TrimEnd('\')
$DataDir = $DataDir.TrimEnd('\')

Write-Host "[search-toolkit] Building production TypeScript (src only)..."
Push-Location $RepoRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  $pkg = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
  $rawCommit = git rev-parse --short HEAD 2>$null
  $commit = if ($rawCommit) { "$rawCommit".Trim() } else { "unknown" }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DataDir "logs") -Force | Out-Null

# Restrict runtime data directory strictly to current user (matches mcp-hub-ctl audit owner-only DACL invariant).
icacls $DataDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed for $DataDir (exit $LASTEXITCODE)" }

# Stage the complete runtime layout in a sibling directory before touching $InstallDir.
$parentDir = Split-Path -Parent $InstallDir
New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
$stagingDir = Join-Path $parentDir (".SearchToolkit.staging-" + [Guid]::NewGuid().ToString("N"))
$backupDir = Join-Path $parentDir (".SearchToolkit.prev-" + [Guid]::NewGuid().ToString("N"))

function Get-Sha256Hex([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}

function Find-RunningInstallProcesses([string]$TargetDir) {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($TargetDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
  } catch {
    return @()
  }
}

try {
  New-Item -ItemType Directory -Path (Join-Path $stagingDir "dist\src") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $stagingDir "skills\search-toolkit") -Force | Out-Null

  # Copy ONLY production runtime artifacts (no dist/tests, dist/scripts, or skills/*-workspace).
  Copy-Item -Recurse -Force (Join-Path $RepoRoot "dist\src\*") (Join-Path $stagingDir "dist\src")
  Get-ChildItem -LiteralPath (Join-Path $stagingDir "dist\src") -Recurse -File -Include "*.map", "*.d.ts" | Remove-Item -Force
  Copy-Item -Recurse -Force (Join-Path $RepoRoot "skills\search-toolkit\*") (Join-Path $stagingDir "skills\search-toolkit")
  foreach ($file in @("package.json", "package-lock.json", "config.example.json")) {
    Copy-Item -Force (Join-Path $RepoRoot $file) (Join-Path $stagingDir $file)
  }

  Write-Host "[search-toolkit] Installing production dependencies into staging directory..."
  Push-Location $stagingDir
  try {
    npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  } finally {
    Pop-Location
  }

  $httpEntry = Join-Path $stagingDir "dist\src\http-server.js"
  $mcpEntry = Join-Path $stagingDir "dist\src\mcp-server.js"
  $cliEntry = Join-Path $stagingDir "dist\src\cli.js"
  $receipt = [ordered]@{
    app = "search-toolkit"
    version = $pkg.version
    commit = $commit
    installedAt = (Get-Date).ToString("o")
    sourceRepo = $RepoRoot
    installDir = $InstallDir
    dataDir = $DataDir
    files = [ordered]@{
      "dist/src/http-server.js" = Get-Sha256Hex $httpEntry
      "dist/src/mcp-server.js" = Get-Sha256Hex $mcpEntry
      "dist/src/cli.js" = Get-Sha256Hex $cliEntry
    }
  }
  $receiptPath = Join-Path $stagingDir "installation.json"
  [System.IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 5) + "`n", [System.Text.UTF8Encoding]::new($false))

  $running = Find-RunningInstallProcesses $InstallDir
  $mcpHubCtl = Get-Command mcp-hub-ctl -ErrorAction SilentlyContinue
  $stoppedViaHub = $false
  if ($running.Count -gt 0) {
    $pids = ($running | ForEach-Object { $_.ProcessId }) -join ", "
    if ($StopRunning) {
      if ($mcpHubCtl) {
        Write-Host "[search-toolkit] Stopping managed service via mcp-hub-ctl..."
        & $mcpHubCtl.Source stop search-toolkit
        if ($LASTEXITCODE -eq 0) {
          $stoppedViaHub = $true
          Start-Sleep -Milliseconds 500
        } else {
          Write-Warning "mcp-hub-ctl stop search-toolkit returned exit $LASTEXITCODE; falling back to stopping PID(s): $pids"
        }
      }
      if (-not $stoppedViaHub) {
        Write-Host "[search-toolkit] Stopping running process(es) in ${InstallDir}: $pids"
        foreach ($proc in $running) {
          Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 500
      }
    } elseif ($mcpHubCtl) {
      Write-Warning "Detected running node process(es) using $InstallDir (PID: $pids). Recommended sequence under McpHub: mcp-hub-ctl stop search-toolkit -> install-local.ps1 -> mcp-hub-ctl start search-toolkit (or pass -StopRunning)."
    } else {
      Write-Warning "Detected running node process(es) using $InstallDir (PID: $pids). If swap fails due to file locks, stop the daemon or re-run with -StopRunning."
    }
  }

  $swapped = $false
  $backedUp = $false
  try {
    if (Test-Path -LiteralPath $InstallDir) {
      Move-Item -LiteralPath $InstallDir -Destination $backupDir
      $backedUp = $true
    }
    Move-Item -LiteralPath $stagingDir -Destination $InstallDir
    $swapped = $true
  } catch {
    if (-not $swapped -and $backedUp -and (Test-Path -LiteralPath $backupDir) -and -not (Test-Path -LiteralPath $InstallDir)) {
      Move-Item -LiteralPath $backupDir -Destination $InstallDir -ErrorAction SilentlyContinue
    }
    if ($stoppedViaHub -and $mcpHubCtl) {
      & $mcpHubCtl.Source start search-toolkit 2>$null | Out-Null
    }
    throw "Failed to swap staged install into $InstallDir (a running process may hold file locks; stop it or pass -StopRunning): $($_.Exception.Message)"
  }

  if ($backedUp -and (Test-Path -LiteralPath $backupDir)) {
    Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($stoppedViaHub -and $mcpHubCtl) {
    Write-Host "[search-toolkit] Starting managed service via mcp-hub-ctl..."
    & $mcpHubCtl.Source start search-toolkit
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "mcp-hub-ctl start search-toolkit exited with $LASTEXITCODE; check mcp-hub-ctl status."
    }
  }
} finally {
  if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "[search-toolkit] Installed v$($pkg.version) ($commit) -> $InstallDir"
