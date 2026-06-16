process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { PNG } from 'pngjs'
import type { Printer } from '@printstream/shared'
import {
  readPrinterStorageActivePrintObjects,
  readPrinterStorageActivePrintObjectsFromMetadata,
  setPrinterStorageThreeMfDepsForTests
} from './printer-storage-3mf.js'

const printer: Printer = {
  id: 'printer-1',
  name: 'Printer 1',
  host: '127.0.0.1',
  serial: 'SERIAL-1',
  accessCode: 'secret',
  model: 'P1S',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
}

const sliceInfoXml = `
<config>
  <plate>
    <metadata key="index" value="23"/>
    <metadata key="gcode_file" value="Metadata/plate_23.gcode"/>
    <metadata key="thumbnail_file" value="Metadata/plate_23.png"/>
    <object identify_id="7" name="Bracket"/>
  </plate>
</config>
`.trim()

afterEach(() => {
  setPrinterStorageThreeMfDepsForTests(null)
})

test('readPrinterStorageActivePrintObjects builds previews from the pick mask without requesting plate gcode', async () => {
  const zipEntryRequests: string[][] = []

  setPrinterStorageThreeMfDepsForTests({
    readPrinterZipEntries: async (
      _printer: Printer,
      _remotePath: string,
      entryPaths: string[]
    ): Promise<Map<string, Buffer>> => {
      zipEntryRequests.push([...entryPaths])
      if (entryPaths.includes('Metadata/slice_info.config')) {
        return new Map([
          ['Metadata/slice_info.config', Buffer.from(sliceInfoXml, 'utf8')]
        ])
      }
      if (entryPaths.length === 1 && entryPaths[0] === 'Metadata/pick_23.png') {
        return new Map([
          ['Metadata/pick_23.png', createPickMaskPng(4, 4, [
            { x: 1, y: 0, width: 2, height: 3, objectId: 7 }
          ])]
        ])
      }
      throw new Error(`unexpected entry request: ${entryPaths.join(', ')}`)
    },
    downloadFileFromPrinter: async () => {
      throw new Error('unexpected full archive download')
    }
  })

  const objects = await readPrinterStorageActivePrintObjects(printer, '/cache/plate-23.3mf', 23)

  assert.equal(objects?.length, 1)
  assert.match(objects?.[0]?.previewPath ?? '', /^M 1 1 L 3 1 L 3 4 L 1 4 L 1 1 Z$/)
  assert.deepEqual(zipEntryRequests, [
    ['Metadata/slice_info.config', 'Metadata/project_settings.config', 'Metadata/model_settings.config'],
    ['Metadata/pick_23.png']
  ])
})

test('readPrinterStorageActivePrintObjects falls back to a full archive download when the suffix read misses slice_info.config', async () => {
  const zipEntryRequests: string[][] = []
  let fullDownloadCalls = 0

  setPrinterStorageThreeMfDepsForTests({
    readPrinterZipEntries: async (
      _printer: Printer,
      _remotePath: string,
      entryPaths: string[]
    ): Promise<Map<string, Buffer>> => {
      zipEntryRequests.push([...entryPaths])
      if (entryPaths.includes('Metadata/slice_info.config')) {
        return new Map([
          ['Metadata/project_settings.config', Buffer.from('{"curr_bed_type":"Cool Plate"}', 'utf8')]
        ])
      }
      throw new Error(`unexpected entry request: ${entryPaths.join(', ')}`)
    },
    downloadFileFromPrinter: async () => {
      fullDownloadCalls += 1
      return createStoredZip([
        { path: 'Metadata/slice_info.config', data: Buffer.from(sliceInfoXml, 'utf8') },
        {
          path: 'Metadata/pick_23.png',
          data: createPickMaskPng(4, 4, [
            { x: 1, y: 0, width: 2, height: 3, objectId: 7 }
          ])
        }
      ])
    }
  })

  const objects = await readPrinterStorageActivePrintObjects(printer, '/cache/plate-23.3mf', 23)

  assert.equal(fullDownloadCalls, 1)
  assert.equal(objects?.length, 1)
  assert.equal(objects?.[0]?.name, 'Bracket')
  assert.match(objects?.[0]?.previewPath ?? '', /^M 1 1 L 3 1 L 3 4 L 1 4 L 1 1 Z$/)
  assert.deepEqual(zipEntryRequests, [
    ['Metadata/slice_info.config', 'Metadata/project_settings.config', 'Metadata/model_settings.config']
  ])
})

test('readPrinterStorageActivePrintObjectsFromMetadata loads live Metadata files from the printer root', async () => {
  const downloadRequests: string[][] = []

  setPrinterStorageThreeMfDepsForTests({
    readPrinterZipEntries: async () => {
      throw new Error('unexpected zip entry read')
    },
    downloadFileFromPrinter: async (
      _printer: Printer,
      candidates: string[]
    ): Promise<Buffer | null> => {
      downloadRequests.push([...candidates])
      const first = candidates[0]
      if (first === '/Metadata/slice_info.config') {
        return Buffer.from(sliceInfoXml, 'utf8')
      }
      if (first === '/Metadata/model_settings.config') {
        return Buffer.from([
          '<config>',
          '  <plate>',
          '    <metadata key="plater_id" value="23"/>',
          '    <metadata key="plater_name" value="Plate Twenty Three"/>',
          '  </plate>',
          '</config>'
        ].join('\n'), 'utf8')
      }
      if (first === '/Metadata/project_settings.config') {
        return null
      }
      if (first === '/Metadata/pick_23.png') {
        return createPickMaskPng(4, 4, [
          { x: 1, y: 0, width: 2, height: 3, objectId: 7 }
        ])
      }
      throw new Error(`unexpected direct metadata request: ${candidates.join(', ')}`)
    }
  })

  const objects = await readPrinterStorageActivePrintObjectsFromMetadata(printer, {
    plateIndex: 23,
    gcodeFile: '/data/Metadata/plate_23.gcode'
  })

  assert.equal(objects?.length, 1)
  assert.equal(objects?.[0]?.name, 'Bracket')
  assert.match(objects?.[0]?.previewPath ?? '', /^M 1 1 L 3 1 L 3 4 L 1 4 L 1 1 Z$/)
  assert.deepEqual(downloadRequests, [
    ['/Metadata/slice_info.config', '/data/Metadata/slice_info.config'],
    ['/Metadata/project_settings.config', '/data/Metadata/project_settings.config'],
    ['/Metadata/model_settings.config', '/data/Metadata/model_settings.config'],
    ['/Metadata/pick_23.png', '/data/Metadata/pick_23.png']
  ])
})

test('readPrinterStorageActivePrintObjectsFromMetadata loads live Metadata files from the active archive directory', async () => {
  const downloadRequests: string[][] = []

  setPrinterStorageThreeMfDepsForTests({
    readPrinterZipEntries: async () => {
      throw new Error('unexpected zip entry read')
    },
    downloadFileFromPrinter: async (
      _printer: Printer,
      candidates: string[]
    ): Promise<Buffer | null> => {
      downloadRequests.push([...candidates])
      const archiveCandidate = candidates[1]
      if (archiveCandidate === '/cache/Metadata/slice_info.config') {
        return Buffer.from(sliceInfoXml, 'utf8')
      }
      if (archiveCandidate === '/cache/Metadata/model_settings.config') {
        return Buffer.from([
          '<config>',
          '  <plate>',
          '    <metadata key="plater_id" value="23"/>',
          '    <metadata key="plater_name" value="Plate Twenty Three"/>',
          '  </plate>',
          '</config>'
        ].join('\n'), 'utf8')
      }
      if (archiveCandidate === '/cache/Metadata/project_settings.config') {
        return null
      }
      if (archiveCandidate === '/cache/Metadata/pick_23.png') {
        return createPickMaskPng(4, 4, [
          { x: 1, y: 0, width: 2, height: 3, objectId: 7 }
        ])
      }
      throw new Error(`unexpected direct metadata request: ${candidates.join(', ')}`)
    }
  })

  const objects = await readPrinterStorageActivePrintObjectsFromMetadata(printer, {
    plateIndex: 23,
    gcodeFile: '/cache/Current Print.gcode.3mf'
  })

  assert.equal(objects?.length, 1)
  assert.equal(objects?.[0]?.name, 'Bracket')
  assert.match(objects?.[0]?.previewPath ?? '', /^M 1 1 L 3 1 L 3 4 L 1 4 L 1 1 Z$/)
  assert.deepEqual(downloadRequests, [
    ['/Metadata/slice_info.config', '/cache/Metadata/slice_info.config'],
    ['/Metadata/project_settings.config', '/cache/Metadata/project_settings.config'],
    ['/Metadata/model_settings.config', '/cache/Metadata/model_settings.config'],
    ['/Metadata/pick_23.png', '/cache/Metadata/pick_23.png']
  ])
})

function createPickMaskPng(
  width: number,
  height: number,
  regions: Array<{ x: number; y: number; width: number; height: number; objectId: number }>
): Buffer {
  const png = new PNG({ width, height, colorType: 6 })

  for (const region of regions) {
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        const offset = (width * y + x) << 2
        png.data[offset] = region.objectId & 0xff
        png.data[offset + 1] = (region.objectId >> 8) & 0xff
        png.data[offset + 2] = 0
        png.data[offset + 3] = 255
      }
    }
  }

  return PNG.sync.write(png)
}

function createStoredZip(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const crc32 = computeCrc32(entry.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc32 >>> 0, 14)
    localHeader.writeUInt32LE(entry.data.byteLength, 18)
    localHeader.writeUInt32LE(entry.data.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, entry.data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc32 >>> 0, 16)
    centralHeader.writeUInt32LE(entry.data.byteLength, 20)
    centralHeader.writeUInt32LE(entry.data.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(centralHeader, name)

    localOffset += localHeader.byteLength + name.byteLength + entry.data.byteLength
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.byteLength, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function computeCrc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}