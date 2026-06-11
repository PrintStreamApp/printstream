import { createWriteStream } from 'node:fs'
import { rm, rename } from 'node:fs/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import yazl from 'yazl'

const DIRECT_ALL_PLATE_MODELS = new Set(['H2D', 'H2DPRO', 'H2C'])

type PlateOutput = {
  plate: number
  filePath: string
}

type PlateBundle = {
  sliceInfoPlateBlock: string
  modelSettingsPlateBlock: string
  entries: Array<{ name: string; buffer: Buffer; mtime: Date }>
}

export function shouldUseAllPlateMergeFallback(input: {
  plate: number
  outputFileName: string
  printerModel: string | null
}): boolean {
  return input.plate === 0
    && input.outputFileName.toLowerCase().endsWith('.3mf')
    && !supportsDirectAllPlateExport(input.printerModel)
}

export function supportsDirectAllPlateExport(printerModel: string | null): boolean {
  if (!printerModel) return true
  return DIRECT_ALL_PLATE_MODELS.has(normalizePrinterModel(printerModel))
}

export function extractPlateIdsFromModelSettingsXml(xml: string): number[] {
  const plateIds = new Set<number>()
  for (const match of xml.matchAll(/<plate\b[^>]*>[\s\S]*?<metadata\s+key="plater_id"\s+value="(\d+)"\s*\/>[\s\S]*?<\/plate>/g)) {
    const plateId = Number.parseInt(match[1] ?? '', 10)
    if (Number.isInteger(plateId) && plateId > 0) plateIds.add(plateId)
  }
  return [...plateIds].sort((left, right) => left - right)
}

export async function readPlateIdsFromModelSettings(filePath: string): Promise<number[]> {
  const xml = await readZipEntryText(filePath, 'Metadata/model_settings.config').catch(() => null)
  return xml ? extractPlateIdsFromModelSettingsXml(xml) : []
}

export function mergeSliceInfoXml(baseXml: string, plateBlocks: Map<number, string>): string {
  const beforeClose = baseXml.match(/^[\s\S]*?(?=<\/config>\s*$)/)?.[0]
  if (!beforeClose) return baseXml
  const prefix = beforeClose.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>/g, '').trimEnd()
  const mergedBlocks = [...plateBlocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block.trim())
  return `${prefix}\n${mergedBlocks.join('\n')}\n</config>`
}

export function mergeModelSettingsXml(baseXml: string, plateBlocks: Map<number, string>): string {
  let replacedAny = false
  const updated = baseXml.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>/g, (block) => {
    const plateId = extractPlateIdFromModelSettingsBlock(block)
    if (plateId == null) return block
    const replacement = plateBlocks.get(plateId)
    if (!replacement) return block
    replacedAny = true
    return replacement.trim()
  })
  if (replacedAny) return updated

  const beforeClose = baseXml.match(/^[\s\S]*?(?=<\/config>\s*$)/)?.[0]
  if (!beforeClose) return baseXml
  const mergedBlocks = [...plateBlocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block.trim())
  return `${beforeClose.trimEnd()}\n${mergedBlocks.join('\n')}\n</config>`
}

export function buildModelSettingsRelationshipsXml(plateIds: number[]): string {
  const relationships = plateIds
    .sort((left, right) => left - right)
    .map((plateId, index) => ` <Relationship Target="/Metadata/plate_${plateId}.gcode" Id="rel-${index + 1}" Type="http://schemas.bambulab.com/package/2021/gcode"/>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    relationships,
    '</Relationships>'
  ].join('\n')
}

export async function mergeAllPlateOutputs(input: {
  outputPath: string
  plateOutputs: PlateOutput[]
}): Promise<void> {
  if (input.plateOutputs.length === 0) throw new Error('No plate outputs to merge')

  const sortedOutputs = [...input.plateOutputs].sort((left, right) => left.plate - right.plate)
  const baseOutput = sortedOutputs[0] as PlateOutput
  const baseSliceInfoXml = await readZipEntryText(baseOutput.filePath, 'Metadata/slice_info.config')
  const baseModelSettingsXml = await readZipEntryText(baseOutput.filePath, 'Metadata/model_settings.config')
  const plateBundles = new Map<number, PlateBundle>()

  for (const plateOutput of sortedOutputs) {
    plateBundles.set(plateOutput.plate, await readPlateBundle(plateOutput))
  }

  const sliceInfoBlocks = new Map([...plateBundles].map(([plate, bundle]) => [plate, bundle.sliceInfoPlateBlock]))
  const modelSettingsBlocks = new Map([...plateBundles].map(([plate, bundle]) => [plate, bundle.modelSettingsPlateBlock]))
  const tempPath = `${input.outputPath}.merge`
  await rm(tempPath, { force: true })

  const sourceZip = await openZip(baseOutput.filePath)
  const outputZip = new yazl.ZipFile()
  const output = createWriteStream(tempPath)
  outputZip.outputStream.pipe(output)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      sourceZip.close()
      if (error) {
        output.destroy()
        reject(error)
      } else {
        resolve()
      }
    }

    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('finish', () => finish())
    sourceZip.on('error', finish)
    sourceZip.on('end', async () => {
      try {
        const mergedSliceInfoXml = mergeSliceInfoXml(baseSliceInfoXml, sliceInfoBlocks)
        const mergedModelSettingsXml = mergeModelSettingsXml(baseModelSettingsXml, modelSettingsBlocks)
        outputZip.addBuffer(Buffer.from(mergedSliceInfoXml, 'utf8'), 'Metadata/slice_info.config')
        outputZip.addBuffer(Buffer.from(mergedModelSettingsXml, 'utf8'), 'Metadata/model_settings.config')
        outputZip.addBuffer(
          Buffer.from(buildModelSettingsRelationshipsXml(sortedOutputs.map((entry) => entry.plate)), 'utf8'),
          'Metadata/_rels/model_settings.config.rels'
        )

        for (const [, bundle] of plateBundles) {
          for (const entry of bundle.entries) {
            outputZip.addBuffer(entry.buffer, entry.name, { mtime: entry.mtime })
          }
        }
        outputZip.end()
      } catch (error) {
        finish(error as Error)
      }
    })
    sourceZip.on('entry', (entry: Entry) => {
      if (shouldSkipBaseEntry(entry.fileName)) {
        sourceZip.readEntry()
        return
      }
      readZipEntryBuffer(sourceZip, entry).then(
        (buffer) => {
          outputZip.addBuffer(buffer, entry.fileName, { mtime: entry.getLastModDate() })
          sourceZip.readEntry()
        },
        (error) => finish(error as Error)
      )
    })
    sourceZip.readEntry()
  })

  await rename(tempPath, input.outputPath)
}

function normalizePrinterModel(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '')
}

function extractPlateIdFromModelSettingsBlock(block: string): number | null {
  const match = block.match(/<metadata\s+key="plater_id"\s+value="(\d+)"\s*\/>/)
  const plateId = Number.parseInt(match?.[1] ?? '', 10)
  return Number.isInteger(plateId) && plateId > 0 ? plateId : null
}

function extractSliceInfoPlateBlock(xml: string, plate: number): string {
  for (const block of xml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []) {
    const match = block.match(/<metadata\s+key="index"\s+value="(\d+)"\s*\/>/)
    if (Number.parseInt(match?.[1] ?? '', 10) === plate) return block
  }
  throw new Error(`slice_info.config is missing plate ${plate}`)
}

function extractModelSettingsPlateBlock(xml: string, plate: number): string {
  for (const block of xml.match(/<plate\b[^>]*>[\s\S]*?<\/plate>/g) ?? []) {
    if (extractPlateIdFromModelSettingsBlock(block) === plate) return block
  }
  throw new Error(`model_settings.config is missing plate ${plate}`)
}

function shouldSkipBaseEntry(fileName: string): boolean {
  return fileName === 'Metadata/slice_info.config'
    || fileName === 'Metadata/model_settings.config'
    || fileName === 'Metadata/_rels/model_settings.config.rels'
    || extractPlateAssetPlate(fileName) != null
}

function extractPlateAssetPlate(fileName: string): number | null {
  const patterns = [
    /^Metadata\/plate_(\d+)\.gcode$/,
    /^Metadata\/plate_(\d+)\.gcode\.md5$/,
    /^Metadata\/plate_(\d+)\.json$/,
    /^Metadata\/plate_(\d+)\.png$/,
    /^Metadata\/plate_(\d+)_small\.png$/,
    /^Metadata\/plate_no_light_(\d+)\.png$/,
    /^Metadata\/pick_(\d+)\.png$/,
    /^Metadata\/top_(\d+)\.png$/
  ]
  for (const pattern of patterns) {
    const match = fileName.match(pattern)
    const plateId = Number.parseInt(match?.[1] ?? '', 10)
    if (Number.isInteger(plateId) && plateId > 0) return plateId
  }
  return null
}

async function readPlateBundle(plateOutput: PlateOutput): Promise<PlateBundle> {
  const zipFile = await openZip(plateOutput.filePath)
  return await new Promise((resolve, reject) => {
    const entries: PlateBundle['entries'] = []
    let sliceInfoPlateBlock: string | null = null
    let modelSettingsPlateBlock: string | null = null
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      zipFile.close()
      if (error) {
        reject(error)
        return
      }
      if (!sliceInfoPlateBlock || !modelSettingsPlateBlock) {
        reject(new Error(`Packaged output for plate ${plateOutput.plate} is missing merge metadata`))
        return
      }
      resolve({
        sliceInfoPlateBlock,
        modelSettingsPlateBlock,
        entries
      })
    }

    zipFile.on('error', finish)
    zipFile.on('end', () => finish())
    zipFile.on('entry', (entry: Entry) => {
      if (entry.fileName === 'Metadata/slice_info.config') {
        readZipEntryBuffer(zipFile, entry).then(
          (buffer) => {
            sliceInfoPlateBlock = extractSliceInfoPlateBlock(buffer.toString('utf8'), plateOutput.plate)
            zipFile.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      if (entry.fileName === 'Metadata/model_settings.config') {
        readZipEntryBuffer(zipFile, entry).then(
          (buffer) => {
            modelSettingsPlateBlock = extractModelSettingsPlateBlock(buffer.toString('utf8'), plateOutput.plate)
            zipFile.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      if (extractPlateAssetPlate(entry.fileName) === plateOutput.plate) {
        readZipEntryBuffer(zipFile, entry).then(
          (buffer) => {
            entries.push({ name: entry.fileName, buffer, mtime: entry.getLastModDate() })
            zipFile.readEntry()
          },
          (error) => finish(error as Error)
        )
        return
      }
      zipFile.readEntry()
    })
    zipFile.readEntry()
  })
}

/**
 * Ensure a sliced `.gcode.3mf` carries a per-plate MODEL thumbnail.
 *
 * BambuStudio's all-plate export (`--slice 0`) of a rewritten/editor-arranged project slices the
 * gcode fine but can fail to (re)generate the `plate_N.png` model renders, leaving the file with
 * no thumbnail — the library then shows a misleading toolpath fallback or just the kind label.
 * Copy any missing `plate_N.png` / `plate_N_small.png` from the slicer INPUT, which carries the
 * source project's model renders (the editor's arranged 3MF preserves them). Best-effort: skips
 * plates the input can't supply and never throws — a missing thumbnail must not fail a slice.
 */
export async function backfillPlateThumbnails(outputPath: string, inputPath: string): Promise<void> {
  try {
    const outputEntries = await readAllZipEntries(outputPath)
    const names = new Set(outputEntries.map((entry) => entry.name))
    const plateIds = new Set<number>()
    for (const name of names) {
      const match = /^Metadata\/plate_(\d+)\.gcode$/.exec(name)
      if (match) plateIds.add(Number.parseInt(match[1]!, 10))
    }
    if (plateIds.size === 0) return

    const wanted: string[] = []
    for (const id of plateIds) {
      for (const suffix of ['', '_small']) {
        const name = `Metadata/plate_${id}${suffix}.png`
        if (!names.has(name)) wanted.push(name)
      }
    }
    if (wanted.length === 0) return

    const additions: Array<{ name: string; buffer: Buffer }> = []
    for (const name of wanted) {
      const buffer = await readZipEntryBufferByName(inputPath, name).catch(() => null)
      if (buffer) additions.push({ name, buffer })
    }
    if (additions.length === 0) return

    const tempPath = `${outputPath}.thumbs`
    await rm(tempPath, { force: true })
    await writeZip(tempPath, [
      ...outputEntries.map((entry) => ({ name: entry.name, buffer: entry.buffer, mtime: entry.mtime })),
      ...additions.map((entry) => ({ name: entry.name, buffer: entry.buffer }))
    ])
    await rename(tempPath, outputPath)
  } catch {
    // Best-effort; never fail a slice over a thumbnail.
  }
}

async function readAllZipEntries(filePath: string): Promise<Array<{ name: string; buffer: Buffer; mtime: Date }>> {
  const zipFile = await openZip(filePath)
  return await new Promise((resolve, reject) => {
    const entries: Array<{ name: string; buffer: Buffer; mtime: Date }> = []
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      zipFile.close()
      if (error) reject(error)
      else resolve(entries)
    }
    zipFile.on('error', finish)
    zipFile.on('end', () => finish())
    zipFile.on('entry', (entry: Entry) => {
      if (entry.fileName.endsWith('/')) { zipFile.readEntry(); return }
      readZipEntryBuffer(zipFile, entry).then(
        (buffer) => { entries.push({ name: entry.fileName, buffer, mtime: entry.getLastModDate() }); zipFile.readEntry() },
        (error) => finish(error as Error)
      )
    })
    zipFile.readEntry()
  })
}

async function readZipEntryBufferByName(filePath: string, entryName: string): Promise<Buffer> {
  const zipFile = await openZip(filePath)
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return
      settled = true
      zipFile.close()
      if (error) reject(error)
      else resolve(value as Buffer)
    }
    zipFile.on('error', finish)
    zipFile.on('end', () => finish(new Error(`Entry not found: ${entryName}`)))
    zipFile.on('entry', (entry: Entry) => {
      if (entry.fileName !== entryName) { zipFile.readEntry(); return }
      readZipEntryBuffer(zipFile, entry).then(
        (buffer) => finish(undefined, buffer),
        (error) => finish(error as Error)
      )
    })
    zipFile.readEntry()
  })
}

async function writeZip(filePath: string, entries: Array<{ name: string; buffer: Buffer; mtime?: Date }>): Promise<void> {
  const zip = new yazl.ZipFile()
  const stream = createWriteStream(filePath)
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.on('error', reject)
    stream.on('error', reject)
    stream.on('finish', () => resolve())
    zip.outputStream.pipe(stream)
    for (const entry of entries) {
      zip.addBuffer(entry.buffer, entry.name, entry.mtime ? { mtime: entry.mtime } : undefined)
    }
    zip.end()
  })
}

async function readZipEntryText(filePath: string, entryName: string): Promise<string> {
  const zipFile = await openZip(filePath)
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: string) => {
      if (settled) return
      settled = true
      zipFile.close()
      if (error) reject(error)
      else resolve(value ?? '')
    }
    zipFile.on('error', finish)
    zipFile.on('end', () => finish(new Error(`Entry not found: ${entryName}`)))
    zipFile.on('entry', (entry: Entry) => {
      if (entry.fileName !== entryName) {
        zipFile.readEntry()
        return
      }
      readZipEntryBuffer(zipFile, entry).then(
        (buffer) => finish(undefined, buffer.toString('utf8')),
        (error) => finish(error as Error)
      )
    })
    zipFile.readEntry()
  })
}

async function openZip(filePath: string): Promise<ZipFile> {
  return await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error('Failed to open 3MF'))
      else resolve(zipFile)
    })
  })
}

async function readZipEntryBuffer(zipFile: ZipFile, entry: Entry): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Failed to read ${entry.fileName}`))
        return
      }
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}