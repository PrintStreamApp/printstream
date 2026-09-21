import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getRemoteImportErrorGuidance } from './errorGuidance'

test('getRemoteImportErrorGuidance directs a blocked MakerWorld download to manual import', () => {
  const guidance = getRemoteImportErrorGuidance(
    'MakerWorld blocked PrintStream\'s automated download with a security challenge.'
  )

  assert.equal(guidance?.title, 'Manual download required')
  assert.equal(guidance?.requiresManualIntervention, true)
  assert.equal(guidance?.steps.length, 2)
  assert.match(guidance?.steps[0] ?? '', /download the 3mf in your browser/i)
  assert.match(guidance?.steps[1] ?? '', /choose upload files/i)
  assert.match(guidance?.note ?? '', /does not grant printstream access to retry/i)
})

test('getRemoteImportErrorGuidance returns null for generic failures', () => {
  assert.equal(getRemoteImportErrorGuidance('Import failed'), null)
})
