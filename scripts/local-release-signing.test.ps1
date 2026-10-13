#requires -Version 7.0
param([Parameter(Mandatory)][string]$TauriCliPath, [string]$InstallerFixture = '')
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'local-release-signing.ps1'
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$qaRoot = Join-Path $temporaryRoot ('oats-signing-qa-' + [guid]::NewGuid().ToString('N'))
$checks = 0
function Set-QAAccess([bool]$Broader) {
    # icacls changes only the DACL. Set-Acl can request SACL privileges while
    # changing an existing protected ACL, which is unrelated to this test.
    $icacls = Join-Path $env:SystemRoot 'System32/icacls.exe'
    if ($Broader) { $null = & $icacls $qaRoot /grant '*S-1-5-32-545:(R)' /q }
    else { $null = & $icacls $qaRoot /remove:g '*S-1-5-32-545' /q }
    if ($LASTEXITCODE -ne 0) { throw 'Could not change the QA-only ACL.' }
}
try {
    $first = & $helper -Mode Ensure -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot
    if (-not $first.Created -or -not $first.PublicKeySha256) { throw 'QA identity was not created and verified.' }
    $checks += 1
    $key = Join-Path $qaRoot 'oats-updater.key'
    # Exercise the actual build helper's validation/overlay branches without
    # entering its compiler or resource-copying paths.
    $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $tokens = $null; $errors = $null
    $buildAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repositoryRoot 'frontend/src-tauri/scripts/build-local-windows.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'The build helper has syntax errors.' }
    $updaterBranches = @($buildAst.FindAll({ param($ast) $ast -is [Management.Automation.Language.IfStatementAst] -and $ast.Clauses[0].Item1.Extent.Text -eq '$CreateUpdaterArtifacts' }, $true))
    if ($updaterBranches.Count -ne 2) { throw 'Expected the key validation and CLI config branches.' }
    $previousPublicKey = $env:OATS_UPDATER_PUBLIC_KEY
    try {
        $CreateUpdaterArtifacts = $true
        $env:OATS_UPDATER_PUBLIC_KEY = [IO.File]::ReadAllText($first.PublicKeyPath).Trim()
        $configOverrides = @{}
        foreach ($branch in $updaterBranches) { Invoke-Expression $branch.Extent.Text }
        $config = $configOverrides | ConvertTo-Json -Depth 8 -Compress | ConvertFrom-Json
        if (-not $config.bundle.createUpdaterArtifacts -or -not $config.plugins.updater.requireSignedVersion -or $config.plugins.updater.pubkey -cne $env:OATS_UPDATER_PUBLIC_KEY) { throw 'CLI signing did not receive the same public key as native verification.' }
        $checks += 1
        foreach ($invalid in @('', 'invalid-public-key')) {
            $env:OATS_UPDATER_PUBLIC_KEY = $invalid
            $blocked = $false
            try { Invoke-Expression $updaterBranches[0].Extent.Text } catch { $blocked = $true }
            if (-not $blocked) { throw 'Missing or malformed CLI public key was accepted.' }
            $checks += 1
        }
    } finally { $env:OATS_UPDATER_PUBLIC_KEY = $previousPublicKey }
    if ($InstallerFixture) {
        $version = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'frontend/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
        $qaTarget = Join-Path $qaRoot 'build-target'
        $qaInstaller = Join-Path $qaTarget "x86_64-pc-windows-msvc/release/bundle/nsis/oats_${version}_x64-setup.exe"
        $null = New-Item -ItemType Directory -Path (Split-Path $qaInstaller) -Force
        Copy-Item -LiteralPath $InstallerFixture -Destination $qaInstaller
        $originalInstallerHash = (Get-FileHash -LiteralPath $qaInstaller).Hash
        $signed = & $helper -Mode Sign -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot -TargetRoot $qaTarget
        if ($signed.Created -or (Get-FileHash -LiteralPath $qaInstaller).Hash -ne $originalInstallerHash) { throw 'Sign-only recovery changed the installer or identity.' }
        $checks += 1
        $originalSignatureHash = (Get-FileHash -LiteralPath "$qaInstaller.sig").Hash
        $null = & $helper -Mode Sign -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot -TargetRoot $qaTarget
        if ((Get-FileHash -LiteralPath "$qaInstaller.sig").Hash -ne $originalSignatureHash) { throw 'Sign-only recovery replaced an existing valid signature.' }
        $checks += 1
        [IO.File]::WriteAllText("$qaInstaller.sig", 'invalid QA signature')
        $blocked = $false
        try { $null = & $helper -Mode Sign -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot -TargetRoot $qaTarget } catch { $blocked = $true }
        if (-not $blocked -or [IO.File]::ReadAllText("$qaInstaller.sig") -ne 'invalid QA signature') { throw 'A conflicting signature was replaced instead of rejected.' }
        $checks += 1
    }
    $password = Join-Path $qaRoot 'password.dpapi'
    $originalKeyHash = (Get-FileHash -LiteralPath $key).Hash
    $originalPasswordHash = (Get-FileHash -LiteralPath $password).Hash
    $second = & $helper -Mode Ensure -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot
    if ($second.Created -or $second.PublicKeySha256 -ne $first.PublicKeySha256 -or (Get-FileHash -LiteralPath $key).Hash -ne $originalKeyHash -or (Get-FileHash -LiteralPath $password).Hash -ne $originalPasswordHash) { throw 'Reuse changed the signing identity.' }
    $checks += 1
    $encrypted = [IO.File]::ReadAllBytes($password)
    try {
        [IO.File]::WriteAllBytes($password, [byte[]]::new(24))
        $blocked = $false
        try { $null = & $helper -Mode Ensure -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot } catch { $blocked = $_.Exception.Message -match 'cannot decrypt' }
        if (-not $blocked -or (Get-FileHash -LiteralPath $key).Hash -ne $originalKeyHash) { throw 'Corrupt DPAPI data did not fail without key replacement.' }
    } finally { [IO.File]::WriteAllBytes($password, $encrypted) }
    $checks += 1
    try {
        $entropy = [Text.Encoding]::UTF8.GetBytes('oats/local-release-signing/password/v1')
        $wrong = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('deliberately-wrong-test-password'), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllBytes($password, $wrong)
        $blocked = $false
        try { $null = & $helper -Mode Ensure -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot } catch { $blocked = $_.Exception.Message -match 'Local signing operation failed' }
        if (-not $blocked -or (Get-FileHash -LiteralPath $key).Hash -ne $originalKeyHash) { throw 'The encrypted private key accepted a wrong password.' }
    } finally { [IO.File]::WriteAllBytes($password, $encrypted) }
    $checks += 1
    $public = [IO.File]::ReadAllBytes($first.PublicKeyPath)
    try {
        [IO.File]::Delete($first.PublicKeyPath)
        $blocked = $false
        try { $null = & $helper -Mode Ensure -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot } catch { $blocked = $_.Exception.Message -match 'incomplete' }
        if (-not $blocked -or (Get-FileHash -LiteralPath $key).Hash -ne $originalKeyHash) { throw 'Incomplete identity did not fail without key replacement.' }
    } finally { [IO.File]::WriteAllBytes($first.PublicKeyPath, $public) }
    $checks += 1
    try {
        Set-QAAccess $true
        $blocked = $false
        try { $null = & $helper -Mode Ensure -TauriCliPath $TauriCliPath -IdentityRoot $qaRoot } catch { $blocked = $_.Exception.Message -match 'beyond this Windows user' }
        if (-not $blocked) { throw 'An over-permissive identity directory was accepted.' }
    } finally { Set-QAAccess $false }
    $checks += 1
    $blocked = $false
    try { $null = & $helper -Mode Ensure -TauriCliPath $TauriCliPath -IdentityRoot (Join-Path $PSScriptRoot '../target/never-create-signing-key') } catch { $blocked = $_.Exception.Message -match 'inside the source checkout' }
    if (-not $blocked) { throw 'A repository signing identity path was accepted.' }
    $checks += 1
    [pscustomobject]@{ Passed = $checks; DurableIdentityTouched = $false; PrivateMaterialPrinted = $false }
} finally {
    # Only the new GUID-scoped QA folder is removed; never a durable identity.
    $resolved = [IO.Path]::GetFullPath($qaRoot)
    if (-not $resolved.StartsWith($temporaryRoot + '\oats-signing-qa-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the generated QA directory.' }
    if (Test-Path -LiteralPath $resolved) {
        if ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked QA cleanup.' }
        foreach ($item in Get-ChildItem -LiteralPath $resolved -Force -Recurse) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked QA cleanup.' } }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
