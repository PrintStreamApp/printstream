import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldSkipAuditLog } from './audit-logs.js'

test('skips the health probe', () => {
  assert.equal(shouldSkipAuditLog('/api/health', 200), true)
})

test('does not skip the audit-log clear (DELETE /api/logs 204)', () => {
  assert.equal(shouldSkipAuditLog('/api/logs', 204), false)
})

test('skips per-chunk upload PUTs (audited once at /complete instead)', () => {
  assert.equal(shouldSkipAuditLog('/api/library/uploads/abc-123/chunks', 200), true)
  assert.equal(shouldSkipAuditLog('/api/library/uploads/XYZ_9/chunks', 204), true)
})

test('still audits the upload completion and other library mutations', () => {
  assert.equal(shouldSkipAuditLog('/api/library/uploads/abc-123/complete', 200), false)
  assert.equal(shouldSkipAuditLog('/api/library/uploads/abc-123', 200), false)
  assert.equal(shouldSkipAuditLog('/api/library/uploads/abc-123/chunks/extra', 200), false)
  assert.equal(shouldSkipAuditLog('/api/printers', 201), false)
})
