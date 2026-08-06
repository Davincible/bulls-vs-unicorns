# Cost monitor — what is actually running on Fly and what it should cost per month.
# Run:  powershell -ExecutionPolicy Bypass -File costs.ps1
#
# Fly has no hard "stop at $X" switch, so the real cap is ARCHITECTURAL and this script checks it:
# one fixed-size machine, no autoscaling, one small volume. If any of those drift, cost drifts.

$fly = "$env:USERPROFILE\.fly\bin\fly.exe"
$app = "bulls-arena-engine"

# Fly published rates (USD/month). Update if their pricing changes.
$RATE_256 = 1.94
$RATE_512 = 3.19
$RATE_1G  = 6.38
$RATE_VOL = 0.15   # per GB per month

Write-Output "=== MACHINES (each one costs money) ==="
$machines = & $fly machines list --app $app 2>$null
$machines | Select-Object -First 15

Write-Output ""
Write-Output "=== VOLUMES (the ledger lives here) ==="
& $fly volumes list --app $app 2>$null | Select-Object -First 10

Write-Output ""
Write-Output "=== EXPECTED MONTHLY COST (at the configured size) ==="
Write-Output ("  machine  shared-cpu-1x 512MB, always on : ~`$" + $RATE_512)
Write-Output ("  volume   1 GB                           : ~`$" + $RATE_VOL)
Write-Output ("  bandwidth (light traffic)               : ~`$0-1")
Write-Output ("  ---------------------------------------------")
Write-Output ("  TOTAL                                   : ~`$" + [math]::Round($RATE_512 + $RATE_VOL, 2) + " / month")
Write-Output ""
Write-Output "  Cheaper option: drop the machine to 256MB (~`$$RATE_256/mo) if memory allows."
Write-Output "  Danger: every EXTRA machine adds its full cost again, and a second machine would"
Write-Output "  also split the SQLite ledger. There must only ever be ONE."

Write-Output ""
Write-Output "=== SAFETY CHECKS ==="
$count = ($machines | Select-String -Pattern "^[0-9a-f]{10,}" ).Count
if ($count -gt 1) { Write-Output "  !! $count machines running - EXPECTED 1. Run: fly scale count 1" }
elseif ($count -eq 1) { Write-Output "  OK  exactly 1 machine" }
else { Write-Output "  (no machines yet - not deployed)" }

$toml = Get-Content "fly.toml" -Raw
if ($toml -match "auto_stop_machines = false") { Write-Output "  OK  scale-to-zero disabled (rounds keep running)" } else { Write-Output "  !! auto_stop_machines is not false" }
if ($toml -match "min_machines_running = 1") { Write-Output "  OK  pinned to 1 always-on machine" } else { Write-Output "  !! min_machines_running is not 1" }
if ($toml -match "memory = `"512mb`"") { Write-Output "  OK  memory pinned to 512mb" } else { Write-Output "  !! memory size changed - re-check cost" }

Write-Output ""
Write-Output "Live billing page: https://fly.io/dashboard/mjcryptoofficial-gmail-com/billing"
