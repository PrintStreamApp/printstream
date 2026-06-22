import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toPrinterDto, toPublicPrinterDto } from './printer-record.js'

function makeRow(overrides: { accessCode?: string } = {}) {
  return {
    id: 'printer-1',
    name: 'Printer 1',
    host: '192.168.1.10',
    serial: 'SERIAL123',
    accessCode: overrides.accessCode ?? 'super-secret-code',
    model: 'P1S',
    bridgeId: 'bridge-1',
    currentPlateType: null,
    currentNozzleDiameters: null,
    position: 0,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z')
  }
}

test('toPrinterDto keeps the real access code for internal/transport use', () => {
  const dto = toPrinterDto(makeRow())
  assert.equal(dto.accessCode, 'super-secret-code')
  assert.equal(dto.accessCodeConfigured, undefined)
})

test('toPublicPrinterDto blanks the access code and reports it as configured', () => {
  const dto = toPublicPrinterDto(makeRow())
  assert.equal(dto.accessCode, '', 'the LAN credential must never reach the browser')
  assert.equal(dto.accessCodeConfigured, true)
  // All other fields are preserved.
  assert.equal(dto.id, 'printer-1')
  assert.equal(dto.host, '192.168.1.10')
  assert.equal(dto.serial, 'SERIAL123')
})

test('toPublicPrinterDto reports an unset access code as not configured', () => {
  const dto = toPublicPrinterDto(makeRow({ accessCode: '' }))
  assert.equal(dto.accessCode, '')
  assert.equal(dto.accessCodeConfigured, false)
})
