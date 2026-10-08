$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or later from https://nodejs.org, then run this script again.' }
$taskNodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($taskNodeMajor -lt 22) { throw 'Node.js 22 or later is required.' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
$taskEdgeLocations = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Microsoft\Edge\Application\msedge.exe')
if (-not ($taskEdgeLocations | Where-Object { Test-Path -LiteralPath $_ })) {
  throw 'Microsoft Edge was not found. If Chrome is installed, use npm.cmd ci, copy .env.example to .env, and set BROWSER_CHANNEL=chrome. Otherwise install Edge from its official website.'
}
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
Write-Host 'Setup finished. Edit .env using the README, then run start.ps1.'
