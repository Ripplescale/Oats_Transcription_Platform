param(
    [string]$DataRoot = '',
    [string]$AppPath = (Join-Path $PSScriptRoot 'xx.exe')
)
$ErrorActionPreference = 'Stop'
if (-not $DataRoot) {
    $installationManifest = Join-Path (Split-Path -Parent $AppPath) 'sttapp-local-install.json'
    $savedLocation = Join-Path $env:LOCALAPPDATA 'STTApp\data-location.json'
    if ($env:STTAPP_DATA_DIR) { $DataRoot = $env:STTAPP_DATA_DIR }
    elseif (Test-Path -LiteralPath $savedLocation) {
        try {
            $savedFile = Get-Item -LiteralPath $savedLocation
            if ($savedFile.PSIsContainer -or ($savedFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Expected an ordinary local file.' }
            $DataRoot = (Get-Content -LiteralPath $savedLocation -Raw | ConvertFrom-Json -ErrorAction Stop).data_root
            if (-not ($DataRoot -is [string]) -or -not [IO.Path]::IsPathRooted($DataRoot)) { throw 'The data_root must be an absolute local path.' }
        } catch { throw 'The saved STTApp data-location.json is invalid or unreadable. Repair that saved location before starting oats; no alternate data folder was opened.' }
    }
    elseif (Test-Path -LiteralPath $installationManifest -PathType Leaf) {
        $DataRoot = (Get-Content -LiteralPath $installationManifest -Raw | ConvertFrom-Json).data_root
    } else { $DataRoot = Join-Path $env:LOCALAPPDATA 'STTApp' }
}
if (-not [System.IO.Path]::IsPathRooted($DataRoot)) { throw 'DataRoot must be an absolute private local path.' }
if ($DataRoot -match '(^|[\\/])OneDrive([^\\/]*)([\\/]|$)') { throw 'DataRoot must be outside OneDrive.' }
if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) { throw "Application executable not found: $AppPath" }
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'runtime.json') -PathType Leaf)) {
    throw "Local model runtime has not been configured at $DataRoot. Run the local worker installer first."
}
$previousEnvironment = @{}
foreach ($name in @('STTAPP_DATA_DIR', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:STTAPP_DATA_DIR = $DataRoot
    $env:HF_HUB_OFFLINE = '1'
    $env:TRANSFORMERS_OFFLINE = '1'
    # The GUI only starts. Recording requires the user's explicit Record click.
    Start-Process -FilePath $AppPath -WorkingDirectory (Split-Path -Parent $AppPath) -WindowStyle Normal
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}
