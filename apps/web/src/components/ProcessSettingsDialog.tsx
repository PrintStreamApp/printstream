/**
 * Process (quality) settings editor dialog.
 *
 * Owns the Bambu-faithful process VALUE SPACE: resolving a preset's base config, BambuStudio's
 * conditional visibility/enable rules, its value-coercion clamps, and what counts as changed
 * against a preset, a project's baked overrides, or an object's inherited config. The chrome it
 * renders inside, tabs, search, "Changed only", the footer, belongs to
 * `settings/SettingsCatalogDialog.tsx`, which the filament and machine editors share; this dialog
 * reaches it through a {@link SettingsCatalogAdapter}. The user edits values against the resolved
 * base config; the dialog emits the sparse override map (changed keys) back to the slice dialog and
 * can optionally persist the result as a reusable custom process preset.
 *
 * The catalog's `develop`-tier options are hidden unless developer mode is on
 * (`useEffectiveSlicerDeveloperMode`: the workspace default from the Slicing
 * settings page, optionally overridden per device); the shell applies that gate.
 *
 * Per-object mode (`baseOverlay` present) additionally supports BULK editing, one dialog for a
 * multi-selection of objects or parts (`initialOverridesByMember`): keys the members disagree on
 * render as "Mixed" and, untouched, keep each member's own value on apply. The seed/apply rules
 * live in `lib/processBulkOverrides.ts`.
 */
import { useEffect, useMemo, useState } from 'react'
import { FormControl, FormLabel, Stack, Typography } from '@mui/joy'
import {
  applyProcessConfigDefaults,
  applySupportRecommendationChanges,
  computeProcessFieldStates,
  createProcessConfigAccessor,
  defaultProcessVisibilityContext,
  diffProcessConfig,
  getProcessFieldState,
  processConfigValuesEqual,
  processSettingsCatalog,
  recommendSupportSettingsForInterfaceFilament,
  validateProcessConfig,
  type ProcessSettingOverrides,
  type ProcessVisibilityContext,
  describeSettingsBaseline,
  type ProcessConfig,
  type ResolveProcessConfigResponse,
  type SettingsBaselineOrigin,
  type SlicingPresetSummary
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { collectBulkOverridesResult, summarizeBulkOverrides } from '../lib/processBulkOverrides'
import { useEffectiveSlicerDeveloperMode } from '../lib/slicerDeveloperMode'
import { SlicingPresetAutocomplete } from './library/SlicingPresetAutocomplete'
import { usePromptDialog } from './PromptDialogProvider'
import { SettingsCatalogDialog } from './settings/SettingsCatalogDialog'
import { SettingsBaselineNote } from './settings/SettingsBaselineNote'
import { formatSettingValueForDisplay } from './settings/settingValueDisplay'
import { resolveWorkspaceProcessConfig } from './workspaceProcessResolver'
import type { SettingsCatalogAdapter } from './settings/settingsCatalogAdapter'
import type { SettingFilamentChoice } from './settings/SettingValueField'

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
   * selection order. When present with more than one entry, the dialog seeds from ALL of them:
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
  /** Search text to open the catalog with, from the cross-catalog settings search. */
  initialQuery?: string
  /**
   * The project's materials for filament-index settings (support/raft base+interface,
   * walls/infill filament): see {@link SettingValueField}. Omitted, those fall back to
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
   * 'preset' edits the stored preset ITSELF: opened from the slicer-profiles settings, where
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
   * run with no workspace. Additive: omitting it preserves the exact library behaviour.
   */
  resolveConfig?: ProcessConfigResolver
  /**
   * Omitted for `applyScope: 'preset'`, which has nothing to apply to.
   *
   * `meta.clearedKeys` names keys the user RESET (relevant to per-object bulk editing, where the
   * caller merges per member: assign `overrides`, delete `clearedKeys`, and leave everything else,
   * the untouched "Mixed" keys: alone). Single-target callers may ignore it: there `overrides`
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
 * appear in the global process dialog: per-object editing never reaches it.
 */
const SUPPORT_INTERFACE_FILAMENT_KEY = 'support_interface_filament'

/*
 * The suggestion prompt's value formatting lives in `settings/settingValueDisplay.ts`: the
 * parameter table renders the same settings and has to say the same thing about them. It stays
 * lower case here because the prompt reads the value inside a sentence.
 */

export default function ProcessSettingsDialog(props: ProcessSettingsDialogProps): JSX.Element {
  const { open, onClose, slicerTargetId, processProfileId, processProfileName, sourceFileId, initialOverrides, initialOverridesByMember, profileOptions, onProfileChange, allowedKeys, baseOverlay, titlePrefix, filamentChoices, applyScope = 'slice', canEditOriginal, initialQuery, resolveConfig, onApply } = props
  const allowedKeySet = useMemo(() => (allowedKeys ? new Set(allowedKeys) : null), [allowedKeys])
  const isKeyAllowed = (key: string): boolean => allowedKeySet === null || allowedKeySet.has(key)
  // Reveal BambuStudio's develop-tier options only when developer mode is on (workspace
  // default, optionally overridden per device: see useEffectiveSlicerDeveloperMode). The shell
  // applies the tier gate itself; this only tells it which mode it is in.
  const showDeveloperOptions = useEffectiveSlicerDeveloperMode()
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
   * False when the response carried no `baseConfig`: the named preset is not installed, so the
   * baseline is a copy of the profile's own values and a value diff can only ever be empty. The
   * declared record is then the only evidence of a change there is.
   */
  const [baselineResolved, setBaselineResolved] = useState(true)
  /**
   * What the change markers ended up being measured against, straight from the resolver. Held here
   * rather than taken as a prop so the caveat can never disagree with the config it describes, a
   * host computing it separately answered per PRESET while the resolver answers per REQUEST.
   */
  const [baselineOrigin, setBaselineOrigin] = useState<SettingsBaselineOrigin | undefined>(undefined)
  const [config, setConfig] = useState<ProcessConfig>({})
  // PER-OBJECT mode (baseOverlay present): the keys EXPLICITLY set as per-object overrides, tracked
  // apart from value equality. BambuStudio lists a per-object setting as "set" whenever it is present
  // in the object's config, even if its value matches the inherited one (it still PINS the value
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
  const [saving, setSaving] = useState(false)
  const { confirm, promptText } = usePromptDialog()

  // Callers pass `visibilityContext` as a fresh object literal each render (e.g. the editor:
  // `visibilityContext={{ ...perObject.visibilityContext, isGlobalConfig: false }}`), so identity-
  // keying this memo would recompute it, and the expensive `computeProcessFieldStates` below, on
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
  // re-render: flashing "Loading…" and resetting the form mid-edit. Depend on a stable
  // content hash instead so it reloads only when the values actually change.
  const baseOverlayKey = JSON.stringify(baseOverlay ?? null)
  const initialOverridesKey = JSON.stringify(initialOverridesByMember ?? initialOverrides ?? null)

  useEffect(() => {
    if (!open || !processProfileId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setBaseConfig(null)
    // Same shape as the filament dialog's default branch, and it is what type-checks that the
    // workspace resolver still satisfies the seam a host may replace.
    const resolve = (resolveConfig ?? resolveWorkspaceProcessConfig)({
      processProfileId,
      targetId: slicerTargetId || null,
      sourceFileId: sourceFileId || null
    })
    resolve
      .then((response) => {
        if (cancelled) return
        const effective = applyProcessConfigDefaults(response.config)
        if (baseOverlay) {
          // Per-object: the object inherits the global effective config (profile + global
          // overrides); that is both the slice base and the reset target.
          const globalEffective = applyProcessConfigDefaults({ ...effective, ...baseOverlay })
          setSliceBase(globalEffective)
          setBaseConfig(globalEffective)
          // A per-object override is measured against the OBJECT's inherited config, which has no
          // "parent preset" of its own: the distinction does not apply here.
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
          const baseline = applyProcessConfigDefaults(response.baseConfig)
          setSliceBase(effective)
          setBaseConfig(baseline)
          setParentBaseline(response.parentConfig
            ? { ...baseline, ...applyProcessConfigDefaults(response.parentConfig) }
            : null)
          setBakedKeys(new Set(response.overriddenKeys))
          setDeclaresOverrides(response.declaresOverrides === true)
          setBaselineResolved(response.baselineResolved !== false)
          setBaselineOrigin(response.baselineOrigin)
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
   * The value must actually DIFFER from the preset, the same test the reset affordance uses, so a
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
    // inherited one (see `explicitKeys`), it is still an override.
    if (perObjectMode && explicitKeys.has(key)) return true
    const option = processSettingsCatalog.options[key]
    if (!baselineResolved) return bakedKeys.has(key)
    if (processConfigValuesEqual(baseConfig[key], config[key], option)) return false
    // With a record present, an undeclared difference is version drift between the preset and the
    // file, which BambuStudio normalizes away, not the user's change. An in-session edit always
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
   * An override the PRESET itself carries relative to its parent: emphasis only, never counted and
   * never caught by "changed only". BambuStudio keeps this as a separate question from "modified"
   * (`current_different_from_parent_options` vs `current_dirty_options`), in a single non-virtual
   * `Tab::update_changed_ui` that every preset type shares, so this matches the material dialog's
   * `isPresetOverride` rather than being a process-specific idea.
   */
  const isPresetOverride = (key: string): boolean =>
    parentBaseline !== null && baseConfig !== null
    && !processConfigValuesEqual(parentBaseline[key], baseConfig[key], processSettingsCatalog.options[key])

  /**
   * What a changed value replaced. A project change is measured against the preset; an override the
   * preset carries is measured against its parent, so the hover names which baseline it is showing
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

  /**
   * Whether a key renders at all: allowed by the per-object subset, and not hidden by the
   * conditional engine (a setting whose controlling toggle is off). Developer-tier gating and the
   * search/changed filters are the shell's job, this is the part only this dialog can answer.
   */
  const isKeyVisible = (key: string): boolean =>
    isKeyAllowed(key) && getProcessFieldState(fieldStates.states, key).visible

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
  // if edited back to the inherited value): BambuStudio's model. Editing also resolves a "Mixed"
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
   * the settings it recommends. Decision logic, including "the config already matches, say
   * nothing", lives in `recommendSupportSettingsForInterfaceFilament`; this only asks and applies.
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
      return { key, label: option?.label ?? key, value: formatSettingValueForDisplay(option, value) }
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
    // even when its value already matched, that is the whole point of the "set but matching" case.
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

  /** True when a key can be reset, a value differs from the baseline, OR (per-object) it is an
   * explicit override that reset would remove even though its value matches. */
  const canReset = (key: string): boolean => {
    if (baseConfig === null) return false
    if (perObjectMode && explicitKeys.has(key)) return true
    return isValueChanged(key)
  }

  /**
   * Differs from what is SAVED, an edit made in this session, as opposed to an override the preset
   * already carries relative to its parent. BambuStudio colours only the former (Tab.cpp
   * `update_changed_ui`: a value equal to the last saved one takes the default text colour, a value
   * differing from it takes `m_modified_label_clr`).
   */
  const isUnsaved = (key: string): boolean =>
    !processConfigValuesEqual(sliceBase[key], config[key], processSettingsCatalog.options[key])

  /**
   * The overrides to emit. Per-object mode preserves EVERY explicitly-set key (even one whose value
   * matches the inherited config), so a value-matching pin survives an apply instead of being
   * dropped by the value-diff, while still-mixed keys are emitted in NEITHER set, which is what
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

  /**
   * Everything the shared shell needs that only this dialog can answer: how to read and write a
   * value (element 0 of a per-variant vector, as BambuStudio's process tab does), and what each of
   * the change states means here.
   */
  const adapter: SettingsCatalogAdapter = {
    columnsFor: (key) => {
      const option = processSettingsCatalog.options[key]
      if (!option) return []
      return [{
        id: key,
        settingKey: key,
        value: accessor.str(key),
        enabled: getProcessFieldState(fieldStates.states, key).enabled,
        enumRestriction: fieldStates.enumRestrictions.get(key),
        mixed: mixedKeys.has(key),
        onChange: (value) => setScalar(key, value)
      }]
    },
    isModified,
    isUnsaved,
    // The FIELD marks any value differing from the preset baseline, while the LINE marks only what
    // this session changed relative to the effective slice base, a 3MF's baked overrides sit
    // between the two, and collapsing them would either hide a real deviation or colour one the
    // user did not make.
    isFieldChanged: isValueChanged,
    isPresetOverride,
    canReset,
    onReset: resetKey,
    originalOf,
    // The per-object "set, but matching what it inherits" state: an explicit pin with no value
    // difference to show, which is still resettable. Three flavours behind the one dot, each
    // naming what reset will do.
    lineMarker: (keys) => {
      if (!perObjectMode) return null
      if (!keys.some((key) => isModified(key))) return null
      if (keys.some((key) => isValueChanged(key))) return null
      if (keys.some((key) => mixedKeys.has(key))) {
        return { tooltip: 'Set to different values across the selection: edit to apply one value to everything, or reset to clear it everywhere' }
      }
      return {
        tooltip: bulkSelection
          ? 'Set on every selected item (matches the inherited value): reset to inherit'
          : 'Set for this object (matches the inherited value): reset to inherit'
      }
    }
  }

  const header = (
    <>
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
      {(() => {
        // Rendered from the resolver's own report, so the caveat and the config it describes can
        // never disagree.
        const note = loading || error ? null : describeSettingsBaseline(baselineOrigin, 'process')
        return note ? <SettingsBaselineNote note={note} /> : null
      })()}
    </>
  )

  return (
    <SettingsCatalogDialog
      open={open}
      onClose={onClose}
      catalog={processSettingsCatalog}
      initialQuery={initialQuery}
      titlePrefix={titlePrefix ?? 'Process settings'}
      presetName={processProfileName}
      header={header}
      loading={loading}
      loadingLabel="Loading process settings…"
      error={error}
      ready={baseConfig !== null}
      showDeveloperOptions={showDeveloperOptions}
      isKeyVisible={isKeyVisible}
      adapter={adapter}
      corrections={corrections}
      filamentChoices={filamentChoices}
      actions={{
        onResetAll: handleResetAll,
        onCancel: onClose,
        saving,
        /*
          PER-OBJECT mode has no preset destination: the edit is a SUBSET of keys layered on the
          project's process (`allowedKeys` + `baseOverlay`), so "save as preset" would mint a full
          process preset silently carrying the whole inherited config. With one destination left,
          naming it ("Apply to this project") implies a choice that does not exist: the title
          already says whose settings these are ("Object settings: <name>").
        */
        onUpdatePreset: !perObjectMode && canEditOriginal ? () => void handleUpdateOriginal() : undefined,
        onSaveAsPreset: perObjectMode ? undefined : () => void handleSaveAsPreset(),
        apply: applyScope === 'preset' ? undefined : {
          label: perObjectMode ? 'Apply' : applyScope === 'project' ? 'Apply to this project' : 'Apply to this slice',
          onApply: handleApply
        }
      }}
    />
  )
}
