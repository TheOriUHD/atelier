# The release's rehearsal on the Windows build machine (deploy/ship/release.mjs, before anything is tagged): the terminal
# app's tests in a real pseudo-terminal (ConPTY), as the build runs them, with CI set as on the Linux machine. The release
# command copies this script, the source of HEAD (qa-src.tar.gz) and the runners built on the Mac (qa-runner-bin.tar.gz)
# to $Root, then runs it. It works in $Root\qa, apart from the build's own $Root\src.
param([string]$Root = 'C:\atelier-build')
# Native tools write warnings to stderr, which 'Stop' would turn into failures: each step's exit code is checked instead.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$env:Path = "$Root\tools\node;" + $env:Path
function Step($m) { Write-Output ("=== " + $m + " " + (Get-Date -Format HH:mm:ss)) }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE)" } }

Step 'source'
Remove-Item -Recurse -Force "$Root\qa" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$Root\qa\runner" | Out-Null
tar.exe -xzf "$Root\qa-src.tar.gz" -C "$Root\qa"; Check 'unpacking the source'
tar.exe -xzf "$Root\qa-runner-bin.tar.gz" -C "$Root\qa\runner"; Check 'unpacking the runners'

Step 'install'
Set-Location "$Root\qa"
pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 3
Check 'pnpm install'

Step 'terminal app'
pnpm --filter @atelier/cli build 2>&1 | Select-Object -Last 2
Check 'the terminal app bundle'
pnpm --filter @atelier/server build 2>&1 | Select-Object -Last 2
Check 'the server bundle'
$env:ATELIER_NO_BROWSER = '1'
$env:CI = '1'
npx vitest run apps/cli 2>&1 | Select-Object -Last 25
Check 'the terminal app tests'
Step 'done'
