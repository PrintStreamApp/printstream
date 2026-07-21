import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, mock, test } from 'node:test'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { bridgeSessionManager } from './bridge-session-manager.js'
import { prisma } from './prisma.js'
import {
  copyBridgeLibraryFile,
  deleteBridgeLibraryFile,
  ensureBridgeLibraryLocalCopy,
  ensureLibraryFileReplica,
  inspectBridgeLibraryThreeMf,
  pruneBridgeLibraryDerivedCache,
  pruneBridgeLibraryLocalCache,
  readBridgeLibraryThumbnail,
  storeBridgeLibraryBuffer,
  statBridgeLibraryFile,
  storeBridgeLibraryFile
} from './bridge-library-files.js'
import { libraryDir } from './library-paths.js'
import { THREE_MF_INDEX_PARSER_VERSION } from '@printstream/shared/three-mf'
import yazl from 'yazl'

const originalReplicaFindUnique = prisma.libraryFileReplica.findUnique
const originalReplicaUpdate = prisma.libraryFileReplica.update
const originalReplicaUpsert = prisma.libraryFileReplica.upsert

afterEach(async () => {
  mock.restoreAll()
  await rm(path.join(libraryDir, '_bridge-derived-cache'), { recursive: true, force: true }).catch(() => undefined)
  Object.defineProperty(prisma.libraryFileReplica, 'findUnique', { value: originalReplicaFindUnique, configurable: true })
  Object.defineProperty(prisma.libraryFileReplica, 'update', { value: originalReplicaUpdate, configurable: true })
  Object.defineProperty(prisma.libraryFileReplica, 'upsert', { value: originalReplicaUpsert, configurable: true })
})

test('ensureBridgeLibraryLocalCopy downloads bridge-owned files once and reuses the local cache', async () => {
  const bridgeId = 'bridge-cache-test'
  const storedPath = 'bridge-cache-file.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async (_bridgeId: string, _method: string, params: unknown) => {
    const offset = typeof params === 'object' && params && 'offset' in params && typeof params.offset === 'number'
      ? params.offset
      : 0
    const payload = Buffer.from('bridge payload')
    return offset >= payload.byteLength
      ? { bufferBase64: Buffer.alloc(0).toString('base64'), eof: true, sizeBytes: payload.byteLength }
      : { bufferBase64: payload.subarray(offset).toString('base64'), eof: true, sizeBytes: payload.byteLength }
  })

  const firstPath = await ensureBridgeLibraryLocalCopy({ bridgeId, storedPath })
  const secondPath = await ensureBridgeLibraryLocalCopy({ bridgeId, storedPath })

  assert.equal(firstPath, cachePath)
  assert.equal(secondPath, cachePath)
  assert.equal(requestRpc.mock.callCount(), 2)
  assert.equal((await readFile(cachePath, 'utf8')), 'bridge payload')
})

test('ensureBridgeLibraryLocalCopy rebuilds a partial local cache copy', async () => {
  const bridgeId = 'bridge-cache-partial-test'
  const storedPath = 'bridge-cache-file.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeFile(cachePath, 'bridge')

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async (_bridgeId: string, _method: string, params: unknown) => {
    const offset = typeof params === 'object' && params && 'offset' in params && typeof params.offset === 'number'
      ? params.offset
      : 0
    const payload = Buffer.from('bridge payload')
    return offset >= payload.byteLength
      ? { bufferBase64: Buffer.alloc(0).toString('base64'), eof: true, sizeBytes: payload.byteLength }
      : { bufferBase64: payload.subarray(offset).toString('base64'), eof: true, sizeBytes: payload.byteLength }
  })

  const resolvedPath = await ensureBridgeLibraryLocalCopy({ bridgeId, storedPath })

  assert.equal(resolvedPath, cachePath)
  assert.equal((await readFile(cachePath, 'utf8')), 'bridge payload')
  assert.deepEqual(requestRpc.mock.calls.map((call) => call.arguments[2]), [
    { storedPath, offset: 6, maxBytes: 4 * 1024 * 1024 },
    { storedPath, offset: 0, maxBytes: 4 * 1024 * 1024 }
  ])
})

test('storeBridgeLibraryFile uploads local bytes through bridge RPC and deleteBridgeLibraryFile clears the cache', async () => {
  const bridgeId = 'bridge-upload-test'
  const storedPath = 'bridge-upload-file.3mf'
  const sourcePath = path.join(libraryDir, `${Date.now()}-${storedPath}`)
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await mkdir(libraryDir, { recursive: true })
  await writeFile(sourcePath, 'local payload')
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeFile(cachePath, 'stale cache')

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => null)

  await storeBridgeLibraryFile(bridgeId, storedPath, sourcePath)
  await deleteBridgeLibraryFile(bridgeId, storedPath)

  assert.deepEqual(requestRpc.mock.calls.map((call) => [call.arguments[1], call.arguments[2]]), [
    ['library.storeStart', { storedPath }],
    ['library.storeChunk', { storedPath, chunkBase64: Buffer.from('local payload').toString('base64') }],
    ['library.delete', { storedPath }]
  ])
  await assert.rejects(() => readFile(cachePath), /ENOENT/)

  await rm(sourcePath, { force: true }).catch(() => undefined)
})

test('storeBridgeLibraryBuffer clears a stale local bridge cache before writing', async () => {
  const bridgeId = 'bridge-buffer-cache-clear-test'
  const storedPath = 'bridge-buffer-cache-file.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeFile(cachePath, 'stale cache')

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => null)

  await storeBridgeLibraryBuffer(bridgeId, storedPath, Buffer.from('new bridge payload'))

  assert.deepEqual(requestRpc.mock.calls.map((call) => [call.arguments[1], call.arguments[2]]), [
    ['library.storeStart', { storedPath }],
    ['library.storeChunk', { storedPath, chunkBase64: Buffer.from('new bridge payload').toString('base64') }]
  ])
  await assert.rejects(() => readFile(cachePath), /ENOENT/)
})

test('ensureLibraryFileReplica stores a tracked dispatch replica on the target bridge', async () => {
  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(
    bridgeSessionManager,
    'requestRpc',
    async (_bridgeId: string, method: string) => {
    if (method === 'library.readChunk') {
      return {
        bufferBase64: Buffer.from('source bytes').toString('base64'),
        eof: true
      }
    }
    return null
    }
  )
  Object.defineProperty(prisma.libraryFileReplica, 'findUnique', {
    value: async () => null,
    configurable: true
  })
  Object.defineProperty(prisma.libraryFileReplica, 'upsert', {
    value: async () => ({
      id: 'replica-1',
      storedPath: 'replica-file-path.3mf'
    }),
    configurable: true
  })

  const storedPath = await ensureLibraryFileReplica({
    tenantId: 'tenant-1',
    libraryFileId: 'file-1',
    fileName: 'Part Tray.3mf',
    sourceBridgeId: 'bridge-source',
    sourceStoredPath: 'source-file.3mf',
    sizeBytes: 12,
    targetBridgeId: 'bridge-target'
  })

  assert.equal(storedPath, 'replica-file-1-Part_Tray.3mf')
  assert.deepEqual(requestRpc.mock.calls.map((call) => [call.arguments[0], call.arguments[1]]), [
    ['bridge-target', 'library.storeStart'],
    ['bridge-source', 'library.readChunk'],
    ['bridge-target', 'library.storeChunk']
  ])
  assert.deepEqual(requestRpc.mock.calls[2]?.arguments[2], {
    storedPath: 'replica-file-1-Part_Tray.3mf',
    chunkBase64: Buffer.from('source bytes').toString('base64')
  })
})

test('inspectBridgeLibraryThreeMf requests normalized 3mf metadata from the owning bridge', async () => {
  const bridgeId = 'bridge-inspect-rpc-test'
  const storedPath = 'widget.3mf'
  await rm(path.join(libraryDir, '_bridge-derived-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({
    // A CURRENT bridge: without this the API now (correctly) distrusts the index and
    // re-parses locally, which is not what these tests exercise.
    parserVersion: THREE_MF_INDEX_PARSER_VERSION,
    index: {
      plates: [{
        index: 1,
        name: 'Plate 1',
        gcodeFile: 'Metadata/plate_1.gcode',
        pickFile: 'Metadata/pick_1.png',
        thumbnailFile: 'Metadata/plate_1.png',
        plateType: 'Textured PEI Plate',
        nozzleSizes: ['0.4'],
        filaments: [],
        objects: [{ id: 1, name: 'Object 1' }]
      }],
      projectFilaments: [],
      compatiblePrinterModels: ['P1S']
    }
  }))

  const index = await inspectBridgeLibraryThreeMf({
    ownerBridgeId: bridgeId,
    storedPath
  })

  assert.equal(index.plates[0]?.name, 'Plate 1')
  assert.equal(requestRpc.mock.calls[0]?.arguments[1], 'library.inspect3mf')
  assert.deepEqual(requestRpc.mock.calls[0]?.arguments[2], { storedPath })
})

test('inspectBridgeLibraryThreeMf caches bridge metadata without downloading file bytes', async () => {
  const bridgeId = 'bridge-derived-index-test'
  const storedPath = 'derived-widget.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await rm(path.join(libraryDir, '_bridge-derived-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({
    // A CURRENT bridge: without this the API now (correctly) distrusts the index and
    // re-parses locally, which is not what these tests exercise.
    parserVersion: THREE_MF_INDEX_PARSER_VERSION,
    index: {
      plates: [{
        index: 1,
        name: 'Derived Plate',
        gcodeFile: 'Metadata/plate_1.gcode',
        pickFile: null,
        thumbnailFile: 'Metadata/plate_1.png',
        plateType: null,
        nozzleSizes: ['0.4'],
        filaments: [],
        objects: [{ id: 1, name: 'Object 1' }]
      }],
      projectFilaments: [],
      compatiblePrinterModels: ['P1S'],
      printerProfileName: 'Bambu Lab P1S 0.4 nozzle',
      processProfileName: '0.20mm Standard'
    }
  }))

  const first = await inspectBridgeLibraryThreeMf({ ownerBridgeId: bridgeId, storedPath })
  const second = await inspectBridgeLibraryThreeMf({ ownerBridgeId: bridgeId, storedPath })

  assert.equal(first.plates[0]?.name, 'Derived Plate')
  assert.equal(second.plates[0]?.name, 'Derived Plate')
  assert.deepEqual(requestRpc.mock.calls.map((call) => call.arguments[1]), ['library.inspect3mf'])
  await assert.rejects(() => readFile(cachePath), /ENOENT/)
})

test('inspectBridgeLibraryThreeMf prefers an existing local cache copy over bridge metadata', async () => {
  const bridgeId = 'bridge-local-cache-preferred-test'
  const storedPath = 'cached-widget.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeZipFixture(cachePath, [
    ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
      default_print_profile: 'Custom Project Process',
      filament_type: ['ABS'],
      filament_settings_id: ['Bambu ABS'],
      filament_colour: ['#FFC72C'],
      physical_extruder_map: ['1', '0'],
      filament_nozzle_map: ['1'],
      extruder_nozzle_stats: ['Standard#1', 'Standard#1']
    }), 'utf8')]
  ])

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({
    // A CURRENT bridge: without this the API now (correctly) distrusts the index and
    // re-parses locally, which is not what these tests exercise.
    parserVersion: THREE_MF_INDEX_PARSER_VERSION,
    index: {
      plates: [{
        index: 1,
        name: 'Plate 1',
        gcodeFile: null,
        pickFile: null,
        thumbnailFile: null,
        plateType: null,
        nozzleSizes: ['0.4'],
        filaments: [{
          id: 1,
          filamentType: 'ABS',
          filamentName: 'Bambu ABS',
          color: '#FFC72C',
          usedGrams: 125.39,
          usedMeters: 50.13,
          nozzleId: 0,
          nozzleDiameter: '0.4',
          chamberTemperature: 65
        }],
        objects: []
      }],
      projectFilaments: [{
        id: 1,
        filamentType: 'ABS',
        filamentName: 'Bambu ABS',
        color: '#FFC72C',
        nozzleId: 0,
        chamberTemperature: 65
      }],
      compatiblePrinterModels: ['H2D'],
      printerProfileName: 'Bambu Lab H2D 0.4 nozzle',
      processProfileName: 'Wrong bridge result'
    }
  }))

  const index = await inspectBridgeLibraryThreeMf({
    ownerBridgeId: bridgeId,
    storedPath
  })

  assert.equal(index.projectFilaments[0]?.nozzleId, 1)
  assert.equal(index.processProfileName, 'Custom Project Process')
  assert.equal(requestRpc.mock.callCount(), 0)
})

test('inspectBridgeLibraryThreeMf falls back to local parsing when the bridge index lacks baked profiles', async () => {
  const bridgeId = 'bridge-fallback-test'
  const storedPath = 'fallback-widget.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeZipFixture(cachePath, [
    ['Metadata/model_settings.config', Buffer.from([
      '<config>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <metadata key="plater_name" value="Front Plate"/>',
      '  </plate>',
      '  <plate>',
      '    <metadata key="plater_id" value="2"/>',
      '    <metadata key="plater_name" value="Rear Plate"/>',
      '  </plate>',
      '</config>'
    ].join('\n'), 'utf8')],
    ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
      default_print_profile: 'Custom Project Process',
      printer_settings_id: 'Bambu Lab P1S 0.4 nozzle'
    }), 'utf8')]
  ])

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async (_bridgeId: string, method: string, params: unknown) => {
    if (method === 'library.inspect3mf') {
      return {
        // A CURRENT bridge: without this the API now (correctly) distrusts the index and
    // re-parses locally, which is not what these tests exercise.
    parserVersion: THREE_MF_INDEX_PARSER_VERSION,
    index: {
          plates: [{
            index: 1,
            name: 'Plate 1',
            gcodeFile: null,
            pickFile: null,
            thumbnailFile: null,
            plateType: null,
            nozzleSizes: [],
            filaments: [],
            objects: []
          }],
          projectFilaments: [{
            id: 1,
            filamentType: 'PLA',
            filamentName: 'Bambu PLA Basic - Custom',
            color: '#408080',
            nozzleId: null,
            chamberTemperature: 0
          }],
          compatiblePrinterModels: ['P1S'],
          printerProfileName: null,
          processProfileName: null
        }
      }
    }

    const offset = typeof params === 'object' && params && 'offset' in params && typeof params.offset === 'number'
      ? params.offset
      : 0
    const payload = await readFile(cachePath)
    return offset >= payload.byteLength
      ? { bufferBase64: Buffer.alloc(0).toString('base64'), eof: true, sizeBytes: payload.byteLength }
      : { bufferBase64: payload.subarray(offset).toString('base64'), eof: true, sizeBytes: payload.byteLength }
  })

  const index = await inspectBridgeLibraryThreeMf({
    ownerBridgeId: bridgeId,
    storedPath
  })

  assert.deepEqual(index.plates.map((plate) => plate.name), ['Front Plate', 'Rear Plate'])
  assert.equal(index.processProfileName, 'Custom Project Process')
  assert.equal(requestRpc.mock.callCount(), 0)
})

test('inspectBridgeLibraryThreeMf falls back to local parsing when bridge plate filament usage is empty', async () => {
  const bridgeId = 'bridge-empty-plate-filaments-test'
  const storedPath = 'empty-plate-filaments.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeZipFixture(cachePath, [
    ['Metadata/slice_info.config', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><config><header/></config>', 'utf8')],
    ['Metadata/model_settings.config', Buffer.from([
      '<config>',
      '  <object id="8">',
      '    <metadata key="extruder" value="1"/>',
      '    <part id="1"><metadata key="extruder" value="2"/></part>',
      '  </object>',
      '  <object id="9">',
      '    <metadata key="extruder" value="3"/>',
      '  </object>',
      '  <plate>',
      '    <metadata key="plater_id" value="1"/>',
      '    <metadata key="plater_name" value="Front Plate"/>',
      '    <model_instance>',
      '      <metadata key="object_id" value="8"/>',
      '    </model_instance>',
      '  </plate>',
      '  <plate>',
      '    <metadata key="plater_id" value="2"/>',
      '    <metadata key="plater_name" value="Rear Plate"/>',
      '    <model_instance>',
      '      <metadata key="object_id" value="9"/>',
      '    </model_instance>',
      '  </plate>',
      '</config>'
    ].join('\n'), 'utf8')],
    ['Metadata/project_settings.config', Buffer.from(JSON.stringify({
      default_print_profile: '0.20mm Ryan @BBL X1C',
      printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
      filament_type: ['PLA', 'PETG', 'ABS'],
      filament_settings_id: ['Bambu PLA Basic', 'Bambu PETG HF', 'Bambu ABS']
    }), 'utf8')]
  ])

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async (_bridgeId: string, method: string, params: unknown) => {
    if (method === 'library.inspect3mf') {
      return {
        // A CURRENT bridge: without this the API now (correctly) distrusts the index and
    // re-parses locally, which is not what these tests exercise.
    parserVersion: THREE_MF_INDEX_PARSER_VERSION,
    index: {
          plates: [{
            index: 1,
            name: 'Front Plate',
            gcodeFile: null,
            pickFile: null,
            thumbnailFile: null,
            plateType: null,
            nozzleSizes: [],
            filaments: [],
            objects: []
          }],
          projectFilaments: [{
            id: 1,
            filamentType: 'PLA',
            filamentName: 'Bambu PLA Basic',
            color: '#FFFFFF',
            nozzleId: null,
            chamberTemperature: 0
          }, {
            id: 2,
            filamentType: 'PETG',
            filamentName: 'Bambu PETG HF',
            color: '#00FF00',
            nozzleId: null,
            chamberTemperature: 0
          }, {
            id: 3,
            filamentType: 'ABS',
            filamentName: 'Bambu ABS',
            color: '#0000FF',
            nozzleId: null,
            chamberTemperature: 0
          }],
          compatiblePrinterModels: ['P1S'],
          printerProfileName: 'Bambu Lab P1S 0.4 nozzle',
          processProfileName: '0.20mm Ryan @BBL X1C'
        }
      }
    }

    const offset = typeof params === 'object' && params && 'offset' in params && typeof params.offset === 'number'
      ? params.offset
      : 0
    const payload = await readFile(cachePath)
    return offset >= payload.byteLength
      ? { bufferBase64: Buffer.alloc(0).toString('base64'), eof: true, sizeBytes: payload.byteLength }
      : { bufferBase64: payload.subarray(offset).toString('base64'), eof: true, sizeBytes: payload.byteLength }
  })

  const index = await inspectBridgeLibraryThreeMf({
    ownerBridgeId: bridgeId,
    storedPath
  })

  assert.deepEqual(index.plates.map((plate) => plate.filaments.map((filament) => filament.id)), [[1, 2], [3]])
  assert.equal(index.processProfileName, '0.20mm Ryan @BBL X1C')
  assert.equal(requestRpc.mock.callCount(), 0)
})

async function writeZipFixture(filePath: string, entries: Array<[string, Buffer]>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const [entryPath, buffer] of entries) {
    zip.addBuffer(buffer, entryPath)
  }

  await new Promise<void>((resolve, reject) => {
    zip.outputStream
      .pipe(createWriteStream(filePath))
      .on('close', resolve)
      .on('error', reject)
    zip.end()
  })
}

test('readBridgeLibraryThumbnail requests and caches the selected plate thumbnail from the bridge', async () => {
  const bridgeId = 'bridge-thumb-test'
  const storedPath = 'thumb-widget.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await rm(path.join(libraryDir, '_bridge-derived-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async (_bridgeId: string, method: string) => {
    if (method === 'library.readThumbnail') {
      return { pngBase64: Buffer.from('plate-two-preview').toString('base64') }
    }
    throw new Error(`${method} should not be used for cached bridge thumbnails`)
  })

  const first = await readBridgeLibraryThumbnail({
    ownerBridgeId: bridgeId,
    storedPath
  }, 2)
  const second = await readBridgeLibraryThumbnail({
    ownerBridgeId: bridgeId,
    storedPath
  }, 2)

  assert.equal(first?.toString('utf8'), 'plate-two-preview')
  assert.equal(second?.toString('utf8'), 'plate-two-preview')
  assert.deepEqual(requestRpc.mock.calls.map((call) => call.arguments[1]), ['library.readThumbnail'])
  await assert.rejects(() => readFile(cachePath), /ENOENT/)
})

test('readBridgeLibraryThumbnail falls back to a local copy when bridge thumbnail extraction fails', async () => {
  const bridgeId = 'bridge-thumb-local-fallback-test'
  const storedPath = 'thumb-widget.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await rm(path.join(libraryDir, '_bridge-derived-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async (_bridgeId: string, method: string, params: unknown) => {
    if (method === 'library.readThumbnail') {
      throw new Error('bridge thumbnail extraction failed')
    }
    const offset = typeof params === 'object' && params && 'offset' in params && typeof params.offset === 'number'
      ? params.offset
      : 0
    const payload = await readFile(cachePath)
    return offset >= payload.byteLength
      ? { bufferBase64: Buffer.alloc(0).toString('base64'), eof: true, sizeBytes: payload.byteLength }
      : { bufferBase64: payload.subarray(offset).toString('base64'), eof: true, sizeBytes: payload.byteLength }
  })

  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeZipFixture(cachePath, [
    ['Metadata/plate_1.png', Buffer.from('plate-one-preview')],
    ['Metadata/plate_2.png', Buffer.from('plate-two-preview')]
  ])

  const png = await readBridgeLibraryThumbnail({ ownerBridgeId: bridgeId, storedPath }, 2)

  assert.equal(png?.toString('utf8'), 'plate-two-preview')
  assert.deepEqual(requestRpc.mock.calls.map((call) => call.arguments[1]), ['library.readThumbnail', 'library.readChunk'])
})

test('pruneBridgeLibraryDerivedCache removes stale derived files and empty directories', async () => {
  const staleDir = path.join(libraryDir, '_bridge-derived-cache', 'bridge-prune-test', 'stale')
  const freshDir = path.join(libraryDir, '_bridge-derived-cache', 'bridge-prune-test', 'fresh')
  const stalePath = path.join(staleDir, 'index.json')
  const freshPath = path.join(freshDir, 'thumbnail-1.png')
  await mkdir(staleDir, { recursive: true })
  await mkdir(freshDir, { recursive: true })
  await writeFile(stalePath, '{}')
  await writeFile(freshPath, 'png')
  const staleDate = new Date(Date.now() - 10_000)
  await utimes(stalePath, staleDate, staleDate)

  const result = await pruneBridgeLibraryDerivedCache(1_000)

  assert.equal(result.removedFiles, 1)
  assert.equal(result.removedDirs, 1)
  await assert.rejects(() => readFile(stalePath), /ENOENT/)
  assert.equal((await readFile(freshPath, 'utf8')), 'png')
})

test('statBridgeLibraryFile requests size and sha256 from the owning bridge', async () => {
  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => ({
    sizeBytes: 123,
    contentSha256: 'a'.repeat(64)
  }))

  const info = await statBridgeLibraryFile({
    ownerBridgeId: 'bridge-1',
    storedPath: 'widget.3mf'
  })

  assert.equal(info.sizeBytes, 123)
  assert.equal(info.contentSha256, 'a'.repeat(64))
  assert.equal(requestRpc.mock.calls[0]?.arguments[1], 'library.stat')
  assert.deepEqual(requestRpc.mock.calls[0]?.arguments[2], { storedPath: 'widget.3mf' })
})

test('copyBridgeLibraryFile requests an in-bridge copy without pulling bytes through the api', async () => {
  mock.method(bridgeSessionManager, 'isConnected', () => true)
  const requestRpc = mock.method(bridgeSessionManager, 'requestRpc', async () => null)

  await copyBridgeLibraryFile({
    ownerBridgeId: 'bridge-1',
    sourceStoredPath: 'source.3mf',
    targetStoredPath: 'snapshot.3mf'
  })

  assert.equal(requestRpc.mock.calls[0]?.arguments[1], 'library.copy')
  assert.deepEqual(requestRpc.mock.calls[0]?.arguments[2], {
    sourceStoredPath: 'source.3mf',
    targetStoredPath: 'snapshot.3mf'
  })
})

test('pruneBridgeLibraryLocalCache removes stale local copies and keeps fresh ones', async () => {
  const staleDir = path.join(libraryDir, '_bridge-cache', 'bridge-local-prune-test')
  const stalePath = path.join(staleDir, 'stale-copy.3mf')
  const freshPath = path.join(staleDir, 'fresh-copy.3mf')
  await mkdir(staleDir, { recursive: true })
  await writeFile(stalePath, 'stale bytes')
  await writeFile(freshPath, 'fresh bytes')
  const staleDate = new Date(Date.now() - 10_000)
  await utimes(stalePath, staleDate, staleDate)

  try {
    const result = await pruneBridgeLibraryLocalCache(1_000)

    assert.ok(result.removedFiles >= 1, 'the stale copy is removed')
    await assert.rejects(() => readFile(stalePath), /ENOENT/)
    assert.equal((await readFile(freshPath, 'utf8')), 'fresh bytes')
  } finally {
    await rm(staleDir, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('ensureBridgeLibraryLocalCopy refreshes recency on a validated stale copy so active files never age out', async () => {
  const bridgeId = 'bridge-cache-recency-test'
  const storedPath = 'bridge-cache-recency.3mf'
  const cachePath = path.join(libraryDir, '_bridge-cache', bridgeId, storedPath)

  await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeFile(cachePath, 'bridge payload')
  // Two days old: past the touch-throttle window, so a validated use must bump it.
  const staleDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
  await utimes(cachePath, staleDate, staleDate)

  mock.method(bridgeSessionManager, 'isConnected', () => true)
  mock.method(bridgeSessionManager, 'requestRpc', async (_bridgeId: string, _method: string, params: unknown) => {
    const offset = typeof params === 'object' && params && 'offset' in params && typeof params.offset === 'number'
      ? params.offset
      : 0
    const payload = Buffer.from('bridge payload')
    return offset >= payload.byteLength
      ? { bufferBase64: Buffer.alloc(0).toString('base64'), eof: true, sizeBytes: payload.byteLength }
      : { bufferBase64: payload.subarray(offset).toString('base64'), eof: true, sizeBytes: payload.byteLength }
  })

  try {
    const resolvedPath = await ensureBridgeLibraryLocalCopy({ bridgeId, storedPath })
    assert.equal(resolvedPath, cachePath)
    const { stat: statFile } = await import('node:fs/promises')
    const info = await statFile(cachePath)
    assert.ok(Date.now() - info.mtimeMs < 60_000, 'mtime was refreshed to now (LRU recency bump)')
    assert.equal((await readFile(cachePath, 'utf8')), 'bridge payload', 'the copy itself was not re-downloaded')
  } finally {
    await rm(path.join(libraryDir, '_bridge-cache', bridgeId), { recursive: true, force: true }).catch(() => undefined)
  }
})

test('an index from a bridge on an older parser version is re-parsed locally, not trusted', async () => {
  // The bridge deploys separately from the API. After a parser bump, an un-upgraded bridge keeps
  // returning indexes that silently lack the new fields (Zod fills their defaults), and those were
  // cached and chip-stamped as CURRENT — which is how `needsSettingsRepair`/`projectVersion` never
  // appeared for files indexed while the bridge lagged. The version clause makes the API pull the
  // bytes and parse with its own (current) parser instead.
  const { shouldFallbackToLocalThreeMfParse } = await import('./bridge-library-files.js')
  const { THREE_MF_INDEX_PARSER_VERSION } = await import('@printstream/shared/three-mf')
  const healthyIndex = {
    plates: [{ index: 1, name: null, gcodeFile: null, pickFile: null, thumbnailFile: null, plateType: null, nozzleSizes: [], filaments: [{ id: 1, filamentType: 'PLA', filamentName: null, color: null, usedGrams: null, usedMeters: null, nozzleId: null, bedTemperature: null, chamberTemperature: null }], objects: [], prediction: null, weight: null }],
    projectFilaments: [{ id: 1, filamentType: 'PLA', filamentName: null, color: null, nozzleId: null, isSupport: false, isSoluble: false }],
    compatiblePrinterModels: [],
    supportFilamentIds: [],
    printerProfileName: 'Bambu Lab X2D 0.4 nozzle',
    processProfileName: '0.20mm Standard @BBL X2D',
    geometryOnly: false,
    objectExport: false,
    needsSettingsRepair: false,
    projectVersion: null
  }

  // A structurally healthy index from a CURRENT bridge is trusted.
  assert.equal(shouldFallbackToLocalThreeMfParse({ index: healthyIndex, parserVersion: THREE_MF_INDEX_PARSER_VERSION } as never), false)
  // The same index from a LAGGING bridge is not — its fields may be silently defaulted.
  assert.equal(shouldFallbackToLocalThreeMfParse({ index: healthyIndex, parserVersion: THREE_MF_INDEX_PARSER_VERSION - 1 } as never), true)
  // A bridge that predates version reporting entirely parses as 0 and always re-parses.
  assert.equal(shouldFallbackToLocalThreeMfParse({ index: healthyIndex, parserVersion: 0 } as never), true)
  // A NEWER bridge is fine: the API strips fields it does not know.
  assert.equal(shouldFallbackToLocalThreeMfParse({ index: healthyIndex, parserVersion: THREE_MF_INDEX_PARSER_VERSION + 1 } as never), false)
})
