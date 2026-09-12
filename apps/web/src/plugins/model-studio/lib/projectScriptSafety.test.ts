import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPostProcessingScripts, removePostProcessingScripts } from './projectScriptSafety'

test('detects host commands but treats Studio empty defaults as script-free', () => {
  assert.equal(hasPostProcessingScripts('{"post_process":[]}'), false)
  assert.equal(hasPostProcessingScripts('{"post_process":["  "]}'), false)
  assert.equal(hasPostProcessingScripts('{"post_process":["/tmp/process.sh"]}'), true)
})

test('removes only host commands and preserves printer G-code', () => {
  const result = JSON.parse(removePostProcessingScripts(JSON.stringify({
    post_process: ['host-command'],
    machine_start_gcode: 'G28'
  }))) as Record<string, unknown>
  assert.deepEqual(result.post_process, [])
  assert.equal(result.machine_start_gcode, 'G28')
})
