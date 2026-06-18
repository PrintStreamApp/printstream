/**
 * Windows guided install/uninstall window — a small WinForms dialog (logo,
 * progress bar, live output, and an optional "Open" button) shown in place of a
 * console. Windows only; `startSetupGui` returns null elsewhere so callers keep
 * their console output. Shared by every PrintStream Node SEA (the self-hosted
 * server and the standalone bridge), parameterized by app identity + framing.
 *
 * Like the tray, the window is a self-contained PowerShell script run by the
 * stock `powershell`; the Node side drives it by writing a progress JSON file
 * the window polls — the same status-file pattern the tray uses, no IPC.
 *
 * Showing a window from a double-clicked console exe is fiddly, so the mechanism
 * is deliberate and the same on every caller:
 *  - PowerShell is spawned with `windowsHide` so no console pops (essential for
 *    a GUI-subsystem host, harmless otherwise). windowsHide also sets the
 *    process show state to SW_HIDE, which WinForms would apply to the form — so
 *    the script overrides it by calling ShowWindow on the form's own handle once
 *    the message loop runs. This works regardless of the host's PE subsystem.
 *  - The script is emitted with a UTF-8 BOM and reads the progress file as UTF-8,
 *    because Windows PowerShell 5.1 otherwise decodes both as the ANSI codepage
 *    and mangles non-ASCII (… —).
 *  - The form auto-scales (AutoScaleMode = Dpi) so the layout tracks the display
 *    DPI instead of the title font overrunning hand-placed controls.
 *  - PowerShell's stdout/stderr go to a diagnostic log, so a window that fails to
 *    render still leaves a reason behind.
 *
 * The host process must stay alive while the window is up (the window is its
 * child); callers `await gui.wait()` last.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface SetupGuiOptions {
  /** App id (kebab) — names the temp dir and the diagnostic log file. */
  appId: string
  /** Display name shown in the title and the Open button. */
  appName: string
  /** PNG logo bytes shown top-left (each app passes its own icon). */
  logoPng: Buffer
  /** Service log directory opened by the "View logs" button on failure. */
  logsDir: string
  /** Window + header title, e.g. "Setting up PrintStream". */
  title: string
  /** Final phase text on success, e.g. "PrintStream is ready". */
  readyText: string
  /** Show the primary action button — install flows do, uninstall flows don't. */
  showOpen: boolean
  /**
   * Label for the primary action button (defaults to "Open <appName>"). The
   * server opens the app URL; the bridge opens its pairing URL, so it overrides
   * this to "Connect to workspace".
   */
  openLabel?: string
  /**
   * Show a button that copies `copyText` to the clipboard — the bridge uses it
   * for the connect code, so the operator can paste it into their workspace.
   */
  showCopy?: boolean
  /** Label for the copy button (defaults to "Copy code"). */
  copyLabel?: string
}

interface SetupProgress {
  status: 'running' | 'done' | 'error'
  phase: string
  /** Prominent bold line above the output — a connect code or the app URL. */
  highlight: string
  /** Value the Copy button puts on the clipboard (e.g. the bare connect code). */
  copyText: string
  lines: string[]
  appUrl: string
  logsDir: string
}

/** Handle for the running setup window; methods write the polled progress file. */
export interface SetupGui {
  /** Set the line under the progress bar and append it to the output. */
  phase(message: string): void
  /** Append a line to the output box. */
  log(message: string): void
  /** Set the prominent bold line above the output (connect code / app URL). */
  highlight(text: string): void
  /** Set the value the Copy button copies (enables it once non-empty). */
  setCopyText(text: string): void
  /** Mark complete; enables the action button for `appUrl` when one is shown. */
  done(appUrl?: string): void
  /** Mark failed; keeps the window open with the error and a logs button. */
  fail(message: string): void
  /**
   * Resolves once the window is on screen with its current phase painted (or a
   * short timeout). Callers await this before triggering a UAC prompt so the
   * user sees the window — and *why* admin is needed — before the prompt, rather
   * than the prompt appearing over a blank screen.
   */
  whenVisible(): Promise<void>
  /** Resolves when the operator closes the window; the host awaits this last. */
  wait(): Promise<void>
}

/**
 * Where the window's PowerShell writes its own stdout/stderr. If the window
 * fails to render (a script error we cannot show in a window that never
 * appeared), this file holds the reason. Stable under %TEMP% so it is findable.
 */
export function setupGuiDiagnosticLogPath(appId: string): string {
  return path.join(tmpdir(), `${appId}-setup-gui.log`)
}

/**
 * Spawns the window and returns a handle to drive it, or null when not on
 * Windows (the caller then keeps its console output).
 */
export function startSetupGui(options: SetupGuiOptions): SetupGui | null {
  if (process.platform !== 'win32') return null

  let workDir: string
  try {
    workDir = mkdtempSync(path.join(tmpdir(), `${options.appId}-setup-`))
  } catch {
    return null
  }
  const progressFile = path.join(workDir, 'progress.json')
  const logoPath = path.join(workDir, 'logo.png')
  const scriptPath = path.join(workDir, 'setup-gui.ps1')
  // The window touches this once it has painted its first phase; whenVisible()
  // waits for it so a UAC prompt never beats the window onto the screen.
  const readyFile = path.join(workDir, 'ready')
  const visible = new Promise<void>((resolve) => {
    const deadline = Date.now() + 6_000
    const poll = setInterval(() => {
      if (existsSync(readyFile) || Date.now() > deadline) {
        clearInterval(poll)
        resolve()
      }
    }, 100)
  })

  const state: SetupProgress = { status: 'running', phase: 'Starting…', highlight: '', copyText: '', lines: [], appUrl: '', logsDir: options.logsDir }
  const flush = (): void => {
    try {
      const tmp = `${progressFile}.tmp`
      writeFileSync(tmp, JSON.stringify(state))
      renameSync(tmp, progressFile) // atomic: the window never reads a half-written file
    } catch {
      // Best-effort; the window keeps its last good state.
    }
  }

  let closed: Promise<void>
  try {
    writeFileSync(logoPath, options.logoPng)
    // Lead with a UTF-8 BOM (U+FEFF) so Windows PowerShell 5.1 decodes the
    // script's non-ASCII (… —) as UTF-8 instead of the ANSI codepage.
    writeFileSync(scriptPath, `${'\ufeff'}${generateSetupGuiScript({
      ...options,
      progressFile,
      logoPath,
      readyFile,
      openLabel: options.openLabel ?? `Open ${options.appName}`,
      showCopy: options.showCopy ?? false,
      copyLabel: options.copyLabel ?? 'Copy code'
    })}`, 'utf8')
    flush()
    let diagFd: number | undefined
    try {
      diagFd = openSync(setupGuiDiagnosticLogPath(options.appId), 'w')
    } catch {
      diagFd = undefined
    }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { stdio: ['ignore', diagFd ?? 'ignore', diagFd ?? 'ignore'], windowsHide: true }
    )
    // The child inherited its own duplicate of the fd; drop ours.
    if (diagFd !== undefined) closeSync(diagFd)
    closed = new Promise<void>((resolve) => {
      child.on('error', () => resolve())
      child.on('exit', () => resolve())
    })
  } catch {
    return null
  }

  return {
    phase(message) {
      state.phase = message
      state.lines.push(message)
      flush()
    },
    log(message) {
      state.lines.push(message)
      flush()
    },
    highlight(text) {
      state.highlight = text
      flush()
    },
    setCopyText(text) {
      state.copyText = text
      flush()
    },
    done(appUrl) {
      state.status = 'done'
      state.phase = options.readyText
      state.appUrl = appUrl ?? ''
      flush()
    },
    fail(message) {
      state.status = 'error'
      state.phase = 'This did not complete'
      state.lines.push(message)
      flush()
    },
    whenVisible() {
      return visible
    },
    wait() {
      return closed
    }
  }
}

/** WinForms window driven by the progress file; mirrors the tray's PS approach. */
function generateSetupGuiScript(input: {
  progressFile: string
  logoPath: string
  readyFile: string
  appName: string
  title: string
  showOpen: boolean
  openLabel: string
  showCopy: boolean
  copyLabel: string
}): string {
  const q = (value: string): string => value.replaceAll("'", "''")
  return `$ErrorActionPreference = 'Stop'
# Win32 surface: System DPI awareness (which WinForms scales against) and
# ShowWindow/SetForegroundWindow to force the form visible. The host launches us
# with windowsHide (so no console pops), but that sets our process show state to
# SW_HIDE — which WinForms applies to the main form. We override it on the form's
# own handle once the message loop runs (see the timer's first tick).
Add-Type -Name Win32 -Namespace SetupUi -MemberDefinition '
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'
try { [void][SetupUi.Win32]::SetProcessDPIAware() } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
# Route any unhandled WinForms exception (e.g. from a timer tick) to stderr — the
# diagnostic log — instead of popping a .NET crash dialog in the user's face.
try { [System.Windows.Forms.Application]::add_ThreadException({ param($s, $e) try { Write-Error ($e.Exception | Out-String) } catch {} }) } catch {}
try {

$progressFile = '${q(input.progressFile)}'
$readyFile = '${q(input.readyFile)}'
$logoPath = '${q(input.logoPath)}'
$appName = '${q(input.appName)}'
$title = '${q(input.title)}'
$openLabel = '${q(input.openLabel)}'
$copyLabel = '${q(input.copyLabel)}'
$showOpen = $${input.showOpen ? 'true' : 'false'}
$showCopy = $${input.showCopy ? 'true' : 'false'}
$script:appUrl = ''
$script:copyText = ''
$script:logsDir = ''
$script:seen = 0
$script:shown = $false

$form = New-Object System.Windows.Forms.Form
# Design coordinates are at 96 DPI; AutoScaleMode = Dpi scales the whole layout
# to the display DPI so the (DPI-scaled) fonts never overrun the controls.
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
$form.Text = $title
$form.ClientSize = New-Object System.Drawing.Size(600, 470)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$logo = New-Object System.Windows.Forms.PictureBox
$logo.SizeMode = 'Zoom'
$logo.Size = New-Object System.Drawing.Size(44, 44)
$logo.Location = New-Object System.Drawing.Point(20, 18)
try { $logo.Image = [System.Drawing.Image]::FromFile($logoPath) } catch {}
$form.Controls.Add($logo)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = $title
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object System.Drawing.Point(76, 22)
$titleLabel.AutoSize = $true
$form.Controls.Add($titleLabel)

$phase = New-Object System.Windows.Forms.Label
$phase.Text = 'Starting…'
$phase.AutoSize = $false
$phase.AutoEllipsis = $true
$phase.Location = New-Object System.Drawing.Point(20, 64)
$phase.Size = New-Object System.Drawing.Size(560, 18)
$form.Controls.Add($phase)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 30
$bar.Location = New-Object System.Drawing.Point(20, 90)
$bar.Size = New-Object System.Drawing.Size(560, 14)
$form.Controls.Add($bar)

$output = New-Object System.Windows.Forms.TextBox
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = 'Vertical'
$output.BackColor = [System.Drawing.Color]::White
$output.Font = New-Object System.Drawing.Font('Consolas', 9)
$output.Location = New-Object System.Drawing.Point(20, 114)
$output.Size = New-Object System.Drawing.Size(560, 232)
$form.Controls.Add($output)

# Prominent connect code / app URL, placed AFTER the log so it is at the end of
# the reading flow, right above the action buttons (empty until the host sets it).
$highlight = New-Object System.Windows.Forms.Label
$highlight.Text = ''
$highlight.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$highlight.TextAlign = 'MiddleCenter'
$highlight.AutoEllipsis = $true
$highlight.Location = New-Object System.Drawing.Point(20, 354)
$highlight.Size = New-Object System.Drawing.Size(560, 36)
$form.Controls.Add($highlight)

# Buttons live in a right-to-left flow panel so they pack to the right and
# AutoSize to their text — they never clip or overlap, whatever the DPI or which
# optional buttons are shown. Added in right-to-left visual order. (Named
# $buttonBar, distinct from the $bar progress bar above.)
$buttonBar = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonBar.FlowDirection = 'RightToLeft'
$buttonBar.WrapContents = $false
$buttonBar.Location = New-Object System.Drawing.Point(20, 402)
$buttonBar.Size = New-Object System.Drawing.Size(560, 48)
$form.Controls.Add($buttonBar)

$close = New-Object System.Windows.Forms.Button
$close.Text = 'Close'
$close.AutoSize = $true
$close.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
$close.add_Click({ $form.Close() })
$buttonBar.Controls.Add($close)
$form.AcceptButton = $close

if ($showOpen) {
  $open = New-Object System.Windows.Forms.Button
  $open.Text = $openLabel
  $open.AutoSize = $true
  $open.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
  $open.Enabled = $false
  # Start-Process on a URL goes through ShellExecute, which opens it in the
  # default browser. (This window is unelevated, so the browser is too — no need
  # for the old explorer.exe indirection, which opened a file window instead.)
  $open.add_Click({ if ($script:appUrl) { Start-Process $script:appUrl }; $form.Close() })
  $buttonBar.Controls.Add($open)
  $form.AcceptButton = $open
}

if ($showCopy) {
  $copy = New-Object System.Windows.Forms.Button
  $copy.Text = $copyLabel
  $copy.AutoSize = $true
  $copy.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
  $copy.Enabled = $false
  $copy.add_Click({
    if ($script:copyText) {
      try { [System.Windows.Forms.Clipboard]::SetText($script:copyText); $copy.Text = 'Copied!' } catch {}
    }
  })
  $buttonBar.Controls.Add($copy)
}

$logsBtn = New-Object System.Windows.Forms.Button
$logsBtn.Text = 'View logs'
$logsBtn.AutoSize = $true
$logsBtn.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
$logsBtn.Visible = $false
$logsBtn.add_Click({ if ($script:logsDir -and (Test-Path -LiteralPath $script:logsDir)) { Start-Process $script:logsDir } })
$buttonBar.Controls.Add($logsBtn)

$script:marked = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.add_Tick({
  if (-not $script:shown) {
    # Override the SW_HIDE the launcher set (windowsHide) so the form appears.
    $script:shown = $true
    [void][SetupUi.Win32]::ShowWindow($form.Handle, 1)
    [void][SetupUi.Win32]::SetForegroundWindow($form.Handle)
  }
  if (-not (Test-Path -LiteralPath $progressFile)) { return }
  try { $p = Get-Content -LiteralPath $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return }
  if (-not $p) { return }
  $phase.Text = [string]$p.phase
  $highlight.Text = [string]$p.highlight
  $script:copyText = [string]$p.copyText
  if ($showCopy -and $script:copyText) { $copy.Enabled = $true }
  $script:logsDir = [string]$p.logsDir
  if ($p.lines -and $p.lines.Count -gt $script:seen) {
    for ($i = $script:seen; $i -lt $p.lines.Count; $i++) { $output.AppendText([string]$p.lines[$i] + [Environment]::NewLine) }
    $script:seen = $p.lines.Count
  }
  if (-not $script:marked) {
    # Signal the host that the window is up AND has painted this phase, so it can
    # raise a UAC prompt knowing the user can already see why. Refresh forces the
    # paint to happen now rather than after this handler returns.
    $script:marked = $true
    $form.Refresh()
    try { [System.IO.File]::WriteAllText($readyFile, 'ok') } catch {}
  }
  if ($p.status -eq 'done') {
    $bar.Style = 'Continuous'; $bar.Value = 100
    $script:appUrl = [string]$p.appUrl
    if ($showOpen) { $open.Enabled = [bool]$p.appUrl }
    # Keep logs reachable after success too, so the operator can check service
    # output if the app/bridge is slow to come up.
    if ($script:logsDir -and (Test-Path -LiteralPath $script:logsDir)) { $logsBtn.Visible = $true }
    $form.TopMost = $false
  } elseif ($p.status -eq 'error') {
    $bar.Style = 'Continuous'; $bar.Value = 100
    $logsBtn.Visible = $true
    $form.TopMost = $false
  }
})
$timer.Start()
$form.Add_Shown({
  $script:shown = $true
  [void][SetupUi.Win32]::ShowWindow($form.Handle, 1)
  [void][SetupUi.Win32]::SetForegroundWindow($form.Handle)
  $form.Activate(); $form.BringToFront()
})
[System.Windows.Forms.Application]::Run($form)
} catch {
  # The window failed to render — there is nowhere on screen to show this, so
  # emit it to stderr, which the launcher captures into the diagnostic log.
  Write-Error ($_ | Out-String)
  exit 1
}
`
}
