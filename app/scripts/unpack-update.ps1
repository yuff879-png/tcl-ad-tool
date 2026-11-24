param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination,
  [string]$ProgressFile = '', [string]$RunId = '')
$ErrorActionPreference='Stop'
if ($ProgressFile -and $RunId -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid extraction progress identity' }
$script:progressUnavailable = $false
function Publish-Extraction([long]$Current, [long]$Total) {
  if (-not $ProgressFile -or $script:progressUnavailable) { return }
  $record = @{ schemaVersion=1; runId=$RunId; phase='extracting'; current=$Current; total=$Total; unit='bytes'; updatedAt=[DateTimeOffset]::Now.ToString('o') } | ConvertTo-Json -Compress
  $temporary = $ProgressFile + '.tmp'
  try {
    [IO.File]::WriteAllText($temporary, $record, (New-Object Text.UTF8Encoding($false)))
    $retryClock = [Diagnostics.Stopwatch]::StartNew()
    $retryDelay = 10
    while ($true) {
      try {
        if ([IO.File]::Exists($ProgressFile)) { [IO.File]::Replace($temporary, $ProgressFile, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $ProgressFile) }
        break
      } catch {
        $cause = $_.Exception.GetBaseException()
        $remaining = 1500 - $retryClock.ElapsedMilliseconds
        if (($cause -isnot [IO.IOException] -and $cause -isnot [UnauthorizedAccessException]) -or $remaining -le 0) { throw }
        Start-Sleep -Milliseconds ([Math]::Min($retryDelay, $remaining))
        $retryDelay = [Math]::Min($retryDelay * 2, 100)
      }
    }
  } catch {
    # UI telemetry cannot turn a valid extraction into an installation failure.
    # Emit one warning for this extraction and stop retrying on every chunk.
    $script:progressUnavailable = $true
    Write-Warning 'Extraction progress is unavailable; extraction continues.'
    try {
      $warningFile = Join-Path ([IO.Path]::GetDirectoryName($ProgressFile)) 'extract-progress-warning.json'
      $warningTemporary = $warningFile + '.tmp'
      $warning = @{ schemaVersion=1; runId=$RunId; phase='extracting'; message='解压进度数值暂时不可用，文件解压仍在继续。'; updatedAt=[DateTimeOffset]::Now.ToString('o') } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText($warningTemporary, $warning, (New-Object Text.UTF8Encoding($false)))
      [IO.File]::Move($warningTemporary, $warningFile)
    } catch { }
  } finally { if ([IO.File]::Exists($temporary)) { try { [IO.File]::Delete($temporary) } catch { } } }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$base=[IO.Path]::GetFullPath($Destination).TrimEnd('\')+'\'
if (Test-Path -LiteralPath $Destination) { throw 'Extraction directory already exists' }
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $names=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  [long]$total=0
  foreach ($entry in $zip.Entries) {
    $parts=$entry.FullName.Split('/')
    if ($parts.Length -lt 2 -or $parts[0] -ne 'TCL广告投放工具') { throw 'Unexpected package root' }
    $relative=($parts | Select-Object -Skip 1) -join '/'
    if (-not $relative -or $relative.EndsWith('/')) { continue }
    if ($relative -match '[\\:]' -or ($relative.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' -or $_ -match '[. ]$' }) -or -not $names.Add($relative)) { throw 'Unsafe or duplicate archive path' }
    $top=$relative.Split('/')[0]
    $dirs=@('src','public','scripts','launcher','test','node_modules','runtime')
    $files=@('package.json','package-lock.json','update-channel.json','release-manifest.json','使用说明.md','更新说明.md','Start.cmd','Repair_Runtime.cmd','Check_Runtime.cmd','TCL.exe','TCL广告投放工具.exe','一键启动.cmd','检查运行环境.cmd','修复运行环境.cmd')
    if (($relative.Contains('/') -and $top -notin $dirs) -or (-not $relative.Contains('/') -and $top -notin $files)) { throw 'Package includes non-application files' }
    if ($entry.FullName -match '(^|/)(\.env|config\.json|records\.sqlite|instance\.json)$' -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Private or linked archive entry' }
    $out=[IO.Path]::GetFullPath((Join-Path $base $relative))
    if (-not $out.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive escapes destination' }
    $total+=$entry.Length
    if ($total -gt 600MB -or $names.Count -gt 30000) { throw 'Unpacked archive too large' }
  }
  [void][IO.Directory]::CreateDirectory($base)
  [long]$completed=0
  $progressClock=[Diagnostics.Stopwatch]::StartNew()
  $buffer=New-Object byte[] (1MB)
  Publish-Extraction $completed $total
  foreach ($entry in $zip.Entries) {
    $relative=($entry.FullName.Split('/') | Select-Object -Skip 1) -join '/'
    if (-not $relative -or $relative.EndsWith('/')) { continue }
    $out=Join-Path $base $relative
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($out))
    $inputStream=$entry.Open()
    try {
      $outputStream=[IO.File]::Open($out,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try {
        while (($count=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
          $outputStream.Write($buffer,0,$count); $completed+=$count
          if ($progressClock.ElapsedMilliseconds -ge 100) { Publish-Extraction $completed $total; $progressClock.Restart() }
        }
      } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
  }
  Publish-Extraction $completed $total
} finally { $zip.Dispose() }
