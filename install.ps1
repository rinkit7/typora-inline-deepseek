param(
  [string]$CommunityDirectory = (Join-Path $env:USERPROFILE '.typora\community-plugins'),
  [string]$TyporaExecutable = ''
)
$ErrorActionPreference = 'Stop'
function Get-PluginFileHash([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','')}
  finally {$algorithm.Dispose(); $stream.Dispose()}
}
$project = [System.IO.Path]::GetFullPath($PSScriptRoot)
$community = [System.IO.Path]::GetFullPath($CommunityDirectory)
$plugins = Join-Path $community 'plugins'
$destination = Join-Path $plugins 'typora-inline-deepseek'
$settings = Join-Path $community 'settings\plugins.json'
if (!(Test-Path -LiteralPath (Join-Path $community 'loader.js') -PathType Leaf)) {throw 'Install typora-community-plugin before installing this plugin.'}
if ($TyporaExecutable -and !(Test-Path -LiteralPath $TyporaExecutable -PathType Leaf)) {throw 'Typora executable not found.'}
if (!(Test-Path -LiteralPath (Join-Path $project 'dist\chat-ui.js') -PathType Leaf)) {throw 'Build the UI before installing: npm run build'}
$manifest = Get-Content -LiteralPath (Join-Path $project 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.id -ne 'typora-inline-deepseek') {throw 'Unexpected source plugin identity.'}
if (Test-Path -LiteralPath $destination) {
  $resolved = (Resolve-Path -LiteralPath $destination).ProviderPath
  if ($resolved -ne [System.IO.Path]::GetFullPath($destination) -or (Split-Path -Parent $resolved) -ne $plugins) {throw 'Unexpected plugin path.'}
  $links = @(Get-Item -LiteralPath $destination; Get-ChildItem -LiteralPath $destination -Force -Recurse) | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }
  if ($links) {throw 'Refusing to update a plugin containing filesystem links.'}
  $existing = Get-Content -LiteralPath (Join-Path $destination 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($existing.id -ne $manifest.id) {throw 'Destination belongs to a different plugin.'}
}
$enabled = @{}
if (Test-Path -LiteralPath $settings -PathType Leaf) {
  $previous = Get-Content -LiteralPath $settings -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($property in $previous.PSObject.Properties) {$enabled[$property.Name] = $property.Value}
}
$runtimeFiles = @('main.js','manifest.json','package.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md')
$runtimeFiles += Get-ChildItem -LiteralPath (Join-Path $project 'src'),(Join-Path $project 'bin'),(Join-Path $project 'dist') -File -Recurse | ForEach-Object {$_.FullName.Substring($project.Length + 1)}
$backup = $null
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $settings)) {
  $stamp = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyyMMdd-HHmmss-fff')
  $backup = Join-Path $community ('backups\typora-inline-deepseek\' + $stamp)
  if (Test-Path -LiteralPath $backup) {throw 'Backup path already exists.'}
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  if (Test-Path -LiteralPath $destination) {Copy-Item -LiteralPath $destination -Destination (Join-Path $backup 'typora-inline-deepseek') -Recurse}
  if (Test-Path -LiteralPath $settings) {Copy-Item -LiteralPath $settings -Destination (Join-Path $backup 'plugins.json')}
}
foreach ($relative in $runtimeFiles) {
  $output = Join-Path $destination $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $project $relative) -Destination $output -Force
  if ((Get-PluginFileHash $output) -ne (Get-PluginFileHash (Join-Path $project $relative))) {throw "File mismatch: $relative"}
}
$enabled[$manifest.id] = $true
New-Item -ItemType Directory -Path (Split-Path -Parent $settings) -Force | Out-Null
$json = $enabled | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($settings,$json,[System.Text.UTF8Encoding]::new($false))
[pscustomobject]@{installed=$destination;id=$manifest.id;verifiedFiles=$runtimeFiles.Count;backup=$backup} | ConvertTo-Json
