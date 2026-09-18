import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseWorktreeList,
  privateWorktreeVolumes,
  removeCurrentWorktree
} from './worktree-removal.mjs'

const WORKTREES = `worktree /checkout
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/dev

worktree /trees/feature
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feature
`

test('parses registered worktree roots and branches', () => {
  assert.deepEqual(parseWorktreeList(WORKTREES), [
    { root: '/checkout', branch: 'refs/heads/dev' },
    { root: '/trees/feature', branch: 'refs/heads/feature' }
  ])
})

test('private volume names exclude the shared slicer engine cache', () => {
  assert.deepEqual(privateWorktreeVolumes('printstream-wt-feature'), [
    'printstream-wt-feature-database',
    'printstream-wt-feature_slicer-data',
    'printstream-wt-feature_slicer-work'
  ])
})

test('tears down and removes a clean worktree before deleting only its private volumes', () => {
  const calls = []
  const result = removeCurrentWorktree({
    repoRoot: '/trees/feature',
    environment: { PATH: '/bin' },
    resolveIdentity: () => ({ isPrimary: false, composeProject: 'printstream-wt-feature' }),
    run: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd })
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: WORKTREES, stderr: '' }
      }
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
      if (command === 'docker' && args[1] === 'ls') {
        return {
          status: 0,
          stdout: [
            'printstream-wt-feature-database',
            'printstream-wt-feature_slicer-data',
            'printstream-wt-feature_slicer-work',
            'printstream-slicer-compose-engines'
          ].join('\n'),
          stderr: ''
        }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
  })

  assert.equal(result.state, 'removed')
  assert.deepEqual(calls.map(({ command, args, cwd }) => ({ command, args, cwd })), [
    { command: 'git', args: ['worktree', 'list', '--porcelain'], cwd: '/trees/feature' },
    { command: 'git', args: ['status', '--short'], cwd: '/trees/feature' },
    { command: 'npm', args: ['run', 'dev:down'], cwd: '/trees/feature' },
    { command: 'git', args: ['worktree', 'remove', '/trees/feature'], cwd: '/checkout' },
    { command: 'docker', args: ['volume', 'ls', '--format', '{{.Name}}'], cwd: '/checkout' },
    {
      command: 'docker',
      args: [
        'volume',
        'rm',
        'printstream-wt-feature-database',
        'printstream-wt-feature_slicer-data',
        'printstream-wt-feature_slicer-work'
      ],
      cwd: '/checkout'
    }
  ])
})

test('fails closed on a dirty worktree unless discard was explicitly authorized', () => {
  const calls = []
  const result = removeCurrentWorktree({
    repoRoot: '/trees/feature',
    resolveIdentity: () => ({ isPrimary: false, composeProject: 'printstream-wt-feature' }),
    run: (command, args) => {
      calls.push({ command, args })
      if (args[0] === 'worktree') return { status: 0, stdout: WORKTREES, stderr: '' }
      return { status: 0, stdout: ' M feature.ts\n', stderr: '' }
    }
  })

  assert.equal(result.state, 'failed')
  assert.match(result.detail, /explicit discard authorization/)
  assert.equal(calls.some(({ command }) => command === 'npm'), false)
})

test('uses forced worktree removal only after explicit discard authorization', () => {
  const calls = []
  const result = removeCurrentWorktree({
    repoRoot: '/trees/feature',
    discardChanges: true,
    resolveIdentity: () => ({ isPrimary: false, composeProject: 'printstream-wt-feature' }),
    run: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd })
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: WORKTREES, stderr: '' }
      }
      if (command === 'git' && args[0] === 'status') {
        return { status: 0, stdout: ' M feature.ts\n', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
  })

  assert.equal(result.state, 'removed')
  assert.deepEqual(
    calls.find(({ command, args }) => command === 'git' && args[0] === 'worktree' && args[1] === 'remove'),
    {
      command: 'git',
      args: ['worktree', 'remove', '--force', '/trees/feature'],
      cwd: '/checkout'
    }
  )
})

test('refuses to remove the primary checkout before running commands', () => {
  let called = false
  const result = removeCurrentWorktree({
    repoRoot: '/checkout',
    resolveIdentity: () => ({ isPrimary: true, composeProject: 'printstream' }),
    run: () => {
      called = true
      return { status: 0, stdout: '', stderr: '' }
    }
  })

  assert.deepEqual(result, { state: 'failed', detail: 'refusing to remove the primary checkout' })
  assert.equal(called, false)
})
