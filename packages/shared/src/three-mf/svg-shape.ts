/**
 * What an SVG part was EXTRUDED FROM, so it stays editable after the geometry is baked.
 *
 * OWNS two records and the archive-entry naming they share. An extruded SVG part is baked triangles
 * like any other, so without a record a saved logo reopens as anonymous solids and the only way to
 * change its width is to delete it and re-import: the same problem `<text_info/>` solves for text
 * (`text-info.ts`), and this module is its counterpart.
 *
 * **NEITHER record carries the artwork.** Both name an archive entry (`3D/<name>.svg`) holding the
 * source bytes, and the shapes are re-derived from those bytes on open. That is not our choice:
 * BambuStudio's reader says so in place ("MayBe: store also shapes to not store svg / But be
 * carefull curve will be lost", `bbs_3mf.cpp:9834`), and `EmbossShape::shapes_with_ids` is absent
 * from its serializer entirely. No entry, no re-editability, in either tool.
 *
 * **Why two records rather than one.** They answer different questions and only one of them is
 * Studio's:
 *
 * - {@link BambuStudioShape} (`<BambuStudioShape/>`, writer `bbs_3mf.cpp:9786`, reader `:9812`) is
 *   the INTEROP record. Studio makes ONE volume per SVG, so this record describes a whole artwork.
 * - {@link SvgPartRecord} (`<printstream_svg/>`) is OURS, and exists because our SVG tool makes one
 *   part PER DRAWN SHAPE so a logo's background is deletable and each mark can take its own
 *   filament. Studio's format cannot express "this volume is shape 3 of 12": the per-shape ids are
 *   derived at parse time (`2i` fill / `2i+1` stroke, `NSVGUtils.cpp:45`) and never written, so a
 *   split import needs a field Studio does not have.
 *
 * **A SPLIT import must not carry a {@link BambuStudioShape}.** Stamping one on each of N parts
 * tells Studio that every one of them is the whole logo, and editing any single mark there would
 * regenerate the entire artwork over it. Write the interop record only where it is TRUE (a
 * one-part, merged, import) and the private record everywhere. A record that lies is worse than a
 * record that is absent, because the absent one reopens as geometry and the lying one silently
 * destroys the other N-1 parts.
 *
 * Counterpart in the browser: `apps/web/src/plugins/model-studio/lib/svgGeometry.ts` produces the
 * geometry these describe, and `SvgToolPanel.tsx` is the panel they reopen.
 */

import {
  decodeXmlAttributeValue,
  escapeXmlAttribute,
  xmlAttribute as attribute,
  xmlNumberAttribute as numberAttribute
} from './xml-write.js'

/** Studio's element name (`SHAPE_TAG`, `bbs_3mf.cpp:424`). */
export const BAMBU_SHAPE_ELEMENT = 'BambuStudioShape'

/**
 * The PrusaSlicer-lineage element Studio still reads (`OLD_SHAPE_TAG`, `bbs_3mf.cpp:423`), routed
 * to the same handler. Accepted on read so a file from that tooling reopens; never written.
 */
export const LEGACY_SHAPE_ELEMENT = 'slic3rpe:shape'

/** Our own element. Prefixed like the `printstream_model_kind` marker so provenance is obvious. */
export const PRINTSTREAM_SVG_ELEMENT = 'printstream_svg'

/**
 * Where a source SVG lives inside the archive. Studio's detector is
 * `starts_with("3D/") && ends_with(".svg")` (`bbs_3mf.cpp:2520`) and BOTH halves are
 * case-sensitive, so `3d/` or `.SVG` are invisible to it.
 */
export const SVG_ENTRY_PREFIX = '3D/'
export const SVG_ENTRY_SUFFIX = '.svg'

/**
 * Studio's integer shape space: 1e5 units per millimetre (`SCALING_FACTOR`, `libslic3r.h:58`).
 * The `scale` attribute maps that space back to mm.
 */
export const STUDIO_SHAPE_SCALE = 1e-5

/**
 * Millimetres per unitless SVG user unit, as nanosvg resolves them.
 *
 * Studio parses with `units = "mm", dpi = 96` (`NSVGUtils.hpp:68`), so one user unit is 25.4/96 mm,
 * NOT one millimetre. Getting this wrong scales a reopened artwork by 3.78x.
 */
export const SVG_USER_UNITS_PER_MM = 96 / 25.4

/**
 * Studio insets a part's extrusion by this much so a surface-projected shape does not z-fight its
 * host (`SAFE_SURFACE_OFFSET`, `EmbossJob.cpp:37`). It matters here only because it shifts the
 * regenerated mesh's centre, which is what {@link studioShapeFixTransform} compensates for.
 */
const SAFE_SURFACE_OFFSET = 0.015

/**
 * Studio's `<BambuStudioShape/>`, as it sits in a `<part>` inside `Metadata/model_settings.config`.
 *
 * Field names track Studio's `EmbossShape` (`EmbossShape.hpp:133`) rather than its attributes, which
 * are abbreviated. Only what Studio actually serializes is here: `shapes_with_ids`, `text_scales`,
 * `text_cursors` and friends are runtime scratch and are not even in its undo archive.
 */
export interface BambuStudioShape {
  /**
   * Bare source filename for display and Studio's Reload button, or `''`.
   *
   * NOT how the artwork is found: Studio consults a local path only when the archive entry is
   * missing (`NSVGUtils.cpp:126`), and a path from another machine will not resolve anyway.
   */
  filePath: string
  /** Archive entry holding the bytes, e.g. `3D/logo.svg`. Empty means the record cannot reopen. */
  filePathIn3mf: string
  /** Multiplier from Studio's integer shape space to millimetres. See {@link studioShapeScale}. */
  scale: number
  /** Studio's "contains self-intersection" warning flag, round-tripped so its banner is faithful. */
  unhealed: boolean
  /** Extrusion depth in mm. */
  depth: number
  /** Whether the shape is projected onto the host surface rather than extruded flat. */
  useSurface: boolean
  /**
   * Studio's `fix_3mf_tr`: the correction between the mesh as SAVED and the mesh Studio would
   * REGENERATE from the shapes. 12 numbers, column-major 4x3, or null when absent.
   *
   * Consumers apply the INVERSE (`volume.matrix * fix->inverse()`, `EmbossJob.cpp:147`), despite the
   * header comment at `EmbossShape.hpp:153` reading the other way round. Trust the code.
   */
  fixTransform: readonly number[] | null
}

/**
 * Our own record: what the SVG TOOL was set to, so its panel reopens where the user left it.
 *
 * Deliberately does NOT restate anything already persisted elsewhere. The part's `operation` is its
 * `<part>` subtype and its placement is its component transform; duplicating either would create a
 * second source of truth that drifts the first time one is edited by a path that does not know
 * about this record.
 */
export interface SvgPartRecord {
  /** Archive entry holding the source bytes, e.g. `3D/logo.svg`. The record's identity. */
  entryPath: string
  /** Original filename WITH extension, for the panel's label. Studio's `filepath` drops nothing. */
  fileName: string
  /**
   * Which drawn shape this part is: 1-based paint order within the parsed artwork, or 0 when the
   * import was merged into a single part and therefore represents all of them.
   *
   * Paint order, not a stable id: our parser and Studio's enumerate shapes differently (Studio's
   * skipped shapes still consume an index, `NSVGUtils.cpp:29`), so this is only meaningful against
   * the SAME bytes read by the SAME parser, which is exactly the case it is used in.
   */
  pieceIndex: number
  /** Artwork width in mm the user chose. Height follows the file's aspect ratio. */
  widthMm: number
  /** Extrusion depth in mm. */
  thickness: number
  /** Whether a detected backdrop shape was kept. Needed to reproduce the same piece set on reopen. */
  includeBackground: boolean
}

/**
 * The `scale` attribute for artwork our tool sized to `mmPerSourceUnit` millimetres per SVG user
 * unit (`svgGeometry.ts` computes exactly that as `widthMm / parsed.width`).
 *
 * Studio re-parses the SVG itself and gets its OWN integer extents, so this has to undo nanosvg's
 * unit conversion for the artwork to reopen at the size the user picked rather than its natural one.
 *
 * ASSUMES the file's coordinates are unitless user units, which is what a drawing tool emits and
 * what {@link SVG_USER_UNITS_PER_MM} is derived for. A file declaring physical units (`width="50mm"`)
 * resolves differently inside nanosvg and would reopen mis-scaled in Studio; nothing here can detect
 * that without reimplementing `nsvg__scaleToViewbox`. Revisit if that turns up in a real file.
 */
export function studioShapeScale(mmPerSourceUnit: number): number {
  if (!Number.isFinite(mmPerSourceUnit) || mmPerSourceUnit <= 0) return STUDIO_SHAPE_SCALE
  return STUDIO_SHAPE_SCALE * mmPerSourceUnit * SVG_USER_UNITS_PER_MM
}

/**
 * The `transform` (`fix_3mf_tr`) for a mesh we authored CENTRED on z=0.
 *
 * Our extrusion centres its soup about zero (`buildSvgPieceSoups` translates by `-thickness/2`),
 * while the mesh Studio regenerates on edit runs `-SAFE_SURFACE_OFFSET .. depth`, centred half a
 * thickness higher. Writing identity here would be arithmetically honest about our own geometry and
 * still wrong in effect: Studio applies the inverse before regenerating, so the first edit of an
 * un-fixed part jumps it up by `depth/2`. This is the offset that makes the regenerated mesh land
 * where the saved one sat.
 */
export function studioShapeFixTransform(depth: number): number[] {
  const dz = depth / 2 - SAFE_SURFACE_OFFSET
  return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, dz]
}

/**
 * Pick the archive entry for a source file, avoiding names already used in the same archive.
 *
 * Mirrors Studio's own scheme (`Plater.cpp:23048`), including its quirk that the sequence runs
 * `logo.svg`, `logo_2.svg`, `logo_3.svg` with no `_1`, and its `unknown` fallback for a file with no
 * usable name. Matching it matters because an entry Studio does not recognise is one it drops on the
 * next save, taking our re-editability with it.
 */
export function svgArchiveEntryPath(fileName: string, taken: ReadonlySet<string>): string {
  const stem = fileName.replace(/\.[^./\\]*$/, '').replace(/[/\\]/g, '').trim()
  const base = stem.length > 0 ? stem : 'unknown'
  let suffix = 0
  for (;;) {
    const candidate = `${SVG_ENTRY_PREFIX}${base}${suffix === 0 ? '' : `_${suffix + 1}`}${SVG_ENTRY_SUFFIX}`
    if (!taken.has(candidate)) return candidate
    suffix += 1
  }
}

/** Whether an archive entry is a source SVG, by Studio's own case-sensitive test. */
export function isSvgArchiveEntry(entryPath: string): boolean {
  return entryPath.startsWith(SVG_ENTRY_PREFIX) && entryPath.endsWith(SVG_ENTRY_SUFFIX)
}

/**
 * Serialize one `<BambuStudioShape/>`, in Studio's own attribute order.
 *
 * Two attributes are written ONLY when true, as literal `1`, because that is how Studio's reader
 * tests them (`use_surface == 1`, `bbs_3mf.cpp:9823`), so `use_surface="true"` reads as FALSE there.
 * `scale` is always written even at its default: Studio's reader has no fallback for it
 * (`:9814`, constructed positionally at `:9841`), so an absent `scale` is read as 0 and collapses
 * the shape to nothing.
 */
export function serializeBambuStudioShape(shape: BambuStudioShape): string {
  const attributes: Array<[string, string]> = []
  // Studio omits both path attributes together when there is no archive entry, and its writer
  // returns before either is emitted (`bbs_3mf.cpp:9762`). A `filepath` without a `filepath3mf`
  // would name a file only the authoring machine can see.
  if (shape.filePathIn3mf.length > 0) {
    if (shape.filePath.length > 0) attributes.push(['filepath', escapeXmlAttribute(shape.filePath)])
    attributes.push(['filepath3mf', escapeXmlAttribute(shape.filePathIn3mf)])
  }
  attributes.push(['scale', `${shape.scale}`])
  if (shape.unhealed) attributes.push(['unhealed', '1'])
  attributes.push(['depth', `${shape.depth}`])
  if (shape.useSurface) attributes.push(['use_surface', '1'])
  if (shape.fixTransform) attributes.push(['transform', shape.fixTransform.map((n) => `${n}`).join(' ')])
  return `<${BAMBU_SHAPE_ELEMENT} ${attributes.map(([key, value]) => `${key}="${value}"`).join(' ')}/>`
}

/**
 * Parse one `<BambuStudioShape/>` (or the legacy `<slic3rpe:shape/>`, which Studio routes to the
 * same reader).
 *
 * Returns the record even when it names no archive entry, rather than null. Studio produces exactly
 * that shape: its writer emits both path attributes and only THEN discovers it has no bytes to
 * store (`bbs_3mf.cpp:9772`), and its copyright branch writes a record with no paths at all, so a
 * dangling reference is a real state to represent rather than an error. Ask
 * {@link BambuStudioShape.filePathIn3mf} before trying to reopen one.
 *
 * `scale` is NOT defaulted, deliberately: Studio reads a missing one as 0, and reporting the same 0
 * is what lets a caller notice a file that will open collapsed rather than silently papering over it.
 */
export function parseBambuStudioShape(source: string): BambuStudioShape {
  const rawTransform = attribute(source, 'transform')
  const transform = rawTransform
    ? rawTransform.trim().split(/\s+/).map((n) => Number.parseFloat(n))
    : null
  const fixTransform = transform && transform.length === 12 && transform.every((n) => Number.isFinite(n))
    ? transform
    : null

  // Studio coerces an absent-or-zero depth to 10 (`bbs_3mf.cpp:9820`), which also means a genuine
  // `depth="0"` is inexpressible in this format. Mirror it so both tools agree on what a file means.
  const rawDepth = numberAttribute(source, 'depth', 0)
  const depth = Math.abs(rawDepth) < 1e-9 ? 10 : rawDepth

  return {
    filePath: decodeXmlAttributeValue(attribute(source, 'filepath') ?? ''),
    filePathIn3mf: decodeXmlAttributeValue(attribute(source, 'filepath3mf') ?? ''),
    scale: numberAttribute(source, 'scale', 0),
    unhealed: numberAttribute(source, 'unhealed', 0) === 1,
    depth,
    useSurface: numberAttribute(source, 'use_surface', 0) === 1,
    fixTransform
  }
}

/**
 * Read a volume BambuStudio embossed as one of ours, so a file authored there reopens editable here
 * rather than as anonymous solids.
 *
 * Studio makes one volume per artwork, so the result is always a whole-artwork record
 * ({@link SvgPartRecord.pieceIndex} 0). Returns null when the record names no archive entry, since
 * the artwork is re-derived from those bytes and there is nothing to reopen without them, which is
 * a state Studio really does write (`bbs_3mf.cpp:9772`).
 *
 * `widthMm` cannot be recovered and is reported as 0. Studio stores `scale` relative to nanosvg's
 * OWN extents for the file, which are not known until the artwork has been parsed, so resolving a
 * millimetre width here would mean guessing; the reopen path has the bytes and can derive it. Zero
 * is the honest "not known yet", and no caller may treat it as a real width.
 */
export function svgPartRecordFromBambuShape(shape: BambuStudioShape): SvgPartRecord | null {
  if (shape.filePathIn3mf.length === 0) return null
  const fileName = shape.filePath.length > 0
    ? shape.filePath
    : shape.filePathIn3mf.slice(shape.filePathIn3mf.lastIndexOf('/') + 1)
  return {
    entryPath: shape.filePathIn3mf,
    fileName,
    pieceIndex: 0,
    widthMm: 0,
    thickness: shape.depth,
    // Studio has no backdrop concept: it extrudes every shape in the file, so nothing was excluded.
    includeBackground: true
  }
}

/** Serialize one `<printstream_svg/>`. */
export function serializeSvgPartRecord(record: SvgPartRecord): string {
  const attributes: Array<[string, string]> = [
    ['entry', escapeXmlAttribute(record.entryPath)],
    ['file_name', escapeXmlAttribute(record.fileName)],
    ['piece_index', `${record.pieceIndex}`],
    ['width_mm', `${record.widthMm}`],
    ['thickness', `${record.thickness}`],
    ['include_background', record.includeBackground ? '1' : '0']
  ]
  return `<${PRINTSTREAM_SVG_ELEMENT} ${attributes.map(([key, value]) => `${key}="${value}"`).join(' ')}/>`
}

/**
 * Parse one `<printstream_svg/>`. Returns null when it names no archive entry, which is the only
 * field with no sensible default: the panel reopens by re-parsing those bytes, so a record that
 * cannot find them describes a part that is not re-editable however complete the rest of it is.
 */
export function parseSvgPartRecord(source: string): SvgPartRecord | null {
  const entryPath = attribute(source, 'entry')
  if (entryPath == null || entryPath.length === 0) return null
  return {
    entryPath: decodeXmlAttributeValue(entryPath),
    fileName: decodeXmlAttributeValue(attribute(source, 'file_name') ?? ''),
    pieceIndex: Math.trunc(numberAttribute(source, 'piece_index', 0)),
    widthMm: numberAttribute(source, 'width_mm', 0),
    thickness: numberAttribute(source, 'thickness', 0),
    includeBackground: numberAttribute(source, 'include_background', 0) !== 0
  }
}
