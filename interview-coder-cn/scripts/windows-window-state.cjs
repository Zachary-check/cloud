/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// Read-only Win32 observations of our test windows. No hooks, injection,
// elevation, process enumeration or access to third-party window contents.
module.exports = function windowStates(windows) {
  const entries = Object.entries(windows).map(([name, window]) => {
    if (!/^[a-z]+$/.test(name)) throw new Error('Invalid probe name')
    const handle = window.getNativeWindowHandle().readBigUInt64LE().toString()
    return `@{Name='${name}';Handle=[IntPtr]::new([Int64]${handle})}`
  })
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowStateProbe {
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", ExactSpelling=true)]
  public static extern IntPtr Style(IntPtr window, int index);
  [DllImport("user32.dll")]
  public static extern bool GetLayeredWindowAttributes(IntPtr window, out uint key, out byte alpha, out uint flags);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  public static extern IntPtr GetTopWindow(IntPtr window);
  [DllImport("user32.dll")]
  public static extern IntPtr GetWindow(IntPtr window, uint command);
}
'@
$entries = @(${entries.join(',')})
$result = foreach ($entry in $entries) {
  $style = [WindowStateProbe]::Style($entry.Handle, -20).ToInt64()
  [uint32]$key=0; [byte]$alpha=0; [uint32]$flags=0
  $hasAlpha=[WindowStateProbe]::GetLayeredWindowAttributes($entry.Handle,[ref]$key,[ref]$alpha,[ref]$flags)
  $cursor=[WindowStateProbe]::GetTopWindow([IntPtr]::Zero); $position=-1; $index=0
  while ($cursor -ne [IntPtr]::Zero -and $index -lt 1024) {
    if ($cursor -eq $entry.Handle) { $position=$index; break }
    $cursor=[WindowStateProbe]::GetWindow($cursor,2); $index++
  }
  [pscustomobject]@{name=$entry.Name;layered=(($style -band 0x80000) -ne 0);topmost=(($style -band 8) -ne 0);visible=[WindowStateProbe]::IsWindowVisible($entry.Handle);hasAlpha=$hasAlpha;alpha=[int]$alpha;flags=[int]$flags;z=$position}
}
ConvertTo-Json -InputObject @($result) -Compress
`
  const stdout = execFileSync(
    join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 32768 }
  )
  return Object.fromEntries(JSON.parse(stdout.trim()).map((state) => [state.name, state]))
}
