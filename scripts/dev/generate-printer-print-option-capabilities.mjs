#!/usr/bin/env node
/**
 * Generates the firmware-versioned print-option configuration BambuStudio overlays onto printer
 * reports before deciding which controls to show.
 *
 * BambuStudio merges every `resources/printers/<model>.json` entry whose version is less than or
 * equal to the installed OTA version (`json_diff::load_compatible_settings`). These values are not
 * all present on MQTT, so a model-only table cannot reproduce Studio for older X1 firmware.
 *
 * Usage:
 *   node scripts/dev/generate-printer-print-option-capabilities.mjs [--src <bambustudio-src>]
 *
 * Output: packages/shared/src/generated/printer-print-option-capabilities.generated.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractModelCodeMap } from './generate-filament-blacklist.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

const CONFIG_FIELDS = Object.freeze({
  support_ai_monitoring: 'aiMonitoring',
  support_auto_recovery_step_loss: 'autoRecovery',
  support_build_plate_marker_detect: 'buildPlateDetection',
  support_build_plate_marker_detect_type: 'buildPlateDetectionType',
  support_first_layer_inspect: 'firstLayerInspection',
  support_prompt_sound: 'promptSound',
  support_save_remote_print_file_to_storage: 'storeSentFilesOnExternalStorage'
})

function parseArgs(argv) {
  let src = path.join(repoRoot, 'tmp', 'bambustudio-src')
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--src') src = path.resolve(argv[++index])
  }
  return { src }
}

function initialConfig() {
  return {
    aiMonitoring: false,
    autoRecovery: false,
    buildPlateDetection: false,
    buildPlateDetectionType: null,
    firstLayerInspection: false,
    promptSound: false,
    storeSentFilesOnExternalStorage: false
  }
}

/** Extract the effective capability snapshots at every version that changes one. */
export function extractPrinterPrintOptionCapabilities(src) {
  const modelCodes = extractModelCodeMap(src)
  const byModel = {}

  for (const [modelCode, modelKey] of Object.entries(modelCodes)) {
    const file = path.join(src, 'resources', 'printers', `${modelCode}.json`)
    const versions = JSON.parse(readFileSync(file, 'utf8'))
    const current = initialConfig()
    const snapshots = []

    for (const [minimumFirmwareVersion, entry] of Object.entries(versions).sort(([left], [right]) => left.localeCompare(right))) {
      const print = entry?.print ?? {}
      let changed = false

      for (const [studioKey, outputKey] of Object.entries(CONFIG_FIELDS)) {
        if (!(studioKey in print)) continue
        const value = print[studioKey]
        if (outputKey === 'buildPlateDetectionType') {
          if (!Number.isInteger(value) || value < 0 || value > 2) {
            throw new Error(`${modelCode}@${minimumFirmwareVersion}.${studioKey} must be 0, 1, or 2`)
          }
        } else if (typeof value !== 'boolean') {
          throw new Error(`${modelCode}@${minimumFirmwareVersion}.${studioKey} must be boolean`)
        }
        if (current[outputKey] !== value) {
          current[outputKey] = value
          changed = true
        }
      }

      if (changed || snapshots.length === 0) {
        snapshots.push({ minimumFirmwareVersion, config: { ...current } })
      }
    }

    const existing = byModel[modelKey]
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshots)) {
      throw new Error(
        `BambuStudio model codes for ${modelKey} disagree about print-option capabilities. `
        + `Keep the device code so the app can distinguish them before regenerating.`
      )
    }
    byModel[modelKey] = snapshots
  }

  return Object.fromEntries(Object.entries(byModel).sort(([left], [right]) => left.localeCompare(right)))
}

function render(model) {
  return `/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Regenerate with: node scripts/dev/generate-printer-print-option-capabilities.mjs
 * Source: BambuStudio \`resources/printers/*.json\` (vendored at tmp/bambustudio-src)
 *
 * BambuStudio applies the last snapshot whose minimum version is not newer than the printer's OTA
 * firmware. The resolver lives in \`../printer-capabilities.ts\`.
 */

export interface BambuStudioPrintOptionConfig {
  aiMonitoring: boolean
  autoRecovery: boolean
  buildPlateDetection: boolean
  buildPlateDetectionType: 0 | 1 | 2 | null
  firstLayerInspection: boolean
  promptSound: boolean
  storeSentFilesOnExternalStorage: boolean
}

export interface BambuStudioPrintOptionCapabilitySnapshot {
  minimumFirmwareVersion: string
  config: BambuStudioPrintOptionConfig
}

export const BAMBU_STUDIO_PRINT_OPTION_CAPABILITIES: Readonly<
  Record<string, readonly BambuStudioPrintOptionCapabilitySnapshot[]>
> = ${JSON.stringify(model, null, 2)}
`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { src } = parseArgs(process.argv.slice(2))
  const model = extractPrinterPrintOptionCapabilities(src)
  const outPath = path.join(repoRoot, 'packages/shared/src/generated/printer-print-option-capabilities.generated.ts')
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, render(model))
  console.log(`Wrote ${outPath}`)
  console.log(`  models: ${Object.keys(model).length}`)
}
