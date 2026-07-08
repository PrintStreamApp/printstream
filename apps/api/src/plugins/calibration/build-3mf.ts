/**
 * Assembles a printable calibration 3MF from generated geometry (see
 * {@link ./geometry.js}) using the normal editor bake path, so a calibration
 * print slices through the exact same pipeline as any other project.
 *
 * - **Flow ratio:** a grid of patches baked as separate objects, each carrying a
 *   per-object `print_flow_ratio` metadata override so one slice prints every
 *   patch at its own ratio (the process recipe — wall count, top layers, infill —
 *   is applied as whole-plate slice overrides by the caller, not here).
 * - **Pressure advance:** one tower baked as a single object, plus a raw
 *   `Metadata/custom_gcode_per_layer.xml` sidecar that injects `M400` + `M900 K…`
 *   at each millimetre of Z so K steps up the tower (verified to survive the CLI
 *   slice). This is BambuStudio's own tower mechanism, expressed as Custom
 *   (type 4) per-layer entries the slicer re-snaps to the nearest layer.
 *
 * Objects are placed at bed centre in global build coordinates, matching how the
 * editor writes build items.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PressureAdvanceParameters } from '@printstream/shared'
import { MAX_PA_K_VALUE } from '@printstream/shared'
import { buildEditedThreeMf, createObjectCustomizedThreeMf, type ImportedObjectInput, type ObjectProcessOverrides } from '../../lib/three-mf.js'
import type { SceneEdit } from '@printstream/shared'
import { flowRatioPlate, pressureAdvanceTower } from './geometry.js'

/** Bed footprint (mm) per Bambu model; defaults to the 256mm class when unknown. */
const BED_SIZE_BY_MODEL: Record<string, { width: number; depth: number }> = {
  A1mini: { width: 180, depth: 180 },
  H2D: { width: 350, depth: 320 },
  H2DPRO: { width: 350, depth: 320 },
  H2C: { width: 330, depth: 320 },
  H2S: { width: 340, depth: 320 }
}

function bedCenter(printerModel: string): { x: number; y: number } {
  const bed = BED_SIZE_BY_MODEL[printerModel] ?? { width: 256, depth: 256 }
  return { x: bed.width / 2, y: bed.depth / 2 }
}

function identityInstance(importId: string, center: { x: number; y: number }): SceneEdit['instances'][number] {
  return {
    importId,
    plateIndex: 1,
    position: { x: center.x, y: center.y, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }
  }
}

/**
 * Build a flow-ratio calibration 3MF: one patch object per offset, each sliced at
 * `currentFlowRatio * (100 + offset) / 100`. Returns the output path (caller owns
 * cleanup of its parent dir) plus the patch layout for the result-entry UI.
 */
export async function buildFlowRatioThreeMf(input: {
  outputPath: string
  printerModel: string
  currentFlowRatio: number
  offsets: readonly number[]
}): Promise<{ patches: Array<{ offsetPercent: number; flowRatio: number }> }> {
  const center = bedCenter(input.printerModel)
  const patches = flowRatioPlate(input.offsets)
  const imports: ImportedObjectInput[] = patches.map((patch, index) => ({
    importId: `patch-${index}`,
    name: `Flow ${patch.offsetPercent > 0 ? '+' : ''}${patch.offsetPercent}%`,
    mesh: patch.mesh
  }))
  const edit: SceneEdit = {
    plates: [{ index: 1 }],
    instances: imports.map((imported) => identityInstance(imported.importId, center))
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'calibration-flow-'))
  const bakedPath = path.join(workDir, 'baked.3mf')
  try {
    const result = await buildEditedThreeMf(null, bakedPath, edit, imports)
    const objectIdByImport = new Map(result.importObjectIds.map((entry) => [entry.importId, entry.objectId]))

    const overrides: ObjectProcessOverrides = {}
    const layout: Array<{ offsetPercent: number; flowRatio: number }> = []
    patches.forEach((patch, index) => {
      const objectId = objectIdByImport.get(`patch-${index}`)
      const flowRatio = input.currentFlowRatio * (100 + patch.offsetPercent) / 100
      layout.push({ offsetPercent: patch.offsetPercent, flowRatio })
      if (objectId != null) {
        overrides[String(objectId)] = { print_flow_ratio: flowRatio.toFixed(4) }
      }
    })

    await createObjectCustomizedThreeMf(bakedPath, input.outputPath, 1, { objectProcessOverrides: overrides })
    return { patches: layout }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Build a pressure-advance tower calibration 3MF, injecting `M400`/`M900 K…` at
 * each millimetre of Z so K sweeps from `startK` to `endK`. Returns the tower
 * height so the result-entry UI can bound the "best band height" input.
 */
export async function buildPressureAdvanceThreeMf(input: {
  outputPath: string
  printerModel: string
  parameters: PressureAdvanceParameters
}): Promise<{ heightMm: number }> {
  const { startK, endK, step } = input.parameters
  const center = bedCenter(input.printerModel)
  const tower = pressureAdvanceTower(startK, endK, step)
  const imports: ImportedObjectInput[] = [{ importId: 'pa-tower', name: 'PA tower', mesh: tower.mesh }]
  const edit: SceneEdit = {
    plates: [{ index: 1 }],
    instances: [identityInstance('pa-tower', center)]
  }

  await buildEditedThreeMf(null, input.outputPath, edit, imports, {
    extraEntries: [{ name: 'Metadata/custom_gcode_per_layer.xml', content: buildPaTowerCustomGcode(tower.bandStartZ, tower.heightMm, startK, step) }]
  })
  return { heightMm: tower.heightMm }
}

/**
 * Custom (type 4) per-layer G-code that sets pressure advance once per millimetre
 * of Z: `K = startK + step * floor(z)` above `bandStartZ`, so measuring the best
 * band height reads back the K directly. Emits Bambu direct-drive `M400`/`M900 K`
 * (the flavor used by every currently supported Bambu model).
 */
function buildPaTowerCustomGcode(bandStartZ: number, heightMm: number, startK: number, step: number): string {
  const bandMm = Math.round(heightMm - bandStartZ)
  const layers: string[] = []
  for (let n = 0; n < bandMm; n++) {
    const k = Math.min(MAX_PA_K_VALUE, startK + step * n)
    // The floor-0 band is set on the first layer; each further mm re-sets K.
    const topZ = bandStartZ + (n === 0 ? 0.2 : n)
    const gcode = `M400&#10;M900 K${k.toFixed(4)}`
    layers.push(`<layer top_z="${topZ}" type="4" extruder="1" color="" extra="${gcode}" gcode="${gcode}"/>`)
  }
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<custom_gcodes_per_layer>',
    '<plate>',
    '<plate_info id="1"/>',
    ...layers,
    '<mode value="MultiAsSingle"/>',
    '</plate>',
    '</custom_gcodes_per_layer>',
    ''
  ].join('\n')
}
