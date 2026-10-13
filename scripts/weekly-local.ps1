# Weekly RENG run (Windows scheduled task "RENG Weekly Post", Tuesdays 9:30am).
# Refreshes data, pushes if changed (the GitHub bot may have already), then posts the
# standings image + notes to the league chat. --once makes the post idempotent: a week
# is never posted twice, and nothing posts after the regular season.
# Keep this file ASCII-only (Windows PowerShell 5.1 misreads UTF-8 without BOM).
$ErrorActionPreference = "Continue"  # native stderr (git progress) must not throw in PS 5.1
Set-Location (Split-Path $PSScriptRoot -Parent)
$log = Join-Path (Get-Location) "data\chat-posts\weekly.log"
function Log($m) { "$(Get-Date -Format s)  $m" | Add-Content $log }

try {
  Log "--- start"
  git pull --rebase --quiet 2>&1 | ForEach-Object { Log "git: $_" }
  if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
  npm run data 2>&1 | Select-Object -Last 3 | ForEach-Object { Log "data: $_" }
  git add src/data
  git diff --staged --quiet
  if ($LASTEXITCODE -ne 0) {
    git commit -q -m "chore: weekly VP update ($(Get-Date -Format yyyy-MM-dd))"
    git push --quiet 2>&1 | ForEach-Object { Log "git: $_" }
    Log "pushed data"
  } else { Log "no data changes" }
  node scripts/post-standings.mjs --post --once --notes 2>&1 | ForEach-Object { Log "post: $_" }
  Log "--- done (exit $LASTEXITCODE)"
} catch {
  Log "ERROR: $_"
  exit 1
}
