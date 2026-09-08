/**
 * The parameter table's data model: every object and volume in the project as one flat, sortable
 * list of rows, each carrying the effective value of the chosen setting columns.
 *
 * This is BambuStudio's `GUI_ObjectTable` read side (`ObjectGridTable::construct_object_configs`),
 * and it is READ-ONLY BY DESIGN. The table exists to answer "which of these forty objects differs,
 * and how", a question that currently costs one dialog per object; editing already works, through
 * the settings dialog and the row controls, and both handle things this module deliberately does
 * not know about -- that per-object overrides live on the borrowed slice controller while per-part
 * overrides live on `EditorState`, that the two have separate undo stacks, that clearing a
 * per-object key must write an explicit `{}` rather than deleting it, and that filament-index
 * values are remapped when materials move. Re-deriving those here would be a second writer for
 * every one of them; Studio has exactly that, and it is where all of its bugs are.
 *
 * Two invariants the rest of the plugin already relies on and this module must not restate:
 *
 * - **An object is not an instance.** Linked copies share one `objectId` and therefore one settings
 *   map, so they collapse into ONE row with a copy count. Emitting a row per instance would show
 *   the same override N times and imply N places to change it.
 * - **Volumes are counted by `instanceVolumeRows`, never by `instance.parts.length`.** An object's
 *   volumes are its baked parts plus this session's added ones plus, where the part list is empty,
 *   its own body. That rule has been got wrong three times in this plugin and always the same way.
 *
 * Counterparts: `parameterTableColumns.ts` decides WHICH settings become columns;
 * `ParameterTableDialog.tsx` renders these rows and routes every edit back to the existing dialogs.
 */
import { processConfigValuesEqual, processSettingsCatalog } from '@printstream/shared'
import {
  addedPartHostId,
  effectiveAddedParts,
  instanceVolumeRows,
  partSlotKey,
  BODY_PART_INDEX,
  type EditorInstance,
  type EditorState
} from './editorModel'
import { partMemberKey, type PartMember } from './selectionModel'

/** A serialized setting value as the config, the 3MF and the wire all carry it. */
export type ParameterSettingValue = string | string[]

/** One cell: what the row's setting resolves to, and whether the row itself is what decided that. */
export interface ParameterTableCell {
  /**
   * The effective serialized value, or null when nothing in the chain supplies one (the preset has
   * not resolved yet, or genuinely does not carry the key). Null renders as "not set" rather than
   * as a blank, because a blank cell and a cell holding an empty string look identical.
   */
  value: ParameterSettingValue | null
  /**
   * This row carries its OWN entry for the key, rather than inheriting it. Note this is about
   * PROVENANCE, not difference: an override whose value equals what would have been inherited is
   * still an override, because it is pinned and will not follow a change to the preset. The table
   * marks those separately via {@link ParameterTableCell.redundant} rather than hiding them.
   */
  overridden: boolean
  /**
   * An override that currently matches what the row would inherit anyway. Worth showing because it
   * is invisible in every other surface and is almost always an accident -- a value nudged and put
   * back, or one copied onto an object it did not need to be on -- and it silently pins that object
   * against a later change to the preset.
   */
  redundant: boolean
}

/** An object row, or one of its volumes. Volumes are indented under the object they belong to. */
export type ParameterTableRowKind = 'object' | 'part'

/**
 * Whether an object's instances will print.
 *
 * Three-valued, and it has to be: printability is PER INSTANCE (`EditorInstance.printable`) while a
 * row collapses every linked copy into one. An object with three copies where the user skipped only
 * the second has no single answer, and reporting whichever instance the walk saw first is an
 * arbitrary one that flips with plate order.
 */
export type ParameterTablePrintability = 'all' | 'none' | 'mixed'

export interface ParameterTableRow {
  /** Stable row identity, unique across the table. */
  key: string
  kind: ParameterTableRowKind
  /** The object's editor-side identity (`addedPartHostId`), which is what every seam keys on. */
  objectId: number
  /** Which volume this row is, or null on an object row. */
  member: PartMember | null
  name: string
  /** Plates the object is placed on, ascending. An object may legitimately appear on several. */
  plateIndexes: number[]
  /** How many instances place this object. 1 for most; >1 means linked copies. */
  copies: number
  /** Whether this object's copies will print. A volume has no printability of its own. */
  printability: ParameterTablePrintability
  /** How many settings this row overrides, across ALL keys, not only the visible columns. */
  overrideCount: number
  cells: Record<string, ParameterTableCell>
}

/** Everything the rows are derived from. */
export interface ParameterTableInput {
  state: EditorState
  /**
   * Per-OBJECT overrides keyed by object id, exactly as the slice controller holds them
   * (`sliceConfig.perObjectSettings.value`). NOT part of `EditorState`: per-object and per-part
   * overrides live in different homes, which is the single most surprising thing about this data.
   */
  objectOverrides: Readonly<Record<string, Readonly<Record<string, ParameterSettingValue>>>>
  /** The project's global process overrides: what an object inherits before its own. */
  globalOverrides: Readonly<Record<string, ParameterSettingValue>>
  /**
   * The resolved process preset, or null while it loads. Null is a real state and renders as
   * "not set" rather than as an error: the grid is still useful without it, because an OVERRIDDEN
   * cell resolves from the override alone and those are the rows anyone came here to find.
   */
  baseConfig: Readonly<Record<string, unknown>> | null
  /** Setting keys to build cells for, in display order. */
  columns: readonly string[]
}

/** Serialized form of a resolved base-config value, or null when it carries nothing usable. */
function baseConfigValue(raw: unknown): ParameterSettingValue | null {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  if (Array.isArray(raw)) return raw.map((entry) => String(entry))
  return null
}

/**
 * Resolve one cell against the inheritance chain, innermost first.
 *
 * The chain is the same one the settings dialog composes as its `baseOverlay`
 * (`{ ...globalOverrides, ...objectOverrides }` for a part, `globalOverrides` for an object), so a
 * value shown here and the baseline the dialog resets to cannot disagree. Building it any other way
 * is how a cell would report a number the dialog then calls unset.
 */
function resolveCell(
  key: string,
  own: Readonly<Record<string, ParameterSettingValue>> | undefined,
  inherited: ReadonlyArray<Readonly<Record<string, ParameterSettingValue>> | undefined>,
  baseConfig: Readonly<Record<string, unknown>> | null
): ParameterTableCell {
  let inheritedValue: ParameterSettingValue | null = null
  for (const layer of inherited) {
    const candidate = layer?.[key]
    if (candidate !== undefined) {
      inheritedValue = candidate
      break
    }
  }
  if (inheritedValue === null) inheritedValue = baseConfigValue(baseConfig?.[key])

  const ownValue = own?.[key]
  if (ownValue === undefined) return { value: inheritedValue, overridden: false, redundant: false }

  // `processConfigValuesEqual` and not `===`: BambuStudio writes one value several ways (a percent
  // with or without its sign, a scalar standing in for a uniform per-extruder array), so string
  // equality would call a redundant override meaningful and vice versa.
  const redundant = inheritedValue !== null
    && processConfigValuesEqual(ownValue, inheritedValue, processSettingsCatalog.options[key])
  return { value: ownValue, overridden: true, redundant }
}

/** The volumes an object lists, in the order the sidebar lists them. Empty when it lists none. */
function volumeMembers(
  state: EditorState,
  instance: EditorInstance
): Array<{ member: PartMember; name: string }> {
  const added = effectiveAddedParts(state, instance)
  const { showRows, showBodyRow } = instanceVolumeRows(instance, added.length)
  if (!showRows) return []

  const members: Array<{ member: PartMember; name: string }> = []
  if (showBodyRow) members.push({ member: { kind: 'body' }, name: instance.name })
  for (const part of instance.parts) {
    // Cut connectors are not volume rows anywhere else either; counting them here would make a cut
    // half read as a multi-part object and list a row per peg.
    if (part.cutConnector) continue
    members.push({ member: { kind: 'baked', partIndex: part.partIndex }, name: part.name ?? `Part ${part.partIndex + 1}` })
  }
  for (const part of added) members.push({ member: { kind: 'added', key: part.key }, name: part.name })
  return members
}

/** Where a volume's own overrides live. The two kinds have different homes; see the module header. */
function volumeOverrides(
  state: EditorState,
  instance: EditorInstance,
  objectId: number,
  member: PartMember
): Readonly<Record<string, ParameterSettingValue>> | undefined {
  if (member.kind === 'added') {
    return effectiveAddedParts(state, instance).find((part) => part.key === member.key)?.settings
  }
  const partIndex = member.kind === 'body' ? BODY_PART_INDEX : member.partIndex
  return state.partProcessOverrides?.[partSlotKey(objectId, partIndex)]
}

/**
 * Build the table's rows: one per object, each followed by its volumes.
 *
 * Objects come out in the project's own order (the order the plates list them), which is the order
 * the sidebar shows and the order the bake writes; sorting is a separate step so the unsorted view
 * matches what the user already has on screen.
 */
export function buildParameterTableRows(input: ParameterTableInput): ParameterTableRow[] {
  const { state, objectOverrides, globalOverrides, baseConfig, columns } = input

  // Collapse instances to objects. A linked copy is another PLACEMENT of one object, and every
  // settings seam keys on the object, so one row per object with a copy count is the honest shape.
  const byObject = new Map<number, {
    instance: EditorInstance
    plates: Set<number>
    copies: number
    // Counted rather than copied from the first instance: printability is per-instance, so the
    // count is the only thing that can distinguish all/none/mixed once the copies collapse.
    printableCopies: number
  }>()
  for (const plate of state.plates) {
    for (const instance of plate.instances) {
      const objectId = addedPartHostId(instance)
      // Null means an import with no identity yet, which can carry no per-object settings at all.
      if (objectId == null) continue
      const existing = byObject.get(objectId)
      if (existing) {
        existing.plates.add(plate.index)
        existing.copies += 1
        if (instance.printable) existing.printableCopies += 1
        continue
      }
      byObject.set(objectId, {
        instance,
        plates: new Set([plate.index]),
        copies: 1,
        printableCopies: instance.printable ? 1 : 0
      })
    }
  }

  const rows: ParameterTableRow[] = []
  for (const [objectId, entry] of byObject) {
    const { instance, plates, copies, printableCopies } = entry
    const printability: ParameterTablePrintability = printableCopies === copies
      ? 'all'
      : printableCopies === 0 ? 'none' : 'mixed'
    const own = objectOverrides[String(objectId)]
    const objectCells: Record<string, ParameterTableCell> = {}
    for (const key of columns) objectCells[key] = resolveCell(key, own, [globalOverrides], baseConfig)

    rows.push({
      key: `object:${objectId}`,
      kind: 'object',
      objectId,
      member: null,
      name: instance.name,
      plateIndexes: [...plates].sort((a, b) => a - b),
      copies,
      printability,
      overrideCount: own ? Object.keys(own).length : 0,
      cells: objectCells
    })

    for (const volume of volumeMembers(state, instance)) {
      const volumeOwn = volumeOverrides(state, instance, objectId, volume.member)
      const cells: Record<string, ParameterTableCell> = {}
      // A volume inherits its OBJECT's overrides before the globals, which is the same chain the
      // part settings dialog overlays. Skipping the object layer would show a part inheriting the
      // preset over an override its own object sets, i.e. a value it will never print at.
      for (const key of columns) cells[key] = resolveCell(key, volumeOwn, [own, globalOverrides], baseConfig)

      rows.push({
        key: `part:${objectId}:${partMemberKey(volume.member)}`,
        kind: 'part',
        objectId,
        member: volume.member,
        name: volume.name,
        plateIndexes: [...plates].sort((a, b) => a - b),
        copies,
        printability,
        overrideCount: volumeOwn ? Object.keys(volumeOwn).length : 0,
        cells
      })
    }
  }
  return rows
}

/**
 * The sort keys that name a FIXED column rather than a setting.
 *
 * Named once so the comparator and the unset-last rule below cannot disagree about which keys are
 * settings, and so the list is not re-allocated inside a comparator that runs O(n log n) times (it
 * was an inline array literal, written out twice on adjacent lines).
 *
 * Its guard in {@link rowIsUnsetFor} is belt-and-braces TODAY, and worth saying so rather than
 * overselling: a fixed key missing from this set would read `cells[key]`, find nothing on any row,
 * and mark them all unset, so the guard never fires and the column still sorts correctly (verified
 * against `plate`). It earns its place only if a fixed column is ever given a key that some rows
 * also carry a cell for, which is exactly the collision nobody would think to look for.
 *
 * `copies` and `overrides` are deliberately NOT here. Nothing renders a sortable header for them
 * (the grid sorts name, plate and the chosen setting columns), so branches for them would be
 * unreachable, and the dead-code rule applies to a case whose only caller does not exist. The
 * question "which objects override something" is answered by the Overridden-only filter instead.
 */
const FIXED_SORT_KEYS = new Set(['name', 'plate'])

export type ParameterTableSortKey = 'name' | 'plate' | string
export type ParameterTableSortDirection = 'asc' | 'desc'

/**
 * Whether a cell carries no answer for its column.
 *
 * ONE definition, shared by the comparator and by the sign rule below, because they disagreed: the
 * comparator treated an EMPTY value as unset (correctly, per `isUnsetProcessValue` in the shared
 * settings module, and `String([])` produces `''` for an empty vector too) while the sign rule
 * tested only `value == null`. So an empty-valued row was ordered last by the comparator and then
 * had that verdict flipped by the descending sign, and it jumped to the TOP -- the exact thing the
 * doc below promises cannot happen. Two predicates for one question is how that survived review.
 */
export function isUnsetCellValue(value: ParameterSettingValue | null | undefined): boolean {
  if (value == null) return true
  // EVERY element, not the joined string: `['', ''].join(',')` is `','`, so a per-extruder value
  // blank on both extruders read as SET. It sorted above genuinely unset rows, and once `cellText`
  // started deferring to this predicate it would have rendered a bare ", " in the cell instead of
  // the em-dash and its "Not set by this project or its preset" tooltip. `['']` happened to work,
  // which is why the single-extruder case hid it.
  if (Array.isArray(value)) return value.every((entry) => entry === '')
  return value === ''
}

/** Compare two object rows for one sort key. Volumes never reach this; they follow their object. */
function compareRows(a: ParameterTableRow, b: ParameterTableRow, key: ParameterTableSortKey): number {
  if (key === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  if (key === 'plate') {
    const left = a.plateIndexes[0] ?? Number.MAX_SAFE_INTEGER
    const right = b.plateIndexes[0] ?? Number.MAX_SAFE_INTEGER
    return left - right
  }
  // A setting column. Numeric where both sides parse as numbers, so 2, 3, 10 does not order as
  // 10, 2, 3; text otherwise, which is what an enum wants.
  const left = a.cells[key]?.value
  const right = b.cells[key]?.value
  const leftUnset = isUnsetCellValue(left)
  const rightUnset = isUnsetCellValue(right)
  // An unset value sorts last in BOTH directions rather than at one end: it is the absence of an
  // answer, not the smallest one, and burying the rows that DO have a value is the opposite of
  // what sorting a column is for. The sign rule below leaves these verdicts alone.
  if (leftUnset && rightUnset) return 0
  if (leftUnset) return 1
  if (rightUnset) return -1
  const leftText = String(left)
  const rightText = String(right)
  const leftNumber = Number(leftText)
  const rightNumber = Number(rightText)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' })
}

/** Whether a row has no answer for the column being sorted. Fixed columns always have one. */
function rowIsUnsetFor(row: ParameterTableRow, key: ParameterTableSortKey): boolean {
  if (FIXED_SORT_KEYS.has(key)) return false
  return isUnsetCellValue(row.cells[key]?.value)
}

/**
 * Sort the OBJECT rows and re-insert each object's volumes behind it.
 *
 * Volumes are never sorted among the objects. BambuStudio does the same (`sort_row_data` reorders
 * object rows and re-appends each object's volume rows), and it is the only coherent option: a
 * volume's row is meaningless away from the object it belongs to, and the indentation that says so
 * would be pointing at whatever row happened to land above it.
 *
 * Unset values sort last in both directions, so a descending sort does not fill the top of the
 * table with rows that have no value for the column being sorted.
 */
export function sortParameterTableRows(
  rows: readonly ParameterTableRow[],
  key: ParameterTableSortKey | null,
  direction: ParameterTableSortDirection
): ParameterTableRow[] {
  if (!key) return [...rows]

  const objects = rows.filter((row) => row.kind === 'object')
  const partsByObject = new Map<number, ParameterTableRow[]>()
  for (const row of rows) {
    if (row.kind !== 'part') continue
    const existing = partsByObject.get(row.objectId)
    if (existing) existing.push(row)
    else partsByObject.set(row.objectId, [row])
  }

  const sign = direction === 'asc' ? 1 : -1
  const sorted = [...objects].sort((a, b) => {
    const result = compareRows(a, b, key)
    // Unset-last is absolute, so it must not be flipped by the direction. `compareRows` has already
    // decided those cases; only a genuine comparison takes the sign.
    if (rowIsUnsetFor(a, key) !== rowIsUnsetFor(b, key)) return result
    return result * sign
  })

  const out: ParameterTableRow[] = []
  for (const row of sorted) {
    out.push(row)
    const parts = partsByObject.get(row.objectId)
    if (parts) out.push(...parts)
  }
  return out
}

/**
 * Rows whose name matches a query, keeping each surviving volume's object row above it.
 *
 * A volume matching on its own would otherwise appear with no parent, and an indented row under
 * nothing reads as a top-level object with a strange name. BambuStudio has no search here at all
 * (its box is commented out), so this has no behaviour to mirror.
 */
export function filterParameterTableRows(
  rows: readonly ParameterTableRow[],
  query: string
): ParameterTableRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]

  const keptObjects = new Set<number>()
  for (const row of rows) {
    if (row.name.toLowerCase().includes(needle)) keptObjects.add(row.objectId)
  }
  return rows.filter((row) => {
    if (!keptObjects.has(row.objectId)) return false
    // An object row survives when anything in its group matched; a volume row only on its own name,
    // or searching an object's name would list every volume it has.
    return row.kind === 'object' || row.name.toLowerCase().includes(needle)
  })
}

/** Rows carrying at least one override, keeping each surviving volume's object row above it. */
export function filterOverriddenRows(rows: readonly ParameterTableRow[]): ParameterTableRow[] {
  const keptObjects = new Set<number>()
  for (const row of rows) {
    if (row.overrideCount > 0) keptObjects.add(row.objectId)
  }
  return rows.filter((row) => {
    if (!keptObjects.has(row.objectId)) return false
    return row.kind === 'object' || row.overrideCount > 0
  })
}
