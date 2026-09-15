param(
  [int]$Port = 8789,
  [string]$BindHost = '127.0.0.1',
  [bool]$OpenBrowser = $true
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

function Write-Step([string]$Msg) {
  Write-Host "[upstream-balance-radar] $Msg" -ForegroundColor Cyan
}

function Wait-HttpReady([string]$Url, [int]$Retries = 60) {
  for ($i = 0; $i -lt $Retries; $i++) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 1000
    }
  }
  return $false
}

$appUrl = "http://$BindHost`:$Port"
try {
  $health = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 2
  if ($health.ok -and $health.version -eq '0.2.0') {
    Write-Step "Service already running: $appUrl"
    if ($OpenBrowser) { Start-Process $appUrl }
    exit 0
  }
} catch {}

$occupied = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($occupied) { throw "Port $Port is already in use. Close the existing service yourself or start with -Port <another port>." }

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm not found. Install Node.js and pnpm first.'
}

if (-not (Test-Path -LiteralPath (Join-Path $scriptDir 'node_modules'))) {
  Write-Step 'Installing dependencies...'
  pnpm install
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}

Write-Step 'Building frontend...'
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

$env:PORT = "$Port"
$env:HOST = $BindHost
if ($BindHost -notin @('127.0.0.1','localhost','::1')) { $env:RADAR_MODE='server' } else { $env:RADAR_MODE='local' }
$stdoutLog = Join-Path $scriptDir 'start-local.out.log'
$stderrLog = Join-Path $scriptDir 'start-local.err.log'
Remove-Item -LiteralPath $stdoutLog, $stderrLog -ErrorAction SilentlyContinue

Write-Step "Starting service: http://$BindHost`:$Port"
$process = Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' -WorkingDirectory $scriptDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

try {
  if (-not (Wait-HttpReady "http://$BindHost`:$Port/api/health" 60)) {
    if (Test-Path -LiteralPath $stdoutLog) {
      Write-Step 'Startup log:'
      Get-Content -LiteralPath $stdoutLog -Tail 40 | ForEach-Object { Write-Host $_ }
    }
    if (Test-Path -LiteralPath $stderrLog) {
      Get-Content -LiteralPath $stderrLog -Tail 40 | ForEach-Object { Write-Host $_ }
    }
    throw 'Service start timeout.'
  }
  Write-Step 'Service ready.'
  if ($OpenBrowser) {
    Start-Process "http://$BindHost`:$Port"
  }
  Write-Step "Service is running in the background (PID $($process.Id)). You can close this launcher window."
} catch {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
  throw
}
