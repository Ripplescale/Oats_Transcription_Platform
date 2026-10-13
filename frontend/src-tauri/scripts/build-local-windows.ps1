param(
    [ValidateSet('Check', 'Build', 'Package')]
    [string]$Mode = 'Build',
    [string]$BuildToolsPath = 'C:\BuildTools-STT',
    [string]$LabRoot = '',
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'STTApp'),
    [string]$TargetRoot = 'C:\STTBuild\target',
    [string]$TauriCliPath = '',
    [switch]$CreateUpdaterArtifacts,
    [switch]$DebugBuild,
    [switch]$SkipFrontend
)
$ErrorActionPreference = 'Stop'
$nativeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$frontendRoot = (Resolve-Path (Join-Path $nativeRoot '..')).Path
$repositoryRoot = (Resolve-Path (Join-Path $frontendRoot '..')).Path
$updaterPublicKey = ''
if ($CreateUpdaterArtifacts) {
    $updaterPublicKey = [string]$env:OATS_UPDATER_PUBLIC_KEY
    if (-not $updaterPublicKey.Trim()) { throw 'Signed updater artifacts require OATS_UPDATER_PUBLIC_KEY before building.' }
    $updaterPublicKey = $updaterPublicKey.Trim()
    $validationNode = (Get-Command node.exe -ErrorAction Stop).Source
    $validateKey = 'require(process.argv[1]).parsePublicKey(process.env.OATS_UPDATER_PUBLIC_KEY);'
    $validationOutput = & $validationNode -e $validateKey (Join-Path $repositoryRoot 'scripts/windows-update-feed.cjs') 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'OATS_UPDATER_PUBLIC_KEY is not a valid Tauri public key. No build was started.' }
}
if (-not $LabRoot) { $LabRoot = Join-Path $DataRoot 'lab' }
if (-not [System.IO.Path]::IsPathRooted($DataRoot) -or $DataRoot -match '(^|[\\/])OneDrive([^\\/]*)([\\/]|$)') {
    throw 'DataRoot must be an absolute local path outside OneDrive.'
}
if (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'runtime.json') -PathType Leaf)) {
    throw "The local STT runtime has not been installed at $DataRoot"
}
$binariesRoot = Join-Path $nativeRoot 'binaries'
New-Item -ItemType Directory -Path $binariesRoot -Force | Out-Null
$installData = @{data_root=$DataRoot} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $binariesRoot 'sttapp-local-install.json'), $installData, [System.Text.UTF8Encoding]::new($false))
$rustRoot = Join-Path $LabRoot 'rust'
$rustBin = Join-Path $rustRoot 'rustup\toolchains\stable-x86_64-pc-windows-msvc\bin'
$cargoExe = Join-Path $rustBin 'cargo.exe'
$devShell = Join-Path $BuildToolsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
if (-not (Test-Path -LiteralPath $cargoExe)) { throw "Missing isolated Rust MSVC toolchain: $cargoExe" }
if (-not (Test-Path -LiteralPath $devShell)) { throw "Missing Microsoft C++ Build Tools: $devShell" }
Import-Module $devShell
Enter-VsDevShell -VsInstallPath $BuildToolsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null

# Ship the release C++ runtime beside the executable. Installing the compiler on
# a development machine must not be an undeclared runtime requirement.
$redistRoot = Join-Path $BuildToolsPath 'VC\Redist\MSVC'
$redistVersion = Get-ChildItem -LiteralPath $redistRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $redistVersion) { throw "Missing Microsoft release C++ redistributables at $redistRoot" }
$crtSource = Join-Path $redistVersion.FullName 'x64\Microsoft.VC143.CRT'
$crtTarget = Join-Path $binariesRoot 'msvc-runtime'
New-Item -ItemType Directory -Path $crtTarget -Force | Out-Null
$crtFiles = @(Get-ChildItem -LiteralPath $crtSource -Filter '*.dll' -File)
if ($crtFiles.Count -eq 0) { throw "No release C++ runtime DLLs found at $crtSource" }
foreach ($crtFile in $crtFiles) {
    $signature = Get-AuthenticodeSignature -LiteralPath $crtFile.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "Unverified Microsoft runtime DLL: $($crtFile.FullName)"
    }
    Copy-Item -LiteralPath $crtFile.FullName -Destination (Join-Path $crtTarget $crtFile.Name) -Force
}

# Environment changes apply only to this build process. All caches stay outside OneDrive.
$env:CARGO_HOME = Join-Path $rustRoot 'cargo'
$env:RUSTUP_HOME = Join-Path $rustRoot 'rustup'
$env:RUSTC = Join-Path $rustBin 'rustc.exe'
$env:RUSTDOC = Join-Path $rustBin 'rustdoc.exe'
$env:PATH = "$rustBin;$env:PATH"
# MSBuild still rejects generated paths over 260 characters. A short junction
# keeps the cache physically private while avoiding that compiler limitation.
$privateTarget = Join-Path $rustRoot 'app-target'
New-Item -ItemType Directory -Path $privateTarget -Force | Out-Null
if (-not (Test-Path -LiteralPath $TargetRoot)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $TargetRoot) -Force | Out-Null
    New-Item -ItemType Junction -Path $TargetRoot -Target $privateTarget | Out-Null
}
$env:CARGO_TARGET_DIR = $TargetRoot
$env:CARGO_BUILD_JOBS = '1'
$env:CMAKE_BUILD_PARALLEL_LEVEL = '1'
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_PROFILE_RELEASE_DEBUG = '0'
# The crate's pre-generated bindings use Linux ABI sizes. Generate Windows
# bindings with the pinned LLVM libclang library instead.
Remove-Item Env:WHISPER_DONT_GENERATE_BINDINGS -ErrorAction SilentlyContinue
$env:LIBCLANG_PATH = Join-Path $LabRoot 'windows-build\libclang\libclang-18.1.1.data\platlib\clang\native'
if (-not (Test-Path -LiteralPath (Join-Path $env:LIBCLANG_PATH 'libclang.dll'))) {
    throw "Missing private libclang build dependency at $env:LIBCLANG_PATH"
}
# ONNX is loaded dynamically; build.rs separately verifies the pinned Microsoft
# runtime files. Avoid ort-sys fetching a second unneeded runtime distribution.
$env:ORT_LIB_LOCATION = Join-Path $binariesRoot 'onnxruntime'

Push-Location $nativeRoot
try {
    if ($Mode -eq 'Check') {
        & $cargoExe check --locked --package xx --target x86_64-pc-windows-msvc -j 1
    } else {
        $tauriCli = if ($TauriCliPath) { (Resolve-Path -LiteralPath $TauriCliPath).Path } else { Join-Path $frontendRoot 'node_modules\@tauri-apps\cli\tauri.js' }
        if (-not (Test-Path -LiteralPath $tauriCli)) { throw 'Install the frozen frontend lockfile before building.' }
        $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
        $tauriArguments = @($tauriCli, 'build', '--target', 'x86_64-pc-windows-msvc')
        if ($DebugBuild) { $tauriArguments += '--debug' }
        if ($Mode -eq 'Build') { $tauriArguments += '--no-bundle' }
        else { $tauriArguments += @('--bundles', 'nsis') }
        $configOverrides = @{}
        if ($CreateUpdaterArtifacts) {
            $configOverrides.bundle = @{ createUpdaterArtifacts = $true }
            # CLI signing reads configuration independently of the native override.
            $configOverrides.plugins = @{ updater = @{ pubkey = $updaterPublicKey; requireSignedVersion = $true } }
        }
        if ($SkipFrontend) {
            if (-not (Test-Path -LiteralPath (Join-Path $frontendRoot 'out\index.html'))) {
                throw 'SkipFrontend requires an existing checked frontend/out export.'
            }
            $configOverrides.build = @{ beforeBuildCommand = '' }
        }
        if ($configOverrides.Count) { $tauriArguments += @('--config', ($configOverrides | ConvertTo-Json -Depth 8 -Compress)) }
        $tauriArguments += @('--', '--locked', '-j', '1')
        & $nodeExe @tauriArguments
    }
    if ($LASTEXITCODE -ne 0) { throw "Windows $Mode failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
