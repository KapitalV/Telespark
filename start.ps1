$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.env')) { throw 'Run setup.ps1 first and fill in .env.' }
& npm.cmd start
exit $LASTEXITCODE
