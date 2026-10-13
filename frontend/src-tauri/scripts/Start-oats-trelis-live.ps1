param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$trelisExecutable = (Resolve-Path -LiteralPath $Executable).Path
if (-not (Test-Path -LiteralPath $trelisExecutable -PathType Leaf) -or [IO.Path]::GetExtension($trelisExecutable) -ne '.exe') {
    throw 'Choose the checked oats build with live Trelis dictation.'
}
$trelisAppDirectory = Split-Path -Parent $trelisExecutable
foreach ($trelisResource in @('dictation_worker.py', 'sttapp-local-install.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $trelisAppDirectory $trelisResource) -PathType Leaf)) {
        throw "The oats build is missing $trelisResource."
    }
}
$trelisInstall = Get-Content -LiteralPath (Join-Path $trelisAppDirectory 'sttapp-local-install.json') -Raw | ConvertFrom-Json
if (-not ($trelisInstall.data_root -is [string]) -or -not [IO.Path]::IsPathRooted($trelisInstall.data_root)) {
    throw 'The app must use the existing local oats data directory.'
}
$trelisRuntimePath = Join-Path $trelisInstall.data_root 'runtime.json'
$trelisRuntime = Get-Content -LiteralPath $trelisRuntimePath -Raw | ConvertFrom-Json
if ($trelisRuntime.PSObject.Properties.Name -contains 'dictation_backend' -and $trelisRuntime.dictation_backend -ne 'trelis') {
    throw 'The existing runtime must select Trelis.'
}
foreach ($trelisPath in @($trelisRuntime.python_executable, $trelisRuntime.worker_script, $trelisRuntime.registry_path)) {
    if (-not ($trelisPath -is [string]) -or -not [IO.Path]::IsPathRooted($trelisPath) -or -not (Test-Path -LiteralPath $trelisPath -PathType Leaf)) {
        throw 'The existing Trelis runtime needs setup.'
    }
}
if (Get-Process -Name xx -ErrorAction SilentlyContinue) {
    throw 'Save your notes and fully close oats, including its tray icon, before switching builds.'
}
$trelisPreviousEnvironment = @{}
foreach ($trelisEnvironmentName in @('OATS_DICTATION_RUNTIME', 'STTAPP_DATA_DIR', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE')) {
    $trelisPreviousEnvironment[$trelisEnvironmentName] = [Environment]::GetEnvironmentVariable($trelisEnvironmentName, 'Process')
}
try {
    # Select the original runtime explicitly, overriding the retired experiment
    # and any separate dictation config without changing either file.
    $env:OATS_DICTATION_RUNTIME = $trelisRuntimePath
    $env:STTAPP_DATA_DIR = $trelisInstall.data_root
    $env:HF_HUB_OFFLINE = '1'
    $env:TRANSFORMERS_OFFLINE = '1'
    Start-Process -FilePath $trelisExecutable -WorkingDirectory $trelisAppDirectory -WindowStyle Hidden
} finally {
    foreach ($trelisEnvironmentName in $trelisPreviousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($trelisEnvironmentName, $trelisPreviousEnvironment[$trelisEnvironmentName], 'Process')
    }
}
