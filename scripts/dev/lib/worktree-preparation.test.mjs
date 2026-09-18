import assert from 'node:assert/strict'
import { test } from 'node:test'

import { prepareWorktree } from './worktree-preparation.mjs'

test('prepares checkout dependencies without running a development preflight', async () => {
  const calls = []
  const result = await prepareWorktree({
    repoRoot: '/checkout',
    environment: { PATH: '/bin' },
    run: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: '  + checkout already prepared\n', stderr: '' }
    }
  })

  assert.equal(result.state, 'prepared')
  assert.deepEqual(result.lines, ['+ checkout already prepared'])
  assert.deepEqual(calls, [{
    command: 'devkit',
    args: ['prepare'],
    options: {
      cwd: '/checkout',
      encoding: 'utf8',
      env: { PATH: '/bin' },
      timeout: 14 * 60 * 1000
    }
  }])
})

test('returns Devkit preparation failures without touching development infrastructure', async () => {
  const result = await prepareWorktree({
    repoRoot: '/checkout',
    run: () => ({ status: 1, stdout: '', stderr: 'npm ci failed' })
  })

  assert.equal(result.state, 'failed')
  assert.equal(result.detail, 'npm ci failed')
})
