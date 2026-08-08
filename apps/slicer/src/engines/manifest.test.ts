process.env.NODE_ENV = 'test'

/**
 * Manifest bookkeeping: which engine is the default, and how versions order.
 *
 * Both rules have a wrong answer that looks right. Sorting versions as strings
 * puts "2.9.0" above "2.10.0"; and picking the newest overall would make a beta
 * the default, which Bambu's own file-version refusal tells users not to slice
 * with.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseDefaultTargetId, compareVersions } from './manifest.js'

function engine(id: string, version: string, prerelease = false) {
  return {
    id, version, prerelease,
    label: id, family: 'bambustudio', slicerName: 'Bambu Studio',
    isDefault: false, cliPath: '/x', appDir: '/x', profileDir: '/x'
  }
}

test('versions compare numerically, not as text', () => {
  assert.ok(compareVersions('2.10.0', '2.9.0') > 0, '2.10 is newer than 2.9')
  assert.ok(compareVersions('2.7.1.62', '2.7.1.57') > 0)
  assert.equal(compareVersions('2.7.1.62', '2.7.1.62'), 0)
})

test('the newest stable wins, never a newer beta', () => {
  const chosen = chooseDefaultTargetId([
    engine('a', '2.7.1.62'),
    engine('b', '2.8.1.55', true),
    engine('c', '2.7.0.55')
  ])
  assert.equal(chosen, 'a', 'a beta must never become the default')
})

test('a deployment holding only betas still gets a default', () => {
  // A default that cannot slice is worse than a beta one.
  const chosen = chooseDefaultTargetId([engine('b', '2.8.0.50', true), engine('c', '2.8.1.55', true)])
  assert.equal(chosen, 'c')
})

test('no engines means no default', () => {
  assert.equal(chooseDefaultTargetId([]), null)
})
