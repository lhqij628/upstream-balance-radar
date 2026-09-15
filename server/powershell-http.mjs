import { execFile } from 'node:child_process'
import fssync from 'node:fs'
import path from 'node:path'

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
$req = $raw | ConvertFrom-Json
$headers = @{}
if ($req.headers) {
  $req.headers.PSObject.Properties | ForEach-Object { $headers[$_.Name] = [string]$_.Value }
}
$params = @{
  UseBasicParsing = $true
  Method = [string]$req.method
  Uri = [string]$req.url
  Headers = $headers
  TimeoutSec = [int]$req.timeoutSecs
}
if ([string]$req.method -eq 'POST') {
  $params['ContentType'] = 'application/json'
  $params['Body'] = ($req.body | ConvertTo-Json -Depth 32 -Compress)
}
if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey('SkipHttpErrorCheck')) {
  $params['SkipHttpErrorCheck'] = $true
}
try {
  $resp = Invoke-WebRequest @params
  $contentType = ''
  if ($resp.Headers['Content-Type']) { $contentType = [string]$resp.Headers['Content-Type'] }
  [pscustomobject]@{
    ok = $true
    status = [int]$resp.StatusCode
    contentType = $contentType
    body = [string]$resp.Content
  } | ConvertTo-Json -Compress -Depth 8
} catch [System.Net.WebException] {
  $response = $_.Exception.Response
  if ($response) {
    $stream = $response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    [pscustomobject]@{
      ok = $true
      status = [int]$response.StatusCode
      contentType = [string]$response.ContentType
      body = $reader.ReadToEnd()
    } | ConvertTo-Json -Compress -Depth 8
  } else {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 8
  }
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 8
}
`

export function shouldUseWindowsHttpFallback() {
  return process.platform === 'win32' && process.env.DISABLE_POWERSHELL_HTTP_FALLBACK !== '1'
}

export function powershellRequest({ url, method = 'GET', headers = {}, body, timeoutSecs = 12 }) {
  if (!shouldUseWindowsHttpFallback()) return null
  return new Promise((resolve) => {
    const exe = pickPowerShell()
    const child = execFile(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], {
      timeout: Math.max(5, Math.min(90, Number(timeoutSecs) + 8)) * 1000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (_error, stdout) => {
      try {
        const parsed = JSON.parse(String(stdout || '').trim())
        resolve(parsed.ok ? parsed : null)
      } catch { resolve(null) }
    })
    child.stdin.end(JSON.stringify({ url, method, headers, body, timeoutSecs: Math.max(3, Math.min(60, Number(timeoutSecs) || 12)) }))
  })
}

function pickPowerShell() {
  if (process.env.POWERSHELL_EXE) return process.env.POWERSHELL_EXE
  const candidates = [
    path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
    'pwsh.exe',
    'powershell.exe',
  ]
  return candidates.find((candidate) => candidate.includes('\\') ? fssync.existsSync(candidate) : true) || 'powershell.exe'
}
