param([string]$OutputFile = '')
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if (!$OutputFile) {$OutputFile = Join-Path $project 'bin\activate-window.exe'}
$source = Join-Path $project 'native\activate-window.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) {throw 'The Windows .NET Framework x64 C# compiler is required.'}
New-Item -ItemType Directory -Path (Split-Path -Parent ([System.IO.Path]::GetFullPath($OutputFile))) -Force | Out-Null
& $compiler /nologo /target:winexe /platform:x64 "/out:$OutputFile" $source
if ($LASTEXITCODE -ne 0) {throw "C# compilation failed: $LASTEXITCODE"}
& $OutputFile --self-test
if ($LASTEXITCODE -ne 0) {throw "Native helper self-test failed: $LASTEXITCODE"}
Write-Output 'Native helper compiled and self-tested.'
