#requires -Version 7.0
param([Parameter(Mandatory)][string]$BundleDirectory, [ValidateSet('Oats-Setup.exe','Oats-Repair.exe')][string]$ArtifactName = 'Oats-Setup.exe', [string]$IdentityRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'oats-release-signing'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Get-SetupSigningMaximum($Manifest, [string]$Name) {
    $maximum = 8MB
    if ($Name -eq 'Oats-Setup.exe' -and $Manifest.PSObject.Properties['app_installer_bytes']) {
        $bytes = [long]$Manifest.app_installer_bytes
        if ($bytes -lt 3 -or $bytes -gt 512MB -or -not $Manifest.PSObject.Properties['app_installer_sha256'] -or $Manifest.app_installer_sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid embedded app installer bounds' }
        $maximum += $bytes
    }
    return $maximum
}
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$directory = (Resolve-Path -LiteralPath $BundleDirectory).Path
$installer = Join-Path $directory $ArtifactName
$public = Join-Path $IdentityRoot 'oats-updater.key.pub'
$key = Join-Path $IdentityRoot 'oats-updater.key'
$protected = Join-Path $IdentityRoot 'password.dpapi'
foreach ($path in @($key, $public, $protected)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'The existing oats signing identity is required. No identity was created.' } }
$bundle = Get-Content -Raw -LiteralPath (Join-Path $directory 'bundle.json') | ConvertFrom-Json
if ($bundle.app_version -notmatch '^0\.\d+\.\d+$' -or $bundle.id -notmatch '^[a-f0-9]{20}$') { throw 'Invalid complete-setup manifest' }
$cli = Join-Path $repository 'frontend/node_modules/@tauri-apps/cli/tauri.js'
# Reuse ACL, ownership, CLI version and key-pair verification from the standard
# release helper before decrypting anything for this separate artifact.
$null = & (Join-Path $repository 'scripts/local-release-signing.ps1') -Mode Ensure -IdentityRoot $IdentityRoot -TauriCliPath $cli
$lock = [IO.FileStream]::new((Join-Path $IdentityRoot 'identity.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$passwordBytes = $null
$password = $null
try {
    $file = Get-Item -LiteralPath $installer
    if ($file.Length -gt (Get-SetupSigningMaximum $bundle $ArtifactName) -or $file.Length -lt 1024 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Setup executable exceeds its verified app payload and bootstrap bounds, or is not an ordinary file' }
    $readLock = [IO.FileStream]::new($installer, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if (-not (Test-Path -LiteralPath "$installer.sig")) {
            Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
            $entropy = [Text.Encoding]::UTF8.GetBytes('oats/local-release-signing/password/v1')
            $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($protected), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
            $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
            $start = [Diagnostics.ProcessStartInfo]::new((Get-Command node.exe -ErrorAction Stop).Source)
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            foreach ($arg in @($cli, 'signer', 'sign', '--app-version', $bundle.app_version, $installer)) { $start.ArgumentList.Add($arg) }
            foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_PRIVATE_KEY', 'TAURI_PRIVATE_KEY_PATH', 'TAURI_KEY_PASSWORD')) { $null = $start.Environment.Remove($name) }
            $start.Environment['TAURI_SIGNING_PRIVATE_KEY_PATH'] = $key
            $start.Environment['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = $password
            $process = [Diagnostics.Process]::Start($start)
            try {
                $stdout = $process.StandardOutput.ReadToEndAsync()
                $stderr = $process.StandardError.ReadToEndAsync()
                if (-not $process.WaitForExit(120000)) { $process.Kill($true); throw 'Setup signing timed out' }
                $null = $stdout.GetAwaiter().GetResult()
                $null = $stderr.GetAwaiter().GetResult()
                if ($process.ExitCode -ne 0) { throw 'Setup signing failed; private signer output was suppressed' }
            } finally { $process.Dispose() }
        }
        $verifier = Join-Path $repository 'scripts/windows-update-feed.cjs'
        $check = 'const fs=require("fs"),v=require(process.argv[1]);v.verifySignedInstaller(fs.readFileSync(process.argv[2]),fs.readFileSync(process.argv[2]+".sig","utf8"),fs.readFileSync(process.argv[3],"utf8"),process.argv[4]);console.log("Complete-setup signature verified");'
        & node -e $check $verifier $installer $public $bundle.app_version
        if ($LASTEXITCODE -ne 0) { throw 'Complete-setup signature verification failed' }
    } finally { $readLock.Dispose() }
} finally {
    if ($passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    $password = $null
    $lock.Dispose()
}
