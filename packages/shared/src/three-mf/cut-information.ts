/**
 * `Metadata/cut_information.xml`: what BambuStudio needs to recognise two objects as the halves of
 * one cut, and which of their volumes are connectors.
 *
 * OWNS the write side. The read-through side -- keeping a file we did not author in step when the
 * object or volume order changes -- is `object-ordinal-sidecars.ts`, and the two must agree about
 * the ordinal spaces, so read its header before changing anything here.
 *
 * **Nothing about the print depends on this file.** The connector geometry is in the model, its
 * volume type is in `model_settings.config`, and the tolerance is already baked into the vertices,
 * so a cut prints identically without it. What it buys is that BambuStudio RECOGNISES the result:
 * the cut badge on the object row, "delete all connectors", and the lock that stops one half of a
 * cut being scaled non-uniformly and no longer fitting the other. Absent, the halves reopen as
 * ordinary objects and the connectors as ordinary solids.
 *
 * ## What we can honestly say, and what we cannot
 *
 * A `<connector>` names a VOLUME. Our cut DRILLS its holes into the half's geometry rather than
 * leaving a negative volume for the slicer to resolve, so on the hole side there is frequently no
 * volume to point at -- for a dowel, whose every side is a hole, there is none on either half. Those
 * connectors are therefore absent from the list rather than invented, and `connectors_cnt` carries
 * the real count so the two halves still agree with each other. A record that lies is worse than one
 * that is absent: pointing a `<connector>` at a volume that is not one makes BambuStudio treat
 * ordinary geometry as a connector and offer to delete it.
 *
 * Two more limits worth stating rather than discovering. Studio's `radius`/`height` are scale
 * factors on a UNIT mesh, while ours are millimetres baked into the vertices at identity; we record
 * the true millimetres, which is what its readout wants, but re-cutting in Studio would compute
 * tolerance against them wrongly. And `style`/`shape` have nowhere to go -- `ModelVolume::CutInfo`
 * keeps only the type -- so a frustum hexagon reopens described as a plain one.
 *
 * ## Rules the format imposes
 *
 * - **Write every attribute.** The reader takes `radius` and `height` with a default and the other
 *   six with none, and `pt::ptree::get` THROWS on a missing one. Nothing catches it between
 *   `_extract_cut_information_from_archive` and `load_model`, so one absent attribute does not
 *   degrade the cut, it fails the whole project load.
 * - **`<object id>` is a 1-based ordinal over the placed root objects in BUILD-ITEM order**, not a
 *   3MF object id. Same space as the other three ordinal sidecars; `parseRootModelObjectIdOrder` is
 *   the one definition of it.
 * - **`<connector volume_id>` is a 0-based index into the object's whole volume list**, which is
 *   why it is resolved from the FINAL model document here rather than predicted: several passes
 *   append, reorder and remove components, and the only reliable answer is what got written.
 * - **`connectors_cnt` is not the length of the list below it.** BambuStudio compares it, the id and
 *   the check sum together to decide two objects came from the same cut, so it must match across the
 *   group even where their connector lists differ.
 *
 * Counterpart: `bake.ts` emits this, and `apps/web/src/plugins/model-studio/lib/cutConnectors.ts`
 * builds the connectors it describes.
 */
import { parseRootModelObjectIdOrder } from './scene-parser.js'

/** The archive entry BambuStudio reads this from (`bbs_3mf.cpp:190`). */
export const CUT_INFORMATION_ENTRY = 'Metadata/cut_information.xml'

/**
 * `CutConnectorType` as BambuStudio serializes it (`Model.hpp:249`). Thread is deliberately not
 * ported, so 3 never appears; the numbers are a persisted wire format and must not be renumbered.
 */
export const CUT_CONNECTOR_TYPE_CODES = { plug: 0, dowel: 1, snap: 2 } as const

export type CutConnectorTypeName = keyof typeof CUT_CONNECTOR_TYPE_CODES

/** One connector that still EXISTS as a volume, and so can be named in the file. */
export interface CutInformationConnector {
  /** Baked id of the object holding the volume. */
  objectId: number
  /** The mesh object its `<component>` references, which is how its volume ordinal is found. */
  componentObjectId: number
  type: CutConnectorTypeName
  /** Millimetres. See the header for how this differs from Studio's unit-mesh scale factor. */
  radius: number
  height: number
  radiusTolerance: number
  heightTolerance: number
}

/** Everything one cut produced, which BambuStudio treats as a group. */
export interface CutInformationGroup {
  /**
   * Every object the cut made: both halves, plus one per dowel pin. This is what `check_sum`
   * reports, and Studio disables non-uniform scaling for a group it can never fully select, so a
   * count larger than the objects actually written is a permanent, invisible restriction.
   */
  objectIds: readonly number[]
  /**
   * Connectors the cut PLACED, including any whose hole was drilled into the mesh and which
   * therefore cannot appear below. Shared across the group; see the header.
   */
  connectorCount: number
  connectors: readonly CutInformationConnector[]
}

/** Escape nothing: every value here is a number. Kept as a function so that stays deliberate. */
function num(value: number): string {
  // Trim float noise without losing the precision a tolerance needs. BambuStudio writes up to 9
  // significant digits and parses with `get<float>`, so anything round-trippable is fine.
  return String(Number(value.toFixed(6)))
}

/**
 * The volume ordinal of a component within its object, read out of the model document.
 *
 * Returns null when the object has no `<components>` (a plain inline-mesh object cannot hold a
 * connector) or the component is not among them, which is the honest answer for a connector whose
 * volume some later pass removed.
 */
function volumeOrdinalOf(modelXml: string, objectId: number, componentObjectId: number): number | null {
  const object = modelXml.match(new RegExp(`<object\\b[^>]*\\bid="${objectId}"[^>]*>([\\s\\S]*?)</object>`))
  if (!object) return null
  const components = [...object[1]!.matchAll(/<component\b[^>]*\bobjectid="(\d+)"/g)]
  const ordinal = components.findIndex((match) => Number(match[1]) === componentObjectId)
  return ordinal >= 0 ? ordinal : null
}

/** Highest `cut_id` already in a document, so a new group cannot collide with one Studio wrote. */
function highestCutId(xml: string): number {
  let highest = 0
  for (const match of xml.matchAll(/<cut_id\b[^>]*\bid="(\d+)"/g)) {
    highest = Math.max(highest, Number(match[1]) || 0)
  }
  return highest
}

/**
 * Author the entry for a save that made cuts, keeping whatever the base file already recorded.
 *
 * MERGES rather than replaces, which is the one way this differs from the other authored sidecars.
 * Height ranges and brim ears are wholly editor-owned, so the editor's state IS the truth and a save
 * can emit the complete set. Cut information is not: a project may already carry groups made in
 * BambuStudio for objects this session never touched, and replacing the file would silently strip
 * them.
 *
 * It APPENDS without checking whether an ordinal is already described, and what makes that safe sits
 * in the caller rather than here. A group's objects are always freshly imported ones, and the bake
 * gives an import an id no base object holds (`bake-documents.ts` allocates upward from the base's
 * highest); `baseXml` has already been remapped by object IDENTITY, which DROPS the block of any base
 * object this save does not write (`object-ordinal-sidecars.ts`). So an inherited block names a
 * surviving base object, an authored one names a new object, and no two objects share a position in
 * the build order. That is what keeps a re-bake of one edit idempotent, which matters because the
 * editor keeps a cut's halves import-backed and re-emits the group on every save of the session
 * (pinned by `bake.objectOrdinalSidecars.test.ts`). The one input outside the rule is a base whose
 * build order cannot be READ at all: the remap leaves such a file untouched rather than guessing, so
 * a stale block there could hold an ordinal this save also authors. Deduping here would resolve that
 * by keeping the stale block over the record describing the objects actually written, which is the
 * wrong way round, so it is deliberately not done.
 *
 * `baseXml` is the base file's entry AFTER the ordinal remap, or empty when it had none. Returns
 * the whole document, or `null` when there is nothing at all to write.
 */
export function serializeCutInformation(
  groups: readonly CutInformationGroup[],
  modelXml: string,
  baseXml = ''
): string | null {
  const ordinalByObjectId = new Map<number, number>()
  parseRootModelObjectIdOrder(modelXml).forEach((id, index) => {
    if (!ordinalByObjectId.has(id)) ordinalByObjectId.set(id, index + 1)
  })

  const inherited = [...baseXml.matchAll(/[ \t]*<object\b[\s\S]*?<\/object>\n?/g)].map((match) => match[0]!.trimEnd())
  let nextCutId = highestCutId(baseXml)
  const authored: string[] = []

  for (const group of groups) {
    // An object that never made it into the document (deleted in the same save) takes no block, and
    // the check sum follows the survivors: reporting more objects than exist is what permanently
    // disables non-uniform scaling for the group.
    const placed = group.objectIds.filter((objectId) => ordinalByObjectId.has(objectId))
    // One half alone is not a cut. Studio declines to record one for the same reason
    // (`update_object_cut_id` returns early unless it kept both halves).
    if (placed.length < 2) continue
    const cutId = ++nextCutId

    for (const objectId of placed) {
      const lines = [
        ` <object id="${ordinalByObjectId.get(objectId)}">`,
        `  <cut_id id="${cutId}" check_sum="${placed.length}" connectors_cnt="${group.connectorCount}"/>`
      ]
      const connectors = group.connectors
        .filter((connector) => connector.objectId === objectId)
        .map((connector) => ({ connector, volumeId: volumeOrdinalOf(modelXml, objectId, connector.componentObjectId) }))
        .filter((entry): entry is { connector: CutInformationConnector; volumeId: number } => entry.volumeId !== null)
      if (connectors.length > 0) {
        lines.push('  <connectors>')
        for (const { connector, volumeId } of connectors) {
          lines.push(
            `   <connector volume_id="${volumeId}" type="${CUT_CONNECTOR_TYPE_CODES[connector.type]}"`
            + ` radius="${num(connector.radius)}" height="${num(connector.height)}"`
            + ` r_tolerance="${num(connector.radiusTolerance)}" h_tolerance="${num(connector.heightTolerance)}"/>`
          )
        }
        lines.push('  </connectors>')
      }
      lines.push(' </object>')
      authored.push(lines.join('\n'))
    }
  }

  const blocks = [...inherited, ...authored]
  if (blocks.length === 0) return null
  return `<?xml version="1.0" encoding="utf-8"?>\n<objects>\n${blocks.join('\n')}\n</objects>\n`
}

/** What one object's `<object>` block says: its cut group, and which volume ordinals are connectors. */
export interface ParsedCutObject {
  /** The cut group id. Two objects sharing one are halves of the same cut. */
  cutId: number
  /** 0-based volume ordinals this object's connectors occupy. */
  connectorVolumeIds: Set<number>
}

/**
 * Read the entry back, keyed by the 1-based BUILD ORDINAL its `<object id>` names.
 *
 * The counterpart to {@link serializeCutInformation}, and the hop without which the whole record is
 * write-only: the editor would know which volumes are connectors for the session that MADE them and
 * for no other, so a saved project would reopen with its halves as ordinary objects. That is the
 * failure the text tool shipped with -- a record written correctly over six hops and read by nobody
 * on the seventh -- and it is invisible, because nothing throws and the geometry is all still there.
 *
 * Tolerant where BambuStudio's own reader is strict. Its `get` throws on a missing attribute and
 * takes the whole project load down with it; ours is reading a file that may have been written by
 * anything, and a cut it cannot describe is better skipped than fatal. A block with an unreadable
 * ordinal or cut id is dropped, and a connector with an unreadable `volume_id` is ignored while its
 * siblings are kept.
 *
 * `cut_id="0"` means NOT CUT (`ObjectID::valid()` is `id != 0`) and is skipped, which matters
 * because BambuStudio writes a block for every object whether it was cut or not.
 */
export function parseCutInformation(xml: string | null | undefined): Map<number, ParsedCutObject> {
  const byOrdinal = new Map<number, ParsedCutObject>()
  if (!xml) return byOrdinal
  for (const block of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const ordinal = Number.parseInt(block[1]!.match(/\bid="(\d+)"/)?.[1] ?? '', 10)
    if (!Number.isInteger(ordinal) || ordinal < 1) continue
    const body = block[2]!
    const cutId = Number.parseInt(body.match(/<cut_id\b[^>]*\bid="(\d+)"/)?.[1] ?? '', 10)
    if (!Number.isInteger(cutId) || cutId === 0) continue
    const connectorVolumeIds = new Set<number>()
    for (const connector of body.matchAll(/<connector\b[^>]*\bvolume_id="(\d+)"/g)) {
      const volumeId = Number.parseInt(connector[1]!, 10)
      if (Number.isInteger(volumeId)) connectorVolumeIds.add(volumeId)
    }
    byOrdinal.set(ordinal, { cutId, connectorVolumeIds })
  }
  return byOrdinal
}
