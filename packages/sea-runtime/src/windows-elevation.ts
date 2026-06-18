/**
 * Windows UAC self-elevation helpers, shared by every PrintStream Node SEA's
 * guided installer and uninstaller. Relaunching with the `RunAs` verb is the
 * only way a non-elevated process can request admin, and it can be declined
 * (UAC/SmartScreen refuse a freshly downloaded, not-yet-trusted executable), so
 * the relaunch reports success/failure instead of throwing and crashing the
 * double-click window.
 *
 * This is generic/public plumbing: the launch-tray-in-user-session helper is
 * parameterized by a scheduled-task name so each app keeps its own task.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { commandSucceeds, runCommand } from './service/exec.js'

/** `net session` succeeds only in an elevated process. */
export function processIsElevated(): boolean {
  return commandSucceeds('net', ['session'])
}

/**
 * Hides this process's own console window — used so a double-clicked,
 * console-subsystem exe that drives a GUI shows only the GUI, not a console.
 *
 * Only hides when we OWN the console (a bare double-click), never when run from
 * a terminal (which would hide the user's shell). The guard is the console's
 * attached-process count: the helper PowerShell shares our console, so on a bare
 * launch the count is just us + it (2), but a terminal adds the parent shell
 * (3+). Best-effort and silent; there is an unavoidable brief flash before it
 * runs (the OS shows the console before any of our code does).
 */
export function hideOwnConsoleWindow(): void {
  if (process.platform !== 'win32') return
  const script = [
    "$t = Add-Type -PassThru -Name ConsoleHide -Namespace PsSetup -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow(); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int n); [System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern int GetConsoleProcessList(int[] buffer, int count);'",
    '$buffer = New-Object int[] 8',
    '$count = $t::GetConsoleProcessList($buffer, 8)',
    'if ($count -le 2) { [void]$t::ShowWindow($t::GetConsoleWindow(), 0) }'
  ].join('; ')
  runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { allowFailure: true })
}

/**
 * Removes this executable's Mark-of-the-Web (the `Zone.Identifier` alternate
 * data stream) so the UAC relaunch is not blocked. Best-effort; it does not
 * affect the one-time SmartScreen prompt on the very first launch (that fires
 * before any code runs), only the elevation that follows it.
 */
export function clearOwnMarkOfTheWeb(): void {
  try {
    rmSync(`${process.execPath}:Zone.Identifier`, { force: true })
  } catch {
    // Best-effort; the elevation path still has its manual fallback.
  }
}

/**
 * Relaunches this executable elevated with the given arguments. Returns false
 * when elevation was denied/cancelled or could not be requested, so callers can
 * fall back to manual guidance rather than letting the unhandled error crash.
 *
 * `hidden` starts the elevated process with no console window — used when the
 * elevated run presents its own GUI, so the console-subsystem exe does not flash
 * a second window behind it.
 */
export function relaunchSelfElevatedWindows(args: string[], options: { hidden?: boolean } = {}): boolean {
  const exe = process.execPath.replaceAll("'", "''")
  const argList = args.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(',')
  const windowStyle = options.hidden ? " -WindowStyle Hidden" : ''
  const result = runCommand('powershell', [
    '-NoProfile',
    '-Command',
    `Start-Process -FilePath '${exe}' -ArgumentList ${argList} -Verb RunAs${windowStyle}`
  ], { allowFailure: true })
  return result !== null
}

/** The operator's answer to the uninstall keep-or-delete-data question. */
export type UninstallChoice = 'purge' | 'keep' | 'cancel'

/**
 * Asks whether to keep or delete data on uninstall, so the choice is presented
 * once in the uninstall flow itself — the same for the tray, Settings → Apps,
 * and the CLI. Uses a force-shown WinForms dialog (not MessageBox): launched
 * with `windowsHide`, the host carries SW_HIDE, which a MessageBox shown from a
 * GUI-subsystem host does not reliably override — so we build a real form and
 * call ShowWindow on its own handle (the same mechanism the setup window uses).
 * System-DPI aware so it is crisp. Returns the button pressed via exit code;
 * defaults to 'cancel' on any failure.
 */
export function promptWindowsUninstallChoice(appName: string): UninstallChoice {
  const q = appName.replaceAll("'", "''")
  const script = `${'﻿'}$ErrorActionPreference = 'Stop'
Add-Type -Name Win32 -Namespace UninstUi -MemberDefinition '
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'
try { [void][UninstUi.Win32]::SetProcessDPIAware() } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$script:result = 12
$form = New-Object System.Windows.Forms.Form
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
$form.Text = 'Uninstall ${q}'
$form.ClientSize = New-Object System.Drawing.Size(460, 200)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Remove ${q} from this computer?' + [Environment]::NewLine + [Environment]::NewLine + 'Keep your data, or also delete everything (including your library files)? Deleting cannot be undone.'
$label.Location = New-Object System.Drawing.Point(20, 20)
$label.Size = New-Object System.Drawing.Size(440, 80)
$form.Controls.Add($label)

# AutoSize buttons (with generous left-to-right spacing) so the labels can never
# be clipped, whatever the DPI scale.
$pad = New-Object System.Windows.Forms.Padding(12, 6, 12, 6)

$keep = New-Object System.Windows.Forms.Button
$keep.Text = 'Keep data'
$keep.AutoSize = $true
$keep.Padding = $pad
$keep.Location = New-Object System.Drawing.Point(20, 150)
$keep.add_Click({ $script:result = 11; $form.Close() })
$form.Controls.Add($keep)
$form.AcceptButton = $keep

$purge = New-Object System.Windows.Forms.Button
$purge.Text = 'Delete all data'
$purge.AutoSize = $true
$purge.Padding = $pad
$purge.Location = New-Object System.Drawing.Point(160, 150)
$purge.add_Click({ $script:result = 10; $form.Close() })
$form.Controls.Add($purge)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.AutoSize = $true
$cancel.Padding = $pad
$cancel.Location = New-Object System.Drawing.Point(330, 150)
$cancel.add_Click({ $script:result = 12; $form.Close() })
$form.Controls.Add($cancel)
$form.CancelButton = $cancel

$script:shown = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.add_Tick({
  if (-not $script:shown) {
    $script:shown = $true
    [void][UninstUi.Win32]::ShowWindow($form.Handle, 1)
    [void][UninstUi.Win32]::SetForegroundWindow($form.Handle)
  }
})
$timer.Start()
$form.Add_Shown({ [void][UninstUi.Win32]::ShowWindow($form.Handle, 1); [void][UninstUi.Win32]::SetForegroundWindow($form.Handle); $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
exit $script:result
`
  let workDir: string
  try {
    workDir = mkdtempSync(path.join(tmpdir(), 'ps-uninstall-choice-'))
  } catch {
    return 'cancel'
  }
  const scriptPath = path.join(workDir, 'choice.ps1')
  try {
    writeFileSync(scriptPath, script, 'utf8')
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      windowsHide: true
    })
    if (result.status === 10) return 'purge'
    if (result.status === 11) return 'keep'
    return 'cancel'
  } catch {
    return 'cancel'
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/**
 * Removes the install dir after this process exits. The dir holds the running
 * executable — locked by this uninstaller and any leftover tray process — so a
 * detached, hidden PowerShell waits, kills any remaining `<exeBaseName>`
 * processes to release the lock, then retries the delete. This is why uninstall
 * does not ask the operator to delete the program folder by hand. Best-effort.
 */
export function scheduleWindowsInstallDirCleanup(installDir: string, exeBaseName: string): void {
  const dir = installDir.replaceAll("'", "''")
  const name = exeBaseName.replaceAll("'", "''")
  const script = [
    'Start-Sleep -Seconds 4',
    `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
    'for ($i = 0; $i -lt 20; $i++) {',
    `  if (-not (Test-Path -LiteralPath '${dir}')) { break }`,
    `  Remove-Item -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue`,
    '  Start-Sleep -Milliseconds 500',
    '}'
  ].join('; ')
  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
  } catch {
    // Best-effort.
  }
}

/**
 * Launches the tray in the *interactive user's* (unelevated) session. A tray
 * icon spawned from the elevated installer would run as administrator, where its
 * notification-area icon often fails to appear; a one-shot scheduled task with a
 * Limited run level drops back to the user's session. The action is given as a
 * (`execute`, `argument`) pair so callers can run a console exe directly or —
 * to avoid a visible console window — run it hidden via `wscript <launcher.vbs>`.
 * `taskName` is the transient scheduled-task name (each app passes its own so
 * they never collide). Returns false (so the caller can fall back to a direct
 * spawn) if the ScheduledTasks cmdlets are unavailable or the task could not be
 * created/run.
 */
export function launchTrayInUserSessionWindows(execute: string, argument: string, taskName: string): boolean {
  const quotedExe = execute.replaceAll("'", "''")
  const quotedArg = argument.replaceAll("'", "''")
  const quotedTask = taskName.replaceAll("'", "''")
  const script = [
    `$a = New-ScheduledTaskAction -Execute '${quotedExe}' -Argument '${quotedArg}'`,
    '$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited',
    '$t = New-ScheduledTask -Action $a -Principal $p',
    `Register-ScheduledTask -TaskName '${quotedTask}' -InputObject $t -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${quotedTask}'`,
    'Start-Sleep -Seconds 2',
    `Unregister-ScheduledTask -TaskName '${quotedTask}' -Confirm:$false`
  ].join('; ')
  const result = runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { allowFailure: true })
  return result !== null
}
