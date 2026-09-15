import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { hostBridgeProcessSpec, stopHostService } from './host-bridge.mjs'

test('a host bridge targets its worktree API without changing fixed container ports', () => {
  const spec = hostBridgeProcessSpec({
    repoRoot: '/repo',
    apiPort: 22071,
    env: { NODE_OPTIONS: '--trace-warnings', KEEP_ME: 'yes' },
    execPath: '/node'
  })

  assert.equal(spec.command, '/node')
  assert.equal(spec.options.cwd, path.join('/repo', 'apps', 'bridge'))
  assert.equal(spec.options.env.BRIDGE_SERVER_URL, 'http://127.0.0.1:22071')
  assert.equal(spec.options.env.KEEP_ME, 'yes')
  assert.match(spec.options.env.NODE_OPTIONS, /--trace-warnings/)
  assert.match(spec.options.env.NODE_OPTIONS, /exit-with-parent\.cjs/)
  assert.deepEqual(spec.args.slice(1, 4), [
    '--name=bridge',
    '--entry=src/index.ts',
    '--env-file=../../.env'
  ])
})

test('stopping a host service asks its supervisor to terminate gracefully', async () => {
  const events = []
  const child = {
    exitCode: null,
    signalCode: null,
    once(event, listener) {
      assert.equal(event, 'exit')
      this.onExit = listener
    },
    kill(signal) {
      events.push(signal)
      this.signalCode = signal
      this.onExit?.()
    }
  }

  await stopHostService(child)
  assert.deepEqual(events, ['SIGTERM'])
})

test('a host service that ignores graceful shutdown is force-stopped visibly', async () => {
  const events = []
  const warnings = []
  const child = {
    exitCode: null,
    signalCode: null,
    once() {},
    kill(signal) { events.push(signal) }
  }

  await stopHostService(child, {
    timeoutMs: 1,
    warn: (message) => warnings.push(message)
  })

  assert.deepEqual(events, ['SIGTERM', 'SIGKILL'])
  assert.match(warnings[0], /did not stop within 1ms/)
})
