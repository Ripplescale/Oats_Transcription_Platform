param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$RuntimeConfig
)
$ErrorActionPreference = 'Stop'
throw 'The faster-whisper dictation experiment was retired after failing real-speech recognition. Use Start-oats-trelis-live.ps1 with the checked live-dictation build instead.'
$dictationExe = (Resolve-Path -LiteralPath $Executable).Path
$dictationConfig = (Resolve-Path -LiteralPath $RuntimeConfig).Path
if (-not (Test-Path -LiteralPath $dictationExe -PathType Leaf) -or [IO.Path]::GetExtension($dictationExe) -ne '.exe') {
    throw 'Choose the checked experimental oats executable.'
}
$dictationAppDirectory = Split-Path -Parent $dictationExe
foreach ($dictationResource in @('dictation_worker.py', 'faster_whisper_dictation.py', 'sttapp-local-install.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dictationAppDirectory $dictationResource) -PathType Leaf)) {
        throw "The experimental app is missing $dictationResource beside its executable."
    }
}
$dictationInstall = Get-Content -LiteralPath (Join-Path $dictationAppDirectory 'sttapp-local-install.json') -Raw | ConvertFrom-Json
if (-not ($dictationInstall.data_root -is [string]) -or
    -not [IO.Path]::IsPathRooted($dictationInstall.data_root) -or
    -not (Test-Path -LiteralPath $dictationInstall.data_root -PathType Container)) {
    throw 'The experimental app must be bound to the existing local oats data directory.'
}
$dictationSettings = Get-Content -LiteralPath $dictationConfig -Raw | ConvertFrom-Json
if ($dictationSettings.dictation_backend -ne 'faster_whisper') {
    throw 'This launcher requires an explicit faster_whisper dictation configuration.'
}
if (-not (Test-Path -LiteralPath $dictationSettings.python_executable -PathType Leaf)) {
    throw 'The isolated dictation Python environment is unavailable.'
}
foreach ($dictationAsset in @('model.bin', 'config.json', 'tokenizer.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dictationSettings.faster_whisper.model_path $dictationAsset) -PathType Leaf)) {
        throw "The local dictation model is missing $dictationAsset."
    }
}
if (Get-Process -Name xx -ErrorAction SilentlyContinue) {
    throw 'Save your notes and close oats, including its tray icon, before launching the experimental build.'
}
# The selection belongs only to this child process. No installed runtime or
# system environment setting is changed, and no running app is terminated.
$previousDictationRuntime = $env:OATS_DICTATION_RUNTIME
$previousDictationDataRoot = $env:STTAPP_DATA_DIR
try {
    $env:OATS_DICTATION_RUNTIME = $dictationConfig
    $env:STTAPP_DATA_DIR = $dictationInstall.data_root
    Start-Process -FilePath $dictationExe -WorkingDirectory $dictationAppDirectory -WindowStyle Hidden
} finally {
    if ($null -eq $previousDictationRuntime) { Remove-Item Env:OATS_DICTATION_RUNTIME -ErrorAction SilentlyContinue }
    else { $env:OATS_DICTATION_RUNTIME = $previousDictationRuntime }
    if ($null -eq $previousDictationDataRoot) { Remove-Item Env:STTAPP_DATA_DIR -ErrorAction SilentlyContinue }
    else { $env:STTAPP_DATA_DIR = $previousDictationDataRoot }
}
