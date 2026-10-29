# Validate signing bounds without reading any signing identity or invoking a signer.
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'sign-setup.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Signing script has parse errors'}
$function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SetupSigningMaximum'},$true)
if(-not $function){throw 'Signing bounds function missing'}
Invoke-Expression $function.Extent.Text
$legacy=[pscustomobject]@{app_version='0.8.9'}
if((Get-SetupSigningMaximum $legacy 'Oats-Setup.exe') -ne 8MB){throw 'Legacy bootstrap bound changed'}
$overlay=[pscustomobject]@{app_version='0.8.10';app_installer_bytes=44MB;app_installer_sha256=('a'*64)}
if((Get-SetupSigningMaximum $overlay 'Oats-Setup.exe') -ne 52MB){throw 'Current app overlay cannot be signed'}
if((Get-SetupSigningMaximum $overlay 'Oats-Repair.exe') -ne 8MB){throw 'Repair bound must remain small'}
foreach($invalid in @(-1,2,(512MB+1),'invalid')) {
    $overlay.app_installer_bytes=$invalid; $rejected=$false
    try{Get-SetupSigningMaximum $overlay 'Oats-Setup.exe'|Out-Null}catch{$rejected=$true}
    if(-not $rejected){throw 'Invalid app overlay size accepted'}
}
$overlay.app_installer_bytes=44MB; $overlay.app_installer_sha256='invalid'; $rejected=$false
try{Get-SetupSigningMaximum $overlay 'Oats-Setup.exe'|Out-Null}catch{$rejected=$true}
if(-not $rejected){throw 'Invalid overlay digest accepted'}
'8 setup signing-bound checks passed; no keys were read.'
