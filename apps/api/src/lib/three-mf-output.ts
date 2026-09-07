/**
 * 3MF slicing-output I/O: produce slice-ready 3MF variants and read sliced output artifacts.
 *
 * The write side prepares 3MFs for the slicer/printer: {@link createSinglePlateThreeMf} (slim
 * single-plate copy), {@link createObjectFilteredThreeMf}/{@link createObjectCustomizedThreeMf}
 * (drop unselected objects and/or inject per-object process overrides for a single-plate slice),
 * and {@link embedPlateThumbnails} (bake editor-rendered plate previews into a sliced 3MF). The
 * read side parses a plate's sliced gcode / pick-mask PNG into per-object first-layer outlines for
 * the printer's active-print object view ({@link readPlateObjectsWithPreview}).
 *
 * Depends on the reader (plate index) and three-mf-internal (ZIP I/O + escaping); nothing depends
 * on this module except the public three-mf barrel.
 */
import { createWriteStream } from 'node:fs'
import { rename } from 'node:fs/promises'
import { platePrintUnits, type PrinterActivePrintObject, type PrinterActivePrintObjectPreviewBounds, type SceneEditPlateFilamentChanges, type SceneEditPlatePauses } from '@printstream/shared'
import { PNG } from 'pngjs'
import yauzl, { type Entry } from 'yauzl'
import yazl from 'yazl'
import { readEntry, readZipEntryBuffer, rewriteThreeMfEntries } from './three-mf-internal.js'
import { CUSTOM_GCODE_PER_LAYER_ENTRY, buildDefaultPickFilePath, readPlateIndex, type ThreeMfIndex } from './three-mf-reader.js'
import { applyObjectProcessOverridesXml, mergeCustomGcodePerLayer, plateThumbnailEntries, rekeyObjectProcessOverrides, type ObjectProcessOverrides } from '@printstream/shared/three-mf'

const ACTIVE_PRINT_PREVIEW_MAX_GCODE_BYTES = 128 * 1024 * 1024
const MINIMAL_THREE_MF_MODEL_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
  '  <resources/>',
  '  <build/>',
  '</model>'
].join('\n')

export async function readPlateObjectsWithPreview(
  filePath: string,
  plateIndex: number | null,
  signal?: AbortSignal
): Promise<PrinterActivePrintObject[]> {
  const index = await readPlateIndex(filePath, signal)
  const plate = (plateIndex != null
    ? index.plates.find((entry) => entry.index === plateIndex)
    : null) ?? index.plates[0]
  if (!plate) return []

  let gcodeBuffer: Buffer | null = null
  if (plate.gcodeFile) {
    try {
      gcodeBuffer = await readEntry(filePath, plate.gcodeFile, signal, ACTIVE_PRINT_PREVIEW_MAX_GCODE_BYTES)
    } catch {
      gcodeBuffer = null
    }
  }

  let pickBuffer: Buffer | null = null
  const pickFile = plate.pickFile ?? buildDefaultPickFilePath(plate.index)
  if (pickFile) {
    try {
      pickBuffer = await readEntry(filePath, pickFile, signal)
    } catch {
      pickBuffer = null
    }
  }

  return buildPlateObjectsWithPreview(index, plateIndex, gcodeBuffer, pickBuffer)
}

export function buildPlateObjectsWithPreview(
  index: ThreeMfIndex,
  plateIndex: number | null,
  gcodeBuffer: Buffer | null,
  pickBuffer: Buffer | null = null
): PrinterActivePrintObject[] {
  const plate = (plateIndex != null
    ? index.plates.find((entry) => entry.index === plateIndex)
    : null) ?? index.plates[0]
  if (!plate) return []

  // One entry per PLACEMENT, identified by its firmware handle. Both matter, and both used to be
  // wrong here. `PrinterActivePrintObject.id` is sent straight to the printer as the `skip_objects`
  // `obj_list`, and the previews below are keyed by the G-code's "unique label id": BOTH of which
  // are the `identify_id` space, while `object.id` is the model `object_id`. Those coincide only
  // for a slice_info-derived index (printer storage), so for a job dispatched from the library the
  // mid-print skip targeted ids the firmware does not know AND no preview ever matched, silently.
  // Sharing `platePrintUnits` with the prepare-print picker also keeps the copy numbering
  // identical between the two surfaces.
  const objects = platePrintUnits(plate.objects).map<PrinterActivePrintObject>((unit) => ({
    // An object the file records no handle for cannot be skipped by instance; fall back to its
    // object id, which is what this surface has always sent, rather than dropping the row.
    id: unit.identifyId ?? unit.objectId,
    name: unit.label,
    previewPath: null,
    previewBounds: null
  }))
  if (objects.length === 0) return objects

  if (pickBuffer) {
    try {
      const previews = parsePickMaskObjectPreviews(pickBuffer, objects)
      if (previews.size > 0) {
        return objects.map((object) => {
          const preview = previews.get(object.id)
          return preview
            ? { ...object, previewPath: preview.previewPath, previewBounds: preview.previewBounds }
            : object
        })
      }
    } catch {
      // Fall back to the G-code parser when the pick mask is absent or invalid.
    }
  }

  if (!plate.gcodeFile || !gcodeBuffer) return objects

  try {
    const previews = parseFirstLayerObjectPreviews(gcodeBuffer.toString('utf8'), objects)
    return objects.map((object) => {
      const preview = previews.get(object.id)
      return preview
        ? { ...object, previewPath: preview.previewPath, previewBounds: preview.previewBounds }
        : object
    })
  } catch {
    return objects
  }
}

/**
 * Create a 3MF copy containing only the selected plate's heavy plate media.
 *
 * Project-level metadata/config entries are preserved so printer logs and
 * cover lookup can still understand the job, while Bambu's per-plate
 * G-code/config/thumbnail entries for other plates are dropped.
 *
 * The surviving plate is RENUMBERED to 1, because a one-plate archive that still calls itself plate
 * 3 is one BambuStudio refuses to read: `load_gcode_3mf_from_stream` indexes `plate_data_list` by
 * `plater_id - 1` and bails on any id above the plate count (`bbs_3mf.cpp:1633-1639`, the twin of
 * the project-loader guard at `:2323-2329`). That costs the printer's own SD browser the file's
 * title, time, weight and thumbnail (`PrinterFileSystem.cpp:973`) and makes print-from-SD fail with
 * "Failed to parse model information" (`MediaFilePanel.cpp:690`). The print itself is unaffected
 * either way: firmware consumes the gcode entry named in the upload parameter and never reads this.
 *
 * Only the two IDENTITY fields move. Entry names (`Metadata/plate_3.gcode`, its thumbnails) and the
 * `gcode_file` / `thumbnail_file` pointers are left exactly as they are, because the importer
 * resolves every asset through those stored strings (`:4539-4547`, extracted by literal name at
 * `:1674`) and never rebuilds a name from the index. Renaming them would also mean rewriting the
 * upload parameter, i.e. changing live print protocol to fix a metadata read.
 */
export function createSinglePlateThreeMf(sourcePath: string, outputPath: string, plate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true }, (openError, sourceZip) => {
      if (openError || !sourceZip) {
        reject(openError ?? new Error('Failed to open 3MF'))
        return
      }

      const outputZip = new yazl.ZipFile()
      const output = createWriteStream(outputPath)
      let settled = false
      let copiedEntries = 0

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

      outputZip.outputStream.pipe(output)
      outputZip.outputStream.on('error', finish)
      output.on('error', finish)
      output.on('finish', () => {
        if (copiedEntries === 0) finish(new Error('No entries copied into slim 3MF'))
        else finish()
      })

      sourceZip.on('error', finish)
      sourceZip.on('end', () => outputZip.end())
      sourceZip.on('entry', (entry: Entry) => {
        if (entry.fileName === '3D/3dmodel.model') {
          outputZip.addBuffer(Buffer.from(MINIMAL_THREE_MF_MODEL_XML, 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
          copiedEntries++
          sourceZip.readEntry()
          return
        }
        if (shouldDropPlateEntry(entry.fileName, plate)) {
          sourceZip.readEntry()
          return
        }
        if (entry.fileName === 'Metadata/slice_info.config') {
          readZipEntryBuffer(sourceZip, entry).then(
            (buffer) => {
              outputZip.addBuffer(Buffer.from(filterSliceInfoXml(buffer.toString('utf8'), plate), 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
              copiedEntries++
              sourceZip.readEntry()
            },
            finish
          )
          return
        }
        if (entry.fileName === 'Metadata/model_settings.config') {
          readZipEntryBuffer(sourceZip, entry).then(
            (buffer) => {
              outputZip.addBuffer(Buffer.from(filterModelSettingsXml(buffer.toString('utf8'), plate), 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
              copiedEntries++
              sourceZip.readEntry()
            },
            finish
          )
          return
        }
        if (entry.fileName.endsWith('/')) {
          outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
          copiedEntries++
          sourceZip.readEntry()
          return
        }
        sourceZip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`Failed to read ${entry.fileName}`))
            return
          }
          stream.on('error', finish)
          stream.on('end', () => sourceZip.readEntry())
          outputZip.addReadStream(stream, entry.fileName, { mtime: entry.getLastModDate() })
          copiedEntries++
        })
      })
      sourceZip.readEntry()
    })
  })
}

function shouldDropPlateEntry(entryPath: string, selectedPlate: number): boolean {
  if (entryPath.startsWith('3D/') && entryPath !== '3D/3dmodel.model') {
    return true
  }
  const match = /^Metadata\/(?:plate|top|pick)_(\d+)(?:_[^/.]+)?\.(?:gcode(?:\.md5)?|png|json|config)$/i.exec(entryPath)
    ?? /^Metadata\/plate_no_light_(\d+)\.png$/i.exec(entryPath)
    ?? /^Metadata\/process_settings_(\d+)\.config$/i.exec(entryPath)
  if (!match) return false
  return Number(match[1]) !== selectedPlate
}

function filterSliceInfoXml(xml: string, selectedPlate: number): string {
  let keptPlate: string | null = null
  const filtered = xml.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>/g, (block) => {
    const indexMatch = /<metadata\s+key="index"\s+value="(\d+)"\s*\/>/.exec(block)
    if (Number(indexMatch?.[1]) === selectedPlate) {
      keptPlate = renumberPlateMetadata(block, 'index')
      return keptPlate
    }
    return ''
  })
  return keptPlate ? filtered : xml
}

/**
 * Point one plate block's identity key at plate 1.
 *
 * `slice_info`'s `index` and `model_settings`' `plater_id` are the SAME key space to the importer:
 * the slice record is attached by looking its `index` up in the map built from `plater_id`
 * (`bbs_3mf.cpp:4593-4597`). A miss leaves `m_curr_plater` null and `_handle_end_config_plater`
 * then returns false (`:4766-4770`), aborting the parse outright. So the two are renumbered together
 * or not at all: fixing one alone is worse than fixing neither.
 */
function renumberPlateMetadata(block: string, key: 'index' | 'plater_id'): string {
  return block.replace(new RegExp(`(<metadata\\s+key="${key}"\\s+value=")\\d+(")`), '$11$2')
}

function filterModelSettingsXml(xml: string, selectedPlate: number): string {
  let keptPlate: string | null = null
  const filtered = xml.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>/g, (block) => {
    const plateIdMatch = /<metadata\s+key="plater_id"\s+value="(\d+)"\s*\/>/.exec(block)
    if (Number(plateIdMatch?.[1]) === selectedPlate) {
      keptPlate = renumberPlateMetadata(block, 'plater_id')
      return keptPlate
    }
    return ''
  })
  return keptPlate ? filtered : xml
}

/**
 * Create a 3MF copy where the target plate keeps only the selected objects. Geometry and all other
 * entries are copied verbatim; the deselected objects' `<build><item>` entries are marked
 * `printable="0"` so the slicer drops them from that plate (see {@link createObjectCustomizedThreeMf}
 * for why instance-metadata removal alone does not exclude an object).
 *
 * Object ids are Bambu `object_id` values (see {@link parseModelSettingsPlates}). Intended for
 * single-plate slices; callers must pass `plate > 0` and a non-empty selection.
 */
export function createObjectFilteredThreeMf(
  sourcePath: string,
  outputPath: string,
  plate: number,
  selectedObjectIds: number[]
): Promise<void> {
  return createObjectCustomizedThreeMf(sourcePath, outputPath, plate, { selectedObjectIds })
}

/** Per-object process overrides keyed by Bambu `object_id` (string), each a sparse key→value map. */
// Applied here while preparing a slice; the transform itself is shared so the browser's save path
// runs the identical rewrite. Re-exported for the api barrel's existing consumers.
export { applyObjectProcessOverridesXml } from '@printstream/shared/three-mf'
export type { ObjectProcessOverrides } from '@printstream/shared/three-mf'

/**
 * Create a 3MF copy customized for slicing: optionally drops unselected objects from the target
 * plate and/or injects per-object process overrides, in a single copy pass while leaving geometry
 * verbatim.
 *
 * Object selection is expressed by marking the deselected objects' `<build><item>` entries
 * `printable="0"` in `3D/3dmodel.model` (the same marker the 3D editor's Printable toggle writes).
 * That flag is NOT itself honored by the BambuStudio CLI: the slicer service reads it back and
 * passes the matching `identify_id`s to the CLI's `--skip-objects` flag, which is what actually
 * excludes them (see `apps/slicer/src/skip-objects.ts`). Removing the `<model_instance>` blocks
 * instead does nothing (the CLI re-derives plate membership from build-item geometry), and physically
 * deleting objects corrupts the `<assemble>` cross-references. Scoped to `plate`'s object set so
 * objects on other plates are never touched. Per-object process overrides are applied to
 * `model_settings.config`.
 *
 * `customGcode` merges slice-time layer filament changes / pauses into
 * `Metadata/custom_gcode_per_layer.xml` (replace-per-listed-plate semantics: see
 * {@link mergeCustomGcodePerLayer}); the entry is upserted when the source archive has none.
 */
export async function createObjectCustomizedThreeMf(
  sourcePath: string,
  outputPath: string,
  plate: number,
  options: {
    selectedObjectIds?: number[]
    objectProcessOverrides?: ObjectProcessOverrides
    customGcode?: { filamentChanges?: SceneEditPlateFilamentChanges[]; pauses?: SceneEditPlatePauses[] }
  }
): Promise<void> {
  const selected = options.selectedObjectIds ? new Set(options.selectedObjectIds) : null
  const overrides = options.objectProcessOverrides
  const hasOverrides = Boolean(overrides && Object.keys(overrides).length > 0)

  // Translate the "keep these objects" selection into the build items to mark unprintable, using the
  // target plate's object set from model_settings so objects on other plates are untouched.
  let unprintableObjectIds: Set<number> | null = null
  if (selected && plate > 0) {
    // A missing/unreadable model_settings.config is benign here: there are then no per-plate
    // model_instances to map a selection against, so we slice all objects (the prior behavior). A
    // genuinely corrupt archive is not silently dropped: the rewriteThreeMfEntries pass below
    // re-opens the same file and surfaces the error, failing the job.
    const modelSettingsXml = await readEntry(sourcePath, 'Metadata/model_settings.config')
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
    if (modelSettingsXml) {
      const plateObjectIds = plateObjectIdsFromModelSettingsXml(modelSettingsXml, plate)
      unprintableObjectIds = new Set([...plateObjectIds].filter((id) => !selected.has(id)))
    }
  }

  const transforms: Record<string, (xml: string) => string> = {}
  const appendEntries: Array<{ name: string; content: string }> = []
  if (hasOverrides) {
    transforms['Metadata/model_settings.config'] = (xml) => applyObjectProcessOverridesXml(xml, overrides!)
  }
  if (unprintableObjectIds && unprintableObjectIds.size > 0) {
    const ids = unprintableObjectIds
    transforms['3D/3dmodel.model'] = (xml) => setBuildItemsUnprintableXml(xml, ids)
  }
  const customGcode = options.customGcode
  if (customGcode && (customGcode.filamentChanges !== undefined || customGcode.pauses !== undefined)) {
    // Transform covers a source that already has the sidecar; the append upserts it when
    // absent (rewriteThreeMfEntries only appends names the copy pass did not write). An
    // empty merge result still writes '': the scene builder's established "cleared" form.
    transforms[CUSTOM_GCODE_PER_LAYER_ENTRY] = (xml) => mergeCustomGcodePerLayer(xml, customGcode.filamentChanges, customGcode.pauses)
    appendEntries.push({ name: CUSTOM_GCODE_PER_LAYER_ENTRY, content: mergeCustomGcodePerLayer(null, customGcode.filamentChanges, customGcode.pauses) })
  }
  await rewriteThreeMfEntries(sourcePath, outputPath, transforms, appendEntries)
}

/**
 * Move each replaced object's per-object process overrides onto the baked `object_id` its
 * "Replace with…" geometry landed on (`replacedObjectIds` comes from {@link buildEditedThreeMf}).
 * The original object is gone from the arranged 3MF, its instances reference the staged import,
 * so an override keyed by the original id would match nothing; re-keying makes it apply to the
 * replacement instead. Untouched objects keep their original key. Returns the input unchanged when
 * there were no replacements.
 */
export function rekeyReplacedObjectOverrides(
  overrides: ObjectProcessOverrides,
  replacedObjectIds: ReadonlyArray<{ originalObjectId: number; bakedObjectId: number }>
): ObjectProcessOverrides {
  // Delegates to the shared implementation the BAKE also uses, so the API's post-pass and the
  // browser's in-bake pass cannot disagree about what re-keying means.
  return rekeyObjectProcessOverrides(overrides, replacedObjectIds)
}


/**
 * Collect the Bambu `object_id`s placed on `plate` from a `model_settings.config` XML string (one
 * id per object, even with multiple instances). Used to turn a "keep these" object selection into
 * the complementary "make these unprintable" set scoped to a single plate.
 */
export function plateObjectIdsFromModelSettingsXml(xml: string, plate: number): Set<number> {
  const ids = new Set<number>()
  for (const plateMatch of xml.matchAll(/<plate\b[^>]*>[\s\S]*?<\/plate>/g)) {
    const block = plateMatch[0]
    const plateId = Number(/<metadata\s+key="plater_id"\s+value="(\d+)"\s*\/>/.exec(block)?.[1])
    if (plateId !== plate) continue
    for (const instanceMatch of block.matchAll(/<model_instance\b[^>]*>[\s\S]*?<\/model_instance>/g)) {
      const objectId = Number(/<metadata\s+key="object_id"\s+value="(\d+)"\s*\/>/.exec(instanceMatch[0])?.[1])
      if (Number.isInteger(objectId)) ids.add(objectId)
    }
  }
  return ids
}

/** Result of mapping a plate's deselected plates-index object ids to instance `identify_id`s. */
export interface PlateSkipIdentifyIds {
  /** `identify_id`s of every instance (on the plate) of the requested objects and instances. */
  identifyIds: number[]
  /** Requested object ids with no matching instance on the plate (or no usable identify_id). */
  unmatchedObjectIds: number[]
  /** Requested instance identify_ids that are not placed on this plate. */
  unmatchedInstanceIds: number[]
  /** Total instances placed on the plate: lets callers refuse a skip-everything selection. */
  plateInstanceCount: number
}

/**
 * Map deselected plate objects to instance `identify_id`s using a parsed 3MF index: the single
 * resolver behind both the library dispatch (`print-dispatcher.ts`) and printer-storage print
 * flows. `identify_id` is the per-instance handle Bambu keys `skip_objects` on (the G-code's
 * "unique label id"), a DIFFERENT id space from the model `object_id`, so the post-start skip
 * must send these, never the object ids themselves. `objectIds` are the plates index's own
 * `objects[].id` values, whatever id space that index carries: model_settings-derived objects use
 * `object_id`, while slice_info-derived objects (gcode-only exports with no `model_instance`
 * blocks; also the printer-storage index) use the identify_id itself. Resolving through the same
 * index the UI displayed is what keeps those two id spaces from ever crossing. Each object's
 * `identifyIds` supplies its firmware skip handles; an object without identify_ids counts as
 * unmatched, and `plateInstanceCount` sums every object's instances so callers can refuse a
 * skip-everything selection. Mirrors the object→identify translation the slicer service does for
 * `--skip-objects` (`apps/slicer/src/skip-objects.ts`).
 */
export function plateSkipIdentifyIdsFromIndex(
  // Structural subset of ThreeMfIndex so callers can pass any parsed index shape.
  index: { plates: ReadonlyArray<{ index: number; objects: ReadonlyArray<{ id: number; identifyIds: ReadonlyArray<number> }> }> },
  plate: number,
  objectIds: ReadonlySet<number>,
  /**
   * Individual placements to skip, by `identify_id` (the request's `skipInstances`). Unioned with
   * the whole-object selection above, and validated against THIS plate: an identify_id belonging
   * to another plate is reported unmatched rather than forwarded, because the firmware would
   * silently ignore it and the user would watch the copy print anyway.
   */
  instanceIds: ReadonlySet<number> = new Set()
): PlateSkipIdentifyIds {
  const plateEntry = index.plates.find((entry) => entry.index === plate)
  const identifyIds: number[] = []
  const matchedObjectIds = new Set<number>()
  const matchedInstanceIds = new Set<number>()
  let plateInstanceCount = 0
  for (const object of plateEntry?.objects ?? []) {
    // An object with no recorded instances still occupies the plate; count at least one
    // so a "skip everything" selection cannot slip past the guard on identify-id count.
    plateInstanceCount += Math.max(1, object.identifyIds.length)
    const wholeObject = objectIds.has(object.id) && object.identifyIds.length > 0
    if (wholeObject) matchedObjectIds.add(object.id)
    for (const identifyId of object.identifyIds) {
      const instanceRequested = instanceIds.has(identifyId)
      if (instanceRequested) matchedInstanceIds.add(identifyId)
      if (!wholeObject && !instanceRequested) continue
      if (!identifyIds.includes(identifyId)) identifyIds.push(identifyId)
    }
  }
  const unmatchedObjectIds = [...objectIds].filter((id) => !matchedObjectIds.has(id))
  const unmatchedInstanceIds = [...instanceIds].filter((id) => !matchedInstanceIds.has(id))
  return { identifyIds, unmatchedObjectIds, unmatchedInstanceIds, plateInstanceCount }
}

/**
 * Mark the `<build><item>` entries of `unprintableObjectIds` as `printable="0"` in a
 * `3D/3dmodel.model` XML string (replacing an existing `printable` attribute or inserting one),
 * leaving every other build item and the rest of the document untouched. This is the same marker the
 * editor's per-object "Printable" toggle writes; the slicer service translates it into BambuStudio's
 * `--skip-objects` CLI flag at slice time (the CLI ignores the flag itself). Build-item `objectid`s
 * are Bambu `object_id` values, matching {@link plateObjectIdsFromModelSettingsXml}.
 */
export function setBuildItemsUnprintableXml(modelXml: string, unprintableObjectIds: Set<number>): string {
  if (unprintableObjectIds.size === 0) return modelXml
  return modelXml.replace(/<build\b[^>]*>[\s\S]*?<\/build>/g, (buildBlock) =>
    buildBlock.replace(/<item\b[^>]*\/>/g, (item) => {
      const objectId = Number(/\bobjectid="(\d+)"/.exec(item)?.[1])
      if (!Number.isInteger(objectId) || !unprintableObjectIds.has(objectId)) return item
      return /\bprintable="[^"]*"/.test(item)
        ? item.replace(/\bprintable="[^"]*"/, 'printable="0"')
        : item.replace(/\s*\/>$/, ' printable="0"/>')
    })
  )
}

/**
 * Embed (or replace) per-plate thumbnail PNGs in a sliced 3MF. An editor SAVE runs no slicer
 * CLI at all, so the editor renders its own plate previews and they are baked in here as
 * `Metadata/plate_N.png` (+ the `_small` variant) so the library thumbnail reflects the edited
 * layout immediately. At SLICE time the CLI can now render its own covers (see
 * docs/slicer-cover-rendering.md); these editor renders remain the save-time source and the
 * backfill fallback. Any existing entry of the same name is replaced.
 */
export async function embedPlateThumbnails(
  threeMfPath: string,
  thumbnails: Array<{ plateIndex: number; png: Buffer }>
): Promise<void> {
  if (thumbnails.length === 0) return
  // Naming and the validity rule come from the shared module, because the BROWSER embeds the same
  // previews into the archive it deflates and the two must not drift about which entries a plate
  // owns. Only the ZIP I/O is per-host, the same split the bake itself keeps.
  const replacements = new Map<string, Buffer>(
    plateThumbnailEntries(thumbnails).map((entry) => [entry.name, Buffer.from(entry.png)])
  )
  if (replacements.size === 0) return

  const tempPath = `${threeMfPath}.thumbs`
  await new Promise<void>((resolve, reject) => {
    yauzl.open(threeMfPath, { lazyEntries: true }, (openError, sourceZip) => {
      if (openError || !sourceZip) { reject(openError ?? new Error('Failed to open 3MF')); return }
      const outputZip = new yazl.ZipFile()
      const output = createWriteStream(tempPath)
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        sourceZip.close()
        if (error) { output.destroy(); reject(error) } else resolve()
      }
      outputZip.outputStream.pipe(output)
      outputZip.outputStream.on('error', finish)
      output.on('error', finish)
      output.on('finish', () => finish())
      const written = new Set<string>()
      sourceZip.on('error', finish)
      sourceZip.on('end', () => {
        for (const [name, buffer] of replacements) {
          if (written.has(name)) continue
          written.add(name)
          outputZip.addBuffer(buffer, name)
        }
        outputZip.end()
      })
      sourceZip.on('entry', (entry: Entry) => {
        if (written.has(entry.fileName)) { sourceZip.readEntry(); return }
        const replacement = replacements.get(entry.fileName)
        if (replacement) {
          written.add(entry.fileName)
          outputZip.addBuffer(replacement, entry.fileName)
          sourceZip.readEntry()
          return
        }
        if (entry.fileName.endsWith('/')) {
          outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
          sourceZip.readEntry()
          return
        }
        sourceZip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { finish(streamError ?? new Error(`Failed to read ${entry.fileName}`)); return }
          stream.on('error', finish)
          stream.on('end', () => sourceZip.readEntry())
          outputZip.addReadStream(stream, entry.fileName, { mtime: entry.getLastModDate() })
        })
      })
      sourceZip.readEntry()
    })
  })
  await rename(tempPath, threeMfPath)
}

interface PreviewPoint {
  x: number
  y: number
}

interface ObjectPreviewAccumulator {
  outerPaths: PreviewPoint[][]
  fallbackPaths: PreviewPoint[][]
}

interface ParsedObjectPreview {
  previewPath: string
  previewBounds: PrinterActivePrintObjectPreviewBounds
}

type FirstLayerStartMode = 'marker' | 'zHeight'

function parsePickMaskObjectPreviews(
  pickBuffer: Buffer,
  // Keyed by the pick mask's own id space, which is the G-code's "unique label id"
  // (`identify_id`): pass the entries whose `id` already speaks it, never raw plate objects.
  objects: ReadonlyArray<{ id: number }>
): Map<number, ParsedObjectPreview> {
  const image = PNG.sync.read(pickBuffer)
  if (image.width <= 0 || image.height <= 0) return new Map()

  const allowedObjectIds = new Set(objects.map((object) => object.id))
  const occupied = new Uint8Array(image.width * image.height)
  const visited = new Uint8Array(image.width * image.height)

  for (let index = 0; index < occupied.length; index += 1) {
    const offset = index * 4
    const alpha = image.data[offset + 3] ?? 0
    const objectId = decodePickMaskObjectId(image.data, offset)
    if (alpha > 0 && objectId > 0) occupied[index] = 1
  }

  const objectPaths = new Map<number, PreviewPoint[][]>()
  for (let startIndex = 0; startIndex < occupied.length; startIndex += 1) {
    if (occupied[startIndex] === 0 || visited[startIndex] === 1) continue

    const queue = [startIndex]
    visited[startIndex] = 1
    const rowPixels = new Map<number, number[]>()
    const idCounts = new Map<number, number>()
    let pixelCount = 0

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const currentIndex = queue[queueIndex]
      if (currentIndex == null) continue
      const x = currentIndex % image.width
      const y = Math.floor(currentIndex / image.width)
      const objectId = decodePickMaskObjectId(image.data, currentIndex * 4)
      if (objectId > 0) {
        idCounts.set(objectId, (idCounts.get(objectId) ?? 0) + 1)
      }
      pixelCount += 1
      const row = rowPixels.get(y)
      if (row) row.push(x)
      else rowPixels.set(y, [x])

      const left = currentIndex - 1
      const right = currentIndex + 1
      const up = currentIndex - image.width
      const down = currentIndex + image.width
      if (x > 0 && occupied[left] === 1 && visited[left] === 0) {
        visited[left] = 1
        queue.push(left)
      }
      if (x + 1 < image.width && occupied[right] === 1 && visited[right] === 0) {
        visited[right] = 1
        queue.push(right)
      }
      if (y > 0 && occupied[up] === 1 && visited[up] === 0) {
        visited[up] = 1
        queue.push(up)
      }
      if (y + 1 < image.height && occupied[down] === 1 && visited[down] === 0) {
        visited[down] = 1
        queue.push(down)
      }
    }

    const objectId = selectDominantPickMaskObjectId(idCounts, pixelCount, allowedObjectIds)
    if (objectId == null) continue
    const paths = buildRasterPreviewPaths(rowPixels, image.height)
    if (paths.length === 0) continue
    const existing = objectPaths.get(objectId)
    if (existing) existing.push(...paths)
    else objectPaths.set(objectId, paths)
  }

  const previews = new Map<number, ParsedObjectPreview>()
  for (const [objectId, paths] of objectPaths.entries()) {
    const previewBounds = calculatePreviewBounds(paths)
    const previewPath = buildPreviewSvgPath(paths)
    if (!previewBounds || !previewPath) continue
    previews.set(objectId, { previewPath, previewBounds })
  }
  return previews
}

function decodePickMaskObjectId(data: Uint8Array, offset: number): number {
  const red = data[offset] ?? 0
  const green = data[offset + 1] ?? 0
  const blue = data[offset + 2] ?? 0
  return red + (green << 8) + (blue << 16)
}

function selectDominantPickMaskObjectId(
  idCounts: ReadonlyMap<number, number>,
  pixelCount: number,
  allowedObjectIds: ReadonlySet<number>
): number | null {
  let bestObjectId: number | null = null
  let bestCount = 0
  for (const [objectId, count] of idCounts.entries()) {
    if (!allowedObjectIds.has(objectId) || count <= bestCount) continue
    bestObjectId = objectId
    bestCount = count
  }
  return bestObjectId != null && bestCount * 2 > pixelCount ? bestObjectId : null
}

function buildRasterPreviewPaths(rowPixels: ReadonlyMap<number, number[]>, imageHeight: number): PreviewPoint[][] {
  const rows = [...rowPixels.keys()].sort((left, right) => left - right)
  const paths: PreviewPoint[][] = []
  const activeRects = new Map<string, { startX: number; endX: number; startRow: number; endRow: number }>()

  const flushRect = (rect: { startX: number; endX: number; startRow: number; endRow: number }) => {
    const minX = rect.startX
    const maxX = rect.endX
    const minY = imageHeight - rect.endRow - 1
    const maxY = imageHeight - rect.startRow
    paths.push([
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
      { x: minX, y: minY }
    ])
  }

  for (const row of rows) {
    const xs = rowPixels.get(row)
    if (!xs || xs.length === 0) continue
    xs.sort((left, right) => left - right)
    const spans: Array<{ startX: number; endX: number }> = []
    let spanStart = xs[0] ?? 0
    let previousX = spanStart
    for (let index = 1; index < xs.length; index += 1) {
      const x = xs[index]
      if (x == null) continue
      if (x === previousX || x === previousX + 1) {
        previousX = x
        continue
      }
      spans.push({ startX: spanStart, endX: previousX + 1 })
      spanStart = x
      previousX = x
    }
    spans.push({ startX: spanStart, endX: previousX + 1 })

    const nextActive = new Map<string, { startX: number; endX: number; startRow: number; endRow: number }>()
    for (const span of spans) {
      const key = `${span.startX}:${span.endX}`
      const existing = activeRects.get(key)
      if (existing && existing.endRow === row - 1) {
        existing.endRow = row
        nextActive.set(key, existing)
      } else {
        nextActive.set(key, { ...span, startRow: row, endRow: row })
      }
    }
    for (const [key, rect] of activeRects.entries()) {
      if (!nextActive.has(key)) flushRect(rect)
    }
    activeRects.clear()
    for (const [key, rect] of nextActive.entries()) activeRects.set(key, rect)
  }

  for (const rect of activeRects.values()) flushRect(rect)
  return paths
}

function parseFirstLayerObjectPreviews(
  gcode: string,
  // Keyed by the `; start printing object, unique label id:` marker, i.e. `identify_id`.
  objects: ReadonlyArray<{ id: number }>
): Map<number, ParsedObjectPreview> {
  const byObjectId = new Map<number, ObjectPreviewAccumulator>(
    objects.map((object) => [object.id, { outerPaths: [], fallbackPaths: [] }])
  )
  let inFirstLayer = false
  let firstLayerStartMode: FirstLayerStartMode | null = null
  let firstLayerZHeight: number | null = null
  let inWipe = false
  let currentObjectId: number | null = null
  let currentFeature: string | null = null
  let absolutePositioning = true
  let relativeExtrusion = false
  let currentX = 0
  let currentY = 0
  let currentZ = 0
  let currentE = 0
  let activePath: { objectId: number; kind: 'outer' | 'fallback'; points: PreviewPoint[] } | null = null

  const flushActivePath = () => {
    if (!activePath || activePath.points.length < 2) {
      activePath = null
      return
    }
    const target = byObjectId.get(activePath.objectId)
    if (!target) {
      activePath = null
      return
    }
    if (activePath.kind === 'outer') target.outerPaths.push(activePath.points)
    else target.fallbackPaths.push(activePath.points)
    activePath = null
  }

  const appendSegment = (objectId: number, kind: 'outer' | 'fallback', from: PreviewPoint, points: PreviewPoint[]) => {
    if (!byObjectId.has(objectId) || points.length === 0) return
    const lastActivePoint = activePath?.points[activePath.points.length - 1]
    const needsNewPath = !activePath
      || activePath.objectId !== objectId
      || activePath.kind !== kind
      || !lastActivePoint
      || !pointsNearlyEqual(lastActivePoint, from)
    if (needsNewPath) {
      flushActivePath()
      activePath = { objectId, kind, points: [from] }
    }
    if (!activePath) return
    for (const point of points) {
      const lastPoint = activePath.points[activePath.points.length - 1]
      if (!lastPoint || !pointsNearlyEqual(lastPoint, point)) {
        activePath.points.push(point)
      }
    }
  }

  const startFirstLayer = (mode: FirstLayerStartMode, zHeight: number | null = null) => {
    inFirstLayer = true
    firstLayerStartMode = mode
    firstLayerZHeight = mode === 'zHeight' ? zHeight : null
    inWipe = false
    currentObjectId = null
    currentFeature = null
  }

  for (const rawLine of gcode.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) continue

    if (trimmed.startsWith(';')) {
      const comment = trimmed.slice(1).trim()
      if (comment.startsWith('object ids of layer 1 start:')) {
        flushActivePath()
        if (!inFirstLayer && firstLayerStartMode == null) startFirstLayer('marker')
        continue
      }
      if (comment.startsWith('Z_HEIGHT:')) {
        const zHeight = parseCommentNumberValue(comment, 'Z_HEIGHT:')
        if (!inFirstLayer) {
          flushActivePath()
          startFirstLayer('zHeight', zHeight)
          continue
        }
        if (
          firstLayerStartMode === 'marker'
          || zHeight == null
          || firstLayerZHeight == null
          || zHeight > firstLayerZHeight + 1e-6
        ) {
          flushActivePath()
          break
        }
        continue
      }
      if (!inFirstLayer) continue
      if (comment.startsWith('FEATURE:')) {
        flushActivePath()
        currentFeature = comment.slice('FEATURE:'.length).trim()
        continue
      }
      if (comment.startsWith('WIPE_START')) {
        flushActivePath()
        inWipe = true
        continue
      }
      if (comment.startsWith('WIPE_END')) {
        flushActivePath()
        inWipe = false
        continue
      }
      const objectMatch = /^start printing object, unique label id:\s*(\d+)/i.exec(comment)
      if (objectMatch) {
        flushActivePath()
        currentObjectId = Number.parseInt(objectMatch[1] ?? '', 10)
      }
      continue
    }

    const code = trimmed.split(';', 1)[0]?.trim() ?? ''
    if (code.length === 0) continue
    const [command] = code.split(/\s+/, 1)
    const params = parseGcodeParams(code)

    switch (command) {
      case 'G90':
        flushActivePath()
        absolutePositioning = true
        continue
      case 'G91':
        flushActivePath()
        absolutePositioning = false
        continue
      case 'M82':
        flushActivePath()
        relativeExtrusion = false
        continue
      case 'M83':
        flushActivePath()
        relativeExtrusion = true
        continue
      case 'G92':
        flushActivePath()
        if (params.X != null) currentX = params.X
        if (params.Y != null) currentY = params.Y
        if (params.Z != null) currentZ = params.Z
        if (params.E != null) currentE = params.E
        continue
      case 'M625':
        if (inFirstLayer) {
          flushActivePath()
          currentObjectId = null
        }
        continue
      case 'G0':
      case 'G1':
      case 'G2':
      case 'G3':
        break
      default:
        continue
    }

    const nextX = params.X != null ? (absolutePositioning ? params.X : currentX + params.X) : currentX
    const nextY = params.Y != null ? (absolutePositioning ? params.Y : currentY + params.Y) : currentY
    const nextZ = params.Z != null ? (absolutePositioning ? params.Z : currentZ + params.Z) : currentZ
    const nextE = params.E != null ? (relativeExtrusion ? currentE + params.E : params.E) : currentE
    const extrusionDelta = params.E != null ? nextE - currentE : 0

    if (
      inFirstLayer
      && !inWipe
      && currentObjectId != null
      && extrusionDelta > 0
      && Number.isFinite(currentX)
      && Number.isFinite(currentY)
      && Number.isFinite(nextX)
      && Number.isFinite(nextY)
    ) {
      const kind = currentFeature === 'Outer wall' ? 'outer' : 'fallback'
      const from = { x: currentX, y: currentY }
      const sampledPoints = command === 'G2' || command === 'G3'
        ? sampleArcPoints(from, { x: nextX, y: nextY }, params.I, params.J, command === 'G2')
        : [{ x: nextX, y: nextY }]
      appendSegment(currentObjectId, kind, from, sampledPoints)
    } else if (command === 'G0' || command === 'G1' || command === 'G2' || command === 'G3') {
      flushActivePath()
    }

    currentX = nextX
    currentY = nextY
    currentZ = nextZ
    currentE = nextE
  }

  flushActivePath()

  const previews = new Map<number, ParsedObjectPreview>()
  for (const [objectId, accumulator] of byObjectId.entries()) {
    const paths = accumulator.outerPaths.length > 0 ? accumulator.outerPaths : accumulator.fallbackPaths
    const previewBounds = calculatePreviewBounds(paths)
    const previewPath = buildPreviewSvgPath(paths)
    if (!previewBounds || !previewPath) continue
    previews.set(objectId, { previewPath, previewBounds })
  }
  return previews
}

function calculatePreviewBounds(paths: PreviewPoint[][]): PrinterActivePrintObjectPreviewBounds | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const path of paths) {
    for (const point of path) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null
  }
  return { minX, minY, maxX, maxY }
}

function buildPreviewSvgPath(paths: PreviewPoint[][]): string | null {
  const commands: string[] = []
  for (const path of paths) {
    if (path.length < 2) continue
    const firstPoint = path[0]
    const lastPoint = path[path.length - 1]
    if (!firstPoint || !lastPoint) continue
    commands.push(`M ${formatPreviewCoordinate(firstPoint.x)} ${formatPreviewCoordinate(firstPoint.y)}`)
    for (let index = 1; index < path.length; index += 1) {
      const point = path[index]
      if (!point) continue
      commands.push(`L ${formatPreviewCoordinate(point.x)} ${formatPreviewCoordinate(point.y)}`)
    }
    if (pointsNearlyEqual(firstPoint, lastPoint, 0.6)) {
      commands.push('Z')
    }
  }
  return commands.length > 0 ? commands.join(' ') : null
}

function parseGcodeParams(line: string): Record<string, number> {
  const params: Record<string, number> = {}
  for (const match of line.matchAll(/\b([A-Z])([-+]?\d*\.?\d+)\b/g)) {
    const key = match[1]
    const value = Number.parseFloat(match[2] ?? '')
    if (!key || !Number.isFinite(value)) continue
    params[key] = value
  }
  return params
}

function parseCommentNumberValue(comment: string, prefix: string): number | null {
  const value = Number.parseFloat(comment.slice(prefix.length).trim())
  return Number.isFinite(value) ? value : null
}

function sampleArcPoints(
  from: PreviewPoint,
  to: PreviewPoint,
  offsetI: number | undefined,
  offsetJ: number | undefined,
  clockwise: boolean
): PreviewPoint[] {
  if (!Number.isFinite(offsetI) || !Number.isFinite(offsetJ)) return [to]
  const center = { x: from.x + (offsetI ?? 0), y: from.y + (offsetJ ?? 0) }
  const radius = Math.hypot(from.x - center.x, from.y - center.y)
  if (!Number.isFinite(radius) || radius <= 0) return [to]

  const startAngle = Math.atan2(from.y - center.y, from.x - center.x)
  const endAngle = Math.atan2(to.y - center.y, to.x - center.x)
  let delta = endAngle - startAngle
  if (clockwise && delta >= 0) delta -= Math.PI * 2
  if (!clockwise && delta <= 0) delta += Math.PI * 2
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) return [to]

  const steps = Math.max(6, Math.ceil(Math.abs(delta) / (Math.PI / 18)))
  const points: PreviewPoint[] = []
  for (let step = 1; step <= steps; step += 1) {
    const angle = startAngle + (delta * step) / steps
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius
    })
  }
  const lastPoint = points[points.length - 1]
  if (!lastPoint || !pointsNearlyEqual(lastPoint, to)) points[points.length - 1] = to
  return points
}

function pointsNearlyEqual(a: PreviewPoint, b: PreviewPoint, tolerance = 0.02): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
}

function formatPreviewCoordinate(value: number): string {
  return (Math.round(value * 100) / 100).toString()
}
