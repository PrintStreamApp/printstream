import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { getBambuStudioPrintOptionConfig } from './printer-capabilities.js'
import { BAMBU_STUDIO_PRINT_OPTION_CAPABILITIES } from './generated/printer-print-option-capabilities.generated.js'

test('firmware-versioned X1 capabilities follow BambuStudio resource overlays', () => {
  const original = getBambuStudioPrintOptionConfig('X1C', '01.01.00.99')
  assert.equal(original.autoRecovery, false)
  assert.equal(original.buildPlateDetection, false)
  assert.equal(original.aiMonitoring, false)

  const updated = getBambuStudioPrintOptionConfig('X1C', '01.01.01.00')
  assert.equal(updated.autoRecovery, true)
  assert.equal(updated.buildPlateDetection, true)
  assert.equal(updated.buildPlateDetectionType, 1)
  assert.equal(updated.aiMonitoring, true)
})

test('unknown firmware uses Studio base config and unknown models stay conservative', () => {
  assert.equal(getBambuStudioPrintOptionConfig('X1C').autoRecovery, false)
  assert.equal(getBambuStudioPrintOptionConfig('H2D').autoRecovery, true)
  assert.equal(getBambuStudioPrintOptionConfig('unknown').autoRecovery, false)
})

/** Walk up to the workspace root (the directory holding `packages/` and `apps/`). */
function findWorkspaceRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'packages')) && existsSync(join(dir, 'apps'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

test('generated print-option capabilities match the vendored BambuStudio resources', async (t) => {
  const root = findWorkspaceRoot()
  const src = root ? join(root, 'tmp', 'bambustudio-src') : null
  if (!src || !existsSync(join(src, 'resources/printers/O1D.json'))) {
    t.skip('vendored BambuStudio source not present')
    return
  }

  const { extractPrinterPrintOptionCapabilities } = await import(
    join(root!, 'scripts/dev/generate-printer-print-option-capabilities.mjs')
  ) as {
    extractPrinterPrintOptionCapabilities: (source: string) => unknown
  }
  const derived = extractPrinterPrintOptionCapabilities(src)
  assert.deepEqual(
    JSON.parse(JSON.stringify(BAMBU_STUDIO_PRINT_OPTION_CAPABILITIES)),
    JSON.parse(JSON.stringify(derived)),
    'Re-run scripts/dev/generate-printer-print-option-capabilities.mjs after updating BambuStudio'
  )
})
