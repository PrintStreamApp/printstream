/**
 * Inert interpreters for the emitted tray callbacks. Only the actual refresh
 * function or timer callback runs: no GUI initialization or service handlers.
 * Counterpart tray-provider.test.ts supplies each real generated script.
 */

/** Extract the Linux callback with Python AST, without importing its GTK module. */
export const linuxRefreshFixture = String.raw`"""Run only the actual emitted Linux refresh method with inert menu doubles."""
import ast, json, sys
source, statuses = json.load(sys.stdin)
tree = ast.parse(source)
tray = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Tray')
method = next(node for node in tray.body if isinstance(node, ast.FunctionDef) and node.name == 'refresh')
module = ast.Module(body=[method], type_ignores=[])

class Item:
    def __init__(self):
        self.visible = True
        self.label = ''
    def hide(self): self.visible = False
    def show(self): self.visible = True
    def set_label(self, value): self.label = value

class FakeTray:
    pass

state = FakeTray()
names = ['status', 'open', 'version', 'code', 'connect', 'copy_code', 'workspace', 'update', 'start_service', 'stop_service', 'restart_service']
for name in names: setattr(state, name + '_item', Item())
state.status_icon = None
state.app_url = ''
state.workspace_url = ''
state.connect_url = ''
state.connect_code = ''
namespace = {'APP_NAME': 'PrintStream'}
exec(compile(module, '<actual emitted refresh>', 'exec'), namespace)
for status in statuses:
    namespace['bridge_status'] = lambda: status
    namespace['refresh'](state)
json.dump({'items': {name: vars(getattr(state, name + '_item')) for name in names},
           'app_url': state.app_url, 'workspace_url': state.workspace_url,
           'connect_url': state.connect_url, 'connect_code': state.connect_code}, sys.stdout)
`

/** Execute one Windows callback case without constructing WinForms or NotifyIcon. */
export const windowsRefreshFixture = String.raw`# Source-only until host lane settles. Execute only the actual emitted tick with
# inert objects; no Forms, NotifyIcon, service, browser, task or client calls.
param([Parameter(Mandatory=$true)][string]$ProviderSha256, [ValidateSet('version','retirement')][string]$Case)
$ErrorActionPreference='Stop'
$file=Join-Path $PSScriptRoot 'windows-tray.ps1'
if ($ProviderSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ProviderSha256) { throw 'Accepted emitted provider required' }
$source=[IO.File]::ReadAllText($file)
$matches=[regex]::Matches($source,'(?s)\$timer\.add_Tick\(\{\r?\n(.*?)\r?\n\}\)\r?\n\$timer\.Start\(\)')
if ($matches.Count -ne 1) { throw 'Expected one actual emitted timer callback' }
$tick=[scriptblock]::Create($matches[0].Groups[1].Value)
$names=@('open','status','version','code','connect','workspace','copyCode','startService','stopService','restartService','update')
$script:testStatus=$null
# These are the only external reads the callback performs. The executable is
# modeled present; the missing-executable Application.Exit path is not admitted.
function Test-Path { param([string]$LiteralPath) return $true }
function Get-BridgeStatus { return $script:testStatus }
function Invoke-InertSequence($statuses) {
  $items=@{}
  foreach($name in $names) {
    $item=[pscustomobject]@{Visible=$true;Text='';Enabled=$true}
    Set-Variable -Name ($name+'Item') -Value $item
    $items[$name]=$item
  }
  $appName='PrintStream';$exePath='fixture-existing'
  $notify=[pscustomobject]@{Visible=$true;Text=''}
  $script:appUrl='';$script:workspaceUrl='';$script:connectUrl='';$script:connectCode=''
  foreach($status in $statuses) { $script:testStatus=$status; [void]$tick.Invoke() }
  return @{items=$items;appUrl=$script:appUrl;workspaceUrl=$script:workspaceUrl;connectUrl=$script:connectUrl;connectCode=$script:connectCode}
}
$cases=@()
if ($Case -eq 'version') { try {
  $result=Invoke-InertSequence @([pscustomobject]@{pid=42;lifecycle='running';appUrl='http://localhost:8080';build='abcdef0123456789'})
  if (-not $result.items.version.Visible -or $result.items.version.Text -ne 'Version: abcdef012345') { throw 'Server string fingerprint not displayed' }
  $cases+=@{name='Windows string server build displays fingerprint through actual emitted tick';pass=$true}
} catch { $cases+=@{name='Windows string server build displays fingerprint through actual emitted tick';pass=$false;error=$_.Exception.Message} }
}
if ($Case -eq 'retirement') { try {
  $bridge=[pscustomobject]@{pid=42;lifecycle='connected';workspaceUrl='https://example.test/workspace';connectCode='fixture';connectUrl='https://example.test/connect';build=[pscustomobject]@{buildRevision='bridge-build'}}
  $result=Invoke-InertSequence @($bridge,$null)
  if ($result.items.workspace.Visible -or $result.workspaceUrl -ne '' -or $result.connectUrl -ne '' -or $result.connectCode -ne '') { throw 'Retired status retained stale workspace' }
  $cases+=@{name='Windows missing status retires prior workspace through actual emitted tick';pass=$true}
} catch { $cases+=@{name='Windows missing status retires prior workspace through actual emitted tick';pass=$false;error=$_.Exception.Message} }
}
$cases|ConvertTo-Json -Depth 6
if (@($cases|Where-Object{-not $_.pass}).Count) { exit 1 }
`
