param([Parameter(Mandatory=$true)][string]$StateFile, [Parameter(Mandatory=$true)][string]$RunId, [int]$HostPid = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ($RunId -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid update run' }
$jobDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($StateFile))
if ([IO.Path]::GetFileName($StateFile) -ne 'progress-state.json') { throw 'Invalid progress state path' }
function Read-SharedJson([string]$File) {
  $stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
    try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally { $stream.Dispose() }
  return $json | ConvertFrom-Json
}
$initial = Read-SharedJson $StateFile
if ($initial.runId -ne $RunId -or $initial.schemaVersion -ne 1) { throw 'Update state identity mismatch' }
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'TCL 更新进度'
$form.ClientSize = New-Object Drawing.Size(520, 295)
$form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
$form.BackColor = [Drawing.Color]::FromArgb(249, 248, 253)
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$title = New-Object Windows.Forms.Label
$title.SetBounds(24, 22, 472, 32); $title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 14, [Drawing.FontStyle]::Bold)
$title.Text = '正在准备更新'; $form.Controls.Add($title)
$detail = New-Object Windows.Forms.TextBox
$detail.SetBounds(24, 64, 472, 92); $detail.Multiline = $true; $detail.ReadOnly = $true; $detail.ScrollBars = 'Vertical'; $detail.BorderStyle = 'None'; $detail.BackColor = $form.BackColor; $form.Controls.Add($detail)
$bar = New-Object Windows.Forms.ProgressBar
$bar.SetBounds(24, 170, 472, 16); $bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 35; $form.Controls.Add($bar)
$elapsed = New-Object Windows.Forms.Label
$elapsed.SetBounds(24, 194, 472, 24); $form.Controls.Add($elapsed)
$hint = New-Object Windows.Forms.Label
$hint.SetBounds(24, 227, 472, 48); $hint.ForeColor = [Drawing.Color]::DimGray
$hint.Text = '可以最小化此窗口。关闭只收起进度，不会中断更新。'; $form.Controls.Add($hint)
$script:terminal = $false; $script:completedAt = $null; $script:missingSince = $null; $script:lastState = $initial
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 250
$timer.Add_Tick({
  try {
    $state = Read-SharedJson $StateFile
    if ($state.runId -ne $RunId -or $state.schemaVersion -ne 1) { return }
    $script:lastState = $state
  } catch { $state = $script:lastState }
  $script:terminal = $state.status -in @('failed', 'succeeded', 'installed')
  $title.Text = [string]$state.title
  $detail.Text = [string]$state.detail
  $current = $state.current; $total = $state.total; $unit = [string]$state.unit
  if ($state.phase -eq 'extracting') {
    try {
      $extraction = Read-SharedJson (Join-Path $jobDirectory 'extract-progress.json')
      if ($extraction.runId -eq $RunId -and $extraction.phase -eq 'extracting') {
        $current = $extraction.current; $total = $extraction.total; $unit = 'bytes'
      }
    } catch {}
    try {
      $warning = Read-SharedJson (Join-Path $jobDirectory 'extract-progress-warning.json')
      if ($warning.runId -eq $RunId -and $warning.phase -eq 'extracting') {
        $current = $null; $total = $null; $detail.Text = [string]$warning.message
      }
    } catch {}
  }
  $measurable = $null -ne $current -and $null -ne $total -and [double]$total -gt 0 -and [double]$current -ge 0 -and [double]$current -le [double]$total
  if ($measurable) {
    $bar.Style = 'Continuous'; $bar.Value = [Math]::Min(100, [Math]::Floor([double]$current * 100 / [double]$total))
    if ($unit -eq 'bytes') { $amount = ('{0:N1} / {1:N1} MB' -f ([double]$current / 1MB), ([double]$total / 1MB)) }
    else { $amount = ('{0} / {1} 个文件' -f $current, $total) }
    $detail.Text = [string]$state.detail + "`r`n" + $amount + ('  ({0}%)' -f $bar.Value)
  } elseif ($script:terminal) { $bar.Style = 'Continuous'; $bar.Value = $(if ($state.status -eq 'succeeded') { 100 } else { 0 }) }
  else { $bar.Style = 'Marquee' }
  $endTime = if ($state.finishedAt) { [DateTimeOffset]::Parse($state.finishedAt) } else { [DateTimeOffset]::Now }
  $seconds = [Math]::Max(0, [Math]::Floor(($endTime - [DateTimeOffset]::Parse($state.startedAt)).TotalSeconds))
  $phaseSeconds = [Math]::Max(0, [Math]::Floor(($endTime - [DateTimeOffset]::Parse($state.phaseStartedAt)).TotalSeconds))
  $elapsed.Text = ('已用时 {0} 分 {1} 秒 · 当前阶段 {2} 秒' -f [Math]::Floor($seconds / 60), ($seconds % 60), $phaseSeconds)
  if (-not $script:terminal) {
    $owner = Get-Process -Id ([int]$state.ownerPid) -ErrorAction SilentlyContinue
    if ($null -eq $owner) {
      if ($null -eq $script:missingSince) { $script:missingSince = [DateTimeOffset]::Now }
      if (([DateTimeOffset]::Now - $script:missingSince).TotalSeconds -ge 5) {
        $title.Text = '更新进程已停止'; $detail.Text = '未收到完成确认。请保留原工具文件夹和 data，查看更新结果后再重试。'
        $hint.Text = '此窗口可关闭；关闭不会修改安装或数据。'; $bar.Style = 'Continuous'; $bar.Value = 0; $script:terminal = $true
      }
    } else { $script:missingSince = $null }
  }
  if ($state.status -eq 'failed') {
    if ($state.reopened -eq $true -and $state.runningVersion -eq $state.version) { $hint.Text = '新版已经正常打开。可关闭此窗口，无需重复安装。' }
    else { $hint.Text = '错误信息会保留在此窗口。关闭不会再次安装；请解决上述问题后重试。' }
    if ($form.WindowState -eq 'Minimized') { $form.WindowState = 'Normal'; $form.Show(); $form.Activate() }
  } elseif ($state.status -eq 'installed') { $hint.Text = '本次未请求自动打开，可关闭此窗口后使用原文件夹内的一键启动。' }
  elseif ($state.status -eq 'succeeded') {
    $hint.Text = '已确认新版窗口打开，程序保持暂停。此窗口即将关闭。'
    if ($null -eq $script:completedAt) { $script:completedAt = [DateTimeOffset]::Now }
    if (([DateTimeOffset]::Now - $script:completedAt).TotalSeconds -ge 1.5) { $form.Close() }
  }
})
$form.Add_FormClosing({ param($sender, $eventArgs)
  if (-not $script:terminal -and $eventArgs.CloseReason -eq [Windows.Forms.CloseReason]::UserClosing) {
    $eventArgs.Cancel = $true; $form.WindowState = 'Minimized'
  }
})
$form.Add_Shown({
  $ready = @{ runId = $RunId; pid = $(if ($HostPid -gt 0) { $HostPid } else { $PID }); windowPid = $PID; shownAt = [DateTimeOffset]::Now.ToString('o') } | ConvertTo-Json -Compress
  $readyFile = Join-Path $jobDirectory 'ui-ready.json'; $temporary = $readyFile + '.tmp'
  [IO.File]::WriteAllText($temporary, $ready, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::Move($temporary, $readyFile); $timer.Start()
})
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
