#requires -Version 7.0
param([Parameter(Mandatory)][string]$Output, [string]$Redist = 'C:/BuildTools-STT/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT')
$ErrorActionPreference = 'Stop'
$Output = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path $Output | Out-Null
function Fetch([string]$Name, [string]$Url) {
    $target = Join-Path $Output $Name
    if (-not (Test-Path -LiteralPath $target)) { Invoke-WebRequest -Uri $Url -OutFile $target }
}
Fetch 'whisper-LICENSE' 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/927cfce34f31707e17f2bff35c349632fb9e2c3a/LICENSE'
Fetch 'Apache-2.0.txt' 'https://www.apache.org/licenses/LICENSE-2.0.txt'
Fetch 'Apex-model-card.md' 'https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Apex/raw/f3214eed20b4e4d4144e739982d911f87b9cb223/README.md'
Fetch 'Silero-LICENSE' 'https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.3/LICENSE'
Fetch 'WebView2.exe' 'https://go.microsoft.com/fwlink/?LinkId=2124701'
Fetch 'whisper-bin-x64.zip' 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip'
Copy-Item -LiteralPath (Join-Path $Redist 'msvcp140.dll') -Destination (Join-Path $Output 'msvcp140.dll')
$files = @{}
New-Item -ItemType Directory -Force -Path (Join-Path $Output 'msvc') | Out-Null
foreach ($dll in Get-ChildItem -LiteralPath $Redist -Filter '*.dll' -File) { Copy-Item -LiteralPath $dll.FullName -Destination (Join-Path $Output ('msvc/' + $dll.Name)) }
foreach ($name in @('WebView2.exe', 'msvcp140.dll') + @(Get-ChildItem -LiteralPath (Join-Path $Output 'msvc') -Filter '*.dll' -File | ForEach-Object { 'msvc/' + $_.Name })) {
    $path = Join-Path $Output $name
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation,') { throw "Microsoft signature verification failed for $name" }
    $files[$name] = @{ sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); publisher = $signature.SignerCertificate.Subject }
}
if ((Get-FileHash (Join-Path $Output 'whisper-bin-x64.zip')).Hash.ToLowerInvariant() -ne 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c') { throw 'Apex CPU archive identity differs' }
@{ schema = 1; files = $files; webview_source = 'https://go.microsoft.com/fwlink/?LinkId=2124701'; apex_source = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip' } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $Output 'verified-inputs.json') -Encoding utf8NoBOM
Write-Output 'Redistributable inputs verified. Nothing was installed.'
