import assert from 'node:assert/strict'
import test from 'node:test'
import { BAMBU_FILAMENT_PRESETS, type PrinterCommand } from '@printstream/shared'
import { validateSlotMaterialCommand } from './slot-material-command.js'
import { slotFilamentResolvers } from './slot-filament-registry.js'

const pla = BAMBU_FILAMENT_PRESETS.find((preset) => preset.name === 'Generic PLA')!.id
const composite = BAMBU_FILAMENT_PRESETS.find((preset) => preset.name === 'Generic PETG-CF')!.id
const materialIdentity = { brand: 'Custom', filamentType: 'PETG-CF', materialSubtype: null, colorName: null }
const command: Extract<PrinterCommand, { type: 'setAmsSlot' }> = {
  type: 'setAmsSlot', amsId: 0, slotId: 0, trayInfoIdx: pla, trayType: 'PLA', trayColor: 'FF0000FF',
  nozzleTempMin: 190, nozzleTempMax: 230, materialIdentity
}

test('API rejects both slot command kinds with mismatched or forged compatibility fields', async () => {
  for (const input of [command, { ...command, type: 'setExternalSpool' as const, amsId: 255 as const }]) {
    await assert.rejects(validateSlotMaterialCommand('workspace', 'printer', input), { statusCode: 400 })
    await assert.rejects(validateSlotMaterialCommand('workspace', 'printer', { ...input, trayType: 'PETG-CF' }), { statusCode: 400 })
    await validateSlotMaterialCommand('workspace', 'printer', { ...input, trayType: 'PETG-CF', trayInfoIdx: composite })
    await validateSlotMaterialCommand('workspace', 'printer', { ...input, materialIdentity: { ...materialIdentity, filamentType: 'Custom polymer' } })
  }
})

test('inventory cannot bypass validation by omitting the manual identity', async () => {
  const off = slotFilamentResolvers.register(async (query) => {
    assert.equal(query.workspaceId, 'workspace')
    assert.equal(query.printerId, 'printer')
    return { ...materialIdentity, spoolId: 'spool', remainingGrams: null }
  })
  try {
    await assert.rejects(validateSlotMaterialCommand('workspace', 'printer', { ...command, materialIdentity: null }), { statusCode: 400 })
    await validateSlotMaterialCommand('workspace', 'printer', { ...command, materialIdentity: null, trayInfoIdx: composite, trayType: 'PETG-CF' })
  } finally {
    off()
  }
})

test('inventory lookup failure does not silently permit an unchecked command', async () => {
  const off = slotFilamentResolvers.register(async () => { throw new Error('inventory unavailable') })
  try {
    await assert.rejects(validateSlotMaterialCommand('workspace', 'printer', { ...command, materialIdentity: null }), /inventory unavailable/)
  } finally {
    off()
  }
})
