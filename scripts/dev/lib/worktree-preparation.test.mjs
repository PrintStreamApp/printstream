import assert from 'node:assert/strict'
import { test } from 'node:test'

import { prepareWorktree } from './worktree-preparation.mjs'

test('prepares dependencies before provisioning and verifies every baseline path', async () => {
  const events = []
  const result = await prepareWorktree({
    repoRoot: '/checkout',
    environment: { PATH: '/bin' },
    run: (command, args, options) => {
      events.push({ kind: 'run', command, args, options })
      return { status: 0, stdout: '', stderr: '' }
    },
    loadDevkit: async () => ({
      preflight: async (options) => {
        events.push({ kind: 'preflight', options })
        return {
          identity: { isPrimary: false },
          project: { baselinePaths: ['data/library', 'apps/bridge/data/bridge-state.json'] },
          lines: ['database cloned', 'data restored']
        }
      }
    }),
    pathExists: (candidate) => {
      events.push({ kind: 'inspect', candidate })
      return true
    }
  })

  assert.equal(result.state, 'prepared')
  assert.equal(result.baselinePathCount, 2)
  assert.deepEqual(events[0], {
    kind: 'run',
    command: 'devkit',
    args: ['prepare'],
    options: {
      cwd: '/checkout',
      encoding: 'utf8',
      env: { PATH: '/bin' },
      timeout: 14 * 60 * 1000
    }
  })
  assert.deepEqual(events[1], {
    kind: 'preflight',
    options: { repoRoot: '/checkout', checkDependencies: false }
  })
  assert.equal(events.filter((event) => event.kind === 'inspect').length, 2)
})

test('fails instead of declaring a partially restored bridge baseline ready', async () => {
  const result = await prepareWorktree({
    repoRoot: '/checkout',
    run: () => ({ status: 0, stdout: '', stderr: '' }),
    loadDevkit: async () => ({
      preflight: async () => ({
        identity: { isPrimary: false },
        project: {
          baselinePaths: [
            'data/library',
            'apps/bridge/data/bridge-state.json',
            'apps/bridge/data/bridge-library'
          ]
        },
        lines: []
      })
    }),
    pathExists: (candidate) => candidate.endsWith('data/library')
  })

  assert.equal(result.state, 'failed')
  assert.match(result.detail, /apps\/bridge\/data\/bridge-state\.json/)
  assert.match(result.detail, /apps\/bridge\/data\/bridge-library/)
  assert.match(result.detail, /npm run dev:host -- snapshot/)
  assert.match(result.detail, /npm run dev:host -- reset/)
})

test('does not require baseline paths in the primary checkout', async () => {
  const result = await prepareWorktree({
    repoRoot: '/checkout',
    run: () => ({ status: 0, stdout: '', stderr: '' }),
    loadDevkit: async () => ({
      preflight: async () => ({
        identity: { isPrimary: true },
        project: { baselinePaths: ['optional/local/path'] },
        lines: []
      })
    }),
    pathExists: () => false
  })

  assert.equal(result.state, 'prepared')
})
