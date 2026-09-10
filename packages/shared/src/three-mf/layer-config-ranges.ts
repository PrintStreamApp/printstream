/**
 * BambuStudio height range modifiers: `Metadata/layer_config_ranges.xml`.
 *
 * Owns both directions of that sidecar: parsing it into per-object Z bands with process-setting
 * overrides, and serializing the editor's complete set back out. The editor surfaces them as
 * per-object "height ranges"; the slicer applies each band's settings to the layers inside it.
 *
 * ## The ordinal contract
 *
 * The file's `<object id>` is a **1-based index into the model's object list**, NOT a 3MF object
 * id (`bbs_3mf.cpp:7643-7651` writes a running `object_cnt`; its reader looks up
 * `object.second + 1`). That is the same ordinal space `brim_ear_points.txt` uses, so both
 * directions here resolve through `parseRootModelObjectIdOrder` and callers deal in real object
 * ids. Getting this wrong does not fail loudly: the ranges land on whichever object happens to
 * occupy that slot.
 *
 * ## Two rules BambuStudio enforces by crashing rather than by validating
 *
 * 1. **Every range MUST carry `layer_height`.** `Slicing.cpp:179` does
 *    `it_range->second.option("layer_height")->getFloat()` with no `has()` check, so a range
 *    without it null-derefs the slicer on the next slice. {@link serializeLayerConfigRanges}
 *    therefore refuses to write a range that has no layer height.
 * 2. **Every range should carry `extruder`.** `GUI_ObjectList.cpp:4803` skips building a tree row
 *    for a range with no `extruder` key, so such a range is INVISIBLE in Studio's object list
 *    while still affecting the slice. We always write it (`0` meaning "no override", which is what
 *    Studio's own writer does even though its source comments call that wasteful), so a file we
 *    author stays editable in Studio.
 *
 * ## Semantics (ported, not invented)
 *
 * Z values are millimetres in OBJECT space with z=0 at the object's bottom, raft excluded
 * (`Slicing.cpp:162`). A band covers `[minZ, maxZ)`: closed at the bottom, open at the top
 * (`PrintObjectSlice.cpp:71`). Overlaps are legal in the file and resolved by trimming the LOWER
 * range's top away from the higher one, so the lower range wins (`Slicing.cpp:181-182`); we keep
 * that reading for files that already contain overlaps rather than "repairing" them.
 *
 * Parsing is deliberately tolerant where BambuStudio's is not: its reader throws on a missing
 * `min_z`/`max_z` or an unexpected root element and aborts the whole 3MF load, so a malformed
 * sidecar costs the user their file. A range we cannot read is skipped instead.
 */
import { parseRootModelObjectIdOrder } from './scene-parser.js'
import { xmlAttribute as attribute } from './xml-write.js'

/** The archive entry these ranges live in (`LAYER_CONFIG_RANGES_FILE`, `bbs_3mf.cpp:176`). */
export const LAYER_CONFIG_RANGES_ENTRY = 'Metadata/layer_config_ranges.xml'

/** One height band on an object: a Z span in object space plus the settings it overrides. */
export interface ThreeMfHeightRange {
  /** Band bottom, mm in object space (z=0 at the object's underside). Inclusive. */
  minZ: number
  /** Band top, mm in object space. Exclusive. */
  maxZ: number
  /**
   * Process-setting overrides for the band, keyed by setting id. Always includes `layer_height`;
   * `extruder` is present but `'0'` when the band does not retarget material.
   *
   * Always strings on the way IN: a BambuStudio `<option>` holds one serialized value
   * (`config.opt_serialize`) and the sidecar does not record which settings were vectors, exactly
   * as our object-level overrides do not. {@link WritableHeightRange} is the looser shape the
   * writer accepts, since an editor override may still be array-valued.
   */
  settings: Record<string, string>
}

/**
 * A band on the way OUT. A vector setting may still be an array here (that is how process
 * overrides are held in the editor); it is written joined on `;`, the same form
 * `applyObjectProcessOverridesXml` uses.
 */
export interface WritableHeightRange {
  minZ: number
  maxZ: number
  settings: Record<string, string | string[]>
}

/** The setting every band must carry, because BambuStudio reads it without checking. */
export const HEIGHT_RANGE_LAYER_HEIGHT_KEY = 'layer_height'
/** The setting a band needs for BambuStudio to render a row for it; `'0'` means "no override". */
export const HEIGHT_RANGE_EXTRUDER_KEY = 'extruder'

const OBJECT_BLOCK_RE = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
const RANGE_BLOCK_RE = /<range\b([^>]*?)(?:\/>|>([\s\S]*?)<\/range>)/g
const OPTION_RE = /<option\b([^>]*?)(?:\/>|>([\s\S]*?)<\/option>)/g

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, '&quot;')
}

/**
 * Format a Z value the way BambuStudio's writer does: boost prints a double with no trailing
 * zeros, so `2.0` is written `2`. Matching that keeps a round trip byte-identical for files we
 * did not change.
 */
function formatZ(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

/**
 * Parse `Metadata/layer_config_ranges.xml` into height ranges keyed by ROOT 3MF object id.
 *
 * `rootModelXml` supplies the ordinal order the file is written against. Malformed objects,
 * ranges and options are skipped rather than throwing.
 */
export function parseLayerConfigRanges(
  xml: string | null,
  rootModelXml: string
): Map<number, ThreeMfHeightRange[]> {
  const out = new Map<number, ThreeMfHeightRange[]>()
  if (!xml) return out
  const orderedObjectIds = parseRootModelObjectIdOrder(rootModelXml)

  OBJECT_BLOCK_RE.lastIndex = 0
  let objectMatch: RegExpExecArray | null
  while ((objectMatch = OBJECT_BLOCK_RE.exec(xml)) !== null) {
    const ordinal = Number.parseInt(attribute(objectMatch[1] ?? '', 'id') ?? '', 10)
    if (!Number.isInteger(ordinal) || ordinal <= 0) continue
    const objectId = orderedObjectIds[ordinal - 1]
    if (!objectId) continue

    const ranges: ThreeMfHeightRange[] = []
    const body = objectMatch[2] ?? ''
    RANGE_BLOCK_RE.lastIndex = 0
    let rangeMatch: RegExpExecArray | null
    while ((rangeMatch = RANGE_BLOCK_RE.exec(body)) !== null) {
      const attrs = rangeMatch[1] ?? ''
      const minZ = Number.parseFloat(attribute(attrs, 'min_z') ?? '')
      const maxZ = Number.parseFloat(attribute(attrs, 'max_z') ?? '')
      if (!Number.isFinite(minZ) || !Number.isFinite(maxZ) || maxZ <= minZ) continue

      const settings: Record<string, string> = {}
      const rangeBody = rangeMatch[2] ?? ''
      OPTION_RE.lastIndex = 0
      let optionMatch: RegExpExecArray | null
      while ((optionMatch = OPTION_RE.exec(rangeBody)) !== null) {
        const key = attribute(optionMatch[1] ?? '', 'opt_key')
        if (!key) continue
        settings[key] = decodeXmlText((optionMatch[2] ?? '').trim())
      }
      ranges.push({ minZ, maxZ, settings })
    }
    if (ranges.length > 0) out.set(objectId, ranges)
  }
  return out
}

/** One object's complete desired height-range set, as the editor emits it. */
export interface ObjectHeightRanges {
  objectId: number
  ranges: ReadonlyArray<WritableHeightRange>
}

/**
 * Serialize the complete height-range set into BambuStudio's `layer_config_ranges.xml`.
 *
 * Returns `''` when nothing serializes, which CLEARS the file (the same convention
 * `serializeBrimEarPoints` uses) rather than leaving a stale sidecar behind.
 *
 * Ordinals are re-derived from the SAVED model, so an object that moved or was deleted since the
 * file was read still lands on the right slot. A range with no resolvable layer height is dropped
 * rather than written, because BambuStudio would crash reading it back (see the module header).
 */
export function serializeLayerConfigRanges(entries: ReadonlyArray<ObjectHeightRanges>, modelXml: string): string {
  const ordinalByObjectId = new Map<number, number>()
  parseRootModelObjectIdOrder(modelXml).forEach((id, index) => {
    if (!ordinalByObjectId.has(id)) ordinalByObjectId.set(id, index + 1)
  })

  const blocks: string[] = []
  for (const entry of [...entries].sort((a, b) => a.objectId - b.objectId)) {
    const ordinal = ordinalByObjectId.get(entry.objectId)
    if (!ordinal) continue
    const rangeXml: string[] = []
    for (const range of [...entry.ranges].sort((a, b) => a.minZ - b.minZ || a.maxZ - b.maxZ)) {
      if (!(range.maxZ > range.minZ)) continue
      const settings = { ...range.settings }
      // Never write a range BambuStudio would crash on, or one it would hide from its own UI.
      if (!settings[HEIGHT_RANGE_LAYER_HEIGHT_KEY]) continue
      if (!settings[HEIGHT_RANGE_EXTRUDER_KEY]) settings[HEIGHT_RANGE_EXTRUDER_KEY] = '0'
      const options = Object.keys(settings).sort().map((key) => {
        const value = settings[key]
        const serialized = Array.isArray(value) ? value.join(';') : (value ?? '')
        return `    <option opt_key="${escapeXmlAttribute(key)}">${escapeXmlText(serialized)}</option>`
      })
      rangeXml.push(
        `   <range min_z="${formatZ(range.minZ)}" max_z="${formatZ(range.maxZ)}">\n${options.join('\n')}\n   </range>`
      )
    }
    if (rangeXml.length === 0) continue
    blocks.push(`  <object id="${ordinal}">\n${rangeXml.join('\n')}\n  </object>`)
  }
  if (blocks.length === 0) return ''
  return `<?xml version="1.0" encoding="utf-8"?>\n<objects>\n${blocks.join('\n')}\n</objects>\n`
}
