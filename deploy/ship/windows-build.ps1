# Builds the Windows installer (x64 and arm64 in one) on the Windows build machine. The release command
# (deploy/ship/release.mjs) copies this script, the source of the tag (atelier-src.tar.gz), the runner binaries
# (runner-bin.tar.gz) and the computer use helpers (computer-windows.tar.gz, built with Go on the Mac) to $Root, then
# runs it. $Root holds tools\node (Node and pnpm on the PATH) and src\ (the checkout).
param([string]$Root = 'C:\atelier-build')
# Native tools write warnings to stderr, which 'Stop' would turn into failures: each step's exit code is checked instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$env:Path = "$Root\tools\node;" + $env:Path
function Step($m) { Write-Output ("=== " + $m + " " + (Get-Date -Format HH:mm:ss)) }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" } }

Step 'source'
New-Item -ItemType Directory -Force -Path "$Root\src\runner" | Out-Null
New-Item -ItemType Directory -Force -Path "$Root\src\native" | Out-Null
Remove-Item -Recurse -Force "$Root\src\apps\desktop\release" -ErrorAction SilentlyContinue
tar.exe -xzf "$Root\atelier-src.tar.gz" -C "$Root\src"; Check 'unpacking the source'
tar.exe -xzf "$Root\runner-bin.tar.gz" -C "$Root\src\runner"; Check 'unpacking the runners'
tar.exe -xzf "$Root\computer-windows.tar.gz" -C "$Root\src\native"; Check 'unpacking the computer use helpers'

Step 'install'
Set-Location "$Root\src"
pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 3
Check 'pnpm install'

Step 'build'
Set-Location "$Root\src\apps\desktop"
node scripts\build.mjs 2>&1 | Select-Object -Last 3
Check 'the bundle'

Step 'package'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
pnpm exec electron-builder --config electron-builder.yml --win --publish never 2>&1 | Select-Object -Last 14
Check 'electron-builder'
# electron-builder leaves out a resource folder that is missing without a word: make sure the helpers are in both apps.
foreach ($dir in 'win-unpacked', 'win-arm64-unpacked') {
  foreach ($arch in 'x64', 'arm64') {
    if (-not (Test-Path "$Root\src\apps\desktop\release\$dir\resources\computer\atelier-computer-windows-$arch.exe")) { throw "the computer use helper ($arch) is missing from $dir" }
  }
}
Get-ChildItem "$Root\src\apps\desktop\release" -File | Select-Object Name, Length | Format-Table -AutoSize | Out-String
Step 'done'
