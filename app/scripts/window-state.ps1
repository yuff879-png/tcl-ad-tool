param([Parameter(Mandatory=$true)][string]$ProfilePath, [switch]$ClosePrevious,
  [ValidateRange(0,5000)][int]$WaitMilliseconds = 3000)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TclWindows {
  public delegate bool Callback(IntPtr window, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  public static string Profile(string command) {
    if (String.IsNullOrEmpty(command)) return null;
    int count; IntPtr args = CommandLineToArgvW(command, out count);
    if (args == IntPtr.Zero) return null;
    try {
      for (int i=0; i<count; i++) {
        string arg = Marshal.PtrToStringUni(Marshal.ReadIntPtr(args, i * IntPtr.Size));
        if (arg.StartsWith("--user-data-dir=")) return arg.Substring(16);
      }
      return null;
    } finally { LocalFree(args); }
  }
}
'@
$wanted = [IO.Path]::GetFullPath($ProfilePath).TrimEnd('\')
if ($ClosePrevious -and (![IO.Path]::IsPathRooted($ProfilePath) -or [IO.Path]::GetFileName($wanted) -ne 'browser-profile')) {
  throw 'Closing windows requires an absolute tool browser-profile directory'
}
$owners = New-Object 'System.Collections.Generic.HashSet[uint32]'
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | ForEach-Object {
  $value = [TclWindows]::Profile($_.CommandLine)
  if ($value) {
    if ([string]::Equals([IO.Path]::GetFullPath($value).TrimEnd('\'), $wanted, [StringComparison]::OrdinalIgnoreCase)) { [void]$owners.Add([uint32]$_.ProcessId) }
  }
}
$script:present = $false
$script:targets = New-Object 'System.Collections.Generic.List[object]'
$callback = [TclWindows+Callback]{ param($window, $ignored)
  [uint32]$ownerId = 0
  [void][TclWindows]::GetWindowThreadProcessId($window, [ref]$ownerId)
  if ($owners.Contains($ownerId) -and [TclWindows]::IsWindowVisible($window)) {
    $kind = New-Object Text.StringBuilder 256
    [void][TclWindows]::GetClassName($window, $kind, 256)
    if ($kind.ToString() -eq 'Chrome_WidgetWin_1') {
      $script:present = $true
      $script:targets.Add(@{ Handle=$window; Owner=$ownerId })
    }
  }
  return $true
}
[void][TclWindows]::EnumWindows($callback, [IntPtr]::Zero)
function Test-OriginalWindow($target) {
  if (![TclWindows]::IsWindow($target.Handle)) { return $false }
  [uint32]$currentOwner = 0
  [void][TclWindows]::GetWindowThreadProcessId($target.Handle, [ref]$currentOwner)
  return $currentOwner -eq $target.Owner
}
if ($ClosePrevious) {
  # Graceful WM_CLOSE only for captured windows owned by this EXACT profile.
  # Never terminate browser processes or match a window by its title alone.
  foreach ($target in $script:targets) {
    if (Test-OriginalWindow $target) {
      [void][TclWindows]::PostMessage($target.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
  }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $remaining = @($script:targets | Where-Object { Test-OriginalWindow $_ }).Count
    if ($remaining -eq 0 -or $timer.ElapsedMilliseconds -ge $WaitMilliseconds) { break }
    Start-Sleep -Milliseconds 100
  } while ($true)
  @{ present=($remaining -gt 0); matched=$script:targets.Count; closed=($script:targets.Count-$remaining); remaining=$remaining } | ConvertTo-Json -Compress
} else {
  @{ present=$script:present; windows=$script:targets.Count } | ConvertTo-Json -Compress
}
