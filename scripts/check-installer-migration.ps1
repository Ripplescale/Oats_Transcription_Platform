param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$NsisCompiler,
    [switch]$CompileOnly
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$directory=Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ('native-migration-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory -Force|Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
foreach($fixture in @(@('old','oats','0.8.5'),@('legacy','xx','0.8.2'),@('current','oats','0.8.11'),@('foreign','Other app','0.8.5'))){
    $source=Join-Path $directory ($fixture[0]+'.cs')
    # Fixtures supply real PE version resources; these applications are never run.
    $code='using System.Reflection; [assembly: AssemblyProduct("'+$fixture[1]+'")] [assembly: AssemblyFileVersion("'+$fixture[2]+'")] class Fixture { static void Main() {} }'
    [IO.File]::WriteAllText($source,$code)
    & $compiler /nologo /target:exe "/out:$(Join-Path $directory ($fixture[0]+'.exe'))" $source
    if($LASTEXITCODE -ne 0){throw 'PE fixture compilation failed'}
}
$id=[Guid]::NewGuid().ToString('N')
$output=Join-Path $directory 'native-installer-checks.exe'
& $NsisCompiler /V2 "/DCHECK_OUTPUT=$output" "/DFIXTURE_INPUT=$directory" "/DFIXTURE_ID=$id" (Join-Path $root 'frontend/src-tauri/scripts/installer-migration-checks.nsi')
if($LASTEXITCODE -ne 0){throw 'NSIS migration fixture harness did not compile'}
if($CompileOnly){Write-Output 'Native installer fixture harness compiled. No test executable was run.';return}
$results=Join-Path $env:TEMP ('oats-native-fixtures-'+$id)
& $output /S
if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $results 'passed.txt'))){
    if(Test-Path -LiteralPath (Join-Path $results 'failed.txt')){Get-Content -LiteralPath (Join-Path $results 'failed.txt')}
    throw ('Native installer migration fixtures failed. Inspect '+$results)
}
Get-Content -LiteralPath (Join-Path $results 'passed.txt')
