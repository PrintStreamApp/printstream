import assert from 'node:assert/strict'
import { copyFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import type { BridgeRuntimeInboundMessage, Printer } from '@printstream/shared'
import {
  chooseCompatibleDemoLibraryFile,
  chooseDemoCaptureStreamFileName,
  chooseDemoCameraSnapshotIndex,
  chooseIdleDemoCameraSnapshotName,
  chooseDemoPrintPlate,
  DemoBridgeSimulator,
  renderDemoCameraSnapshotBase64,
  setDemoCameraNowForTests,
  setDemoCameraSnapshotRendererForTests
} from './demo-simulator.js'

type RpcSuccessMessage = Extract<BridgeRuntimeInboundMessage, { type: 'bridge.rpc.success' }>

afterEach(() => {
  setDemoCameraNowForTests(null)
  setDemoCameraSnapshotRendererForTests(null)
})

const printer: Printer = {
  id: 'printer-1',
  name: 'Demo Printer',
  host: 'demo-printer.local',
  serial: 'DEMO-001',
  accessCode: 'DEMO',
  model: 'X1C',
  currentPlateType: 'Textured PEI Plate',
  currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
  position: 0,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z'
}

test('demo bridge simulator emits normalized statuses for configured printers', () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 0 })
  simulator.start((message) => messages.push(message))

  simulator.updatePrinters([printer])

  const statusMessage = messages.find((message) => message.type === 'bridge.printer.status')
  assert.ok(statusMessage)
  assert.equal(statusMessage.printer.printerId, printer.id)
  assert.equal(statusMessage.printer.online, true)
  assert.equal(statusMessage.printer.stage, 'idle')
  assert.equal(statusMessage.printer.ams.length, 1)
  assert.equal(statusMessage.printer.ams[0]?.slots.length, 4)
  assert.equal(statusMessage.printer.externalSpools.length, 1)

  simulator.stop()
})

test('demo bridge simulator applies print and pause command effects', () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 0 })
  simulator.start((message) => messages.push(message))
  simulator.updatePrinters([printer])

  simulator.handleCommand({
    type: 'bridge.command',
    printer,
    payload: { print: { command: 'project_file', param: '/Storage_Box.gcode.3mf' } }
  })
  simulator.handleCommand({
    type: 'bridge.command',
    printer,
    payload: { print: { command: 'pause' } }
  })

  const statuses = messages.filter((message) => message.type === 'bridge.printer.status').map((message) => message.printer)
  assert.equal(statuses.at(-2)?.stage, 'printing')
  assert.equal(statuses.at(-1)?.stage, 'paused')
  assert.equal(statuses.at(-1)?.jobName, 'Storage Box')

  simulator.stop()
})

test('demo bridge simulator applies stop as a cancelled printer state', () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 0 })
  simulator.start((message) => messages.push(message))
  simulator.updatePrinters([printer])

  simulator.handleCommand({
    type: 'bridge.command',
    printer,
    payload: { print: { command: 'project_file', param: '/Storage_Box.gcode.3mf' } }
  })
  simulator.handleCommand({
    type: 'bridge.command',
    printer,
    payload: { print: { command: 'stop' } }
  })

  const statuses = messages.filter((message) => message.type === 'bridge.printer.status').map((message) => message.printer)
  assert.equal(statuses.at(-1)?.stage, 'failed')
  assert.equal(statuses.at(-1)?.subStage, 'Cancelled by demo command')
  assert.equal(statuses.at(-1)?.jobName, null)
  assert.equal(statuses.at(-1)?.deviceError?.message, 'Cancelled by the printer')

  simulator.stop()
})

test('demo bridge simulator clears cancelled attention when a new print starts', () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 0 })
  simulator.start((message) => messages.push(message))
  simulator.updatePrinters([printer])

  simulator.handleCommand({
    type: 'bridge.command',
    printer,
    payload: { print: { command: 'project_file', param: '/Storage_Box.gcode.3mf' } }
  })
  simulator.handleCommand({
    type: 'bridge.command',
    printer,
    payload: { print: { command: 'stop' } }
  })
  simulator.handleCommand({
    type: 'bridge.command',
    printer,
    payload: { print: { command: 'project_file', param: '/Storage_Box.gcode.3mf' } }
  })

  const statuses = messages.filter((message) => message.type === 'bridge.printer.status').map((message) => message.printer)
  assert.equal(statuses.at(-1)?.stage, 'printing')
  assert.equal(statuses.at(-1)?.deviceError, null)
  assert.deepEqual(statuses.at(-1)?.hmsErrors, [])
  assert.equal(statuses.at(-1)?.jobName, 'Storage Box')

  simulator.stop()
})

test('demo bridge simulator uses seeded demo printer scenarios for initial status', () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 0 })
  simulator.start((message) => messages.push(message))

  simulator.updatePrinters([
    { ...printer, id: 'paused-printer', serial: 'DEMO-P1S-001' },
    { ...printer, id: 'printing-printer', serial: 'DEMO-H2D-002', model: 'H2D' },
    { ...printer, id: 'early-printing-printer', serial: 'DEMO-H2D-001', model: 'H2D' },
    { ...printer, id: 'idle-printer-2', serial: 'DEMO-X1C-001' },
    { ...printer, id: 'mid-printing-printer', serial: 'DEMO-X1C-002' },
    { ...printer, id: 'late-printing-printer', serial: 'DEMO-P1S-002' }
  ])

  const statuses = messages
    .filter((message) => message.type === 'bridge.printer.status')
    .map((message) => message.printer)

  assert.equal(statuses.find((status) => status.printerId === 'paused-printer')?.stage, 'paused')
  assert.equal(statuses.find((status) => status.printerId === 'printing-printer')?.stage, 'printing')
  assert.equal(statuses.find((status) => status.printerId === 'early-printing-printer')?.stage, 'printing')
  assert.equal(statuses.find((status) => status.printerId === 'idle-printer-2')?.stage, 'idle')
  assert.equal(statuses.find((status) => status.printerId === 'mid-printing-printer')?.stage, 'printing')
  assert.equal(statuses.find((status) => status.printerId === 'late-printing-printer')?.stage, 'printing')
  assert.equal(statuses.find((status) => status.printerId === 'paused-printer')?.jobName, 'Card Holder (3 rows)')
  assert.equal(statuses.find((status) => status.printerId === 'early-printing-printer')?.jobName, 'Number Plates')
  assert.equal(statuses.find((status) => status.printerId === 'printing-printer')?.jobName, 'Rail Mount')
  assert.equal(statuses.find((status) => status.printerId === 'late-printing-printer')?.jobName, 'Tire Rotation Markers')
  assert.equal(statuses.find((status) => status.printerId === 'early-printing-printer')?.progressPercent, 7)
  assert.ok((statuses.find((status) => status.printerId === 'printing-printer')?.jobName?.length ?? 0) > 0)
  assert.equal(statuses.find((status) => status.printerId === 'paused-printer')?.ams.length, 1)
  assert.equal(statuses.find((status) => status.printerId === 'printing-printer')?.ams.length, 2)
  assert.equal(statuses.find((status) => status.printerId === 'printing-printer')?.externalSpools.length, 2)
  assert.equal(typeof statuses.find((status) => status.printerId === 'printing-printer')?.taskId, 'string')
  assert.ok((statuses.find((status) => status.printerId === 'printing-printer')?.taskId?.length ?? 0) > 0)

  simulator.stop()
})

test('demo bridge simulator keeps seeded printing scenarios printing over time', async () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 1 })
  simulator.start((message) => messages.push(message))

  simulator.updatePrinters([
    { ...printer, id: 'printing-printer', serial: 'DEMO-H2D-002', model: 'H2D' }
  ])

  // Poll instead of sleeping a fixed 40ms: resolves as soon as a printing status lands, so the test
  // is both faster on success and tolerant of a busy CPU delaying the interval ticks.
  const deadline = Date.now() + 2_000
  const printingStatuses = () =>
    messages.filter((message) => message.type === 'bridge.printer.status').map((message) => message.printer)
  while (Date.now() < deadline && printingStatuses().at(-1)?.stage !== 'printing') {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  const statuses = printingStatuses()

  assert.equal(statuses.at(-1)?.stage, 'printing')
  assert.ok((statuses.at(-1)?.progressPercent ?? 0) < 100)

  simulator.stop()
})

test('demo bridge simulator answers basic camera and storage RPCs', () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 0 })
  simulator.start((message) => messages.push(message))
  simulator.updatePrinters([printer])

  assert.equal(simulator.handleRpcRequest({
    type: 'bridge.rpc.request',
    id: 'rpc-1',
    method: 'camera.snapshot',
    params: { printer }
  }), true)
  assert.equal(simulator.handleRpcRequest({
    type: 'bridge.rpc.request',
    id: 'rpc-2',
    method: 'storage.list',
    params: { printer, path: '/', recursive: false, maxDepth: 4 }
  }), true)
  assert.equal(simulator.handleRpcRequest({
    type: 'bridge.rpc.request',
    id: 'rpc-3',
    method: 'bridge.ping',
    params: {}
  }), true)
  assert.equal(simulator.handleRpcRequest({
    type: 'bridge.rpc.request',
    id: 'rpc-4',
    method: 'printer.validateConnection',
    params: { host: printer.host, accessCode: printer.accessCode, serial: printer.serial }
  }), true)

  const cameraResponse = messages.find((message): message is RpcSuccessMessage => message.type === 'bridge.rpc.success' && message.id === 'rpc-1')
  const storageResponse = messages.find((message): message is RpcSuccessMessage => message.type === 'bridge.rpc.success' && message.id === 'rpc-2')
  const pingResponse = messages.find((message): message is RpcSuccessMessage => message.type === 'bridge.rpc.success' && message.id === 'rpc-3')
  const validationResponse = messages.find((message): message is RpcSuccessMessage => message.type === 'bridge.rpc.success' && message.id === 'rpc-4')

  assert.ok(cameraResponse)
  assert.equal(typeof (cameraResponse.result as { jpegBase64?: unknown }).jpegBase64, 'string')
  assert.ok(storageResponse)
  assert.ok(Array.isArray((storageResponse.result as { entries?: unknown }).entries))
  assert.ok(((storageResponse.result as { entries?: Array<{ name: string }> }).entries ?? []).some((entry) => entry.name.endsWith('.gcode.3mf')))
  assert.ok(pingResponse)
  assert.equal(typeof (pingResponse.result as { respondedAt?: unknown }).respondedAt, 'string')
  assert.ok(validationResponse)
  assert.equal((validationResponse.result as { ok?: unknown }).ok, true)

  simulator.stop()
})

test('chooseDemoPrintPlate randomizes across available plates', () => {
  assert.equal(chooseDemoPrintPlate('Storage_Box.gcode.3mf', [1], 0.75), 1)
  assert.equal(chooseDemoPrintPlate('Storage_Box.gcode.3mf', [1, 2, 3], 0), 1)
  assert.equal(chooseDemoPrintPlate('Storage_Box.gcode.3mf', [1, 2, 3], 0.5), 2)
  assert.equal(chooseDemoPrintPlate('Storage_Box.gcode.3mf', [1, 2, 3], 0.99), 3)
})

test('chooseDemoPrintPlate prefers plate 2 for the card holder demo file when available', () => {
  assert.equal(chooseDemoPrintPlate('Card Holder (3 rows).gcode.3mf', [1, 2, 3], 0), 2)
  assert.equal(chooseDemoPrintPlate('faeae66bbb0c95ae-Card_Holder_3_rows_.gcode.3mf', [1, 2], 0.99), 2)
  assert.equal(chooseDemoPrintPlate('Card Holder (3 rows).gcode.3mf', [1, 3], 0.99), 3)
})

test('chooseCompatibleDemoLibraryFile filters demo files by printer model compatibility', () => {
  const files = [
    { fileName: 'x1.gcode.3mf', jobName: 'X1 Print', sizeBytes: 1, modifiedAt: '2026-05-01T00:00:00.000Z', selectedPlate: null },
    { fileName: 'h2d.gcode.3mf', jobName: 'H2D Print', sizeBytes: 1, modifiedAt: '2026-05-01T00:00:00.000Z', selectedPlate: null },
    { fileName: 'shared.gcode.3mf', jobName: 'Shared Print', sizeBytes: 1, modifiedAt: '2026-05-01T00:00:00.000Z', selectedPlate: null }
  ]
  const compatibility = new Map([
    ['x1.gcode.3mf', ['X1C'] as const],
    ['h2d.gcode.3mf', ['H2D'] as const],
    ['shared.gcode.3mf', ['X1C', 'P1S'] as const]
  ])

  assert.equal(chooseCompatibleDemoLibraryFile(files, 'H2D', compatibility, 0)?.fileName, 'h2d.gcode.3mf')
  assert.equal(chooseCompatibleDemoLibraryFile(files, 'P1S', compatibility, 0)?.fileName, 'x1.gcode.3mf')
  assert.equal(chooseCompatibleDemoLibraryFile(files, 'P1S', compatibility, 1)?.fileName, 'shared.gcode.3mf')
})

test('renderDemoCameraSnapshotBase64 prefers watermarked ffmpeg output', { concurrency: false }, () => {
  try {
    setDemoCameraSnapshotRendererForTests(() => Buffer.from('watermarked-demo-jpeg'))
    assert.equal(renderDemoCameraSnapshotBase64('/tmp/demo-camera.jpg'), Buffer.from('watermarked-demo-jpeg').toString('base64'))
  } finally {
    setDemoCameraSnapshotRendererForTests(null)
  }
})

test('chooseDemoCameraSnapshotIndex rotates over time for the same printer', () => {
  const firstIndex = chooseDemoCameraSnapshotIndex('printer-1', 8, 0)
  const secondIndex = chooseDemoCameraSnapshotIndex('printer-1', 8, 5_000)

  assert.notEqual(firstIndex, secondIndex)
})

test('chooseIdleDemoCameraSnapshotName is stable for a printer', { concurrency: false }, () => {
  const availableFileNames = ['chamber-blue-bin.jpg', 'chamber-green-bin.jpg', 'chamber-purple-part.jpg']

  assert.equal(
    chooseIdleDemoCameraSnapshotName('printer-1', availableFileNames),
    chooseIdleDemoCameraSnapshotName('printer-1', availableFileNames)
  )
  assert.match(chooseIdleDemoCameraSnapshotName('printer-1', availableFileNames) ?? '', /^chamber-/)
})

test('chooseDemoCaptureStreamFileName falls back to another mp4 when the preferred file is missing', () => {
  assert.equal(
    chooseDemoCaptureStreamFileName(
      ['20260517-184903-snapshot-01.jpg', 'home-h2d-lifecycle-timelapse.mp4'],
      '20260517-184904-stream.mp4'
    ),
    'home-h2d-lifecycle-timelapse.mp4'
  )
})

test('chooseDemoCaptureStreamFileName prefers an explicit stream mp4 when available', () => {
  assert.equal(
    chooseDemoCaptureStreamFileName(
      ['capture-timelapse.mp4', 'capture-stream.mp4'],
      null
    ),
    'capture-stream.mp4'
  )
})

test('demo bridge simulator serves chamber stills for idle seeded printers', { concurrency: false }, () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 0 })

  try {
    setDemoCameraSnapshotRendererForTests((filePath) => Buffer.from(filePath))
    simulator.start((message) => messages.push(message))
    simulator.updatePrinters([{ ...printer, id: 'idle-printer', serial: 'DEMO-X1C-001' }])

    assert.equal(simulator.handleRpcRequest({
      type: 'bridge.rpc.request',
      id: 'rpc-idle-camera',
      method: 'camera.snapshot',
      params: { printer: { id: 'idle-printer' } }
    }), true)

    const cameraResponse = messages.find(
      (message): message is RpcSuccessMessage => message.type === 'bridge.rpc.success' && message.id === 'rpc-idle-camera'
    )

    assert.ok(cameraResponse)
    const jpegBase64 = (cameraResponse.result as { jpegBase64?: unknown }).jpegBase64
    assert.equal(typeof jpegBase64, 'string')
    assert.match(Buffer.from(jpegBase64 as string, 'base64').toString('utf8'), /chamber-(blue-bin|green-bin|purple-part)\.jpg$/)
  } finally {
    simulator.stop()
  }
})

test('demo bridge simulator serves rail capture snapshots for the seeded rail print', { concurrency: false }, () => {
  const messages: BridgeRuntimeInboundMessage[] = []
  const simulator = new DemoBridgeSimulator({ statusIntervalMs: 0 })

  // The capture frames (.jpg) are gitignored; only the .mp4 timelapse is committed. When no frame is
  // present the simulator renders one from the .mp4 via a non-exported stream path, which this test
  // cannot reproduce. Provision a frame so both the simulator and this test render the same source
  // through renderDemoCameraSnapshotBase64 (cleaned up only if we created it).
  const captureDir = path.resolve('/workspace/printstream/data/demo-captures/home-h2d-20260517-184902')
  const provisionedFrame = path.join(captureDir, '__test-rail-capture-frame.jpg')
  let createdFrame = false
  if (!readdirSync(captureDir).some((fileName) => /\.jpe?g$/i.test(fileName))) {
    copyFileSync(path.resolve('/workspace/printstream/data/demo-camera-snapshots/home-h2d-start.jpg'), provisionedFrame)
    createdFrame = true
  }

  try {
    setDemoCameraNowForTests(() => 0)
    simulator.start((message) => messages.push(message))
    simulator.updatePrinters([{ ...printer, id: 'rail-printer', serial: 'DEMO-H2D-002', model: 'H2D' }])

    assert.equal(simulator.handleRpcRequest({
      type: 'bridge.rpc.request',
      id: 'rpc-rail-camera',
      method: 'camera.snapshot',
      params: { printer: { id: 'rail-printer' } }
    }), true)

    const cameraResponse = messages.find(
      (message): message is RpcSuccessMessage => message.type === 'bridge.rpc.success' && message.id === 'rpc-rail-camera'
    )

    assert.ok(cameraResponse)
    const jpegBase64 = (cameraResponse.result as { jpegBase64?: unknown }).jpegBase64
    assert.equal(typeof jpegBase64, 'string')
    const expectedBase64 = readdirSync(captureDir)
      .filter((fileName) => fileName.toLowerCase().endsWith('.jpg') || fileName.toLowerCase().endsWith('.jpeg'))
      .map((fileName) => renderDemoCameraSnapshotBase64(path.join(captureDir, fileName)))

    assert.equal(expectedBase64.includes(jpegBase64 as string), true)
  } finally {
    simulator.stop()
    if (createdFrame) rmSync(provisionedFrame, { force: true })
  }
})
