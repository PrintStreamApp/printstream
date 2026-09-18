import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readEntry } from '../../lib/three-mf.js'
import { buildPressureAdvanceThreeMf, buildFlowRatioThreeMf, buildMaxVolumetricSpeedThreeMf, buildTemperatureThreeMf, buildVfaThreeMf, buildRetractionThreeMf } from './build-3mf.js'

test('retraction project opts in to toolpath rewriting and marks every band plus the end', async () => {
  const commands = await readCalibrationCommands(async (outputPath) => {
    await buildRetractionThreeMf({ outputPath, printerModel: 'P1S', parameters: { kind: 'retraction', startLength: 0, endLength: 0.4, step: 0.2 } })
    assert.deepEqual(JSON.parse((await readEntry(outputPath, 'Metadata/printstream_retraction_calibration.json')).toString()), { version: 1 })
  })
  assert.deepEqual([...commands.matchAll(/gcode="; PRINTSTREAM_RETRACTION_LENGTH=([\d.]+)/g)].map((match) => Number(match[1])), [0, 0.2, 0.4])
  assert.match(commands, /PRINTSTREAM_RETRACTION_END/)
  assert.doesNotMatch(commands, /M207/)
})

test('new pressure advance towers explicitly measure linear compensation in every band', async () => {
  const commands = await readCalibrationCommands(async (outputPath) => {
    await buildPressureAdvanceThreeMf({ outputPath, printerModel: 'H2D', parameters: { startK: 0, endK: 0.006, step: 0.002 } })
  })
  assert.match(commands, /M400&#10;M900 K0 L1000 M10/)
  assert.match(commands, /M400&#10;M900 K0.002 L1000 M10/)
  assert.equal([...commands.matchAll(/M900 K/g)].length, [...commands.matchAll(/L1000 M10/g)].length)
})

/** Build a calibration project, inspect its per-layer command sidecar, then remove the fixture. */
async function readCalibrationCommands(
  build: (outputPath: string) => Promise<void>
): Promise<string> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'calibration-project-'))
  const outputPath = path.join(fixtureDir, 'calibration.3mf')

  try {
    await build(outputPath)
    return (await readEntry(outputPath, 'Metadata/custom_gcode_per_layer.xml')).toString('utf8')
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
}

test('temperature project carries one fixed 5 C command per 10 mm band', async () => {
  const commands = await readCalibrationCommands(async (outputPath) => {
    await buildTemperatureThreeMf({
      outputPath,
      printerModel: 'X1C',
      parameters: { kind: 'temperature', startTemperature: 230, endTemperature: 220, step: 5 }
    })
  })

  assert.match(commands, /top_z="0\.2"[^>]+gcode="M104 S230"/)
  assert.match(commands, /top_z="10"[^>]+gcode="M104 S225"/)
  assert.match(commands, /top_z="20"[^>]+gcode="M104 S220"/)
})

test('flow-ratio project stores relative object multipliers while reporting absolute ratios', async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'calibration-flow-project-'))
  const outputPath = path.join(fixtureDir, 'calibration.3mf')

  try {
    const result = await buildFlowRatioThreeMf({
      outputPath,
      printerModel: 'X1C',
      currentFlowRatio: 0.98,
      offsets: [-5, 0, 5]
    })
    const settings = (await readEntry(outputPath, 'Metadata/model_settings.config')).toString('utf8')

    assert.deepEqual(
      result.patches.map((patch) => Number(patch.flowRatio.toFixed(4))),
      [0.931, 0.98, 1.029]
    )
    assert.match(settings, /key="print_flow_ratio" value="0\.9500"/)
    assert.match(settings, /key="print_flow_ratio" value="1\.0000"/)
    assert.match(settings, /key="print_flow_ratio" value="1\.0500"/)
    assert.doesNotMatch(settings, /key="print_flow_ratio" value="1\.0290"/)
  } finally {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

test('max-volumetric-speed project converts volume to nozzle-aware motion speed', async () => {
  const commands = await readCalibrationCommands(async (outputPath) => {
    await buildMaxVolumetricSpeedThreeMf({
      outputPath,
      printerModel: 'X1C',
      nozzleDiameter: 0.4,
      flowRatio: 1,
      parameters: { kind: 'maxVolumetricSpeed', startSpeed: 5, endSpeed: 15, step: 5, currentFlowRatio: 1 }
    })
  })

  // A 0.4 mm nozzle uses the authored 0.7 mm line width and 0.32 mm layer height.
  assert.match(commands, /top_z="0\.32"[^>]+gcode="M220 S24\.7"/)
  assert.match(commands, /top_z="1"[^>]+gcode="M220 S49\.5"/)
  assert.match(commands, /top_z="2"[^>]+gcode="M220 S74\.2"/)
})

test('VFA project carries the requested wall speeds in 5 mm bands', async () => {
  const commands = await readCalibrationCommands(async (outputPath) => {
    await buildVfaThreeMf({
      outputPath,
      printerModel: 'X1C',
      parameters: { kind: 'vfa', startSpeed: 40, endSpeed: 60, step: 10 }
    })
  })

  assert.match(commands, /top_z="0\.2"[^>]+gcode="M220 S40\.0"/)
  assert.match(commands, /top_z="5"[^>]+gcode="M220 S50\.0"/)
  assert.match(commands, /top_z="10"[^>]+gcode="M220 S60\.0"/)
})
