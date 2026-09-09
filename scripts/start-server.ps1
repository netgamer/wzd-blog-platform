param(
  [string]$Repository = (Split-Path -Parent $PSScriptRoot),
  [string]$Node = "C:\Program Files\nodejs\node.exe"
)
$ErrorActionPreference = "Stop"
$mutex = New-Object Threading.Mutex($false, "Local\WzdNewsServerWatchdog")
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:3456/api/health" -TimeoutSec 5
    if ($health.status -eq "ok") { exit 0 }
  } catch {}
  if (-not (Test-Path -LiteralPath $Node)) { throw "Windows Node.js not found: $Node" }
  $entry = Join-Path $Repository "scripts\api-server.mjs"
  if (-not (Test-Path -LiteralPath $entry)) { throw "API server not found: $entry" }
  $existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*api-server.mjs*" }
  if ($existing) { throw "An API process exists but health failed. Inspect it before restarting; no unrelated process was stopped." }
  $logs = Join-Path $env:LOCALAPPDATA "WzdNews\logs"
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $process = Start-Process -FilePath $Node -ArgumentList @('"' + $entry + '"') -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "$stamp-out.log") -RedirectStandardError (Join-Path $logs "$stamp-error.log")
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Seconds 2
    if ($process.HasExited) { throw "Server exited; inspect $logs" }
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:3456/api/health" -TimeoutSec 3
      if ($health.status -eq "ok") { Write-Output "WZD API healthy, PID $($process.Id)"; exit 0 }
    } catch {}
  }
  throw "Server health timeout; inspect $logs"
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
