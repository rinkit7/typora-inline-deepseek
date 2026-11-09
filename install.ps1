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
function Assert-PlainDirectory([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $expected = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/')
    if (!$item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $item.FullName.TrimEnd([char[]]'\/') -ne $expected) {
      throw "Unexpected directory: $Path"
    }
  }
}
function Assert-ReleaseAssets([string]$Staged) {
  $bundle = Join-Path $Staged 'dist\chat-ui.js'
  $build = Get-Content -LiteralPath (Join-Path $Staged 'dist\build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ((Get-PluginFileHash $bundle) -ne $build.sha256) {throw 'The staged UI bundle does not match its build record.'}
  foreach ($font in [regex]::Matches([System.IO.File]::ReadAllText($bundle),'KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf)') | ForEach-Object Value | Select-Object -Unique) {
    if (!(Test-Path -LiteralPath (Join-Path $Staged "dist\fonts\$font") -PathType Leaf)) {throw "Missing UI font: $font"}
  }
  $modules = @((Get-Item -LiteralPath (Join-Path $Staged 'main.js'))) + @(Get-ChildItem -LiteralPath (Join-Path $Staged 'src') -Recurse -File -Filter '*.js')
  foreach ($module in $modules) {
    foreach ($match in [regex]::Matches([System.IO.File]::ReadAllText($module.FullName),'(?:from\s*|import\s*)[''"](\.[^''"]+)[''"]')) {
      $dependency = [System.IO.Path]::GetFullPath((Join-Path $module.DirectoryName $match.Groups[1].Value))
      if (!$dependency.StartsWith("$Staged\",[System.StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $dependency -PathType Leaf)) {
        throw "Missing staged module: $($match.Groups[1].Value)"
      }
    }
  }
}
$project = [System.IO.Path]::GetFullPath($PSScriptRoot)
$community = [System.IO.Path]::GetFullPath($CommunityDirectory)
if (!(Test-Path -LiteralPath (Join-Path $community 'loader.js') -PathType Leaf)) {throw 'Install typora-community-plugin before installing this plugin.'}
Assert-PlainDirectory $community
$community = (Resolve-Path -LiteralPath $community).ProviderPath
$plugins = Join-Path $community 'plugins'
$destination = Join-Path $plugins 'typora-inline-deepseek'
$settingsDirectory = Join-Path $community 'settings'
$settings = Join-Path $settingsDirectory 'plugins.json'
$backups = Join-Path $community 'backups'
$backupRoot = Join-Path $backups 'typora-inline-deepseek'
if ($TyporaExecutable -and !(Test-Path -LiteralPath $TyporaExecutable -PathType Leaf)) {throw 'Typora executable not found.'}
if (!(Test-Path -LiteralPath (Join-Path $project 'dist\chat-ui.js') -PathType Leaf)) {throw 'Build the UI before installing: npm run build'}
$manifest = Get-Content -LiteralPath (Join-Path $project 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.id -ne 'typora-inline-deepseek') {throw 'Unexpected source plugin identity.'}

# Hold a per-installation lock through staging, switching and rollback.
$lockPath = Join-Path $community '.typora-inline-deepseek-install.lock'
$lock = [System.IO.FileStream]::new($lockPath,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None,1,[System.IO.FileOptions]::DeleteOnClose)
$transaction = Join-Path $community ('.typora-inline-deepseek-stage-' + [guid]::NewGuid().ToString('N'))
$stageCreated = $false
try {
  foreach ($directory in @($plugins,$destination,$settingsDirectory,$backups,$backupRoot)) {Assert-PlainDirectory $directory}
  $hadPlugin = Test-Path -LiteralPath $destination -PathType Container
  $hadSettings = Test-Path -LiteralPath $settings
  if ($hadPlugin) {
    $links = Get-ChildItem -LiteralPath $destination -Force -Recurse | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }
    if ($links) {throw 'Refusing to update a plugin containing filesystem links.'}
    $existing = Get-Content -LiteralPath (Join-Path $destination 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existing.id -ne $manifest.id) {throw 'Destination belongs to a different plugin.'}
  }
  $enabled = @{}
  if ($hadSettings) {
    $settingsItem = Get-Item -LiteralPath $settings -Force
    if ($settingsItem.PSIsContainer -or ($settingsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {throw 'Unexpected plugin settings file.'}
    $previous = Get-Content -LiteralPath $settings -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $previous.PSObject.Properties) {$enabled[$property.Name] = $property.Value}
  }
  $enabled[$manifest.id] = $true

  $runtimeDirs = @('src','bin','dist') | ForEach-Object {Join-Path $project $_}
  foreach ($directory in $runtimeDirs) {Assert-PlainDirectory $directory}
  $runtimeItems = Get-ChildItem -LiteralPath $runtimeDirs -Recurse -Force
  if ($runtimeItems | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }) {throw 'Release contains filesystem links.'}
  $runtimeFiles = @('main.js','manifest.json','package.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','bin\activate-window.exe')
  $runtimeFiles += $runtimeItems | Where-Object { !$_.PSIsContainer } | ForEach-Object {$_.FullName.Substring($project.Length + 1)}
  $runtimeFiles = @($runtimeFiles | Select-Object -Unique)

  New-Item -ItemType Directory -Path $transaction | Out-Null
  $stageCreated = $true
  $staged = Join-Path $transaction 'plugin'
  foreach ($relative in $runtimeFiles) {
    $inputFile = Join-Path $project $relative
    $output = Join-Path $staged $relative
    $sourceItem = Get-Item -LiteralPath $inputFile -Force
    if ($sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {throw "Unexpected release file: $relative"}
    New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
    [System.IO.File]::Copy($inputFile,$output)
    if ((Get-PluginFileHash $output) -ne (Get-PluginFileHash $inputFile)) {throw "File mismatch: $relative"}
  }
  Assert-ReleaseAssets $staged
  $data = Join-Path $destination 'data'
  if (Test-Path -LiteralPath $data) {Copy-Item -LiteralPath $data -Destination (Join-Path $staged 'data') -Recurse -Force}
  $stagedSettings = Join-Path $transaction 'plugins.json'
  $json = $enabled | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($stagedSettings,$json,[System.Text.UTF8Encoding]::new($false))

  $backup = $null
  $oldMoved = $false
  $installed = $false
  if ($hadPlugin -or $hadSettings) {
    $stamp = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyyMMdd-HHmmss-fff')
    $backup = Join-Path $backupRoot $stamp
    if (Test-Path -LiteralPath $backup) {throw 'Backup path already exists.'}
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Assert-PlainDirectory $backup
    $oldPlugin = Join-Path $backup 'typora-inline-deepseek'
    $oldSettings = Join-Path $backup 'plugins.json'
  }
  New-Item -ItemType Directory -Path $plugins,$settingsDirectory -Force | Out-Null
  Assert-PlainDirectory $staged
  try {
    if ($hadPlugin) {
      [System.IO.Directory]::Move($destination,$oldPlugin)
      $oldMoved = $true
    }
    [System.IO.Directory]::Move($staged,$destination)
    $installed = $true
    if ($hadSettings) {[System.IO.File]::Replace($stagedSettings,$settings,$oldSettings)}
    else {[System.IO.File]::Move($stagedSettings,$settings)}
  } catch {
    $installError = $_
    try {
      if ($installed) {[System.IO.Directory]::Move($destination,$staged)}
      if ($oldMoved) {[System.IO.Directory]::Move($oldPlugin,$destination)}
      if ($hadSettings -and ![System.IO.File]::Exists($settings) -and [System.IO.File]::Exists($oldSettings)) {
        [System.IO.File]::Copy($oldSettings,$settings)
      }
    } catch {
      throw "Installation failed and rollback could not finish. Backup directory: $backup. Install error: $installError. Rollback error: $_"
    }
    throw $installError
  }
  [pscustomobject]@{installed=$destination;id=$manifest.id;verifiedFiles=$runtimeFiles.Count;backup=$backup} | ConvertTo-Json
} finally {
  try {
    if ($stageCreated -and (Test-Path -LiteralPath $transaction)) {
      Assert-PlainDirectory $transaction
      $resolved = (Resolve-Path -LiteralPath $transaction).ProviderPath
      if ($resolved -ne $transaction -or (Split-Path -Parent $resolved) -ne $community) {throw 'Unexpected staging directory.'}
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  } finally {$lock.Dispose()}
}
