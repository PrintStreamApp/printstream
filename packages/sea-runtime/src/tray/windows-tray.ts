/**
 * Windows tray provider: a PowerShell script hosting a WinForms NotifyIcon, so
 * the packaged app needs no extra GUI dependencies. It reads status from the
 * app's world-readable status file (the control socket is owned by the SYSTEM
 * service and unreachable from this unelevated process) and treats a live PID as
 * "running". Menu items reveal themselves from the status fields present: an
 * "Open <app>" item when the file carries an `appUrl` (the self-hosted server),
 * the connect code/page for the bridge, and an "Update" item when a newer build
 * is available (self-elevating via UAC so the install can swap the binary).
 */
export function generateWindowsTrayScript(input: {
  iconPath: string
  statusFile: string
  logsDir: string
  appName: string
  exePath: string
}): string {
  return `$ErrorActionPreference = 'SilentlyContinue'
# Declare the process System-DPI aware *before* any window exists so the WinForms
# menu renders crisply on high-DPI displays. System (not Per-Monitor V2) is
# deliberate: .NET Framework WinForms natively scales menus/fonts to the system
# DPI, but does NOT scale them under Per-Monitor V2 without an app.config opt-in
# we cannot ship — so Per-Monitor V2 leaves the menu bitmap-stretched (blurry).
try {
  Add-Type -Name DpiAware -Namespace Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [void][Native.DpiAware]::SetProcessDPIAware()
} catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$appName = '${psQuote(input.appName)}'
$exePath = '${psQuote(input.exePath)}'
$statusFile = '${psQuote(input.statusFile)}'
$logsDir = '${psQuote(input.logsDir)}'
$script:connectUrl = ''
$script:connectCode = ''
$script:appUrl = ''

function Get-BridgeStatus {
  if (-not (Test-Path -LiteralPath $statusFile)) { return $null }
  try { $s = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json } catch { return $null }
  if (-not $s -or -not $s.pid) { return $null }
  if (-not (Get-Process -Id $s.pid -ErrorAction SilentlyContinue)) { return $null }
  return $s
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$icon = $null
try { $icon = New-Object System.Drawing.Icon('${psQuote(input.iconPath)}') } catch { $icon = $null }
if (-not $icon) { try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath) } catch { $icon = $null } }
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }
$notify.Icon = $icon
$notify.Text = $appName
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open ' + $appName)
$openItem.Visible = $false
$openItem.add_Click({ if ($script:appUrl) { Start-Process $script:appUrl } })
$statusItem = $menu.Items.Add('Starting...')
$statusItem.Enabled = $false
$versionItem = $menu.Items.Add('')
$versionItem.Enabled = $false
$versionItem.Visible = $false
$codeItem = $menu.Items.Add('')
$codeItem.Enabled = $false
$codeItem.Visible = $false
$connectItem = $menu.Items.Add('Open connect page')
$connectItem.Visible = $false
$connectItem.add_Click({ if ($script:connectUrl) { Start-Process $script:connectUrl } })
$copyCodeItem = $menu.Items.Add('Copy connect code')
$copyCodeItem.Visible = $false
$copyCodeItem.add_Click({ if ($script:connectCode) { Set-Clipboard -Value $script:connectCode } })
[void]$menu.Items.Add('-')
$startServiceItem = $menu.Items.Add('Start service')
$startServiceItem.Visible = $false
$startServiceItem.add_Click({ Start-Process -FilePath $exePath -ArgumentList 'service','start' -Verb RunAs })
$stopServiceItem = $menu.Items.Add('Stop service')
$stopServiceItem.Visible = $false
$stopServiceItem.add_Click({ Start-Process -FilePath $exePath -ArgumentList 'service','stop' -Verb RunAs })
$restartServiceItem = $menu.Items.Add('Restart service')
$restartServiceItem.Visible = $false
$restartServiceItem.add_Click({ Start-Process -FilePath $exePath -ArgumentList 'service','restart' -Verb RunAs })
$updateItem = $menu.Items.Add('Update bridge')
$updateItem.Visible = $false
$updateItem.add_Click({
  $notify.ShowBalloonTip(4000, $appName, 'Updating the bridge — approve the administrator prompt.', [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Process -FilePath $exePath -ArgumentList 'update','apply' -Verb RunAs
})
$logsItem = $menu.Items.Add('View logs')
$logsItem.add_Click({ if (Test-Path -LiteralPath $logsDir) { Start-Process $logsDir } })
$uninstallItem = $menu.Items.Add('Uninstall ' + $appName)
$uninstallItem.add_Click({
  # The uninstall flow itself asks whether to keep or delete data (so the choice
  # is identical from the tray, Settings -> Apps, and the CLI), then elevates.
  Start-Process -FilePath $exePath -ArgumentList 'uninstall'
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$quitItem = $menu.Items.Add('Quit tray')
$quitItem.add_Click({
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$notify.ContextMenuStrip = $menu

# Right-click opens the menu automatically; mirror it on left-click via the
# NotifyIcon's own (non-public) ShowContextMenu so positioning matches.
$showMenu = [System.Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic')
$notify.add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { $showMenu.Invoke($notify, $null) }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  if (-not (Test-Path -LiteralPath $exePath)) {
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
    return
  }
  $s = Get-BridgeStatus
  if (-not $s) {
    $statusItem.Text = $appName + ' not running'
    $openItem.Visible = $false
    $versionItem.Visible = $false
    $codeItem.Visible = $false
    $connectItem.Visible = $false
    $copyCodeItem.Visible = $false
    $updateItem.Visible = $false
    $startServiceItem.Visible = $true
    $stopServiceItem.Visible = $false
    $restartServiceItem.Visible = $false
    $script:appUrl = ''
    $notify.Text = $appName + ' - not running'
    return
  }
  $script:appUrl = [string]$s.appUrl
  $openItem.Visible = [bool]$s.appUrl
  $startServiceItem.Visible = $false
  $stopServiceItem.Visible = $true
  $restartServiceItem.Visible = $true
  $updateItem.Visible = [bool]$s.updateAvailable
  $statusItem.Text = 'Status: ' + $s.lifecycle
  $ver = $s.build.buildRevision
  if (-not $ver) { $ver = $s.build.releaseFingerprint }
  if ($ver) {
    $verText = [string]$ver
    $versionItem.Text = 'Version: ' + $verText.Substring(0, [Math]::Min(12, $verText.Length))
    $versionItem.Visible = $true
  } else {
    $versionItem.Visible = $false
  }
  if ($s.connectCode) {
    $script:connectCode = [string]$s.connectCode
    $script:connectUrl = [string]$s.connectUrl
    $codeItem.Text = 'Connect code: ' + $s.connectCode
    $codeItem.Visible = $true
    $connectItem.Visible = [bool]$s.connectUrl
    $copyCodeItem.Visible = $true
  } else {
    $script:connectCode = ''
    $script:connectUrl = ''
    $codeItem.Visible = $false
    $connectItem.Visible = $false
    $copyCodeItem.Visible = $false
  }
  $text = $appName + ' - ' + $s.lifecycle
  $notify.Text = $text.Substring(0, [Math]::Min(63, $text.Length))
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
`
}

function psQuote(value: string): string {
  return value.replaceAll("'", "''")
}
