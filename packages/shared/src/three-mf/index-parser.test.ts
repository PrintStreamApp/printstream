import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractProjectVersion } from './index-parser.js'

test('extractProjectVersion reads the Bambu Studio version that saved the project', () => {
  // Used to warn before a slice: BambuStudio refuses a project newer than the engine (exit 232).
  assert.equal(extractProjectVersion(JSON.stringify({ version: '02.08.00.50' })), '02.08.00.50')
  assert.equal(extractProjectVersion(JSON.stringify({ version: ' 01.09.05.51 ' })), '01.09.05.51')
  // Unknown must stay null — never guessed, or the dialog would warn (or not) on invented data.
  assert.equal(extractProjectVersion(JSON.stringify({})), null)
  assert.equal(extractProjectVersion(JSON.stringify({ version: 'v2.8' })), null)
  assert.equal(extractProjectVersion('not json'), null)
  assert.equal(extractProjectVersion(null), null)
})
