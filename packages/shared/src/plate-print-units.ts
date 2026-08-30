/**
 * The units a prepare-print object picker offers, expanded from a plate's objects.
 *
 * Owns the rule that a printable unit is an INSTANCE, not an object. A 3MF plate records one
 * `<object>` per distinct model and one `<model_instance>` per placement of it, and Bambu's
 * skip protocol keys on the per-placement `identify_id` (`skip_objects` / `s_obj`), so a plate
 * holding eight copies of three models has eight things a user can skip, not three. The plates
 * index already carries every copy's handle in `ThreeMfPlateObject.identifyIds`; this module is
 * what stops a picker collapsing them back down, which is what made a duplicated or linked-copy
 * plate show "only some of" its models and made deselecting one copy silently drop all of them.
 *
 * Counterpart: `plateSkipIdentifyIdsFromIndex` in `apps/api/src/lib/three-mf-output.ts` resolves
 * the selection produced here back to firmware handles, against the same index the picker showed.
 *
 * The two index derivations reach this with DIFFERENT shapes, which is why numbering is computed
 * over the finished list rather than per object. A model_settings-derived plate (a library file)
 * gives one object carrying N `identifyIds`; a slice_info-derived one (printer storage, and any
 * gcode-only export) gives N objects that each carry a single handle and repeat the same name.
 * Numbering per object would leave the second case as N identical unlabelled rows, so the same
 * plate would read differently depending on where it was printed from.
 */
import type { ThreeMfPlateObject } from './printer-contracts.js'

/** One row in a print picker: a single placement of an object on the plate. */
export interface PlatePrintUnit {
  /** Stable identity for React keys and for the caller's deselected set. */
  key: string
  /** The model this placement is of; several units may share it when the object has copies. */
  objectId: number
  /** This placement's firmware skip handle, or null when the file records none for the object. */
  identifyId: number | null
  /** Row label: the object's name, numbered when the plate holds more than one of that name. */
  label: string
  /**
   * Whether this row can actually be excluded from a print.
   *
   * False only for an object the file gives no `identify_id` for. Firmware keys skipping on that
   * handle alone, so there is nothing to send; the row is still LISTED (the plate really does hold
   * it, and hiding it would make the "n of m will print" count lie) but a picker must not let it be
   * deselected. Offering it would produce a selection the server can only reject, which is a
   * dispatch that fails with no way for the user to see why.
   */
  skippable: boolean
}

/**
 * Expand a plate's objects into one unit per placement, in plate order.
 *
 * A name is numbered only when the plate holds several of it, so an ordinary single-copy plate
 * reads exactly as it did. Two genuinely distinct objects that happen to share a name are numbered
 * too: they are indistinguishable in the list otherwise, and the user's question ("which one am I
 * skipping?") is the same either way.
 */
export function platePrintUnits(objects: ReadonlyArray<ThreeMfPlateObject>): PlatePrintUnit[] {
  const units: PlatePrintUnit[] = []
  for (const object of objects) {
    if (object.identifyIds.length === 0) {
      units.push({ key: `object:${object.id}`, objectId: object.id, identifyId: null, label: object.name, skippable: false })
      continue
    }
    for (const identifyId of object.identifyIds) {
      units.push({ key: `instance:${identifyId}`, objectId: object.id, identifyId, label: object.name, skippable: true })
    }
  }

  const nameCounts = new Map<string, number>()
  for (const unit of units) nameCounts.set(unit.label, (nameCounts.get(unit.label) ?? 0) + 1)
  const seen = new Map<string, number>()
  return units.map((unit) => {
    if ((nameCounts.get(unit.label) ?? 0) < 2) return unit
    const ordinal = (seen.get(unit.label) ?? 0) + 1
    seen.set(unit.label, ordinal)
    return { ...unit, label: `${unit.label} #${ordinal}` }
  })
}

/** A deselection, in the id space the print request carries it in. */
export interface PlatePrintSkipSelection {
  /** Individual placements to skip, by `identify_id`. */
  skipInstances: number[]
}

/**
 * Which units a stored selection deselects: the reverse of {@link platePrintSkipSelection}.
 *
 * Needed by the queue dialog, which persists its selection on the item and has to re-check the
 * right boxes when the item is reopened. Resolved against the units of the plate CURRENTLY shown,
 * so a selection stored for a different plate matches nothing rather than checking whichever rows
 * happen to share a number.
 *
 * `skipObjects` is read as well as `skipInstances` because items queued before instance
 * granularity existed named whole models, and reopening one of those must show every copy checked
 * rather than an empty selection.
 */
export function platePrintDeselectedKeys(
  units: ReadonlyArray<PlatePrintUnit>,
  selection: { skipObjects?: number[]; skipInstances?: number[] } | null | undefined
): Set<string> {
  const objects = new Set(selection?.skipObjects ?? [])
  const instances = new Set(selection?.skipInstances ?? [])
  const keys = new Set<string>()
  for (const unit of units) {
    const skipped = unit.identifyId == null
      ? objects.has(unit.objectId)
      : instances.has(unit.identifyId) || objects.has(unit.objectId)
    if (skipped) keys.add(unit.key)
  }
  return keys
}

/**
 * Turn a set of deselected unit keys into the request's skip field.
 *
 * Only `skipInstances` is produced. Every selectable unit has a handle by construction (see
 * `PlatePrintUnit.skippable`), and `identify_id` is the only id space firmware accepts, so there is
 * nothing a whole-object selection could add: `skipObjects` remains on the wire purely for
 * selections persisted by older clients, which the server still resolves.
 *
 * Unskippable units are ignored even if a caller passes their key, so a stale key cannot turn into
 * a request the server is guaranteed to reject.
 */
export function platePrintSkipSelection(
  units: ReadonlyArray<PlatePrintUnit>,
  deselectedKeys: ReadonlySet<string>
): PlatePrintSkipSelection {
  const skipInstances: number[] = []
  for (const unit of units) {
    if (!deselectedKeys.has(unit.key) || unit.identifyId == null) continue
    if (!skipInstances.includes(unit.identifyId)) skipInstances.push(unit.identifyId)
  }
  return { skipInstances }
}
