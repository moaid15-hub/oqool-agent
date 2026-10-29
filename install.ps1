# Oqool Agent installer — Windows (PowerShell).
#   irm https://github.com/moaid15-hub/oqool-agent/releases/latest/download/install.ps1 | iex
# Downloads one program into %LOCALAPPDATA%\oqool-agent\bin and puts it on the user PATH. Nothing else is installed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'moaid15-hub/oqool-agent'
$Version = if ($env:OQOOL_AGENT_VERSION) { $env:OQOOL_AGENT_VERSION } else { 'latest' }
$Dir = if ($env:OQOOL_AGENT_INSTALL) { $env:OQOOL_AGENT_INSTALL } else { Join-Path $env:LOCALAPPDATA 'oqool-agent\bin' }

if (-not [Environment]::Is64BitOperatingSystem) { throw 'Oqool Agent needs 64-bit Windows.' }
$Name = 'oqool-agent-windows-x64.exe'
$Base = if ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Tmp = Join-Path $Dir 'oqool-agent.download'
Write-Host "Oqool Agent: downloading $Name ..."
Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Name" -OutFile $Tmp

# the published checksum must match before the program is put in place
try {
  $Sums = (Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS").Content
  $Want = ($Sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($Name))$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
  if ($Want) {
    $Got = (Get-FileHash -Algorithm SHA256 $Tmp).Hash.ToLower()
    if ($Got -ne $Want.ToLower()) { Remove-Item $Tmp -Force; throw 'Oqool Agent: checksum mismatch - not installed' }
  }
} catch [System.Net.WebException] { }

$Exe = Join-Path $Dir 'oqool-agent.exe'
Move-Item -Force $Tmp $Exe
$V = & $Exe --version
Write-Host "OK  Oqool Agent $V -> $Exe"

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($UserPath -split ';' | Where-Object { $_ -eq $Dir })) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($UserPath) { "$UserPath;" } else { '' }) + $Dir), 'User')
  $env:Path = "$env:Path;$Dir"
  Write-Host "  Added $Dir to your PATH (new terminals see it)"
}
Write-Host ''
# link this computer and start the background agent right away
if (-not $env:OQOOL_AGENT_NO_SETUP) { & $Exe setup } else { Write-Host 'Next:  oqool-agent setup     (link this computer and keep the agent running)' }
