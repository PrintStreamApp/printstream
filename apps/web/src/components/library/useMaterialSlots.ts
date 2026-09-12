/**
 * The MATERIAL SLOTS core of the slice-settings controller: the one implementation of the
 * per-slot material state both hosts share (audit invariant I9: the workspace `SliceFileModal`
 * and the public editor's `useLocalSliceSettingsController` must be one controller core
 * parameterized by capability, never two encodings).
 *
 * Owns, per project filament slot (keyed by session `projectFilamentId`):
 * - the picked material option / colour / toolhead / type filter / per-material tune overrides,
 * - the session's own material LIST once it diverges from the file (Bambu-style add/remove), held
 *   as `sessionSlots` rather than as a delta over the file: see {@link SessionFilamentSlot} for
 *   why, and `onProjectSaved` for how it folds back once a save persists the divergence,
 * - the emitted artefacts: `desiredFilaments` (the full ordered list a save/slice bakes) and
 *   `filamentMappingResult` (the per-slot slicer mappings + unresolved gate),
 * - the reconciliation effects that keep picks valid across catalogue/machine changes, and the
 *   post-save rebase that moves the per-slot keyed state onto the refetched base (see
 *   `onProjectSaved`): the session→saved id renumbering's controller-side half.
 *
 * The host supplies everything catalogue/machine-derived (profiles, options, machine profile) and
 * a callback for the one cross-domain write (remapping filament-INDEX references in process /
 * per-object overrides when a slot is removed) so this module never reaches into process state.
 *
 * Counterparts: `SliceFileModal.tsx` (workspace host: printers, dispatch, plate narrowing),
 * `useLocalSliceSettingsController.ts` (public host: browser presets, anonymous resolvers).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryFile, MixedFilamentConfig, SceneEditFilament, ThreeMfIndex } from '@printstream/shared'
import type { SlicingPresetSummary } from '@printstream/shared'
import {
  buildFilamentMappings,
  buildInitialFilamentColorSelection,
  buildInitialFilamentMaterialOptionSelection,
  buildInitialFilamentToolheadSelection,
  buildSliceDialogProjectFilaments,
  repointMaterialOptionToCompatibleAlias,
  normalizeSliceFilamentColor,
  parseSliceToolheadNozzleId,
  type SliceMaterialOption
} from '../../lib/slicingPresetMatching'

/** One project filament slot as the dialogs/panels see it (base slot or session-added slot). */
export type SliceProjectFilament = ReturnType<typeof buildSliceDialogProjectFilaments>[number]

/**
 * One slot of the session's OWN material list, held once the session diverges from the file.
 *
 * The session used to be a delta over the file (`removed` ids + `added` slots), which made the list
 * unrepresentable whenever the file moved underneath it: after a save the base is the NEW list, so
 * replaying "remove slot 2" deletes whatever slot 2 has since become, and an undo could not put a
 * removed material back at all. Holding the list itself removes the moving frame of reference,
 * a captured list is self-describing, so restoring one is exact.
 */
export interface SessionFilamentSlot {
  projectFilamentId: number
  /**
   * 0-based index in the BASE list whose slicer settings this slot clones at bake time, or null
   * for a slot the file has no counterpart for (a fresh add, or one restored by undoing past the
   * save that removed it). Null authors the slot from its chosen preset instead, which is what
   * adding a material by hand already does.
   */
  sourceIndex: number | null
  label: string
  color: string | null
  nozzleId: number | null
  /**
   * Per-material "tune" overrides for this slot.
   *
   * Held ON the slot rather than in a map keyed by session id: the first field moved off that
   * keying. Per-slot state in an id-keyed map is why the session id space needs renumbering at all:
   * a save rewrites the ids and every map has to be walked across. State that travels WITH its slot
   * needs no such walk, and cannot be orphaned by a remap that misses a map.
   */
  settingOverrides?: Record<string, string | string[]>
  /** The material-type filter the picker is narrowed to for this slot (session UI state). */
  materialTypeFilter?: string
  /**
   * The user explicitly changed this slot's material PROFILE (dropdown or loaded-material picker).
   * A profile change writes a new `filament_settings_id`, and unlike a recolour it is not
   * detectable by comparing values, the baked short name "Bambu PLA Basic" never equals the
   * resolved "Bambu PLA Basic @BBL H2D 0.4 nozzle", so the explicit edit is recorded instead.
   * Programmatic default application sets option ids directly and never flags this.
   */
  profileEdited?: boolean
  /**
   * The session's PICKS, as opposed to `color`/`nozzleId` above, which are what the FILE says.
   * Absent means "no pick yet", which is why the readers fall back to the file's value.
   *
   * With these moved, no per-slot state is keyed by session id any more: a save renumbers slots by
   * rewriting the list, and everything about a slot comes with it. That is what makes the id space
   * an addressing detail rather than something every map has to be walked across.
   */
  pickedOptionId?: string
  pickedColor?: string
  pickedToolheadId?: string
  /** Virtual mixed-slot recipe; null explicitly marks a physical slot in a mixed project. */
  mixedFilament?: MixedFilamentConfig | null
}

/** The file's slots as a session list, each slot cloning the settings of the base slot it came from. */
function materialiseFrom(base: readonly SliceProjectFilament[]): SessionFilamentSlot[] {
  return base.map((filament, index) => ({
    projectFilamentId: filament.projectFilamentId,
    sourceIndex: index,
    label: filament.label,
    color: filament.color,
    nozzleId: filament.nozzleId,
    ...(filament.mixedFilament !== undefined ? { mixedFilament: filament.mixedFilament } : {})
  }))
}

/**
 * Fold a NEW base list into the session's, keeping each surviving slot's session state.
 *
 * Used when the file changes under a session that has not diverged from it (a refetch, a version
 * switch): the file decides membership and order, the session keeps what it knows about each slot.
 */
function adoptBase(base: readonly SliceProjectFilament[], previous: readonly SessionFilamentSlot[]): SessionFilamentSlot[] {
  const previousById = new Map(previous.map((slot) => [slot.projectFilamentId, slot]))
  return base.map((filament, index) => {
    const carried = previousById.get(filament.projectFilamentId)
    return {
      projectFilamentId: filament.projectFilamentId,
      sourceIndex: index,
      label: filament.label,
      color: filament.color,
      nozzleId: filament.nozzleId,
      settingOverrides: carried?.settingOverrides,
      materialTypeFilter: carried?.materialTypeFilter,
      profileEdited: carried?.profileEdited,
      pickedOptionId: carried?.pickedOptionId,
      pickedColor: carried?.pickedColor,
      pickedToolheadId: carried?.pickedToolheadId,
      ...(filament.mixedFilament !== undefined ? { mixedFilament: filament.mixedFilament } : {})
    }
  })
}

/** Apply the file-derived initial picks onto a freshly materialised list. */
function seedPicks(
  slots: SessionFilamentSlot[],
  optionIds: Record<number, string>,
  colors: Record<number, string>,
  toolheadIds: Record<number, string>
): SessionFilamentSlot[] {
  return slots.map((slot) => ({
    ...slot,
    pickedOptionId: optionIds[slot.projectFilamentId],
    pickedColor: colors[slot.projectFilamentId],
    pickedToolheadId: toolheadIds[slot.projectFilamentId]
  }))
}

/** True when two slot lists say the same thing, so a reconcile can return the SAME list. */
function slotsEqual(a: readonly SessionFilamentSlot[], b: readonly SessionFilamentSlot[]): boolean {
  return a.length === b.length && a.every((slot, index) => {
    const other = b[index]
    return other !== undefined
      && slot.projectFilamentId === other.projectFilamentId
      && slot.sourceIndex === other.sourceIndex
      && slot.label === other.label
      && slot.color === other.color
      && slot.nozzleId === other.nozzleId
      && slot.materialTypeFilter === other.materialTypeFilter
      && slot.pickedOptionId === other.pickedOptionId
      && slot.pickedColor === other.pickedColor
      && slot.pickedToolheadId === other.pickedToolheadId
      && JSON.stringify(slot.mixedFilament ?? undefined) === JSON.stringify(other.mixedFilament ?? undefined)
      && Boolean(slot.profileEdited) === Boolean(other.profileEdited)
      && JSON.stringify(slot.settingOverrides ?? null) === JSON.stringify(other.settingOverrides ?? null)
  })
}

/** A slot-carried field, read out in the id-keyed shape consumers still expect. */
function recordFromSlots<T>(
  slots: readonly SessionFilamentSlot[],
  read: (slot: SessionFilamentSlot) => T | undefined
): Record<number, T> {
  const out: Record<number, T> = {}
  for (const slot of slots) {
    const value = read(slot)
    if (value !== undefined) out[slot.projectFilamentId] = value
  }
  return out
}

/** A nozzle id the machine can host, else null (see `toolheadOptions`). */
function clampNozzleId(nozzleId: number | null, available: ReadonlySet<number>): number | null {
  if (nozzleId == null) return null
  return available.has(nozzleId) ? nozzleId : null
}

function recordsEqual(a: Record<number, string>, b: Record<number, string>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => a[Number(key)] === b[Number(key)])
}

/** `{ ...base, ...over }`, but returning `over` unchanged when the merge adds nothing. */
function mergeUnder(base: Record<number, string>, over: Record<number, string>): Record<number, string> {
  const merged = { ...base, ...over }
  return recordsEqual(merged, over) ? over : merged
}

/**
 * Re-point a captured snapshot's `sourceIndex` values at the base list a save has just rewritten.
 *
 * This is the ONLY thing a retained undo frame needs when a save renumbers the slots. Everything
 * else in a frame, the slot list, its ids, and every per-slot map, is self-describing, so a
 * restored frame is coherent on its own terms; `sourceIndex` is the single field that reaches
 * OUTSIDE the frame, into the file's slot order. A source the save dropped becomes null, which
 * authors that slot from its preset instead of cloning a block that no longer exists.
 */
export function rebaseMaterialSlotsSnapshot(
  snapshot: MaterialSlotsSnapshot,
  sourceRemap: ReadonlyMap<number, number>
): MaterialSlotsSnapshot {
  if (!snapshot.sessionSlots) return snapshot
  return {
    ...snapshot,
    sessionSlots: snapshot.sessionSlots.map((slot) => ({
      ...slot,
      sourceIndex: slot.sourceIndex == null ? null : sourceRemap.get(slot.sourceIndex) ?? null
    }))
  }
}

/**
 * OLD base index -> NEW base index, for the base list a save has just written.
 *
 * The saved file's slot j is the session slot that sat at position j, so whatever base index that
 * slot cloned from is now index j. Sources no other slot carried are absent: the save dropped them.
 */
export function buildFilamentSourceRemap(savedSourceIndexes: ReadonlyArray<number | null>): Map<number, number> {
  const map = new Map<number, number>()
  savedSourceIndexes.forEach((source, index) => {
    if (source != null && !map.has(source)) map.set(source, index)
  })
  return map
}

/** The material fields of `SliceConfigSnapshot`: captured/restored by the host's snapshot pair. */
export interface MaterialSlotsSnapshot {
  /** The session's own list, or null while it still follows the file. See {@link SessionFilamentSlot}. */
  sessionSlots: SessionFilamentSlot[] | null
}

export interface MaterialSlotsParams {
  file: LibraryFile
  bakedIndex: ThreeMfIndex | null
  /** The file's persisted slots (`buildSliceDialogProjectFilaments`); the overlay applies on top. */
  baseProjectFilaments: SliceProjectFilament[]
  /** Full filament catalogue (for the initial option seed, before compatibility resolves). */
  filamentProfiles: SlicingPresetSummary[]
  /** Machine/process-compatible subset (drives defaults + the compat reconciliation). */
  compatibleFilamentProfiles: SlicingPresetSummary[]
  /** The pickable options (catalogue + any host extras such as AMS-loaded materials). */
  materialOptions: SliceMaterialOption[]
  selectedMachineProfile: SlicingPresetSummary | null
  /**
   * The target machine's actual toolheads (`buildSliceDialogToolheads`). Used to keep per-slot
   * nozzle assignments VALID for the current machine: a dual-nozzle project switched to a
   * single-nozzle printer otherwise keeps `nozzle-1` selections (and the baked slot nozzle is 1
   * too), so the save/slice emitted nozzle 1 on a one-extruder machine: BambuStudio then reads
   * that extruder out of bounds and SIGSEGVs mid-slice (CLI exit 139). Empty/one entry ⇒ no slot
   * may carry a nozzle id at all.
   */
  toolheadOptions?: ReadonlyArray<{ id: string }>
  /**
   * Narrows which slots the mappings/choices cover (the print dialog narrows to the selected
   * plate's used set; the editor and the public host show everything). Defaults to all.
   */
  visibleFilamentsFilter?: (filament: SliceProjectFilament) => boolean
  /**
   * A slot was removed at this 1-based POSITION in the pre-removal ordered list. The host remaps
   * its filament-INDEX references (process overrides + per-object overrides), those live with the
   * process state, not here. Called BEFORE the removal mutates the list.
   */
  onFilamentRemoved?: (removedPosition: number) => void
  /**
   * The list was reordered: `remap` is the 1-based old-position → new-position permutation over
   * the pre-reorder ordered list. Same host duty as `onFilamentRemoved`: remap the filament-INDEX
   * references (`permuteFilamentIndexOverrides` and friends). Called BEFORE the move mutates the
   * list.
   */
  onFilamentReordered?: (remap: ReadonlyMap<number, number>) => void
}

/**
 * What the user picked in the add-material dialog, and the ONLY source for a new slot's identity.
 *
 * Every field is required: the dialog refuses to confirm without a preset, so there is no "add now,
 * decide later" state to represent here. See `handleAddFilament` for why nothing is defaulted.
 */
export interface AddedMaterialChoice {
  /** Chosen material option id (`SliceMaterialOption.id`), never empty. */
  optionId: string
  /** Chosen colour; normalized on the way into the slot. */
  color: string
  /** Slot label: the option's material type (e.g. "PLA"). */
  label: string
  /**
   * Nozzle the material goes on, when the pick implies one. A material chosen from the printer came
   * out of a specific tray, and on a dual-nozzle machine that tray belongs to one toolhead, so
   * cloning the first slot's nozzle would quietly put it on the wrong one. Absent for a manual pick,
   * which says nothing about nozzles.
   */
  toolheadId?: string
}

/** Complete virtual-slot edit from the mixed-material dialog. */
export interface MixedMaterialChoice {
  /** Existing virtual slot to replace; null appends a new one. */
  projectFilamentId: number | null
  color: string
  type: string
  mixedFilament: MixedFilamentConfig
}

/**
 * Insert or replace one virtual mixed slot while retaining the first component's profile source.
 * Existing physical slots gain explicit null metadata so deleting the final mix remains expressible.
 */
function upsertMixedFilamentSlot(
  slots: readonly SessionFilamentSlot[],
  choice: MixedMaterialChoice,
  baseProjectFilaments: readonly SliceProjectFilament[]
): SessionFilamentSlot[] {
  const normalizedColor = normalizeSliceFilamentColor(choice.color)
  const existingIndex = choice.projectFilamentId == null
    ? -1
    : slots.findIndex((slot) => slot.projectFilamentId === choice.projectFilamentId)

  if (existingIndex >= 0) {
    return slots.map((slot, index) => {
      if (index !== existingIndex) {
        return slot
      }

      return {
        ...slot,
        label: choice.type,
        color: normalizedColor,
        pickedColor: normalizedColor,
        mixedFilament: choice.mixedFilament
      }
    })
  }

  const firstComponentId = choice.mixedFilament.componentIds[0]
  const firstComponent = slots.find((slot) => slot.projectFilamentId === firstComponentId)

  if (!firstComponent) {
    return [...slots]
  }

  const maxId = Math.max(
    0,
    ...baseProjectFilaments.map((entry) => entry.projectFilamentId),
    ...slots.map((entry) => entry.projectFilamentId)
  )
  const physicalSlots = slots.map((slot) => {
    return slot.mixedFilament === undefined ? { ...slot, mixedFilament: null } : slot
  })

  return [...physicalSlots, {
    projectFilamentId: maxId + 1,
    sourceIndex: firstComponent.sourceIndex,
    label: choice.type,
    color: normalizedColor,
    nozzleId: firstComponent.nozzleId,
    pickedOptionId: firstComponent.pickedOptionId,
    pickedColor: normalizedColor,
    pickedToolheadId: firstComponent.pickedToolheadId,
    mixedFilament: choice.mixedFilament
  }]
}

/** Remap a virtual recipe from session ids to the positional ids the next saved file will use. */
function remapMixedFilamentForSave(
  mixedFilament: MixedFilamentConfig,
  savedIdBySessionId: ReadonlyMap<number, number>
): MixedFilamentConfig {
  return {
    ...mixedFilament,
    componentIds: mixedFilament.componentIds.map((id) => savedIdBySessionId.get(id) ?? 0)
  }
}

export interface MaterialSlots {
  /** Base slots minus removed, plus session-added: the full ordered list (session id space). */
  projectFilaments: SliceProjectFilament[]
  /** `projectFilaments` narrowed by the host's filter (what mappings and pickers cover). */
  visibleProjectFilaments: SliceProjectFilament[]
  filamentMaterialOptionIds: Record<number, string>
  setFilamentMaterialOptionIds: React.Dispatch<React.SetStateAction<Record<number, string>>>
  filamentColors: Record<number, string>
  setFilamentColors: React.Dispatch<React.SetStateAction<Record<number, string>>>
  filamentToolheadIds: Record<number, string>
  setFilamentToolheadIds: React.Dispatch<React.SetStateAction<Record<number, string>>>
  filamentMaterialTypeFilters: Record<number, string>
  setFilamentMaterialTypeFilters: React.Dispatch<React.SetStateAction<Record<number, string>>>
  filamentSettingOverridesById: Record<number, Record<string, string | string[]>>
  setFilamentSettingOverridesById: React.Dispatch<React.SetStateAction<Record<number, Record<string, string | string[]>>>>
  profileEditedFilamentIds: Set<number>
  /** Append a material slot from the choice the user confirmed in the add dialog. */
  handleAddFilament: (choice: AddedMaterialChoice) => void
  /** Replace the whole project list from occupied AMS slots, preserving row ids for object links. */
  handleSyncFilaments: (choices: AddedMaterialChoice[]) => void
  handleUpsertMixedFilament: (choice: MixedMaterialChoice) => void
  handleRemoveFilament: (projectFilamentId: number) => void
  /** Move a slot to an insertion gap (0..N, between-tiles drag semantics). */
  handleReorderFilament: (fromIndex: number, insertAt: number) => void
  handleMaterialOptionChange: (projectFilamentId: number, option: SliceMaterialOption | null) => void
  /** See `SliceSettingsController.materialEditListenerRef`: the editor's unsaved-flag hook. */
  materialEditListenerRef: React.MutableRefObject<(() => void) | null>
  desiredFilaments: SceneEditFilament[] | null
  filamentMappingResult: ReturnType<typeof buildFilamentMappings>
  /**
   * Tell the controller a project save persisted, and get back the OLD→NEW base-index map the
   * caller needs for anything still holding pre-save `sourceIndex` values (the editor's undo
   * frames). Null when the session never diverged, so nothing moved.
   */
  onProjectSaved: () => Map<number, number> | null
  /**
   * Seed the option picks + colours from the baked index (the host's one-shot "apply the file's
   * defaults" moment, gated by ITS readiness latch). Composes the seed with the compat
   * reconciliation in ONE updater, so the result matches "seed, then reconcile" regardless of
   * where the host's effect sits relative to this hook's own, intra-flush effect order must not
   * be load-bearing across the module boundary.
   */
  applyBakedMaterialDefaults: () => void
  /** The material fields for the host's `configSnapshot`. */
  materialSnapshot: MaterialSlotsSnapshot
  /** Restore the material fields from a host snapshot (undo/redo). */
  restoreMaterialSnapshot: (snapshot: MaterialSlotsSnapshot) => void
}

export function useMaterialSlots(params: MaterialSlotsParams): MaterialSlots {
  const {
    file, bakedIndex, baseProjectFilaments, filamentProfiles, compatibleFilamentProfiles,
    materialOptions, selectedMachineProfile, toolheadOptions, visibleFilamentsFilter, onFilamentRemoved, onFilamentReordered
  } = params

  // The session's material list. ALWAYS a real list, never "null, so read the file instead",
  // that null was a moving reference, and a snapshot holding it restored whatever the file had
  // become rather than what the user saw. Whether it is the SESSION's list or merely a view of the
  // file is a separate, explicit fact: `sessionOwned`.
  const [sessionSlots, setSessionSlots] = useState<SessionFilamentSlot[]>(() => seedPicks(
    materialiseFrom(baseProjectFilaments),
    buildInitialFilamentMaterialOptionSelection(file, bakedIndex, filamentProfiles),
    buildInitialFilamentColorSelection(file, bakedIndex),
    buildInitialFilamentToolheadSelection(file, bakedIndex)
  ))
  // True once the list is the session's own, an add, a remove, or an undo restoring a specific
  // list. Until then the file may replace it wholesale (a refetch, a version change); afterwards
  // only a save may, by folding the divergence in. Separating this from the STORAGE is what lets
  // per-slot state live on the slots without every write pretending the user diverged.
  const [sessionOwned, setSessionOwned] = useState(false)
  const sessionOwnedRef = useRef(sessionOwned)
  sessionOwnedRef.current = sessionOwned
  // The editor's unsaved-flag hook for edits applied through the controller's OWN dialogs (which
  // stay mounted behind the editor): see SliceSettingsController.materialEditListenerRef.
  const materialEditListenerRef = useRef<(() => void) | null>(null)

  const slotList = sessionSlots
  // Read by callbacks that must know the CURRENT list without taking it as a dependency.
  const slotListRef = useRef(slotList)
  slotListRef.current = slotList
  const projectFilaments = useMemo<SliceProjectFilament[]>(
    () => {
      // Plate usage is the FILE's answer, not the session's, so it is read live per render rather
      // than frozen onto the slot: the slim dialog narrows by it and the active plate changes
      // without the material list changing at all. A slot the file has no counterpart for (a fresh
      // add) is always shown.
      const usedByBaseId = new Map(baseProjectFilaments.map((filament) => [filament.projectFilamentId, filament.usedOnSelectedPlate]))
      return slotList.map((slot) => ({
        projectFilamentId: slot.projectFilamentId,
        label: slot.label,
        color: slot.color,
        nozzleId: slot.nozzleId,
        usedOnSelectedPlate: usedByBaseId.get(slot.projectFilamentId) ?? true,
        ...(slot.mixedFilament !== undefined ? { mixedFilament: slot.mixedFilament } : {})
      }))
    },
    [slotList, baseProjectFilaments]
  )
  // The post-save carry runs in an effect keyed on the base SIGNATURE, so it must read the base
  // list that arrived with it rather than one closed over at arm time.
  const baseProjectFilamentsRef = useRef(baseProjectFilaments)
  baseProjectFilamentsRef.current = baseProjectFilaments
  // Slot-carried state is still READ in its old id-keyed shape so no consumer has to change while
  // the storage moves; these are the shims. Each write applies the caller's updater to that shape
  // and folds the result back onto the slots: returning the SAME list when nothing changed, since
  // an updater that always mints a new list turns an unstable caller into a render loop.
  /**
   * Apply an id-keyed record write onto the slots that hold that state.
   *
   * INVARIANT: a key with no matching slot is silently DISCARDED (the write maps over the existing
   * list). That is correct for a stale write naming a removed slot, but it means these setters
   * cannot introduce a slot, so state for a slot being ADDED must be written as fields of the slot
   * itself, in the same update that appends it (see `handleAddFilament`). Writing it through these
   * setters from inside the appending updater silently lost every pick whose dispatch React
   * evaluated eagerly, which rendered added materials as a bare "PLA" with no preset.
   */
  const writeSlotRecord = useCallback(<T,>(
    value: React.SetStateAction<Record<number, T>>,
    read: (slot: SessionFilamentSlot) => T | undefined,
    write: (slot: SessionFilamentSlot, next: T | undefined) => SessionFilamentSlot
  ) => {
    setSessionSlots((current) => {
      const before = recordFromSlots(current, read)
      const next = typeof value === 'function'
        ? (value as (previous: Record<number, T>) => Record<number, T>)(before)
        : value
      if (JSON.stringify(before) === JSON.stringify(next)) return current
      return current.map((slot) => write(slot, next[slot.projectFilamentId]))
    })
  }, [])

  const filamentSettingOverridesById = useMemo(
    () => recordFromSlots(slotList, (slot) => (slot.settingOverrides && Object.keys(slot.settingOverrides).length > 0 ? slot.settingOverrides : undefined)),
    [slotList]
  )
  const setFilamentSettingOverridesById = useCallback<React.Dispatch<React.SetStateAction<Record<number, Record<string, string | string[]>>>>>(
    (value) => writeSlotRecord(
      value,
      (slot) => (slot.settingOverrides && Object.keys(slot.settingOverrides).length > 0 ? slot.settingOverrides : undefined),
      (slot, next) => ({ ...slot, settingOverrides: next && Object.keys(next).length > 0 ? next : undefined })
    ),
    [writeSlotRecord]
  )

  const filamentMaterialOptionIds = useMemo(() => recordFromSlots(slotList, (slot) => slot.pickedOptionId), [slotList])
  const setFilamentMaterialOptionIds = useCallback<React.Dispatch<React.SetStateAction<Record<number, string>>>>(
    (value) => writeSlotRecord(value, (slot) => slot.pickedOptionId, (slot, next) => ({ ...slot, pickedOptionId: next })),
    [writeSlotRecord]
  )
  const filamentColors = useMemo(() => recordFromSlots(slotList, (slot) => slot.pickedColor), [slotList])
  const setFilamentColors = useCallback<React.Dispatch<React.SetStateAction<Record<number, string>>>>(
    (value) => writeSlotRecord(value, (slot) => slot.pickedColor, (slot, next) => ({ ...slot, pickedColor: next })),
    [writeSlotRecord]
  )
  const filamentToolheadIds = useMemo(() => recordFromSlots(slotList, (slot) => slot.pickedToolheadId), [slotList])
  const setFilamentToolheadIds = useCallback<React.Dispatch<React.SetStateAction<Record<number, string>>>>(
    (value) => writeSlotRecord(value, (slot) => slot.pickedToolheadId, (slot, next) => ({ ...slot, pickedToolheadId: next })),
    [writeSlotRecord]
  )
  const filamentMaterialTypeFilters = useMemo(() => recordFromSlots(slotList, (slot) => slot.materialTypeFilter), [slotList])
  const setFilamentMaterialTypeFilters = useCallback<React.Dispatch<React.SetStateAction<Record<number, string>>>>(
    (value) => writeSlotRecord(value, (slot) => slot.materialTypeFilter, (slot, next) => ({ ...slot, materialTypeFilter: next })),
    [writeSlotRecord]
  )

  /** Read-only: the flag is set by {@link handleMaterialOptionChange} and cleared by a save. */
  const profileEditedFilamentIds = useMemo(
    () => new Set(slotList.filter((slot) => slot.profileEdited).map((slot) => slot.projectFilamentId)),
    [slotList]
  )

  const visibleProjectFilaments = useMemo(
    () => (visibleFilamentsFilter ? projectFilaments.filter(visibleFilamentsFilter) : projectFilaments),
    [projectFilaments, visibleFilamentsFilter]
  )

  // Reconcile the option picks against the CURRENT compatible set: preserve the user's selection
  // while it still resolves to a compatible option; when it does not, hand it over to the same
  // PRODUCT built for this machine before falling back to the target machine's default, so a
  // cross-model switch never leaves a slot pointing at a foreign option, and never silently
  // discards a material the user chose this session (see repointMaterialOptionToCompatibleAlias).
  // Every updater here returns the SAME state identity when nothing changed: these effects key on
  // caller-supplied objects, and an updater that always mints a new object turns an unstable
  // caller identity into an infinite render loop instead of a wasted render.
  useEffect(() => {
    setFilamentMaterialOptionIds((current) => {
      const defaults = buildInitialFilamentMaterialOptionSelection(file, bakedIndex, compatibleFilamentProfiles, selectedMachineProfile)
      const next: Record<number, string> = { ...defaults }
      for (const [filamentId, optionId] of Object.entries(current)) {
        if (!optionId) continue
        if (materialOptions.some((option) => option.id === optionId)) {
          next[Number(filamentId)] = optionId
          continue
        }
        // The pick left the compatible set (a machine switch). Prefer this machine's build of the
        // same product over re-seeding from the file, which would revert the user's own choice.
        const repointed = repointMaterialOptionToCompatibleAlias(optionId, filamentProfiles, materialOptions)
        if (repointed) next[Number(filamentId)] = repointed
      }
      return recordsEqual(current, next) ? current : next
    })
  }, [bakedIndex, compatibleFilamentProfiles, file, filamentProfiles, materialOptions, selectedMachineProfile, setFilamentMaterialOptionIds])
  // Merge baked colours/toolheads UNDER the session's, a late-arriving index fills gaps without
  // overwriting what the user already picked.
  //
  // Keyed on the SLOT LIST as well as the index, and that is load-bearing. These setters are
  // projections that map over the slots that already exist (see `writeSlotRecord`), so a seed for a
  // slot the list has not caught up with is silently discarded. The file's own materials arrive in
  // two steps, a short DTO view first, the full index after, so on a 3-material project the seed
  // ran against 2 slots and the third material lost its nozzle assignment permanently, because the
  // index never changed again to re-trigger this. Re-running when the slot ids change is what
  // closes that window; `mergeUnder` returns the SAME record when nothing differs, so the extra
  // runs cost a comparison and cannot loop.
  const slotIdsKey = slotList.map((slot) => slot.projectFilamentId).join(',')
  useEffect(() => {
    setFilamentColors((current) => mergeUnder(buildInitialFilamentColorSelection(file, bakedIndex), current))
  }, [bakedIndex, file, slotIdsKey, setFilamentColors])
  useEffect(() => {
    setFilamentToolheadIds((current) => mergeUnder(buildInitialFilamentToolheadSelection(file, bakedIndex), current))
  }, [bakedIndex, file, slotIdsKey, setFilamentToolheadIds])

  // Nozzle ids the CURRENT machine can host. A single-toolhead machine yields an empty set (its
  // one option is `primary`, which carries no nozzle id), so no slot may emit one.
  const availableNozzleIds = useMemo(() => {
    const ids = new Set<number>()
    for (const toolhead of toolheadOptions ?? []) {
      const nozzleId = parseSliceToolheadNozzleId(toolhead.id)
      if (nozzleId != null) ids.add(nozzleId)
    }
    return ids
  }, [toolheadOptions])
  // Drop per-slot toolhead picks the current machine does not offer, so the UI never shows (and a
  // save never bakes) a stale dual-nozzle selection after a switch to a single-nozzle printer.
  const offeredToolheadIds = useMemo(() => new Set((toolheadOptions ?? []).map((toolhead) => toolhead.id)), [toolheadOptions])
  useEffect(() => {
    if (offeredToolheadIds.size === 0) return
    setFilamentToolheadIds((current) => {
      const next: Record<number, string> = {}
      for (const [slot, id] of Object.entries(current)) {
        if (id && offeredToolheadIds.has(id)) next[Number(slot)] = id
      }
      return recordsEqual(current, next) ? current : next
    })
  }, [offeredToolheadIds, setFilamentToolheadIds])

  const handleAddFilament = useCallback((choice: AddedMaterialChoice) => {
    const template = projectFilaments[0] ?? null
    setSessionOwned(true)
    // ONE update that appends a COMPLETE slot. The picks must be written as fields of the new slot,
    // never through the setFilamentMaterialOptionIds/Colors/ToolheadIds setters: those are
    // projections that map over the slots that already exist (see `writeSlotRecord`), so a write
    // for an id that is not in the list yet is silently dropped. Calling them from inside this
    // updater lost every pick whose dispatch React evaluated eagerly, which is to say every add
    // after the first, because the first also flipped `sessionOwned` and took the other path.
    setSessionSlots((slots) => {
      const maxId = Math.max(0, ...baseProjectFilaments.map((entry) => entry.projectFilamentId), ...slots.map((entry) => entry.projectFilamentId))
      const newId = maxId + 1
      const templateSlot = template ? slots.find((slot) => slot.projectFilamentId === template.projectFilamentId) ?? null : null
      const color = normalizeSliceFilamentColor(choice.color)
      return [...slots, {
        projectFilamentId: newId,
        // Clone the FIRST base slot's slicer settings, matching what the added-slot overlay did.
        sourceIndex: baseProjectFilaments.length > 0 ? 0 : null,
        label: choice.label,
        color,
        nozzleId: template?.nozzleId ?? null,
        // Seeded ONLY from what the user picked in the add dialog, nothing is cloned from the first
        // material and nothing falls back to a machine default. A slot invented before the user said
        // what it should be reads as a real choice they never made: a default preset (Bambu PLA
        // Basic) meeting the default colour (#FFFFFF) is named by the identity resolver as the
        // genuine product "Bambu PLA Basic, Jade White". An empty pick is equally unacceptable, it
        // bakes a null filament_settings_id and the slicer substitutes Generic PLA.
        pickedOptionId: choice.optionId,
        pickedColor: color,
        // Toolhead is a nozzle ASSIGNMENT rather than part of the material's identity, so cloning
        // the template's still matches what the user would otherwise pick by hand, unless the pick
        // named one itself (a tray belongs to a toolhead), which always wins.
        pickedToolheadId: choice.toolheadId ?? templateSlot?.pickedToolheadId ?? ''
      }]
    })
  }, [projectFilaments, baseProjectFilaments])

  const handleUpsertMixedFilament = useCallback((choice: MixedMaterialChoice) => {
    setSessionOwned(true)
    setSessionSlots((slots) => {
      return upsertMixedFilamentSlot(slots, choice, baseProjectFilaments)
    })
  }, [baseProjectFilaments])

  const handleSyncFilaments = useCallback((choices: AddedMaterialChoice[]) => {
    if (choices.length === 0) {
      return
    }

    // Process settings name slot POSITIONS. Remove tail rows from highest to lowest so the host's
    // existing one-slot remapper can safely update every reference without a second bulk algorithm.
    for (let index = sessionSlots.length - 1; index >= choices.length; index -= 1) {
      onFilamentRemoved?.(index + 1)
    }

    setSessionOwned(true)
    setSessionSlots((slots) => {
      const maxId = Math.max(
        0,
        ...baseProjectFilaments.map((entry) => entry.projectFilamentId),
        ...slots.map((entry) => entry.projectFilamentId)
      )
      const carriedMixedMetadata = slots.some((slot) => slot.mixedFilament !== undefined)

      return choices.map((choice, index): SessionFilamentSlot => {
        const current = slots[index]
        const color = normalizeSliceFilamentColor(choice.color)

        return {
          projectFilamentId: current?.projectFilamentId ?? maxId + index - slots.length + 1,
          sourceIndex: current?.sourceIndex ?? (baseProjectFilaments.length > 0 ? 0 : null),
          label: choice.label,
          color,
          nozzleId: current?.nozzleId ?? null,
          pickedOptionId: choice.optionId,
          pickedColor: color,
          pickedToolheadId: choice.toolheadId,
          profileEdited: true,
          ...(carriedMixedMetadata ? { mixedFilament: null } : {})
        }
      })
    })
  }, [baseProjectFilaments, onFilamentRemoved, sessionSlots])

  const handleRemoveFilament = useCallback((projectFilamentId: number) => {
    // BambuStudio parity: a material can be removed even while a process setting references it:
    // the setting falls back to "Default" rather than the delete being refused. Those settings
    // store the material's POSITION in the ordered list, so every reference above the removed one
    // also shifts down (the host remaps them: see onFilamentRemoved). Done BEFORE the removal so
    // the position still resolves against the pre-removal list. `projectFilaments` is a dependency,
    // not incidental: captured stale, a removal after an add computes the wrong position.
    const removedPosition = projectFilaments.findIndex((filament) => filament.projectFilamentId === projectFilamentId) + 1
    if (removedPosition > 0) onFilamentRemoved?.(removedPosition)
    // The per-slot keyed state is deliberately LEFT in place: an undo that puts this slot back
    // wants its colour/preset/nozzle/overrides, and entries for slots the list no longer holds are
    // ignored by every reader (they are keyed lookups, not iterations).
    setSessionOwned(true)
    setSessionSlots((slots) => slots.filter((slot) => slot.projectFilamentId !== projectFilamentId))
  }, [projectFilaments, onFilamentRemoved])

  /**
   * Move the slot at `fromIndex` into insertion gap `insertAt` (0..N, the between-tiles semantics
   * the drag strip produces: same conversion as `movePlate`). Session ids stay untouched, so
   * paint, badges, and every id-keyed pick follow their material through the move; the SAVE turns
   * the new order into new slot numbers via `sourceIndex`, exactly as removal does. Position-space
   * references (the filament-INDEX process settings) are the one thing that must move NOW, via
   * `onFilamentReordered`, they name positions, not ids.
   */
  const handleReorderFilament = useCallback((fromIndex: number, insertAt: number) => {
    const count = projectFilaments.length
    if (fromIndex < 0 || fromIndex >= count) return
    const target = insertAt > fromIndex ? insertAt - 1 : insertAt
    if (target === fromIndex || target < 0 || target >= count) return
    // 1-based old position → new position, resolved against the pre-move list (dependency on
    // `projectFilaments` is load-bearing, as in removal: stale capture = wrong permutation).
    const order = projectFilaments.map((_unused, index) => index)
    const [movedIndex] = order.splice(fromIndex, 1)
    order.splice(target, 0, movedIndex as number)
    const remap = new Map<number, number>()
    order.forEach((oldIndex, newIndex) => remap.set(oldIndex + 1, newIndex + 1))
    onFilamentReordered?.(remap)
    setSessionOwned(true)
    setSessionSlots((slots) => {
      if (fromIndex >= slots.length) return slots
      const next = [...slots]
      const [movedSlot] = next.splice(fromIndex, 1)
      next.splice(target, 0, movedSlot as SessionFilamentSlot)
      return next
    })
  }, [projectFilaments, onFilamentReordered])

  const handleMaterialOptionChange = useCallback((projectFilamentId: number, option: SliceMaterialOption | null) => {
    setFilamentMaterialOptionIds((current) => ({ ...current, [projectFilamentId]: option?.id ?? '' }))
    // Both slot-carried fields in ONE write, so a pick is a single state update rather than two
    // that each re-derive the list.
    setSessionSlots((current) => {
      const target = current.find((slot) => slot.projectFilamentId === projectFilamentId)
      if (!target) return current
      if (target.profileEdited && (!option || target.materialTypeFilter === option.materialType)) return current
      return current.map((slot) => (slot.projectFilamentId === projectFilamentId
        ? { ...slot, profileEdited: true, materialTypeFilter: option ? option.materialType : slot.materialTypeFilter }
        : slot))
    })
    if (option?.color) {
      setFilamentColors((current) => ({ ...current, [projectFilamentId]: option.color ?? current[projectFilamentId] ?? '' }))
    }
    if (option?.toolheadId) {
      setFilamentToolheadIds((current) => ({ ...current, [projectFilamentId]: option.toolheadId ?? current[projectFilamentId] ?? '' }))
    }
    // Notify the editor (if any) so a pick from its picker Modal flips the unsaved-changes flag.
    materialEditListenerRef.current?.()
  }, [setFilamentMaterialOptionIds, setFilamentColors, setFilamentToolheadIds])

  // Latest catalogue inputs for applyBakedMaterialDefaults: read through a ref so the callback
  // is stable and immune to where the host's readiness effect sits in declaration order.
  const paramsRef = useRef(params)
  paramsRef.current = params
  const applyBakedMaterialDefaults = useCallback(() => {
    const { file: f, bakedIndex: baked, filamentProfiles: profiles, compatibleFilamentProfiles: compatible, materialOptions: options, selectedMachineProfile: machine, baseProjectFilaments: base } = paramsRef.current
    // Slots the FILE has no counterpart for (session adds). The baked seed speaks only for the
    // file's own filaments, so it must not answer for these, it re-seeds from scratch, and a bare
    // replace would clear an added material's preset. Reachable whenever the latch re-arms after an
    // add (the host re-applies on a slicer-target switch), which is how a material the user had just
    // chosen came back blank.
    const fileIds = new Set(base.map((filament) => filament.projectFilamentId))
    const sessionAddedIds = slotListRef.current
      .map((slot) => slot.projectFilamentId)
      .filter((filamentId) => !fileIds.has(filamentId))
    setFilamentMaterialOptionIds((current) => {
      // The full-catalogue seed (what the file names), narrowed by the same rule as the compat
      // reconciliation effect: keep a seeded pick only while it resolves to a pickable option.
      const seeded = buildInitialFilamentMaterialOptionSelection(f, baked, profiles, machine)
      const next: Record<number, string> = { ...buildInitialFilamentMaterialOptionSelection(f, baked, compatible, machine) }
      for (const [filamentId, optionId] of Object.entries(seeded)) {
        if (optionId && options.some((option) => option.id === optionId)) next[Number(filamentId)] = optionId
      }
      for (const filamentId of sessionAddedIds) {
        const picked = current[filamentId]
        if (picked) next[filamentId] = picked
      }
      return next
    })
    setFilamentColors((current) => {
      const next: Record<number, string> = { ...buildInitialFilamentColorSelection(f, baked) }
      for (const filamentId of sessionAddedIds) {
        const picked = current[filamentId]
        if (picked) next[filamentId] = picked
      }
      return next
    })
  }, [setFilamentMaterialOptionIds, setFilamentColors])

  // Identity of the BASE material list (ids/labels/colors/nozzles, not the plate-usage flag,
  // which changes on plate switches). Used to detect the post-save refetch below.
  const baseFilamentSignature = useMemo(
    () => JSON.stringify(baseProjectFilaments.map((filament) => [filament.projectFilamentId, filament.label, filament.color, filament.nozzleId])),
    [baseProjectFilaments]
  )
  // Pending reset armed by a successful editor save: the saved file bakes the CURRENT list as its
  // slots 1..N, so once the refetched base reflects that, the session goes back to FOLLOWING the
  // file: the divergence has been persisted, so keeping it would show every slot twice. `savedIds`
  // records each slot's session id in save order so the per-slot keyed state can follow the
  // renumbering; `savedSourceIndexes` does the same for the retained undo frames (see
  // `buildFilamentSourceRemap`).
  /**
   * A project save persisted the session's list. Renumber it IN MEMORY, immediately.
   *
   * The save wrote the current slots as the file's 1..N, so the session already knows the answer,
   * it does not have to ask the file. This used to arm a pending rebase and wait for the refetched
   * index to say what had just been saved, which meant the correctness of the material list
   * depended on a request landing, in an order the caller had to get right: arming after the
   * invalidation lost the race and showed an added material twice until the editor was reopened.
   *
   * Ownership goes back to the file because the two now agree, so the refetch, whenever it lands,
   * or never, is an ordinary `adoptBase` that refreshes file-derived labels and changes nothing
   * else. Returns the old→new base-index map for anything still holding pre-save `sourceIndex`
   * values (the editor's undo frames).
   */
  const onProjectSaved = useCallback((): Map<number, number> | null => {
    // A session that never diverged bakes the base unchanged, so nothing moved.
    if (!sessionOwned) return null
    const sourceRemap = buildFilamentSourceRemap(sessionSlots.map((slot) => slot.sourceIndex))
    const savedIdBySessionId = new Map(sessionSlots.map((slot, index) => [slot.projectFilamentId, index + 1] as const))
    setSessionSlots((current) => current.map((slot, index) => ({
      ...slot,
      projectFilamentId: index + 1,
      // Slot i of the file we just wrote IS this slot, so that is what a later save clones from.
      sourceIndex: index,
      // The pick is baked into the saved file now, so it is no longer an edit pending against it.
      profileEdited: undefined,
      ...(slot.mixedFilament
        ? {
            mixedFilament: remapMixedFilamentForSave(slot.mixedFilament, savedIdBySessionId)
          }
        : {})
    })))
    setSessionOwned(false)
    return sourceRemap
  }, [sessionOwned, sessionSlots])

  /**
   * The file's list changed under a session that does NOT own its list, a refetch, a version
   * switch, or the post-save refresh. The file decides membership and order; the session keeps what
   * it knows about each surviving slot. A session that owns its list is left alone: it is the user's
   * until a save folds it in.
   */
  useEffect(() => {
    if (sessionOwnedRef.current) return
    // Same list identity when nothing actually changed: this effect keys on a signature derived
    // from a caller-supplied array, and an updater that always mints a new list turns an unstable
    // caller into a render loop instead of a wasted render.
    setSessionSlots((current) => {
      const next = adoptBase(baseProjectFilamentsRef.current, current)
      return slotsEqual(current, next) ? current : next
    })
  }, [baseFilamentSignature])

  // Built once and reused by every submit path so the host's gates and the request that goes out
  // can never disagree about which slots resolved.
  const filamentMappingResult = useMemo(
    () => buildFilamentMappings(visibleProjectFilaments, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, materialOptions, filamentSettingOverridesById),
    [visibleProjectFilaments, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, materialOptions, filamentSettingOverridesById]
  )

  /**
   * The full ordered filament list baked into the saved/sliced 3MF. `sourceIndex` tells the
   * writer which original filament to clone slicer settings from for each slot; `nozzleId`
   * carries the per-slot nozzle assignment. ALWAYS emitted when materials exist: see the
   * delta-save rule in `docs/slicer-architecture.md` (a "changed vs base" gate lost data twice).
   */
  const desiredFilaments = useMemo<SceneEditFilament[] | null>(() => {
    if (sessionSlots.length === 0) {
      return null
    }

    const savedIdBySessionId = new Map(sessionSlots.map((slot, index) => [slot.projectFilamentId, index + 1] as const))
    return sessionSlots.map((filament) => {
      // A slot the file has no counterpart for (fresh add, or one an undo brought back after the
      // save that removed it) has nothing to clone, so the writer authors it from its preset. 0 is
      // the historical fallback and stays the shape the bake expects.
      const hasSource = filament.sourceIndex != null && filament.sourceIndex < baseProjectFilaments.length
      const sourceIndex = hasSource ? filament.sourceIndex as number : 0
      const selectedOption = materialOptions.find((option) => option.id === filamentMaterialOptionIds[filament.projectFilamentId]) ?? null
      return {
        color: normalizeSliceFilamentColor(filamentColors[filament.projectFilamentId] ?? filament.color ?? '#FFFFFF'),
        type: selectedOption?.materialType ?? (hasSource ? null : 'PLA'),
        // The selected preset name so the material choice persists as `filament_settings_id`.
        // Null keeps the slot's existing preset. Only a RESOLVED preset's name may persist: a
        // loaded AMS option with no matched profile carries the tray's display identity in
        // `material`, and writing that into filament_settings_id poisons the saved project: the
        // name matches no catalog preset, so slice-time physics re-derivation silently falls
        // back to Generic PLA.
        settingsId: selectedOption?.profileId ? selectedOption.material : null,
        // The Bambu filament id OF THAT SAME PRESET, read from the preset itself exactly as
        // BambuStudio does (`PresetBundle` writes `filament_settings_id` from `preset.name` and
        // `filament_ids` from `preset.filament_id`, both over one selected-preset list). It is the
        // key BambuStudio BINDS a slot on, so a slot naming PETG HF while carrying the old
        // material's ABS id makes BambuStudio fabricate a junk project preset. Resolved from
        // `profileId` rather than the option's own fields because only the preset knows its id.
        // Null when the option resolved no preset: the bake then reports unknown rather than
        // letting the previous material's id stand.
        filamentId: (selectedOption?.profileId
          ? filamentProfiles.find((profile) => profile.id === selectedOption.profileId)?.filamentIds?.[0]
          : null) ?? null,
        sourceIndex,
        // The chosen toolhead's runtime nozzle id (0 = right, 1 = left), falling back to the slot's
        // baked nozzle so unchanged slots keep their assignment, but ONLY when the current machine
        // actually has that nozzle. A dual-nozzle project switched to a single-nozzle printer
        // otherwise carried nozzle 1 through (from the pick AND the baked value), which BambuStudio
        // reads out of bounds and SIGSEGVs on (exit 139). Null on single-nozzle machines.
        nozzleId: clampNozzleId(
          parseSliceToolheadNozzleId(filamentToolheadIds[filament.projectFilamentId])
            ?? filament.nozzleId
            ?? null,
          availableNozzleIds
        ),
        ...(filament.mixedFilament !== undefined
          ? {
              mixedFilament: filament.mixedFilament
                ? remapMixedFilamentForSave(filament.mixedFilament, savedIdBySessionId)
                : null
            }
          : {})
      }
    })
  }, [sessionSlots, baseProjectFilaments, materialOptions, filamentMaterialOptionIds, filamentColors, filamentToolheadIds, availableNozzleIds, filamentProfiles])

  const materialSnapshot = useMemo<MaterialSlotsSnapshot>(() => ({
    // Always a concrete list, which is the point of holding one: a frame describes what the user
    // saw, so it survives the file changing underneath it.
    // The slots ARE the material state now: picks, overrides, filter, flags and order together.
    // Nothing else belongs here: a second copy of any of it is a snapshot that can disagree with
    // itself, which is what the id-keyed records were.
    sessionSlots
  }), [sessionSlots])
  const restoreMaterialSnapshot = useCallback((snapshot: MaterialSlotsSnapshot) => {
    if (snapshot.sessionSlots) setSessionSlots(snapshot.sessionSlots)
    // A restored frame is a SPECIFIC list to honour, so the file may no longer replace it: the
    // hazard this whole design exists to remove is a captured list that defers to a moved file.
    setSessionOwned(true)
  }, [])

  return {
    projectFilaments,
    visibleProjectFilaments,
    filamentMaterialOptionIds, setFilamentMaterialOptionIds,
    filamentColors, setFilamentColors,
    filamentToolheadIds, setFilamentToolheadIds,
    filamentMaterialTypeFilters, setFilamentMaterialTypeFilters,
    filamentSettingOverridesById, setFilamentSettingOverridesById,
    profileEditedFilamentIds,
    handleAddFilament,
    handleSyncFilaments,
    handleUpsertMixedFilament,
    handleRemoveFilament,
    handleReorderFilament,
    handleMaterialOptionChange,
    materialEditListenerRef,
    desiredFilaments,
    filamentMappingResult,
    onProjectSaved,
    applyBakedMaterialDefaults,
    materialSnapshot,
    restoreMaterialSnapshot
  }
}
