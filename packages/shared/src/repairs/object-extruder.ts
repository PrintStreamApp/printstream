/**
 * The invariant that an object whose parts carry `extruder` metadata also carries the OBJECT-level
 * entry in `model_settings.config`.
 *
 * OWNS detecting and repairing objects saved with a part-level material binding only. For an
 * INLINE-MESH object (its geometry in the root model, one `<part>` reusing the object's own id —
 * the shape our bake used to write for replaced/imported objects) the BambuStudio CLI does not
 * honor the part-level entry and slices the object with filament 1 whatever its parts say.
 * A/B-proven on a real project (CHM - H2): plate objects assigned material 2 sliced as PLA
 * filament 1, and the identical file with the object-level metadata added sliced as PETG
 * filament 2. Desktop BambuStudio writes the extruder at BOTH levels; the bake now does too —
 * this module exists for the files already saved.
 *
 * In the COMPONENTS layout the CLI binds part-level extruders fine (measured: a mixed-material
 * components object with no object-level entry sliced each part with its assigned filament). That
 * is what makes the disagreeing-parts case derivable: an object with more than one `<part>` is
 * necessarily components-layout (3MF objects are mesh XOR components), so when EVERY carrying
 * part has its own entry the object-level slot is inert for the engine — every volume overrides
 * it — and writing the first carrying part's slot merely restores the BambuStudio-shaped document.
 * The one genuinely AMBIGUOUS shape is mixed coverage: a carrying part with no entry of its own
 * inherits the object slot, so writing a sibling's value would change what that part prints with.
 * Those objects are reported, never written; giving the uncovered parts a material in the editor
 * is the remedy (after which the next repair derives cleanly).
 *
 * Detection and repair share the helpers below with the bake's own writers
 * (`setObjectLevelExtruderMetadata`, `sharedCarryingPartExtruderOfBlock`), so a file can never be
 * flagged by one rule and rewritten by another.
 *
 * See `repairs/index.ts` for the contract every repairable defect shares.
 */
import { threeMfPartSubtypeCarriesFilament } from '../three-mf-part-subtype.js'

/** An affected object, named so a surface can point the user at it (ids are invisible in the UI). */
export interface ObjectExtruderSubject {
  objectId: number
  name: string | null
}

export interface ObjectExtruderInspection {
  /** True when at least one object carries part-level extruders but no object-level entry. */
  inconsistent: boolean
  /** Affected objects with a derivable object-level slot — repairable. */
  repairable: ObjectExtruderSubject[]
  /** Affected objects with mixed part coverage — left alone rather than guessed. */
  ambiguous: ObjectExtruderSubject[]
}

/**
 * Rewrite (or insert) an object's OBJECT-level `extruder` metadata. Operates on the object's head
 * (the metadata before its first `<part>`, which is where both BambuStudio and our writers put
 * object metadata) so a part's own `extruder` is never mistaken for the object's. Returns the
 * block unchanged when it has no head metadata to anchor on.
 */
export function setObjectLevelExtruderMetadata(objectBlock: string, extruder: number): string {
  const firstPart = objectBlock.search(/<part\b/)
  const head = firstPart >= 0 ? objectBlock.slice(0, firstPart) : objectBlock
  const rest = firstPart >= 0 ? objectBlock.slice(firstPart) : ''
  const metadata = `<metadata key="extruder" value="${extruder}"/>`
  if (/<metadata\s+key="extruder"\s+value="[^"]*"\s*\/>/.test(head)) {
    return head.replace(/<metadata\s+key="extruder"\s+value="[^"]*"\s*\/>/, metadata) + rest
  }
  const lastMetadata = [...head.matchAll(/[ \t]*<metadata\b[^>]*\/>/g)].at(-1)
  if (!lastMetadata) return objectBlock
  const insertAt = lastMetadata.index + lastMetadata[0].length
  const indent = lastMetadata[0].match(/^[ \t]*/)?.[0] ?? '    '
  return `${head.slice(0, insertAt)}\n${indent}${metadata}${head.slice(insertAt)}${rest}`
}

/**
 * The one extruder every filament-carrying part of this object block sits on, or null when it is
 * not derivable: parts disagree, any carries a non-positive value, or any carrying part has NO
 * entry of its own — such a part INHERITS the object's slot, so writing the object entry from its
 * siblings would silently change what that part prints with. Helper volumes (blockers/enforcers/
 * negative parts) are excluded — their extruder is meaningless and Studio writes 0 there.
 */
export function sharedCarryingPartExtruderOfBlock(objectBlock: string): number | null {
  const extruders = new Set<number>()
  let carryingParts = 0
  for (const [partBlock, attrs] of objectBlock.matchAll(/<part\b([^>]*)>[\s\S]*?<\/part>/g)) {
    const subtype = (attrs ?? '').match(/\bsubtype="([^"]*)"/)?.[1] ?? null
    if (!threeMfPartSubtypeCarriesFilament(subtype)) continue
    carryingParts += 1
    const value = partBlock.match(/<metadata\s+key="extruder"\s+value="(\d+)"\s*\/>/)?.[1]
    const extruder = Number.parseInt(value ?? '', 10)
    if (!Number.isInteger(extruder) || extruder < 1) return null
    extruders.add(extruder)
  }
  return carryingParts > 0 && extruders.size === 1 ? [...extruders][0]! : null
}

/** Whether the block's head (before any `<part>`) declares an object-level extruder. */
function hasObjectLevelExtruder(objectBlock: string): boolean {
  const firstPart = objectBlock.search(/<part\b/)
  const head = firstPart >= 0 ? objectBlock.slice(0, firstPart) : objectBlock
  return /<metadata\s+key="extruder"\s+value="[^"]*"\s*\/>/.test(head)
}

/**
 * The object-level slot derivable from this block's filament-carrying parts:
 * - a number when every carrying part declares an entry (their shared slot, or — parts
 *   disagreeing — the FIRST part's: more than one part means components layout, where each
 *   volume's own entry binds, so the object slot is inert for the engine and only restores the
 *   BambuStudio document shape);
 * - 'ambiguous' when coverage is mixed (an uncovered carrying part inherits the object slot, so
 *   writing a sibling's value would change what it prints with);
 * - null when nothing claims a material (no carrying part has an entry).
 */
function derivableObjectExtruder(objectBlock: string): number | 'ambiguous' | null {
  const covered: number[] = []
  let uncovered = 0
  for (const [partBlock, attrs] of objectBlock.matchAll(/<part\b([^>]*)>[\s\S]*?<\/part>/g)) {
    const subtype = (attrs ?? '').match(/\bsubtype="([^"]*)"/)?.[1] ?? null
    if (!threeMfPartSubtypeCarriesFilament(subtype)) continue
    const value = partBlock.match(/<metadata\s+key="extruder"\s+value="(\d+)"\s*\/>/)?.[1]
    const extruder = Number.parseInt(value ?? '', 10)
    if (Number.isInteger(extruder) && extruder >= 1) covered.push(extruder)
    else uncovered += 1
  }
  if (covered.length === 0) return null
  if (uncovered > 0) return 'ambiguous'
  return covered[0]!
}

/** The object's display name from its head metadata, for pointing a user at it. */
function objectNameOfBlock(objectBlock: string): string | null {
  const firstPart = objectBlock.search(/<part\b/)
  const head = firstPart >= 0 ? objectBlock.slice(0, firstPart) : objectBlock
  return head.match(/<metadata\s+key="name"\s+value="([^"]*)"\s*\/>/)?.[1] ?? null
}

function objectBlocks(modelSettingsXml: string): Array<{ objectId: number; block: string }> {
  const out: Array<{ objectId: number; block: string }> = []
  for (const [block, attrs] of modelSettingsXml.matchAll(/<object\b([^>]*)>[\s\S]*?<\/object>/g)) {
    const objectId = Number.parseInt((attrs ?? '').match(/\bid="(\d+)"/)?.[1] ?? '', 10)
    if (Number.isInteger(objectId)) out.push({ objectId, block })
  }
  return out
}

/**
 * Inspect a `model_settings.config` document for objects missing their object-level extruder.
 *
 * Returns null when there is nothing to judge — no document, or one with no `<object>` blocks at
 * all (a sliced output's plate-only model_settings, a scaffold). An object whose head DOES declare
 * an extruder is never flagged, whatever its parts say: object-level plus differing part-level
 * entries is a legitimate BambuStudio shape (one volume printed in another material).
 */
export function inspectModelSettingsObjectExtruders(
  modelSettingsXml: string | null | undefined
): ObjectExtruderInspection | null {
  if (!modelSettingsXml) return null
  const blocks = objectBlocks(modelSettingsXml)
  if (blocks.length === 0) return null
  const repairable: ObjectExtruderSubject[] = []
  const ambiguous: ObjectExtruderSubject[] = []
  for (const { objectId, block } of blocks) {
    if (hasObjectLevelExtruder(block)) continue
    const derived = derivableObjectExtruder(block)
    if (derived === null) continue
    const subject = { objectId, name: objectNameOfBlock(block) }
    if (derived === 'ambiguous') ambiguous.push(subject)
    else repairable.push(subject)
  }
  return {
    inconsistent: repairable.length > 0 || ambiguous.length > 0,
    repairable,
    ambiguous
  }
}

export interface RepairedObjectExtruders {
  xml: string
  /** Objects given an object-level entry, with the slot written. */
  repaired: Array<ObjectExtruderSubject & { extruder: number }>
  /** Objects left alone because their part coverage is mixed; surfaced so the repair is honestly partial. */
  ambiguous: ObjectExtruderSubject[]
}

/**
 * Write the missing object-level extruder for every repairable object, from its parts (see
 * {@link derivableObjectExtruder} for the rule). Ambiguous objects are reported, never written.
 */
export function repairModelSettingsObjectExtruders(modelSettingsXml: string): RepairedObjectExtruders {
  const repaired: Array<ObjectExtruderSubject & { extruder: number }> = []
  const ambiguous: ObjectExtruderSubject[] = []
  const xml = modelSettingsXml.replace(/<object\b([^>]*)>[\s\S]*?<\/object>/g, (block, attrs: string) => {
    const objectId = Number.parseInt((attrs ?? '').match(/\bid="(\d+)"/)?.[1] ?? '', 10)
    if (!Number.isInteger(objectId)) return block
    if (hasObjectLevelExtruder(block)) return block
    const derived = derivableObjectExtruder(block)
    if (derived === null) return block
    const subject = { objectId, name: objectNameOfBlock(block) }
    if (derived === 'ambiguous') {
      ambiguous.push(subject)
      return block
    }
    repaired.push({ ...subject, extruder: derived })
    return setObjectLevelExtruderMetadata(block, derived)
  })
  return { xml, repaired, ambiguous }
}
