/**
 * Process (quality) settings editor dialog.
 *
 * Renders the Bambu-faithful process settings catalog (generated from
 * BambuStudio source) page-by-page, applying the same conditional
 * visibility/enable rules and value-coercion validation that BambuStudio's
 * Process tab uses. The user edits values against a resolved base config; the
 * dialog emits the sparse override map (changed keys) back to the slice dialog
 * and can optionally persist the result as a reusable custom process preset.
 *
 * The catalog's `develop`-tier options are hidden unless developer mode is on
 * (`useEffectiveSlicerDeveloperMode` — the workspace default from the Slicing
 * settings page, optionally overridden per device); see
 * `isProcessOptionVisibleInMode`.
 *
 * Per-object mode (`baseOverlay` present) additionally supports BULK editing — one dialog for a
 * multi-selection of objects or parts (`initialOverridesByMember`): keys the members disagree on
 * render as "Mixed" and, untouched, keep each member's own value on apply. The seed/apply rules
 * live in `lib/processBulkOverrides.ts`.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, CircularProgress, DialogActions, Divider, FormControl, FormLabel,
  IconButton, Input, Stack, Tab, TabList, TabPanel, Tabs, Tooltip, Typography
} from '@mui/joy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import {
  applyProcessConfigDefaults,
  applySupportRecommendationChanges,
  computeProcessFieldStates,
  createProcessConfigAccessor,
  defaultProcessVisibilityContext,
  diffProcessConfig,
  getProcessFieldState,
  isProcessOptionVisibleInMode,
  processConfigValuesEqual,
  processSettingsCatalog,
  recommendSupportSettingsForInterfaceFilament,
  validateProcessConfig,
  type ProcessConfig,
  type ProcessSettingOption,
  type ProcessSettingOverrides,
  type ProcessVisibilityContext,
  type ResolveProcessConfigResponse,
  type SlicingPresetSummary
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { collectBulkOverridesResult, summarizeBulkOverrides } from '../lib/processBulkOverrides'
import { useEffectiveSlicerDeveloperMode } from '../lib/slicerDeveloperMode'
import { BackAwareModal } from './BackAwareModal'
import { DialogSection } from './DialogSection'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { SlicingPresetAutocomplete } from './library/SlicingPresetAutocomplete'
import { usePromptDialog } from './PromptDialogProvider'
import { SettingValueField, type SettingFilamentChoice } from './settings/SettingValueField'

export interface ProcessSettingsDialogProps {
  open: boolean
  onClose: () => void
  slicerTargetId: string
  processProfileId: string
  processProfileName: string
  /** Source library file id; required to resolve project-embedded (`project:`) profiles. */
  sourceFileId?: string | null
  initialOverrides: ProcessSettingOverrides
  /**
   * Per-object BULK editing (a multi-selection): one override map per selected member, in
   * selection order. When present with more than one entry, the dialog seeds from ALL of them —
   * keys the members agree on show their value, keys they disagree on show as "Mixed" and, left
   * untouched, preserve each member's own value on apply (see `lib/processBulkOverrides.ts`).
   * Only meaningful with `baseOverlay` (per-object mode); `initialOverrides` should then be the
   * first member's map for back-compat. Absent, the dialog edits `initialOverrides` exactly.
   */
  initialOverridesByMember?: ReadonlyArray<ProcessSettingOverrides>
  /** Machine context affecting conditional visibility (printer model, flavor). */
  visibilityContext?: Partial<ProcessVisibilityContext>
  /**
   * Selectable process profiles for switching within the dialog (Bambu carry-over). Full
   * summaries so the switcher renders the SAME grouped picker (project/workspace/built-in)
   * as the slice panel's process dropdown.
   */
  profileOptions?: SlicingPresetSummary[]
  /** Switch the active profile, carrying the current modifications (relative to the preset). */
  onProfileChange?: (profileId: string, carryOverrides: ProcessSettingOverrides) => void
  /** Restrict the editable catalog to these keys (per-object overrides expose a subset). */
  allowedKeys?: readonly string[]
  /**
   * Global effective overrides to overlay onto the resolved base. For per-object editing this is
   * the global process overrides, so the object's baseline/reset target is the inherited global
   * config rather than the bare preset.
   */
  baseOverlay?: ProcessSettingOverrides
  /** Title prefix; defaults to "Process settings" (per-object uses "Object settings"). */
  titlePrefix?: string
  /**
   * The project's materials for filament-index settings (support/raft base+interface,
   * walls/infill filament) — see {@link SettingValueField}. Omitted, those fall back to
   * bare number inputs.
   */
  filamentChoices?: SettingFilamentChoice[]
  /**
   * What the Apply button commits to: a `project` (the 3D editor, where the override is saved
   * with the project) or a one-off `slice` (the print/slice dialog, where it applies to just that
   * slice). Only changes the button wording. Defaults to `slice`.
   */
  /**
   * What the dialog is editing FOR.
   *
   * 'slice' / 'project' edit a slice's config and emit an override map through `onApply`.
   * 'preset' edits the stored preset ITSELF — opened from the slicer-profiles settings, where
   * there is no slice to apply to: the Apply button is hidden and `onApply` is never called, so
   * the only ways out are Save as preset, Update preset (custom presets only, via
   * `canEditOriginal`) and Cancel. That mirrors BambuStudio, where editing a SYSTEM preset can
   * only ever produce a new user preset.
   */
  applyScope?: 'project' | 'slice' | 'preset'
  /**
   * The preset being edited is the user's own, so it can be updated IN PLACE. False/absent for a
   * built-in, which mirrors BambuStudio: a system preset is editable but can only be saved as a
   * new user preset. Matches `FilamentSettingsDialogProps.canEditOriginal`.
   */
  canEditOriginal?: boolean
  /**
   * How the dialog resolves a preset's base config. Defaults to the WORKSPACE route
   * (`/api/slicing/profiles/resolve-process`). The public 3MF editor passes an anonymous resolver
   * (built-in presets via `/api/public/slicing/...`; project presets from the in-tab 3MF), so it can
   * run with no workspace. Additive — omitting it preserves the exact library behaviour.
   */
  resolveConfig?: ProcessConfigResolver
  /**
   * Optional caveat shown under the profile picker about what the "changed" markers are relative to.
   * The public editor sets it for a project that used a workspace CUSTOM preset (unavailable there),
   * where changes are shown against the standard preset it's based on rather than the custom one.
   */
  baselineNote?: string
  /**
   * Omitted for `applyScope: 'preset'`, which has nothing to apply to.
   *
   * `meta.clearedKeys` names keys the user RESET (relevant to per-object bulk editing, where the
   * caller merges per member: assign `overrides`, delete `clearedKeys`, and leave everything else
   * — the untouched "Mixed" keys — alone). Single-target callers may ignore it: there `overrides`
   * is the complete final map, so replacement is equivalent.
   */
  onApply?: (overrides: ProcessSettingOverrides, meta: { clearedKeys: string[] }) => void
}

/** Resolves a preset's base config for the dialog. See {@link ProcessSettingsDialogProps.resolveConfig}. */
export type ProcessConfigResolver = (request: {
  processProfileId: string
  targetId: string | null
  sourceFileId: string | null
}) => Promise<ResolveProcessConfigResponse>

/**
 * The one setting whose change offers a follow-up recommendation (see
 * `offerSupportRecommendation`). Not in `PER_OBJECT_PROCESS_KEYS`, so the prompt can only ever
 * appear in the global process dialog — per-object editing never reaches it.
 */
const SUPPORT_INTERFACE_FILAMENT_KEY = 'support_interface_filament'

/**
 * Display form of a recommended serialized scalar for the suggestion prompt: bools as on/off,
 * enum codes through the catalogue's labels, numbers with the option's unit. The combination
 * table changes up to a dozen settings — including turning support ON and switching its type —
 * so the prompt names what each setting becomes, not just which settings move.
 */
function formatRecommendedSettingValue(option: ProcessSettingOption | undefined, value: string): string {
  if (!option) return value
  if (option.type === 'bool') return value === '1' ? 'on' : 'off'
  if (option.type === 'enum') {
    const index = option.enumValues?.indexOf(value) ?? -1
    return option.enumLabels?.[index] ?? value
  }
  return option.sidetext ? `${value} ${option.sidetext}` : value
}

type ResolveResponse = {
  config: Record<string, string | string[]>
  baseConfig?: Record<string, string | string[]>
  /** The baseline preset's own parent — see `ResolveProcessConfigResponse`. */
  parentConfig?: Record<string, string | string[]>
  overriddenKeys?: string[]
  /** Whether the 3MF declared a changed-from-system record — see `ResolveProcessConfigResponse`. */
  declaresOverrides?: boolean
  /** Whether `baseConfig` is a real resolved preset — see `ResolveProcessConfigResponse`. */
  baselineResolved?: boolean
}

export default function ProcessSettingsDialog(props: ProcessSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, processProfileId, processProfileName, sourceFileId, initialOverrides, initialOverridesByMember, profileOptions, onProfileChange, allowedKeys, baseOverlay, titlePrefix, filamentChoices, applyScope = 'slice', canEditOriginal, resolveConfig, baselineNote, onApply } = props
  const allowedKeySet = useMemo(() => (allowedKeys ? new Set(allowedKeys) : null), [allowedKeys])
  const isKeyAllowed = (key: string): boolean => allowedKeySet === null || allowedKeySet.has(key)
  // Reveal BambuStudio's develop-tier options only when developer mode is on (workspace
  // default, optionally overridden per device — see useEffectiveSlicerDeveloperMode).
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
  const isOptionVisibleInMode = (option: ProcessSettingOption): boolean =>
    isProcessOptionVisibleInMode(option, showDeveloperOptions)
  // `baseConfig` is the preset baseline (reset target); `sliceBase` is the effective config the
  // slicer merges overrides onto (equal to baseConfig for installed presets, but the 3MF's
  // already-overridden config for a project profile). `bakedKeys` marks 3MF overrides whose
  // baseline value could not be resolved, so they still read as modified.
  const [baseConfig, setBaseConfig] = useState<ProcessConfig | null>(null)
  const [sliceBase, setSliceBase] = useState<ProcessConfig>({})
  // The baseline preset's OWN parent, for the emphasis-only third state. Null until resolved.
  const [parentBaseline, setParentBaseline] = useState<ProcessConfig | null>(null)
  const [bakedKeys, setBakedKeys] = useState<Set<string>>(new Set())
  /**
   * True when the 3MF declared a changed-from-system record, making `bakedKeys` the AUTHORITATIVE
   * modified set rather than an addition to the value diff. See `declaresOverrides` on the resolve
   * response: BambuStudio applies the declared list and normalizes everything else back to the
   * preset, so an undeclared difference is drift, not a user's change. False for a file that
   * recorded nothing, where the value diff is all we have.
   */
  const [declaresOverrides, setDeclaresOverrides] = useState(false)
  /**
   * False when the response carried no `baseConfig` — the named preset is not installed, so the
   * baseline is a copy of the profile's own values and a value diff can only ever be empty. The
   * declared record is then the only evidence of a change there is.
   */
  const [baselineResolved, setBaselineResolved] = useState(true)
  const [config, setConfig] = useState<ProcessConfig>({})
  // PER-OBJECT mode (baseOverlay present): the keys EXPLICITLY set as per-object overrides, tracked
  // apart from value equality. BambuStudio lists a per-object setting as "set" whenever it is present
  // in the object's config — even if its value matches the inherited one (it still PINS the value
  // against later global changes). We mirror that: an explicit override is shown (bold), counted, and
  // resettable (reset REMOVES it) regardless of whether its value differs. Unused in global mode
  // (empty), where overrides are the value-diff, so global behaviour is unchanged.
  const perObjectMode = Boolean(baseOverlay)
  const [explicitKeys, setExplicitKeys] = useState<Set<string>>(new Set())
  // BULK per-object mode (several members): keys the members disagree on. Shown as "Mixed";
  // editing one makes it uniform (leaves this set), resetting clears it from every member.
  const [mixedKeys, setMixedKeys] = useState<Set<string>>(new Set())
  // The explicit-key union AT LOAD, so apply can name the keys the user reset (`clearedKeys`).
  const [initialSetKeys, setInitialSetKeys] = useState<Set<string>>(new Set())
  /** Whether this dialog edits several members at once (enables the "Mixed" affordances). */
  const bulkSelection = (initialOverridesByMember?.length ?? 0) > 1
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [corrections, setCorrections] = useState<string[]>([])
  const [activePage, setActivePage] = useState(0)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [showChangedOnly, setShowChangedOnly] = useState(false)
  const normalizedQuery = query.trim().toLowerCase()
  const { confirm, promptText } = usePromptDialog()

  // Callers pass `visibilityContext` as a fresh object literal each render (e.g. the editor:
  // `visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}`), so identity-
  // keying this memo would recompute it — and the expensive `computeProcessFieldStates` below — on
  // every parent render while the dialog is open. Content-key it instead (mirrors `baseOverlayKey`).
  const visibilityContextKey = JSON.stringify(props.visibilityContext ?? null)
  const context: ProcessVisibilityContext = useMemo(
    () => ({ ...defaultProcessVisibilityContext, ...props.visibilityContext }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-keyed; read live value inside.
    [visibilityContextKey]
  )

  // Callers pass `baseOverlay`/`initialOverrides` as fresh object literals each render (e.g.
  // the per-part dialog: `baseOverlay={{ ...globalOverrides, ...objectOverrides }}`). Keying
  // the load effect on their identity would re-resolve the process config on every parent
  // re-render — flashing "Loading…" and resetting the form mid-edit. Depend on a stable
  // content hash instead so it reloads only when the values actually change.
  const baseOverlayKey = JSON.stringify(baseOverlay ?? null)
  const initialOverridesKey = JSON.stringify(initialOverridesByMember ?? initialOverrides ?? null)

  useEffect(() => {
    if (!open || !processProfileId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setBaseConfig(null)
    const resolve = resolveConfig
      ? resolveConfig({ processProfileId, targetId: slicerTargetId || null, sourceFileId: sourceFileId || null })
      : apiFetch<ResolveResponse>('/api/slicing/profiles/resolve-process', {
          method: 'POST',
          body: { processProfileId, targetId: slicerTargetId || null, sourceFileId: sourceFileId || null }
        })
    resolve
      .then((response) => {
        if (cancelled) return
        const effective = applyProcessConfigDefaults(response.config as ProcessConfig)
        if (baseOverlay) {
          // Per-object: the object inherits the global effective config (profile + global
          // overrides); that is both the slice base and the reset target.
          const globalEffective = applyProcessConfigDefaults({ ...effective, ...baseOverlay })
          setSliceBase(globalEffective)
          setBaseConfig(globalEffective)
          // A per-object override is measured against the OBJECT's inherited config, which has no
          // "parent preset" of its own — the distinction does not apply here.
          setParentBaseline(null)
          setBakedKeys(new Set())
          // Per-object: the inherited config IS the baseline, so it always resolves.
          setBaselineResolved(true)
          // Every key a member explicitly overrides is "set", value-matching or not. With several
          // members the form seeds from ALL of them: agreed keys carry their value, disagreements
          // become "Mixed" (holding the inherited value so field-state computation stays sane).
          const seed = summarizeBulkOverrides(
            initialOverridesByMember && initialOverridesByMember.length > 0 ? initialOverridesByMember : [initialOverrides]
          )
          setExplicitKeys(new Set(seed.explicitKeys))
          setInitialSetKeys(new Set(seed.explicitKeys))
          setMixedKeys(seed.mixedKeys)
          setConfig({ ...globalEffective, ...seed.uniformOverrides })
        } else {
          const baseline = applyProcessConfigDefaults((response.baseConfig ?? response.config) as ProcessConfig)
          setSliceBase(effective)
          setBaseConfig(baseline)
          setParentBaseline(response.parentConfig
            ? { ...baseline, ...applyProcessConfigDefaults(response.parentConfig as ProcessConfig) }
            : null)
          setBakedKeys(new Set(response.overriddenKeys ?? []))
          setDeclaresOverrides(response.declaresOverrides === true)
          setBaselineResolved(response.baselineResolved !== false)
          setExplicitKeys(new Set())
          setMixedKeys(new Set())
          setInitialSetKeys(new Set())
          setConfig({ ...effective, ...initialOverrides })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load process settings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
    // baseOverlay/initialOverrides are read inside but keyed by their JSON content above so
    // an unstable object identity from the caller doesn't re-fire this on every render.
    // baseOverlay/initialOverrides are read inside but keyed by their JSON content above so an
    // unstable object identity from the caller doesn't re-fire this on every render. `resolveConfig`
    // must be a STABLE reference (the host memoizes it), or this reloads every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, processProfileId, slicerTargetId, sourceFileId, initialOverridesKey, baseOverlayKey, resolveConfig])

  const fieldStates = useMemo(() => computeProcessFieldStates(config, context), [config, context])
  const accessor = useMemo(() => createProcessConfigAccessor(config), [config])

  /**
   * True when this project/session changed the key relative to the preset in use.
   *
   * The value must actually DIFFER from the preset — the same test the reset affordance uses — so a
   * key marked modified can always be reset and "Reset all" always clears the marks. BambuStudio
   * agrees: its modified marker is `PresetCollection::dirty_options`, a value diff against the
   * selected preset. The declared record decides which of the file's values SURVIVE loading
   * (`update_non_diff_values_to_base_config`), not what counts as changed.
   *
   * The exception is a preset that did not resolve (`baselineResolved` false): there is nothing to
   * diff against, so the record is the only evidence of a change and is taken at its word.
   * Declared here (before `pageHasContent`) so the tab-visibility and "changed only" filter can use it.
   */
  const isModified = (key: string): boolean => {
    if (baseConfig === null) return false
    // A per-object key that is explicitly set counts as modified even when its value matches the
    // inherited one (see `explicitKeys`) — it is still an override.
    if (perObjectMode && explicitKeys.has(key)) return true
    const option = processSettingsCatalog.options[key]
    if (!baselineResolved) return bakedKeys.has(key)
    if (processConfigValuesEqual(baseConfig[key], config[key], option)) return false
    // With a record present, an undeclared difference is version drift between the preset and the
    // file — which BambuStudio normalizes away, not the user's change. An in-session edit always
    // counts, because the user just made it.
    if (declaresOverrides
      && !bakedKeys.has(key)
      && processConfigValuesEqual(sliceBase[key], config[key], option)) return false
    return true
  }

  /** True when a key's VALUE differs from the baseline (the orange "changed" state, vs the plain
   * "explicitly set" bold). Distinct from {@link isModified}, which also flags value-matching
   * per-object overrides. */
  const isValueChanged = (key: string): boolean =>
    baseConfig !== null && !processConfigValuesEqual(baseConfig[key], config[key], processSettingsCatalog.options[key])

  /**
   * An override the PRESET itself carries relative to its parent — emphasis only, never counted and
   * never caught by "changed only". BambuStudio keeps this as a separate question from "modified"
   * (`current_different_from_parent_options` vs `current_dirty_options`), in a single non-virtual
   * `Tab::update_changed_ui` that every preset type shares — so this matches the material dialog's
   * `isPresetOverride` rather than being a process-specific idea.
   */
  const isPresetOverride = (key: string): boolean =>
    parentBaseline !== null && baseConfig !== null
    && !processConfigValuesEqual(parentBaseline[key], baseConfig[key], processSettingsCatalog.options[key])

  /**
   * What a changed value replaced. A project change is measured against the preset; an override the
   * preset carries is measured against its parent — so the hover names which baseline it is showing
   * rather than leaving "original" ambiguous between the two.
   */
  const originalOf = (key: string): { value: string; label: string } | null => {
    const asText = (value: string | string[] | undefined): string | null => {
      if (Array.isArray(value)) {
        const parts = value.map((entry) => String(entry ?? ''))
        const text = parts.every((entry) => entry === parts[0]) ? (parts[0] ?? '') : parts.join(' / ')
        return text === '' ? null : text
      }
      return value === undefined || value === '' ? null : String(value)
    }
    if (isValueChanged(key)) {
      const value = asText(baseConfig?.[key])
      return value === null ? null : { value, label: 'Preset value' }
    }
    if (isPresetOverride(key)) {
      const value = asText(parentBaseline?.[key])
      return value === null ? null : { value, label: 'Inherited value' }
    }
    return null
  }

  // Per-page count of the settings actually SHOWN under the active filters — the number in the tab
  // label. Zero (and hidden) when neither filter is on. It applies the same gates the rows render
  // behind (mode + conditional visibility), then the search match and/or the changed filter, so
  // searching WHILE "Changed only" is checked narrows the count further (the intersection).
  const filtersActive = Boolean(normalizedQuery) || showChangedOnly
  const pageShownCounts = useMemo(() => processSettingsCatalog.pages.map((page) => {
    if (!filtersActive) return 0
    let count = 0
    for (const group of page.groups) {
      for (const line of group.lines) {
        for (const key of line.keys) {
          const option = processSettingsCatalog.options[key]
          if (!option || !isOptionVisibleInMode(option) || !isKeyAllowed(key)) continue
          if (!getProcessFieldState(fieldStates.states, key).visible) continue
          if (normalizedQuery && !processKeyMatchesQuery(key, normalizedQuery)) continue
          if (showChangedOnly && !isModified(key)) continue
          count += 1
        }
      }
    }
    return count
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [filtersActive, normalizedQuery, showChangedOnly, fieldStates, allowedKeySet, config, baseConfig, bakedKeys, declaresOverrides, sliceBase, explicitKeys])

  /** Whether each page has any visible, allowed setting — pages with none are hidden entirely
   * (e.g. Speed when editing the restricted per-object subset). Independent of the search query. */
  const pageHasContent = useMemo(() => processSettingsCatalog.pages.map((page) =>
    page.groups.some((group) => group.lines.some((line) => line.keys.some((key) => {
      const option = processSettingsCatalog.options[key]
      if (!option || !isOptionVisibleInMode(option) || !isKeyAllowed(key) || !getProcessFieldState(fieldStates.states, key).visible) return false
      return !showChangedOnly || isModified(key)
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [fieldStates, allowedKeySet, showChangedOnly, config, baseConfig, bakedKeys, declaresOverrides, sliceBase, explicitKeys])

  // Keep the active tab on a page that still has content.
  useEffect(() => {
    if (pageHasContent[activePage]) return
    const firstVisible = pageHasContent.findIndex(Boolean)
    if (firstVisible >= 0 && firstVisible !== activePage) setActivePage(firstVisible)
  }, [pageHasContent, activePage])

  const commit = (next: ProcessConfig) => {
    // Apply BambuStudio's deterministic value clamps after each edit.
    const issues = validateProcessConfig(next)
    if (issues.length > 0) {
      const fixed = { ...next }
      for (const issue of issues) {
        for (const [key, value] of Object.entries(issue.fix)) fixed[key] = value
      }
      setConfig(fixed)
      setCorrections(issues.map((issue) => issue.message))
    } else {
      setConfig(next)
      setCorrections([])
    }
  }

  // Editing a per-object value makes that key an explicit override (it stays set until reset, even
  // if edited back to the inherited value) — BambuStudio's model. Editing also resolves a "Mixed"
  // key: the typed value now applies uniformly to every member.
  const markExplicit = (key: string) => {
    if (!perObjectMode) return
    setExplicitKeys((prev) => prev.has(key) ? prev : new Set(prev).add(key))
    setMixedKeys((prev) => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  const setValue = (key: string, value: string | string[]) => {
    markExplicit(key)
    commit({ ...config, [key]: value })
  }

  const setScalar = (key: string, scalar: string) => {
    markExplicit(key)
    const current = config[key]
    let value: string | string[] = scalar
    if (Array.isArray(current)) {
      const vector = [...current]
      vector[0] = scalar
      value = vector
    }
    const next = { ...config, [key]: value }
    commit(next)
    if (key === SUPPORT_INTERFACE_FILAMENT_KEY) void offerSupportRecommendation(next, scalar)
  }

  /**
   * BambuStudio's "Suggestion" prompt: choosing a support interface material that calls for a
   * different support geometry (soluble, a dedicated support material, or PLA over TPU) offers
   * the settings it recommends. Decision logic — including "the config already matches, say
   * nothing" — lives in `recommendSupportSettingsForInterfaceFilament`; this only asks and applies.
   *
   * Applies through `commit`, the same path a manual edit takes, so the proposed values land in
   * the dialog's config and ride the existing modified/reset markers and the Apply diff. Nothing
   * is written anywhere until the user hits Apply, exactly as with a hand edit.
   *
   * `nextConfig` is captured rather than re-read after the await: the confirm is a blocking modal
   * over this dialog, so no other edit can land in between.
   */
  const offerSupportRecommendation = async (nextConfig: ProcessConfig, interfaceScalar: string) => {
    if (!filamentChoices || filamentChoices.length === 0) return
    const accessorForNext = createProcessConfigAccessor(nextConfig)
    // The combination-table lookup needs to know which materials the plate's model objects
    // print with; only hosts with plate context declare `usedByPlateModels`. When none do,
    // pass undefined (host cannot tell) so the table path is skipped rather than treating
    // "unknown" as "no model materials".
    const declaresPlateModels = filamentChoices.some((choice) => choice.usedByPlateModels != null)
    const recommendation = recommendSupportSettingsForInterfaceFilament({
      interfaceFilamentId: Number.parseInt(interfaceScalar, 10) || 0,
      supportFilamentId: Number.parseInt(accessorForNext.str('support_filament'), 10) || 0,
      filaments: filamentChoices.map((choice) => ({
        id: choice.id,
        filamentType: choice.filamentType ?? null,
        filamentName: choice.materialName ?? choice.label,
        isSupport: choice.isSupport ?? null,
        isSoluble: choice.isSoluble ?? null
      })),
      modelFilamentIds: declaresPlateModels
        ? filamentChoices.filter((choice) => choice.usedByPlateModels).map((choice) => choice.id)
        : undefined,
      config: nextConfig
    })
    if (!recommendation) return

    const changedEntries = Object.entries(recommendation.changes).map(([key, value]) => {
      const option = processSettingsCatalog.options[key]
      return { key, label: option?.label ?? key, value: formatRecommendedSettingValue(option, value) }
    })
    const accepted = await confirm({
      title: 'Suggestion',
      description: (
        <Stack spacing={1}>
          <Typography level="body-sm">{recommendation.reason} We recommend changing:</Typography>
          <Stack component="ul" spacing={0.25} sx={{ pl: 2.5, my: 0 }}>
            {changedEntries.map((entry) => (
              <Typography key={entry.key} component="li" level="body-sm">
                {entry.label}: <Typography fontWeight="lg">{entry.value}</Typography>
              </Typography>
            ))}
          </Stack>
        </Stack>
      ),
      confirmLabel: 'Change them for me',
      cancelLabel: 'Leave them as they are'
    })
    if (!accepted) return
    commit(applySupportRecommendationChanges(nextConfig, recommendation.changes))
  }

  /** Reverts a key to its resolved system value (BambuStudio "back to system value"). */
  const resetKey = (key: string) => {
    if (!baseConfig) return
    const next = { ...config }
    if (baseConfig[key] === undefined) delete next[key]
    else next[key] = baseConfig[key]
    // Resetting a per-object override REMOVES it (the object goes back to inheriting the global),
    // even when its value already matched — that is the whole point of the "set but matching" case.
    // On a "Mixed" key, reset clears the override from EVERY member (back to inherited for all).
    if (perObjectMode && explicitKeys.has(key)) {
      setExplicitKeys((prev) => { const nextKeys = new Set(prev); nextKeys.delete(key); return nextKeys })
      setMixedKeys((prev) => {
        if (!prev.has(key)) return prev
        const nextKeys = new Set(prev)
        nextKeys.delete(key)
        return nextKeys
      })
    }
    commit(next)
  }

  /** True when a key can be reset — a value differs from the baseline, OR (per-object) it is an
   * explicit override that reset would remove even though its value matches. */
  const canReset = (key: string): boolean => {
    if (baseConfig === null) return false
    if (perObjectMode && explicitKeys.has(key)) return true
    return isValueChanged(key)
  }

  // Count/flag ONLY keys the user can actually see and reset — the same gates the rows render
  // behind (`isOptionVisibleInMode` + the CONDITIONAL `getProcessFieldState(...).visible`, which
  // hides a setting whose controlling toggle is off). Without the conditional gate a modified but
  // hidden key lit its tab and the "*" with no changed row to show for it.
  const isModifiedAndVisible = (key: string): boolean => {
    const option = processSettingsCatalog.options[key]
    if (!option || !isOptionVisibleInMode(option) || !isKeyAllowed(key)) return false
    if (!getProcessFieldState(fieldStates.states, key).visible) return false
    return isModified(key)
  }
  /**
   * Differs from what is SAVED — an edit made in this session, as opposed to an override the preset
   * already carries relative to its parent. BambuStudio colours only the former (Tab.cpp
   * `update_changed_ui`: a value equal to the last saved one takes the default text colour, a value
   * differing from it takes `m_modified_label_clr`).
   */
  const isUnsaved = (key: string): boolean =>
    !processConfigValuesEqual(sliceBase[key], config[key], processSettingsCatalog.options[key])

  const modifiedKeyCount = useMemo(() => {
    if (!baseConfig) return 0
    return Object.keys(processSettingsCatalog.options).filter((key) => isModifiedAndVisible(key)).length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConfig, config, bakedKeys, sliceBase, allowedKeySet, fieldStates, explicitKeys])

  const modifiedPages = useMemo(() => {
    if (!baseConfig) return new Set<number>()
    const result = new Set<number>()
    processSettingsCatalog.pages.forEach((page, index) => {
      const anyModified = page.groups.some((group) =>
        group.lines.some((line) => line.keys.some((key) => isModifiedAndVisible(key)))
      )
      if (anyModified) result.add(index)
    })
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseConfig, config, bakedKeys, sliceBase, allowedKeySet, fieldStates, explicitKeys])

  /**
   * The overrides to emit. Per-object mode preserves EVERY explicitly-set key (even one whose value
   * matches the inherited config), so a value-matching pin survives an apply instead of being
   * dropped by the value-diff — while still-mixed keys are emitted in NEITHER set, which is what
   * lets each member keep its own value. Global mode emits the value-diff relative to the slice
   * base so baked-but-untouched keys aren't re-sent.
   */
  const computeAppliedOverrides = (): { overrides: ProcessSettingOverrides; clearedKeys: string[] } => {
    if (perObjectMode) {
      return collectBulkOverridesResult({ config, explicitKeys, mixedKeys, initialSetKeys })
    }
    return { overrides: diffProcessConfig(sliceBase, config), clearedKeys: [] }
  }

  const handleApply = () => {
    if (!baseConfig) return
    const result = computeAppliedOverrides()
    onApply?.(result.overrides, { clearedKeys: result.clearedKeys })
    onClose()
  }

  /** Reverts every setting to the preset baseline (BambuStudio "reset to default"). In bulk
   * per-object mode that clears every member's overrides, mixed ones included. */
  const handleResetAll = () => {
    if (!baseConfig) return
    setConfig({ ...baseConfig })
    setExplicitKeys(new Set())
    setMixedKeys(new Set())
    setCorrections([])
  }

  /** Save the edited process as a preset. `overwrite` updates the original custom preset in place. */
  const savePreset = async (name: string, overwrite: boolean) => {
    setSaving(true)
    setError(null)
    try {
      const presetConfig: Record<string, string | string[]> = { ...config, name, type: 'process' }
      await apiFetch('/api/slicing/profiles', {
        method: 'POST',
        body: {
          kind: 'process',
          fileName: `${name}.json`,
          encoding: 'utf8',
          overwrite,
          content: JSON.stringify(presetConfig, null, 2)
        }
      })
      const result = computeAppliedOverrides()
      onApply?.(result.overrides, { clearedKeys: result.clearedKeys })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preset')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAsPreset = async () => {
    if (!baseConfig) return
    const name = await promptText({
      title: 'Save as custom process preset',
      label: 'Preset name',
      initialValue: `${processProfileName} (custom)`,
      confirmLabel: 'Save preset'
    })
    if (!name || !name.trim()) return
    await savePreset(name.trim(), false)
  }

  const handleUpdateOriginal = async () => {
    if (!baseConfig) return
    await savePreset(processProfileName, true)
  }

  const pages = processSettingsCatalog.pages

  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 720, width: '100%' }}>
        <Typography level="h4">{titlePrefix ?? 'Process settings'} — {modifiedKeyCount > 0 ? '*' : ''}{processProfileName}</Typography>
        {profileOptions && profileOptions.length > 1 && onProfileChange && (
          <FormControl size="sm" sx={{ mt: 1 }}>
            <FormLabel>Preset</FormLabel>
            {/* Same grouped/sorted picker as the slice panel's process dropdown, so the two
                surfaces present the catalog identically (groups, ordering, tooltips). */}
            <SlicingPresetAutocomplete
              profiles={profileOptions}
              value={profileOptions.find((profile) => profile.id === processProfileId) ?? null}
              placeholder="Choose a process preset"
              ariaLabel="Process preset"
              onChange={(profile) => {
                if (profile && profile.id !== processProfileId && baseConfig) {
                  // Carry modifications (vs the current preset baseline) onto the new profile.
                  onProfileChange(profile.id, diffProcessConfig(baseConfig, config))
                }
              }}
            />
          </FormControl>
        )}
        {baselineNote && !loading && !error && (
          <Alert color="neutral" variant="soft" size="sm" startDecorator={<InfoOutlinedIcon fontSize="small" />} sx={{ mt: 1 }}>
            <Typography level="body-xs">{baselineNote}</Typography>
          </Alert>
        )}
        {loading && (
          <ScrollableDialogBody sx={{ mt: 1, px: 0 }}>
            <Stack alignItems="center" justifyContent="center" sx={{ py: 6 }} spacing={1}>
              <CircularProgress />
              <Typography level="body-sm">Loading process settings…</Typography>
            </Stack>
          </ScrollableDialogBody>
        )}
        {!loading && error && (
          <ScrollableDialogBody sx={{ mt: 1, px: 0 }}>
            <Alert color="danger" sx={{ m: 2 }}>{error}</Alert>
          </ScrollableDialogBody>
        )}
        {!loading && !error && baseConfig && (
          <Tabs
            value={activePage}
            onChange={(_event, value) => setActivePage(typeof value === 'number' ? value : 0)}
            orientation="horizontal"
            sx={{ mt: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', bgcolor: 'transparent' }}
          >
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0, mb: 1, flexWrap: 'wrap' }}>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings…"
                size="sm"
                startDecorator={<Box component="span" sx={{ display: 'inline-flex', fontSize: 18, opacity: 0.6 }}><SearchRoundedIcon fontSize="inherit" /></Box>}
                endDecorator={query ? (
                  <IconButton size="sm" variant="plain" color="neutral" onClick={() => setQuery('')} aria-label="Clear search">
                    <Box component="span" sx={{ display: 'inline-flex', fontSize: 16 }}><CloseRoundedIcon fontSize="inherit" /></Box>
                  </IconButton>
                ) : undefined}
                sx={{ flex: 1, minWidth: 160 }}
              />
              <Checkbox
                size="sm"
                label="Changed only"
                checked={showChangedOnly}
                onChange={(event) => setShowChangedOnly(event.target.checked)}
                disabled={modifiedKeyCount === 0 && !showChangedOnly}
              />
            </Stack>
            <TabList
              sx={{
                overflowX: 'auto',
                flexWrap: 'nowrap',
                flexShrink: 0,
                // The list scrolls rather than wraps (overflowX/nowrap above), but a Tab defaults to
                // `white-space: normal` and is shrinkable — so instead of scrolling, tabs squeezed
                // below their text and wrapped onto two lines while the row still had slack. Pinning
                // each tab to its own width is what makes the scroll actually engage.
                '& > *': { flexShrink: 0, whiteSpace: 'nowrap' }
              }}
            >
              {pages.map((page, index) => pageHasContent[index] ? (
                <Tab
                  key={page.id}
                  value={index}
                  sx={modifiedPages.has(index) ? { color: 'warning.plainColor', fontWeight: 700 } : undefined}
                >
                  {page.title}{filtersActive ? ` (${pageShownCounts[index] ?? 0})` : ''}
                </Tab>
              ) : null)}
            </TabList>
            <ScrollableDialogBody sx={{ mt: 0, px: 0 }}>
              {showChangedOnly && modifiedKeyCount === 0 && (
                <Typography level="body-sm" textColor="text.tertiary" sx={{ p: 2 }}>No changed settings.</Typography>
              )}
              {corrections.length > 0 && (
                <Alert color="warning" size="sm" sx={{ m: 1 }}>
                  <Stack spacing={0.25}>
                    {corrections.map((message) => <Typography key={message} level="body-xs">{message}</Typography>)}
                  </Stack>
                </Alert>
              )}
              {pages.map((page, index) => (
                // No horizontal padding: the group cards must line up with the tabs/search/profile
                // above, which sit at the dialog's own inner edge. `p: 2` here pushed them in 16px on
                // each side. Vertical padding stays for breathing room from the tab list + footer.
                <TabPanel key={page.id} value={index} sx={{ px: 0, py: 2 }}>
                  <Stack spacing={2}>
                    {page.groups.map((group) => {
                      const visibleLines = group.lines.filter((line) =>
                        line.keys.some((key) => {
                          const option = processSettingsCatalog.options[key]
                          if (!option || !isOptionVisibleInMode(option) || !isKeyAllowed(key)) return false
                          if (!getProcessFieldState(fieldStates.states, key).visible) return false
                          if (normalizedQuery && !processKeyMatchesQuery(key, normalizedQuery)) return false
                          return !showChangedOnly || isModified(key)
                        })
                      )
                      if (visibleLines.length === 0) return null
                      return (
                        <DialogSection key={group.title} title={group.title}>
                          <Stack spacing={1.25}>
                            {visibleLines.map((line, lineIndex) => (
                              <ProcessSettingLineRow
                                key={`${group.title}-${lineIndex}`}
                                lineLabel={line.label}
                                keys={line.keys.filter(isKeyAllowed)}
                                showDeveloperOptions={showDeveloperOptions}
                                code={line.code}
                                fullWidth={line.fullWidth}
                                fieldStates={fieldStates}
                                accessor={accessor}
                                config={config}
                                perObjectMode={perObjectMode}
                                bulkSelection={bulkSelection}
                                isMixed={(key) => mixedKeys.has(key)}
                                isModified={isModified}
                                isUnsaved={isUnsaved}
                                isValueChanged={isValueChanged}
                                isPresetOverride={isPresetOverride}
                                originalOf={originalOf}
                                canReset={canReset}
                                onReset={resetKey}
                                onScalarChange={setScalar}
                                onValueChange={setValue}
                                filamentChoices={filamentChoices}
                              />
                            ))}
                          </Stack>
                        </DialogSection>
                      )
                    })}
                  </Stack>
                </TabPanel>
              ))}
            </ScrollableDialogBody>
          </Tabs>
        )}
        <Divider />
        <DialogActions sx={{ justifyContent: 'space-between' }}>
          <Button
            variant="plain"
            color="warning"
            onClick={handleResetAll}
            disabled={loading || !baseConfig || saving || modifiedKeyCount === 0}
            startDecorator={<Box component="span" sx={{ display: 'inline-flex', fontSize: 16 }}><RestartAltRoundedIcon fontSize="inherit" /></Box>}
          >
            Reset all
          </Button>
          <Stack direction="row" spacing={1}>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>Cancel</Button>
            {/*
              PER-OBJECT mode has no preset destination: the edit is a SUBSET of keys layered on the
              project's process (`allowedKeys` + `baseOverlay`), so "save as preset" would mint a
              full process preset silently carrying the whole inherited config. With one destination
              left, naming it ("Apply to this project") implies a choice that does not exist — the
              title already says whose settings these are ("Object settings — <name>").
            */}
            {!perObjectMode && canEditOriginal && (
              <Button variant="outlined" onClick={handleUpdateOriginal} disabled={loading || !baseConfig || saving} loading={saving}>
                Update preset
              </Button>
            )}
            {!perObjectMode && (
              <Button variant="outlined" onClick={handleSaveAsPreset} disabled={loading || !baseConfig || saving} loading={saving}>
                Save as preset
              </Button>
            )}
            {applyScope !== 'preset' && (
              <Button variant="solid" onClick={handleApply} disabled={loading || !baseConfig || saving}>
                {perObjectMode ? 'Apply' : applyScope === 'project' ? 'Apply to this project' : 'Apply to this slice'}
              </Button>
            )}
          </Stack>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}

/** Case-insensitive match of a setting against the search query (label, key, or tooltip). */
function processKeyMatchesQuery(key: string, normalizedQuery: string): boolean {
  const option = processSettingsCatalog.options[key]
  if (!option) return false
  return option.label.toLowerCase().includes(normalizedQuery)
    || key.toLowerCase().includes(normalizedQuery)
    || (option.tooltip?.toLowerCase().includes(normalizedQuery) ?? false)
}

interface ProcessSettingLineRowProps {
  lineLabel?: string
  keys: string[]
  /** Whether BambuStudio develop-tier options are revealed (developer-mode preference). */
  showDeveloperOptions: boolean
  code?: boolean
  /** The line spans the row (BambuStudio's full-width lines: Notes and the G-code editors). */
  fullWidth?: boolean
  fieldStates: ReturnType<typeof computeProcessFieldStates>
  accessor: ReturnType<typeof createProcessConfigAccessor>
  config: ProcessConfig
  /** Per-object dialog: enables the "set but value-matching" (dot + bold) treatment. */
  perObjectMode: boolean
  /** Editing several members at once — adjusts the "set" copy from "this object" to the selection. */
  bulkSelection: boolean
  /** The members disagree on this key (bulk editing): render the "Mixed" state. */
  isMixed: (key: string) => boolean
  isModified: (key: string) => boolean
  isUnsaved: (key: string) => boolean
  /** Value differs from the baseline (the orange "changed" state), vs merely being explicitly set. */
  isValueChanged: (key: string) => boolean
  /** The PRESET's own override of its parent — emphasis only, never counted. */
  isPresetOverride: (key: string) => boolean
  /** The baseline a changed value replaced, for the hover. */
  originalOf: (key: string) => { value: string; label: string } | null
  canReset: (key: string) => boolean
  onReset: (key: string) => void
  onScalarChange: (key: string, value: string) => void
  onValueChange: (key: string, value: string | string[]) => void
  filamentChoices?: SettingFilamentChoice[]
}

function ProcessSettingLineRow(props: ProcessSettingLineRowProps): JSX.Element | null {
  const { keys, lineLabel, showDeveloperOptions, code, fullWidth, fieldStates, accessor, perObjectMode, bulkSelection, isMixed, isModified, isUnsaved, isValueChanged, isPresetOverride, originalOf, canReset, onReset, onScalarChange, filamentChoices } = props
  const visibleKeys = keys.filter((key) => {
    const option = processSettingsCatalog.options[key]
    return option && isProcessOptionVisibleInMode(option, showDeveloperOptions) && getProcessFieldState(fieldStates.states, key).visible
  })
  if (visibleKeys.length === 0) return null

  const firstKey = visibleKeys[0] ?? keys[0] ?? ''
  const firstOption = processSettingsCatalog.options[firstKey]
  const label = lineLabel ?? firstOption?.label ?? firstKey
  // Label states: a value that DIFFERS from the baseline is orange+bold ("changed"). In PER-OBJECT
  // mode a setting that is merely explicitly SET (its value matches the inherited one) is
  // full-contrast + bold with a leading dot ("set", clearer than BambuStudio's bold alone). An
  // inherited setting is the muted default. The global dialog keeps its original orange-for-modified
  // styling (no per-object "set" distinction there).
  const lineValueChanged = visibleKeys.some((key) => isValueChanged(key))
  const lineModified = visibleKeys.some((key) => isModified(key))
  const lineUnsaved = visibleKeys.some((key) => isUnsaved(key))
  const lineMixed = visibleKeys.some((key) => isMixed(key))
  // Full-width lines take the label above and the whole row: the G-code editors and Notes.
  const spansRow = Boolean(code || fullWidth)
  const lineSetOnly = perObjectMode && lineModified && !lineValueChanged
  // Three "set" flavours behind the one dot: mixed across a bulk selection, uniformly set on a
  // bulk selection, or set on the single object — each names what reset will do.
  const setDotTooltip = lineMixed
    ? 'Set to different values across the selection — edit to apply one value to everything, or reset to clear it everywhere'
    : bulkSelection
      ? 'Set on every selected item (matches the inherited value) — reset to inherit'
      : 'Set for this object (matches the inherited value) — reset to inherit'
  // Outside per-object mode this is the same three-state rule per-object mode already used, applied
  // to the preset: an UNSAVED edit is coloured, an override the preset carries is bold only.
  const labelColor = perObjectMode
    ? (lineValueChanged ? 'warning.plainColor' : (lineSetOnly ? 'text.primary' : undefined))
    : (lineUnsaved ? 'warning.plainColor' : undefined)

  // See the note at its use: one control -> FormControl (so the label is really associated);
  // several -> a plain Box, because each control carries its own label.
  // Cast: both accept children and no required props, but a union of two component types is not
  // callable as a JSX tag.
  const RowRoot = (visibleKeys.length === 1 ? FormControl : Box) as typeof Box
  return (
    // A Joy FormControl may contain exactly ONE control, and it labels that control. A row with
    // several visible keys is one setting per extruder variant — several controls, each labelling
    // itself via `showOwnLabel` — so wrapping those in a FormControl is both a Joy error (logged on
    // every render) and a false label association. Use it only when there really is one control.
    <RowRoot>
      {/* Same rule as the filament dialog: a G-code editor takes the label above and the full row
          width rather than sitting in the value column at its minimum size. */}
      <Stack direction={spansRow ? 'column' : { xs: 'column', sm: 'row' }} spacing={1} alignItems={spansRow ? 'stretch' : { sm: 'center' }}>
        <Box sx={{ minWidth: spansRow ? undefined : { sm: 220 }, flexShrink: 0 }}>
          <FormLabel sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.5,
            color: labelColor,
            fontWeight: lineModified || lineUnsaved ? 'xl' : undefined
          }}>
            {lineSetOnly && (
              <Tooltip title={setDotTooltip} variant="soft">
                <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'primary.solidBg', flexShrink: 0 }} />
              </Tooltip>
            )}
            {label}
            {firstOption?.tooltip && (
              <Tooltip title={firstOption.tooltip} variant="soft" sx={{ maxWidth: 320 }}>
                <Box component="span" sx={{ display: 'inline-flex', fontSize: 16, opacity: 0.6 }}>
                  <InfoOutlinedIcon fontSize="inherit" />
                </Box>
              </Tooltip>
            )}
          </FormLabel>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flex: 1, flexWrap: 'wrap', justifyContent: spansRow ? 'stretch' : { sm: 'flex-end' }, width: spansRow ? '100%' : undefined }}>
          {visibleKeys.map((key) => {
            const option = processSettingsCatalog.options[key]
            if (!option) return null
            const enabled = getProcessFieldState(fieldStates.states, key).enabled
            const enumRestriction = fieldStates.enumRestrictions.get(key)
            return (
              <Stack key={key} direction="row" spacing={0.25} alignItems="center" sx={spansRow ? { flex: 1, minWidth: 0 } : undefined}>
                <SettingValueField
                  settingKey={key}
                  option={option}
                  value={accessor.str(key)}
                  enabled={enabled}
                  enumRestriction={enumRestriction}
                  showOwnLabel={visibleKeys.length > 1}
                  modified={isPresetOverride(key)}
                  unsaved={isValueChanged(key)}
                  mixed={isMixed(key)}
                  original={originalOf(key)}
                  filamentChoices={filamentChoices}
                  onScalarChange={onScalarChange}
                  isCode={code}
                />
                {canReset(key) && (
                  <Tooltip title="Reset to preset default" variant="soft">
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="warning"
                      aria-label={`Reset ${option.label} to default`}
                      onClick={() => onReset(key)}
                      sx={{ '--IconButton-size': '1.75rem' }}
                    >
                      <Box component="span" sx={{ display: 'inline-flex', fontSize: 16 }}>
                        <RestartAltRoundedIcon fontSize="inherit" />
                      </Box>
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
            )
          })}
        </Stack>
      </Stack>
    </RowRoot>
  )
}

