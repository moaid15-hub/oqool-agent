# Oqool Agent installer — Windows (CMD or PowerShell).
#   CMD:        powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/moaid15-hub/oqool-agent/releases/latest/download/install.ps1 | iex"
#   PowerShell: irm https://github.com/moaid15-hub/oqool-agent/releases/latest/download/install.ps1 | iex
# On Windows the agent is one script run by Node.js (Node is signed, so Smart App Control lets it run). An installed
# Node 22+ is used; otherwise the official Node is downloaded into the agent's own folder (no administrator rights).
# على Windows يعمل الـ Agent سكربتاً بـ Node الموقّع؛ يُستعمل Node المثبّت أو يُنزَّل Node الرسمي داخل مجلد الـ Agent.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'moaid15-hub/oqool-agent'
$Version = if ($env:OQOOL_AGENT_VERSION) { $env:OQOOL_AGENT_VERSION } else { 'latest' }
$Root = if ($env:OQOOL_AGENT_INSTALL) { $env:OQOOL_AGENT_INSTALL } else { Join-Path $env:LOCALAPPDATA 'oqool-agent' }
$Dir = Join-Path $Root 'bin'
$Base = if ($Version -eq 'latest') { "https://github.com/$Repo/releases/latest/download" } else { "https://github.com/$Repo/releases/download/$Version" }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Oqool Agent needs 64-bit Windows.' }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

function Get-NodeMajor([string]$exe) {
  try { $v = & $exe --version 2>$null; if ($v -match '^v(\d+)\.') { return [int]$Matches[1] } } catch { }
  return 0
}

# 1) Node.js — the one already on this computer (22+), or the official one in the agent's folder
$Node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys -and (Get-NodeMajor $sys.Source) -ge 22) { $Node = $sys.Source }
$local = Join-Path $Root 'node\node.exe'
if (-not $Node -and (Test-Path $local) -and (Get-NodeMajor $local) -ge 22) { $Node = $local }
if (-not $Node) {
  Write-Host 'Oqool Agent: downloading Node.js (official, signed) …'
  $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
  $rel = $index | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') -and ([int]($_.version.TrimStart('v').Split('.')[0]) -ge 22) } | Select-Object -First 1
  if (-not $rel) { throw 'Could not find a Node.js release to download.' }
  $zipName = "node-$($rel.version)-win-x64.zip"
  $zip = Join-Path $env:TEMP $zipName
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$($rel.version)/$zipName" -OutFile $zip
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$($rel.version)/SHASUMS256.txt").Content
  $want = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($zipName))\s*$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
  if (-not $want -or (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $want.ToLower()) { Remove-Item $zip -Force; throw 'Node.js checksum mismatch - not installed' }
  $tmp = Join-Path $Root 'node-download'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Remove-Item $zip -Force
  $nodeDir = Join-Path $Root 'node'
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $nodeDir
  Remove-Item $tmp -Recurse -Force
  $Node = $local
}
Write-Host "Oqool Agent: Node.js $(& $Node --version) → $Node"

# 2) the agent script, checked against the release's SHA256SUMS
Write-Host 'Oqool Agent: downloading the agent …'
$Script = Join-Path $Dir 'oqool-agent.mjs'
$new = "$Script.download"
Invoke-WebRequest -UseBasicParsing -Uri "$Base/oqool-agent.mjs" -OutFile $new
$sums = (Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS").Content
$want = ($sums -split "`n" | Where-Object { $_ -match '\soqool-agent\.mjs\s*$' } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
if (-not $want -or (Get-FileHash -Algorithm SHA256 $new).Hash.ToLower() -ne $want.ToLower()) { Remove-Item $new -Force; throw 'Oqool Agent: checksum mismatch - not installed' }
Move-Item -Force $new $Script

# 3) the command «oqool-agent» (a .cmd beside the script); an older .exe of the agent is retired (it would win on PATH)
Get-Process oqool-agent -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
foreach ($old in @('oqool-agent.exe', 'oqool-agent.exe.old', 'oqool-agent.exe.new')) { $f = Join-Path $Dir $old; if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
$Cmd = Join-Path $Dir 'oqool-agent.cmd'
Set-Content -Path $Cmd -Encoding ASCII -Value "@echo off`r`n`"$Node`" `"%~dp0oqool-agent.mjs`" %*"
Write-Host "OK  Oqool Agent $(& $Cmd --version) → $Cmd"

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($UserPath -split ';' | Where-Object { $_ -eq $Dir })) {
  [Environment]::SetEnvironmentVariable('Path', ($(if ($UserPath) { "$UserPath;" } else { '' }) + $Dir), 'User')
  Write-Host "  Added $Dir to your PATH (new terminals see it)"
}
$env:Path = "$env:Path;$Dir"
Write-Host ''
# link this computer and start the background agent right away
if (-not $env:OQOOL_AGENT_NO_SETUP) { & $Cmd setup } else { Write-Host 'Next:  oqool-agent setup     (link this computer and keep the agent running)' }
