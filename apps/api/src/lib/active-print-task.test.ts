import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTaskScopedAliasKey, matchesActivePrintTask, normalizeActivePrintTaskId } from './active-print-task.js'

test('matchesActivePrintTask requires equal task ids when either side has one', () => {
  assert.equal(matchesActivePrintTask('5681', '5681'), true)
  assert.equal(matchesActivePrintTask('5681', '5682'), false)
  assert.equal(matchesActivePrintTask('5681', null), false)
  assert.equal(matchesActivePrintTask(null, '5681'), false)
})

test('matchesActivePrintTask falls back to true when both task ids are absent', () => {
  assert.equal(matchesActivePrintTask(null, null), true)
  assert.equal(matchesActivePrintTask('  ', undefined), true)
})

test('buildTaskScopedAliasKey appends the normalized task id', () => {
  assert.equal(buildTaskScopedAliasKey('serial:/foo:plate:1', ' 5681 '), 'serial:/foo:plate:1:task:5681')
  assert.equal(buildTaskScopedAliasKey('serial:/foo:plate:1', null), 'serial:/foo:plate:1')
  assert.equal(normalizeActivePrintTaskId('   '), null)
})