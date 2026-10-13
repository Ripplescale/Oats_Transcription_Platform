#requires -Version 7.0
param(
    [ValidateSet('Ensure', 'Build', 'Sign')][string]$Mode = 'Ensure',
    [Parameter(Mandatory)][string]$TauriCliPath,
    [string]$IdentityRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'oats-release-signing'),
    [string]$DataRoot = '',
    [string]$TargetRoot = 'C:\STTBuild\target',
    [string]$BuildToolsPath = 'C:\BuildTools-STT',
    [string]$LabRoot = '',
    [switch]$DebugBuild,
    [switch]$SkipFrontend
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Local signing uses Windows CurrentUser DPAPI.' }
Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$cli = (Resolve-Path -LiteralPath $TauriCliPath).Path
$cliPackage = Get-Content -LiteralPath (Join-Path (Split-Path $cli) 'package.json') -Raw | ConvertFrom-Json
if ($cliPackage.name -ne '@tauri-apps/cli' -or $cliPackage.version -ne '2.12.0') { throw 'Use the reviewed released Tauri CLI 2.12.0 for local signing.' }
if (-not [IO.Path]::IsPathFullyQualified($IdentityRoot)) { throw 'Signing identity requires an absolute directory outside the repository.' }
$IdentityRoot = [IO.Path]::GetFullPath($IdentityRoot).TrimEnd('\', '/')
if ($IdentityRoot -eq $repositoryRoot -or $IdentityRoot.StartsWith($repositoryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Never store a durable signing identity inside the source checkout, including ignored folders.' }
if ($IdentityRoot -match '(^|[\\/])OneDrive([^\\/]*)([\\/]|$)') { throw 'Signing identity must stay outside OneDrive.' }
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allowedSids = @($currentSid.Value, $systemSid.Value)
$entropy = [Text.Encoding]::UTF8.GetBytes('oats/local-release-signing/password/v1')
$privatePath = Join-Path $IdentityRoot 'oats-updater.key'
$publicPath = "$privatePath.pub"
$passwordPath = Join-Path $IdentityRoot 'password.dpapi'
$metadataPath = Join-Path $IdentityRoot 'identity.json'
$verifier = Join-Path $PSScriptRoot 'windows-update-feed.cjs'

function Assert-NoLinks([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Signing paths cannot contain links or reparse points.' }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Assert-PrivateAcl([string]$Path, [bool]$Directory = $false) {
    Assert-NoLinks $Path
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -ne $Directory) { throw 'Unexpected signing identity file type.' }
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids) { throw 'Signing identity is owned by a different account.' }
    if ($Directory -and -not $acl.AreAccessRulesProtected) { throw 'Signing directory must have private, non-inherited permissions.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $allowedSids) { throw 'Signing identity grants access beyond this Windows user and SYSTEM.' }
    }
}
function Write-NewBytes([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Invoke-PrivateNode([string[]]$Arguments, [string]$Password = '', [string]$KeyPath = '') {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_PRIVATE_KEY', 'TAURI_PRIVATE_KEY_PATH', 'TAURI_KEY_PASSWORD')) { $null = $start.Environment.Remove($name) }
    if ($KeyPath) { $start.Environment['TAURI_SIGNING_PRIVATE_KEY_PATH'] = $KeyPath }
    if ($Password) { $start.Environment['TAURI_SIGNING_PRIVATE_KEY_PASSWORD'] = $Password }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Child failed to start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(120000)) { $process.Kill($true); $process.WaitForExit(); throw 'Child timed out.' }
        # Never emit signer output or secret-bearing process arguments, even on failure.
        $null = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Child failed.' }
    } catch { throw 'Local signing operation failed. The existing identity was not replaced; no signer output was exposed.' }
    finally { $process.Dispose() }
}
function Get-PublicIdentity {
    $encoded = [IO.File]::ReadAllText($publicPath).Trim()
    if ($encoded.Length -gt 16384) { throw 'Invalid updater public key.' }
    try {
        $box = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
        $lines = $box.TrimEnd().Split("`n")
        $raw = [Convert]::FromBase64String($lines[1].Trim())
        if ($lines.Count -ne 2 -or $raw.Length -ne 42) { throw 'Invalid key.' }
        $fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($raw)).ToLowerInvariant()
    } catch { throw 'The existing updater public key is invalid. It was not replaced.' }
    return @{ Encoded = $encoded; Fingerprint = $fingerprint }
}

Assert-NoLinks $IdentityRoot
if ($Mode -eq 'Sign' -and -not (Test-Path -LiteralPath $IdentityRoot)) { throw 'Sign-only recovery requires the existing build signing identity. No replacement identity was created.' }
if (-not (Test-Path -LiteralPath $IdentityRoot)) {
    $null = New-Item -ItemType Directory -Path $IdentityRoot
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, $systemSid)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $IdentityRoot -AclObject $acl
}
Assert-PrivateAcl $IdentityRoot $true
$lock = $null
$passwordBytes = $null
$password = $null
$previousEnvironment = @{}
$installerPath = $null
try {
    $lockPath = Join-Path $IdentityRoot 'identity.lock'
    Assert-NoLinks $lockPath
    $lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $present = @(@($privatePath, $publicPath, $passwordPath, $metadataPath) | Where-Object { Test-Path -LiteralPath $_ })
    $created = $present.Count -eq 0
    if ($Mode -eq 'Sign' -and $created) { throw 'Sign-only recovery requires the existing build signing identity. No replacement identity was created.' }
    if ($present.Count -ne 0 -and $present.Count -ne 4) { throw 'The signing identity is incomplete. Preserve and inspect this folder; no key or password was overwritten.' }
    if ($created) {
        $random = [byte[]]::new(48)
        [Security.Cryptography.RandomNumberGenerator]::Fill($random)
        $password = [Convert]::ToBase64String($random)
        [Array]::Clear($random, 0, $random.Length)
        $passwordBytes = [Text.Encoding]::UTF8.GetBytes($password)
        $protected = [Security.Cryptography.ProtectedData]::Protect($passwordBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        Write-NewBytes $passwordPath $protected
        # Tauri 2.12 generate supports a password argument, not a password env
        # input. Use it once internally; capture all output. Later sign/build
        # operations use process environment instead of secret arguments.
        Invoke-PrivateNode @($cli, 'signer', 'generate', '--ci', '--password', $password, '--write-keys', $privatePath)
        $public = Get-PublicIdentity
        $metadata = @{ version = 1; public_key_sha256 = $public.Fingerprint; windows_user_sid = $currentSid.Value; created_at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
        Write-NewBytes $metadataPath ([Text.Encoding]::UTF8.GetBytes($metadata))
    }
    foreach ($file in @($privatePath, $publicPath, $passwordPath, $metadataPath)) { Assert-PrivateAcl $file }
    $public = Get-PublicIdentity
    $metadata = [IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
    if ($metadata.version -ne 1 -or $metadata.public_key_sha256 -ne $public.Fingerprint -or $metadata.windows_user_sid -ne $currentSid.Value) { throw 'Signing identity metadata does not match this account and public key. Nothing was replaced.' }
    if (-not $password) {
        try { $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($passwordPath), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
        catch { throw 'This Windows account cannot decrypt the saved signing password. Preserve the existing identity; do not generate a replacement.' }
        $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
    }
    # Prove the encrypted private key, protected password and public key match
    # before enabling the app or building with this identity. This is not an EXE.
    $probe = Join-Path $IdentityRoot ('probe-' + [guid]::NewGuid().ToString('N'))
    try {
        Write-NewBytes $probe ([Text.Encoding]::UTF8.GetBytes('MZ oats signing identity challenge; never execute'))
        Invoke-PrivateNode @($cli, 'signer', 'sign', '--app-version', '0.0.0', $probe) $password $privatePath
        $check = 'const fs=require("fs"),v=require(process.argv[1]);v.verifySignedInstaller(fs.readFileSync(process.argv[2]),fs.readFileSync(process.argv[2]+".sig","utf8"),fs.readFileSync(process.argv[3],"utf8"),"0.0.0");'
        Invoke-PrivateNode @('-e', $check, $verifier, $probe, $publicPath)
    } finally {
        foreach ($temporary in @($probe, "$probe.sig")) { if (Test-Path -LiteralPath $temporary -PathType Leaf) { [IO.File]::Delete($temporary) } }
    }
    if ($Mode -eq 'Build') {
        if (-not $DataRoot) { throw 'Build requires the existing local STTApp DataRoot.' }
        $environment = @{ TAURI_SIGNING_PRIVATE_KEY = $privatePath; TAURI_SIGNING_PRIVATE_KEY_PATH = $null; TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password; OATS_UPDATER_PUBLIC_KEY = $public.Encoded }
        foreach ($name in $environment.Keys) {
            $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
        }
        $build = Join-Path $repositoryRoot 'frontend/src-tauri/scripts/build-local-windows.ps1'
        $options = @{ Mode = 'Package'; DataRoot = $DataRoot; TargetRoot = $TargetRoot; BuildToolsPath = $BuildToolsPath; TauriCliPath = $cli; CreateUpdaterArtifacts = $true; DebugBuild = $DebugBuild; SkipFrontend = $SkipFrontend }
        if ($LabRoot) { $options.LabRoot = $LabRoot }
        & $build @options
        if (-not $?) { throw 'The signed local package build failed.' }
    }
    if ($Mode -in @('Build', 'Sign')) {
        $version = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'frontend/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
        if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'The installer requires a stable three-part version.' }
        if (-not [IO.Path]::IsPathFullyQualified($TargetRoot)) { throw 'The build target requires an absolute path.' }
        $profile = if ($DebugBuild) { 'debug' } else { 'release' }
        $installerPath = Join-Path $TargetRoot "x86_64-pc-windows-msvc/$profile/bundle/nsis/oats_${version}_x64-setup.exe"
        $verify = 'const fs=require("fs"),v=require(process.argv[1]);v.verifySignedInstaller(fs.readFileSync(process.argv[2]),fs.readFileSync(process.argv[2]+".sig","utf8"),fs.readFileSync(process.argv[3],"utf8"),process.argv[4]);'
        $installer = Get-Item -LiteralPath $installerPath -Force
        if ($installer.PSIsContainer -or ($installer.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $installer.Length -lt 3 -or $installer.Length -gt 512MB) { throw 'The installer must be a bounded ordinary file.' }
        if ($installer.VersionInfo.ProductVersion -ne $version -or $installer.VersionInfo.FileVersion -ne $version) { throw 'The installer Windows version does not match the requested release. It was not signed.' }
        # Keep the finished installer immutable while signer/verifier read it.
        # Sign mode does not compile or rebundle.
        $artifactRead = [IO.FileStream]::new($installerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            if ($Mode -eq 'Sign' -and -not (Test-Path -LiteralPath "$installerPath.sig")) {
                Invoke-PrivateNode @($cli, 'signer', 'sign', '--app-version', $version, $installerPath) $password $privatePath
            }
            # An existing signature is only verified; never silently replaced.
            $signature = Get-Item -LiteralPath "$installerPath.sig" -Force
            if ($signature.PSIsContainer -or ($signature.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The installer signature must be an ordinary file.' }
            Invoke-PrivateNode @('-e', $verify, $verifier, $installerPath, $publicPath, $version)
        } finally { $artifactRead.Dispose() }
    }
    [pscustomobject]@{ PublicKeyPath = $publicPath; PublicKeySha256 = $public.Fingerprint; Created = $created; Mode = $Mode; InstallerPath = $installerPath }
} finally {
    foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    if ($passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    $password = $null
    if ($lock) { $lock.Dispose() }
}
