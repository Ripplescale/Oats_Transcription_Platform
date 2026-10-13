$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$launcher = Join-Path $repository 'frontend/src-tauri/scripts/Start-xx.ps1'
$fixture = Join-Path $repository ('target/launcher-location-' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $fixture 'app/xx.exe'
$local = Join-Path $fixture 'local'
$choice = Join-Path $local 'STTApp/data-location.json'
$saved = Join-Path $fixture 'saved-notes'
$legacy = Join-Path $fixture 'legacy-notes'
$explicit = Join-Path $fixture 'explicit-notes'
$previousLocal = $env:LOCALAPPDATA
$previousRoot = $env:STTAPP_DATA_DIR
$launches = [Collections.Generic.List[string]]::new()
# The launcher resolves this function instead of the OS process cmdlet.
# No executable, microphone, installed app or real data directory is opened.
function Start-Process {
    param($FilePath, $WorkingDirectory, $WindowStyle)
    if ($FilePath -ne $app) { throw 'Unexpected application path.' }
    $launches.Add($env:STTAPP_DATA_DIR)
}
function Write-Choice($file, $value) {
    [IO.File]::WriteAllText($file, (@{ data_root = $value } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
try {
    foreach ($directory in @((Split-Path $app), (Split-Path $choice), $saved, $legacy, $explicit)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    [IO.File]::WriteAllText($app, 'synthetic fixture, never executed')
    foreach ($directory in @($saved, $legacy, $explicit)) { [IO.File]::WriteAllText((Join-Path $directory 'runtime.json'), '{}') }
    Write-Choice (Join-Path (Split-Path $app) 'sttapp-local-install.json') $legacy
    Write-Choice $choice $saved
    $env:LOCALAPPDATA = $local
    $env:STTAPP_DATA_DIR = $null
    & $launcher -AppPath $app
    if ($launches.Count -ne 1 -or $launches[0] -ne $saved) { throw 'Saved choice did not override legacy marker.' }
    [IO.File]::WriteAllText($choice, 'invalid JSON')
    $blocked = $false
    try { & $launcher -AppPath $app } catch { $blocked = $_.Exception.Message -match 'saved STTApp data-location.json' }
    if (-not $blocked -or $launches.Count -ne 1) { throw 'Invalid saved choice did not block launch.' }
    $env:STTAPP_DATA_DIR = $explicit
    & $launcher -AppPath $app
    if ($launches.Count -ne 2 -or $launches[1] -ne $explicit) { throw 'Explicit environment did not win.' }
    & $launcher -AppPath $app -DataRoot $saved
    if ($launches.Count -ne 3 -or $launches[2] -ne $saved) { throw 'Explicit launcher argument did not win.' }
    $env:STTAPP_DATA_DIR = $null
    [IO.File]::Delete($choice) # Only this test's generated file.
    & $launcher -AppPath $app
    if ($launches.Count -ne 4 -or $launches[3] -ne $legacy) { throw 'Legacy fallback did not preserve its location.' }
    '5 launcher location cases passed; no process was started.'
} finally {
    $env:LOCALAPPDATA = $previousLocal
    $env:STTAPP_DATA_DIR = $previousRoot
}
