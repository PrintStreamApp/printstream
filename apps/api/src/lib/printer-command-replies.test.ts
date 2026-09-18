import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PrinterCommandReplies } from './printer-command-replies.js'

test('calibration replies cannot cross printers, sequences or commands', async () => {
  const replies = new PrinterCommandReplies()
  const response = replies.wait('wilma', '1', 'extrusion_cali')
  let settled = false
  void response.then(() => { settled = true })
  replies.accept('fred', { print: { sequence_id: '1', command: 'extrusion_cali' } })
  replies.accept('wilma', { print: { sequence_id: '1', command: 'extrusion_cali_get_result' } })
  await Promise.resolve()
  assert.equal(settled, false)
  replies.accept('wilma', { print: { sequence_id: '1', command: 'extrusion_cali', result: 'success' } })
  assert.equal((await response).result, 'success')
})

test('disconnect and timeout reject pending requests without retrying mutations', async () => {
  const replies = new PrinterCommandReplies()
  const response = replies.wait('wilma', '2', 'extrusion_cali')
  replies.clear('wilma', 'Disconnected')
  await assert.rejects(response, /Disconnected/)
  await assert.rejects(replies.wait('wilma', '3', 'extrusion_cali_get_result', 1), /timed out/)
})
