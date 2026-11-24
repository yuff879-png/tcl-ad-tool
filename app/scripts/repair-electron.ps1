$ErrorActionPreference = 'Stop'
$TaskRoot = Split-Path -Parent $PSScriptRoot
$TaskPin = Get-Content -LiteralPath (Join-Path $TaskRoot 'src/desktop/runtime.json') -Raw | ConvertFrom-Json
$TaskTarget = Join-Path $TaskRoot 'runtime/electron'
$TaskWork = Join-Path $TaskRoot ('.electron-repair-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($TaskWork)
$TaskZipPath = Join-Path $TaskWork $TaskPin.archive
Write-Host 'Downloading the pinned official Electron runtime...'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri $TaskPin.url -OutFile $TaskZipPath
if ((Get-FileHash -LiteralPath $TaskZipPath -Algorithm SHA256).Hash -ne $TaskPin.sha256) { throw 'Electron checksum mismatch. Runtime was not replaced.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$TaskZip = [IO.Compression.ZipFile]::OpenRead($TaskZipPath)
$TaskFiles = [ordered]@{}
try {
    [void][IO.Directory]::CreateDirectory($TaskTarget)
    foreach ($TaskEntry in $TaskZip.Entries) {
        $TaskRelative = $TaskEntry.FullName
        if ($TaskRelative.EndsWith('/')) { continue }
        if ($TaskRelative -match '[\\:]|(^|/)\.\.?(/|$)' -or $TaskRelative.StartsWith('/')) { throw 'Invalid Electron archive path' }
        if ($TaskRelative.StartsWith('locales/') -and $TaskRelative -notin @('locales/en-US.pak','locales/zh-CN.pak','locales/zh-TW.pak')) { continue }
        $TaskOut = Join-Path $TaskTarget $TaskRelative
        [void][IO.Directory]::CreateDirectory((Split-Path -Parent $TaskOut))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($TaskEntry, $TaskOut, $true)
        $TaskFiles[$TaskRelative] = (Get-FileHash -LiteralPath $TaskOut -Algorithm SHA256).Hash.ToLowerInvariant()
    }
} finally { $TaskZip.Dispose() }
$TaskManifest = @{ version=$TaskPin.version; archive=$TaskPin.archive; url=$TaskPin.url; sha256=$TaskPin.sha256; files=$TaskFiles }
$TaskJson = $TaskManifest | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $TaskRoot 'runtime/electron-runtime.json'), $TaskJson, (New-Object Text.UTF8Encoding($false)))
Write-Host 'Electron runtime restored and verified.'
