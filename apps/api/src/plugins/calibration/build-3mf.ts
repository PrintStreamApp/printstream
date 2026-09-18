/**
 * Assembles a printable calibration 3MF from generated geometry (see
 * {@link ./geometry.js}) using the normal editor bake path, so a calibration
 * print slices through the exact same pipeline as any other project.
 *
 * - **Flow ratio:** a grid of patches baked as separate objects, each carrying a
 *   per-object `print_flow_ratio` multiplier over the selected filament preset's
 *   baseline (the process recipe, wall count, top layers, infill, is applied as
 *   whole-plate slice overrides by the caller, not here).
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
import type { CalibrationParameters, PressureAdvanceParameters } from '@printstream/shared'
import { bambuPressureAdvanceGcode, flowRatioFromOffset, MAX_PA_K_VALUE } from '@printstream/shared'
import { buildEditedThreeMf, createObjectCustomizedThreeMf, type ImportedObjectInput, type ObjectProcessOverrides } from '../../lib/three-mf.js'
import type { SceneEdit } from '@printstream/shared'
import {
  flowRatioPlate,
  maxVolumetricSpeedTower,
  pressureAdvanceTower,
  temperatureTower,
  retractionTower,
  vfaTower
} from './geometry.js'

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
 * Build a flow-ratio calibration 3MF: one patch object per offset. The object
 * override is only `(100 + offset) / 100`; the slicer multiplies it by the
 * selected filament preset's `filament_flow_ratio`. The returned layout carries
 * the resulting absolute ratios for the result-entry UI.
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
      const flowRatio = flowRatioFromOffset(input.currentFlowRatio, patch.offsetPercent)
      layout.push({ offsetPercent: patch.offsetPercent, flowRatio })
      if (objectId != null) {
        overrides[String(objectId)] = {
          print_flow_ratio: flowRatioFromOffset(1, patch.offsetPercent).toFixed(4)
        }
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
 * band height reads back the K directly. Uses explicit linear compensation,
 * matching how the saved result is applied: `M400` then `M900 K... L1000 M10`.
 */
function buildPaTowerCustomGcode(bandStartZ: number, heightMm: number, startK: number, step: number): string {
  const bandMm = Math.round(heightMm - bandStartZ)
  const layers: string[] = []
  for (let n = 0; n < bandMm; n++) {
    const k = Math.min(MAX_PA_K_VALUE, startK + step * n)
    // The floor-0 band is set on the first layer; each further mm re-sets K.
    const topZ = bandStartZ + (n === 0 ? 0.2 : n)
    const gcode = bambuPressureAdvanceGcode(Number(k.toFixed(4)), 'linear').replaceAll('\n', '&#10;')
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

type TemperatureParameters = Extract<CalibrationParameters, { kind: 'temperature' }>
type MaxVolumetricSpeedParameters = Extract<CalibrationParameters, { kind: 'maxVolumetricSpeed' }>
type VfaParameters = Extract<CalibrationParameters, { kind: 'vfa' }>

/** Build a single-object tower with per-layer commands authored through the normal 3MF path. */
async function buildCommandTower(input: {
  outputPath: string
  printerModel: string
  importId: string
  name: string
  mesh: ImportedObjectInput['mesh']
  commands: Array<{ topZ: number; gcode: string }>
  retractionCalibration?: boolean
}): Promise<void> {
  const edit: SceneEdit = {
    plates: [{ index: 1 }],
    instances: [identityInstance(input.importId, bedCenter(input.printerModel))]
  }
  await buildEditedThreeMf(null, input.outputPath, edit, [{ importId: input.importId, name: input.name, mesh: input.mesh }], {
    extraEntries: [
      { name: 'Metadata/custom_gcode_per_layer.xml', content: buildCustomGcode(input.commands) },
      ...(input.retractionCalibration ? [{ name: 'Metadata/printstream_retraction_calibration.json', content: '{"version":1}' }] : [])
    ]
  })
}

/** Serialize safe, fixed-shape per-layer custom G-code entries. */
function buildCustomGcode(commands: Array<{ topZ: number; gcode: string }>): string {
  const layers = commands.map(({ topZ, gcode }) => {
    const encoded = gcode.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('\n', '&#10;')
    const normalizedTopZ = Number(topZ.toFixed(4))
    return `<layer top_z="${normalizedTopZ}" type="4" extruder="1" color="" extra="${encoded}" gcode="${encoded}"/>`
  })
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

/** Build a temperature tower whose nozzle temperature drops 5 C every 10 mm. */
export async function buildTemperatureThreeMf(input: {
  outputPath: string
  printerModel: string
  parameters: TemperatureParameters
}): Promise<void> {
  const tower = temperatureTower(input.parameters.startTemperature, input.parameters.endTemperature)
  const commands: Array<{ topZ: number; gcode: string }> = []
  for (let temperature = input.parameters.startTemperature, band = 0;
    temperature >= input.parameters.endTemperature;
    temperature -= input.parameters.step, band++) {
    commands.push({ topZ: band === 0 ? 0.2 : band * 10, gcode: `M104 S${temperature}` })
  }
  await buildCommandTower({ ...input, importId: 'temperature-tower', name: 'Temperature tower', mesh: tower.mesh, commands })
}

/**
 * Build a max-volumetric-speed vase tower. The print recipe fixes extrusion geometry and a
 * 100 mm/s base wall speed; M220 then scales the live motion speed so each millimetre tests the
 * requested volume divided by that known bead cross-section and flow ratio.
 */
export async function buildMaxVolumetricSpeedThreeMf(input: {
  outputPath: string
  printerModel: string
  nozzleDiameter: number
  flowRatio: number
  parameters: MaxVolumetricSpeedParameters
}): Promise<void> {
  const tower = maxVolumetricSpeedTower(input.parameters.startSpeed, input.parameters.endSpeed, input.parameters.step)
  const lineWidth = input.nozzleDiameter * 1.75
  const layerHeight = input.nozzleDiameter * 0.8
  const beadArea = layerHeight * (lineWidth - layerHeight) + Math.PI * layerHeight * layerHeight / 4
  const commands: Array<{ topZ: number; gcode: string }> = []
  for (let value = input.parameters.startSpeed, band = 0;
    value <= input.parameters.endSpeed + 1e-9;
    value += input.parameters.step, band++) {
    const linearSpeed = value / (beadArea * input.flowRatio)
    commands.push({ topZ: band === 0 ? layerHeight : band, gcode: `M220 S${linearSpeed.toFixed(1)}` })
  }
  await buildCommandTower({ ...input, importId: 'max-volumetric-speed-tower', name: 'Max volumetric speed tower', mesh: tower.mesh, commands })
}

/** Build a VFA vase tower whose motion speed increases every 5 mm. */
export async function buildVfaThreeMf(input: {
  outputPath: string
  printerModel: string
  parameters: VfaParameters
}): Promise<void> {
  const tower = vfaTower(input.parameters.startSpeed, input.parameters.endSpeed, input.parameters.step)
  const commands: Array<{ topZ: number; gcode: string }> = []
  for (let value = input.parameters.startSpeed, band = 0;
    value <= input.parameters.endSpeed + 1e-9;
    value += input.parameters.step, band++) {
    commands.push({ topZ: band === 0 ? 0.2 : band * 5, gcode: `M220 S${value.toFixed(1)}` })
  }
  await buildCommandTower({ ...input, importId: 'vfa-tower', name: 'VFA tower', mesh: tower.mesh, commands })
}

/**
 * Retraction uses a bounded slicer-worker post-process, not M207 (the engine
 * emits explicit E moves). Mark each test band and end before the machine's
 * shutdown script. The worker refuses unsupported or unpaired extrusion moves.
 */
export async function buildRetractionThreeMf(input: {
  outputPath: string
  printerModel: string
  parameters: Extract<CalibrationParameters, { kind: 'retraction' }>
}): Promise<void> {
  const { startLength, endLength, step } = input.parameters
  const tower = retractionTower(startLength, endLength, step)
  const commands: Array<{ topZ: number; gcode: string }> = []
  const bands = Math.floor((endLength - startLength) / step + 1e-8) + 1
  for (let band = 0; band < bands; band++) {
    const length = Number((startLength + band * step).toFixed(4))
    commands.push({ topZ: tower.bandStartZ + band + 0.2, gcode: `; PRINTSTREAM_RETRACTION_LENGTH=${length}` })
  }
  commands.push({ topZ: tower.heightMm - 0.2, gcode: '; PRINTSTREAM_RETRACTION_END' })
  await buildCommandTower({ ...input, importId: 'retraction-tower', name: 'Retraction tower', mesh: tower.mesh, commands, retractionCalibration: true })
}
