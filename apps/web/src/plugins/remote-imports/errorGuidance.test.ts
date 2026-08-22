import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getRemoteImportErrorGuidance } from './errorGuidance'

test('getRemoteImportErrorGuidance returns MakerWorld captcha recovery steps', () => {
  const guidance = getRemoteImportErrorGuidance('MakerWorld blocked the download with a Captcha challenge: "robot check".')

  assert.equal(guidance?.title, 'Manual Intervention Required')
  assert.equal(guidance?.requiresManualIntervention, true)
  assert.equal(guidance?.steps.length, 3)
  assert.match(guidance?.steps[0] ?? '', /manually clicking the download button/i)
  assert.match(guidance?.note ?? '', /ip address or vpn/i)
  assert.match(guidance?.note ?? '', /few hours/i)
})

test('getRemoteImportErrorGuidance returns null for generic failures', () => {
  assert.equal(getRemoteImportErrorGuidance('Import failed'), null)
})
