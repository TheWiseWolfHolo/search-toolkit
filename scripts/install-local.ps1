param(
  [string]$InstallDir = "D:\Program Files\SearchToolkit",
  [string]$DataDir = "D:\ProgramData\SearchToolkit"
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host "[search-toolkit] Building TypeScript..."
Push-Location $RepoRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  $pkg = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
  $commit = (git rev-parse --short HEAD 2>$null).Trim()
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DataDir "logs") -Force | Out-Null

# Restrict runtime data directory to current user.
icacls $DataDir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

foreach ($sub in @("dist", "skills")) {
  $dest = Join-Path $InstallDir $sub
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse -Force (Join-Path $RepoRoot $sub) $dest
}
foreach ($file in @("package.json", "package-lock.json", "config.example.json")) {
  Copy-Item -Force (Join-Path $RepoRoot $file) (Join-Path $InstallDir $file)
}

Write-Host "[search-toolkit] Installing production dependencies into $InstallDir..."
Push-Location $InstallDir
try {
  npm ci --omit=dev --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
} finally {
  Pop-Location
}

$httpEntry = Join-Path $InstallDir "dist\src\http-server.js"
$cliEntry = Join-Path $InstallDir "dist\src\cli.js"
function Get-Sha256Hex([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}
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
    "dist/src/cli.js" = Get-Sha256Hex $cliEntry
  }
}
$receiptPath = Join-Path $InstallDir "installation.json"
[System.IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 5) + "`n", [System.Text.UTF8Encoding]::new($false))
Write-Host "[search-toolkit] Installed v$($pkg.version) ($commit) -> $InstallDir"
