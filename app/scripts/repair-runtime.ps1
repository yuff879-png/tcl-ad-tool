[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$TaskRoot = Split-Path -Parent $PSScriptRoot
$TaskRuntime = Join-Path $TaskRoot 'runtime'
$TaskNode = Join-Path $TaskRuntime 'node.exe'
$TaskVersion = '24.15.0'
$TaskLog = Join-Path $TaskRoot 'runtime-setup.log'
try {
    Start-Transcript -LiteralPath $TaskLog -Append | Out-Null
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'This package requires 64-bit Windows 10/11.' }
    if (-not (Test-Path -LiteralPath $TaskNode)) {
        if ($CheckOnly) { throw 'Portable Node.js is missing. Run Repair_Runtime.cmd.' }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $TaskArchiveName = "node-v$TaskVersion-win-x64.zip"
        $TaskBaseUrl = "https://nodejs.org/dist/v$TaskVersion"
        $TaskTemp = Join-Path $TaskRoot ('.runtime-download-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $TaskTemp | Out-Null
        $TaskArchive = Join-Path $TaskTemp $TaskArchiveName
        Write-Host 'Downloading the pinned portable Node.js runtime...'
        Invoke-WebRequest -UseBasicParsing -Uri "$TaskBaseUrl/$TaskArchiveName" -OutFile $TaskArchive
        $TaskHashes = (Invoke-WebRequest -UseBasicParsing -Uri "$TaskBaseUrl/SHASUMS256.txt").Content
        $TaskHashLine = ($TaskHashes -split "`n" | Where-Object { $_.Trim().EndsWith('  ' + $TaskArchiveName) } | Select-Object -First 1)
        if (-not $TaskHashLine) { throw 'Official checksum not found.' }
        $TaskExpected = ($TaskHashLine.Trim() -split '\s+')[0]
        $TaskActual = (Get-FileHash -LiteralPath $TaskArchive -Algorithm SHA256).Hash
        if ($TaskActual -ne $TaskExpected) { throw 'Runtime download checksum mismatch.' }
        Expand-Archive -LiteralPath $TaskArchive -DestinationPath $TaskTemp
        $TaskUnpacked = Join-Path $TaskTemp "node-v$TaskVersion-win-x64"
        New-Item -ItemType Directory -Path $TaskRuntime -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $TaskUnpacked 'node.exe') -Destination $TaskRuntime
        Copy-Item -LiteralPath (Join-Path $TaskUnpacked 'node_modules') -Destination $TaskRuntime -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $TaskUnpacked 'LICENSE') -Destination $TaskRuntime
        # Keep the verified archive for troubleshooting; never delete user data.
    }
    $TaskMajor = [int]((& $TaskNode --version).Trim().TrimStart('v').Split('.')[0])
    if ($TaskMajor -lt 24) { throw 'The bundled runtime is too old. Restore runtime from the portable package.' }
    if (-not $CheckOnly) {
        & $TaskNode --disable-warning=ExperimentalWarning (Join-Path $TaskRoot 'src\instance.js') --check-idle
        if ($LASTEXITCODE -ne 0) { throw 'Exit the application before repairing dependencies.' }
        $TaskNpm = Join-Path $TaskRuntime 'node_modules\npm\bin\npm-cli.js'
        if (-not (Test-Path -LiteralPath $TaskNpm)) { throw 'Bundled npm is missing. Restore the runtime folder from the portable package.' }
        Push-Location $TaskRoot
        try {
            & $TaskNode $TaskNpm ci --ignore-scripts --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check access to registry.npmjs.org.' }
        } finally { Pop-Location }
        & (Join-Path $PSScriptRoot 'repair-electron.ps1')
    }
    & $TaskNode --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'check.js') --quick
    if ($LASTEXITCODE -ne 0) { throw 'Environment check failed.' }
    Write-Host 'Ready. Double-click TCL Launcher to open the GUI. No campaign was started.'
    Stop-Transcript | Out-Null
    exit 0
} catch {
    Write-Host ('FAILED: ' + $_.Exception.Message) -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch {}
    exit 1
}
