import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { generateLinuxTrayScript } from './linux-tray.js'

/** Execute the real emitted menu handler and viewer with inert GTK and journal I/O. */
const fixture = String.raw`
import ast, json, sys, subprocess, types, threading
source, scenario = json.load(sys.stdin)
tree = ast.parse(source)
tray = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Tray')
handler = next(node for node in tray.body if isinstance(node, ast.FunctionDef) and node.name == 'view_logs')
initializer = next(node for node in tray.body if isinstance(node, ast.FunctionDef) and node.name == '__init__')
assert any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and
           isinstance(node.func.value, ast.Name) and node.func.value.id == 'logs_item' and
           node.func.attr == 'connect' and len(node.args) == 2 and
           isinstance(node.args[0], ast.Constant) and node.args[0].value == 'activate' and
           isinstance(node.args[1], ast.Attribute) and node.args[1].attr == 'view_logs'
           for node in ast.walk(initializer)), 'Actual menu must bind the tested callback'
# Keep emitted constants and viewer functions, excluding all GUI initialization.
nodes = [node for node in tree.body if isinstance(node, ast.Assign) or
         (isinstance(node, ast.FunctionDef) and node.name in ['read_service_logs', 'show_service_logs'])]
nodes.append(handler)
calls, texts, events, pending = [], [], [], []
class Widget:
    def __init__(self, **kwargs): pass
    def __getattr__(self, name): return lambda *args: None
    def get_buffer(self): return self
    def get_content_area(self): return self
    def set_text(self, text): texts.append(text)
    def connect(self, event, callback): events.append((event, callback))
class Worker:
    def __init__(self, target, daemon): self.target = target
    def start(self): self.target()
def run(command, **kwargs):
    calls.append([command, kwargs])
    if scenario == 'missing': raise FileNotFoundError()
    if scenario == 'timeout': raise subprocess.TimeoutExpired(command, 15)
    if scenario == 'oserror': raise PermissionError('execution denied')
    return types.SimpleNamespace(
        returncode=1 if scenario == 'denied' else 0,
        stdout='' if scenario in ['empty', 'denied'] else ('-- No entries --' if scenario == 'noentries' else 'retained service log'),
        stderr='Permission denied' if scenario in ['denied', 'warning'] else '')
threading.Thread = Worker
gtk = types.SimpleNamespace(Dialog=Widget, TextView=Widget, ScrolledWindow=Widget,
                            ResponseType=types.SimpleNamespace(CLOSE=1))
namespace = {'Gtk': gtk, 'GLib': types.SimpleNamespace(idle_add=lambda cb, value: pending.append((cb, value))),
             'subprocess': types.SimpleNamespace(run=run, TimeoutExpired=subprocess.TimeoutExpired)}
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<actual emitted logs callback>', 'exec'), namespace)
# No status read or service/control-channel access is available to this callback.
namespace['view_logs'](object())
if scenario == 'closed':
    next(callback for event, callback in events if event == 'destroy')()
for callback, value in pending: callback(value)
json.dump({'calls': calls, 'texts': texts}, sys.stdout)
`

interface ViewerResult { calls: [string[], Record<string, unknown>][]; texts: string[] }

function viewLogs(scenario: string, serviceId = 'printstream-bridge'): ViewerResult {
  const source = generateLinuxTrayScript({
    appName: 'Fixture app', serviceId, iconPath: '/fixture/icon.png',
    statusFile: '/absent/status.json', exePath: '/fixture/exe',
  })
  const child = spawnSync('python3', ['-c', fixture], {
    input: JSON.stringify([source, scenario]), encoding: 'utf8', timeout: 5000,
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout) as ViewerResult
}

const linuxOnly = { skip: process.platform !== 'linux' ? 'Requires Linux Python; no desktop launch' : false }

for (const serviceId of ['printstream-bridge', 'printstream', "fixture with 'quotes' $()"]) {
  test(`Linux View logs reads the fixed journal for ${serviceId} without service status`, linuxOnly, () => {
    const result = viewLogs('success', serviceId)
    assert.deepEqual(result.calls, [[[
      'journalctl', '--system', `--unit=${serviceId}.service`, '--lines=500', '--no-pager', '--output=short-iso',
    ], { capture_output: true, text: true, errors: 'replace', timeout: 15 }]])
    assert.equal(result.texts.at(-1), 'retained service log')
  })
}

for (const [scenario, diagnostic] of [
  ['missing', 'journalctl is not installed'], ['timeout', 'timed out'],
  ['oserror', 'execution denied'], ['denied', 'Permission denied'],
  ['empty', 'No journal entries'], ['noentries', 'No journal entries'],
] as const) {
  test(`Linux View logs visibly explains ${scenario}`, linuxOnly, () => {
    assert.ok(viewLogs(scenario).texts.at(-1)?.includes(diagnostic))
  })
}

test('Linux View logs preserves permission warnings even on journalctl success', linuxOnly, () => {
  const text = viewLogs('warning').texts.at(-1) ?? ''
  assert.match(text, /entries may be incomplete/)
  assert.match(text, /Permission denied/)
  assert.match(text, /retained service log/)
})

test('Linux View logs does not update a destroyed dialog after a late read', linuxOnly, () => {
  assert.equal(viewLogs('closed').texts.length, 1)
})
