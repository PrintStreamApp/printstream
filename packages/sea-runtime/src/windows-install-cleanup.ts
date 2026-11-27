/**
 * Retires only leftover processes running the exact installed executable, then
 * removes its directory after the uninstaller exits. Same-name clients in other
 * directories never acquire termination authority. A native process handle is
 * held across image-path verification and termination so PID reuse cannot turn
 * an admitted process into a different target. A durable operation claim remains
 * owned until deletion settles; qualified scratch fixtures cover native handoff.
 */
import { transferWindowsInstallOperation, withWindowsInstallOperation, type WindowsInstallOperation } from './windows-install-operation.js'
import { WINDOWS_INSTALL_OPERATION_FUNCTIONS } from './windows-install-operation-script.js'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { prepareWindowsCleanupBootstrap } from './windows-cleanup-bootstrap.js'
import { windowsPowerShellPath, windowsWscriptPath } from './windows-hidden-launch.js'

/** Emits generic Win32 plumbing; paths and application identity stay in PowerShell. */
const ownedProcessCleanup = `
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class PrintStreamInstallCleanup {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);

  public static bool TerminateInstalledProcess(int pid, string expectedExe, long cutoff) {
    // QueryLimitedInformation | Terminate. An unavailable identity is skipped.
    IntPtr handle = OpenProcess(0x1000 | 0x0001, false, pid);
    if (handle == IntPtr.Zero) return false;
    try {
      StringBuilder image = new StringBuilder(32768);
      uint size = (uint)image.Capacity;
      if (!QueryFullProcessImageName(handle, 0, image, ref size)) return false;
      if (!String.Equals(Path.GetFullPath(image.ToString()), Path.GetFullPath(expectedExe), StringComparison.OrdinalIgnoreCase)) return false;
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user) || created > cutoff) return false;
      if (!TerminateProcess(handle, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return true;
    } finally {
      CloseHandle(handle);
    }
  }
}
`

/**
 * Builds a best-effort detached Windows cleanup command. installDir must be an
 * absolute non-root directory and exeBaseName the app's filename without .exe.
 * Foreign/unqueryable processes are left alone; deletion retries for one minute
 * and logs a failure under TEMP, which survives a data-purging uninstall.
 */
export function buildInstallDirCleanupScript(installDir: string, exeBaseName: string, operation: WindowsInstallOperation): string {
  const normalized = path.win32.normalize(operation.installDir)
  if (operation.serviceId !== exeBaseName || !path.win32.isAbsolute(installDir) || normalized === path.win32.parse(normalized).root
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(exeBaseName)) {
    throw new Error('Windows install cleanup requires an absolute non-root directory and safe executable basename')
  }
  const quote = (value: string): string => value.replaceAll("'", "''")
  const directory = quote(normalized)
  const executable = quote(path.win32.join(normalized, `${exeBaseName}.exe`))
  const basename = quote(exeBaseName)
  const logName = quote(`${exeBaseName}-uninstall-cleanup.log`)

  const record = Buffer.from(JSON.stringify({ installDir: operation.installDir, serviceId: operation.serviceId, dataDir: operation.dataDir, token: operation.token }), 'utf8').toString('base64')
  return `${WINDOWS_INSTALL_OPERATION_FUNCTIONS}
$record = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${record}')) | ConvertFrom-Json
$control = GetInstallControl $record.installDir $record.serviceId $record.dataDir
AssertInstallClaim $control $record.token
# A permanent per-token receipt prevents duplicate or delayed receivers from
# re-entering after the first receiver releases the claim to a successor.
$receipt = [IO.Path]::Combine($control.directory, 'received-' + $record.token)
$receiver = New-Object IO.FileStream($receipt, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$receiver.Dispose()
AssertInstallClaim $control $record.token
$claim = [IO.File]::ReadAllText($control.claim) | ConvertFrom-Json
# The process that took the claim exits once this receiver acknowledges it, so stamp this
# receiver as the owner: clear-lock must see a running owner while the cleanup works. The token
# and cutoff stay as they were (the cutoff still bounds which processes are terminated below).
$owned = [IO.File]::ReadAllText($control.claim) | ConvertFrom-Json
$owned.pid = $PID
$owned | Add-Member -Force -NotePropertyName ownerStartedAt -NotePropertyValue (ProcessStartedAt $PID)
[IO.File]::WriteAllText($control.claim, ($owned | ConvertTo-Json -Compress))
Start-Sleep -Seconds 4
$err = $null
try {
  Add-Type -TypeDefinition @'
${ownedProcessCleanup}
'@
  foreach ($candidate in @(Get-Process -Name '${basename}' -ErrorAction SilentlyContinue)) {
    [void][PrintStreamInstallCleanup]::TerminateInstalledProcess($candidate.Id, '${executable}', [long]$claim.cutoff)
  }
} catch {
  $err = $_.Exception.Message
}
# 120 x 500 ms permits antivirus to release the closed executable without
# broadening process ownership or asking the operator to delete it manually.
for ($i = 0; $i -lt 120; $i++) {
  AssertInstallClaim $control $record.token
  AssertPlainInstallPath '${directory}'
  if (-not (Test-Path -LiteralPath '${directory}')) { break }
  try {
    Remove-Item -LiteralPath '${directory}' -Recurse -Force -ErrorAction Stop
    break
  } catch {
    $err = $_.Exception.Message
  }
  Start-Sleep -Milliseconds 500
}
if (Test-Path -LiteralPath '${directory}') {
  $line = ((Get-Date).ToString('s')) + ' could not remove ${directory}: ' + $err
  Add-Content -LiteralPath (Join-Path $env:TEMP '${logName}') -Value $line -ErrorAction SilentlyContinue
}
# A settled deletion failure has no further effects, so a successor may retry.
AssertInstallClaim $control $record.token
[IO.File]::Delete($control.claim)`
}

/**
 * Schedule the reviewed app-owned directory through the qualified hidden WScript
 * handoff. Returns after receiver acknowledgement, not after folder removal.
 * Startup refusal is best-effort and logs a fixed diagnostic; DATA is unchanged.
 */
export function scheduleWindowsInstallDirCleanup(installDir: string, exeBaseName: string): void {
  return withWindowsInstallOperation(path.win32.join(installDir, `${exeBaseName}.exe`), () => {
    // Transfer before preparing/spawning: any uncertain helper outcome retains
    // exclusion. A launch failure must never give a potential receiver's claim away.
    const operation = transferWindowsInstallOperation()
    const script = buildInstallDirCleanupScript(installDir, exeBaseName, operation)
    try {
      const bootstrap = prepareWindowsCleanupBootstrap(script, installDir)
      const helper = spawn(windowsWscriptPath(), ['//nologo', '//B', bootstrap.launcher], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      helper.once('error', () => { console.warn('Windows installation cleanup could not be started; installation operation claim retained for administrator recovery.') })
      helper.unref()
      waitForCleanupReceiver(operation)
    } catch {
      console.warn('Windows installation cleanup could not be started; installation operation claim retained for administrator recovery.')
    }
  })
}

/** A spawned process is not an admitted receiver; uncertainty retains the claim. */
function waitForCleanupReceiver(operation: WindowsInstallOperation): void {
  const receipt = path.win32.join(operation.directory, `received-${operation.token}`).replaceAll("'", "''")
  const script = `$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (-not [IO.File]::Exists('${receipt}')) {
  if ([DateTime]::UtcNow -ge $deadline) { exit 1 }
  Start-Sleep -Milliseconds 100
}`
  const result = spawnSync(windowsPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], { windowsHide: true, stdio: 'ignore', timeout: 15000 })
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error('Windows cleanup receiver acknowledgement was not established')
  }
}
