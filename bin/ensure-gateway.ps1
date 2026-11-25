# Deployed to ~/.dori/bin/ensure-gateway.ps1; the DoriGatewayGuard task runs it every minute. The guard program owns the
# tree kill and the hidden supervisor spawn, so this launcher only finds bun and the program and keeps the exit code.
param([string]$Guard = "")

$ErrorActionPreference = "Stop"
$doriHome = if ($env:DORI_HOME) { $env:DORI_HOME } else { Join-Path $env:USERPROFILE ".dori" }

$candidates = @()
if ($Guard -ne "") { $candidates += $Guard }
$candidates += (Join-Path $doriHome "src\src\supervisors\ensure-gateway.ts")
$candidates += (Join-Path $doriHome "bin\ensure-gateway.ts")
$program = $null
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $program = $candidate; break }
}
if ($null -eq $program) {
    "GUARD UNAVAILABLE home=$doriHome tried=$($candidates -join ',')"
    exit 1
}

$bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
if (-not (Test-Path -LiteralPath $bun -PathType Leaf)) {
    $found = Get-Command bun.exe -ErrorAction SilentlyContinue
    if ($null -eq $found) { $found = Get-Command bun -ErrorAction SilentlyContinue }
    if ($null -eq $found) {
        "GUARD UNAVAILABLE bun=missing"
        exit 1
    }
    $bun = $found.Source
}

& $bun $program
exit $LASTEXITCODE
