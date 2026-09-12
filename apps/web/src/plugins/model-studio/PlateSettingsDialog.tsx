/**
 * Per-plate settings: BambuStudio's Plate Settings dialog.
 *
 * OWNS the editing UI for the settings ONE plate may override on the project (bed type, physical
 * filament order, print sequence and vase mode) plus its arrange lock. It edits a draft and
 * applies once, so a half-changed plate is never committed and Cancel needs no undo.
 *
 * THE CONTRACT: each override is a tri-state, and "same as global" is a real choice, distinct from
 * "unset". The caller stores null for it, which is what tells the bake to remove the plate's own
 * value rather than leave the source file's behind. The lock is deliberately NOT a tri-state:
 * BambuStudio has no global lock, so unlocked is absence.
 *
 * WHY A SENTINEL RATHER THAN A NULL OPTION: Joy's `Select` fires `onChange` with a null value of
 * its own accord (a phantom change on re-render), so a null option value cannot be told apart from
 * that and would silently reset a plate's bed type. Every select here uses `GLOBAL` and maps it
 * back, and a null from Joy is ignored outright.
 *
 * The counterpart that WRITES these is `packages/shared/src/three-mf/plate-metadata.ts`
 * (`authoredPlateMetadata`); the engine applies them over the project config at slice time
 * (`BambuStudio.cpp:6897`).
 *
 * THE SKIRT WARNING is BambuStudio's (`Plater.cpp:26005`), and it needs the project's process
 * config, which is why this dialog resolves one. Three things about it. The rule itself lives in
 * `plateSkirtCollisionRisk` because it tests the plate's EFFECTIVE sequence, so a plate left on
 * "same as global" over a by-object project warns too. It is ADVISORY: the process tab's copy of
 * the same test auto-resets `skirt_height`, but doing that here would silently rewrite a
 * project-wide setting from a dialog scoped to one plate. And an unresolved config warns about
 * NOTHING rather than guessing, which is the safe direction: the process tab still raises (and
 * fixes) the same condition when the user next opens it.
 */
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import { Alert, Box, Button, Checkbox, FormControl, FormLabel, IconButton, Input, Option, Select, Sheet, Stack, Typography } from '@mui/joy'
import { useMemo, useState } from 'react'
import {
  createProcessConfigAccessor,
  plateSkirtCollisionRisk,
  processSettingsCatalog,
  reconcilePlateFilamentSequence,
  type PlateLayerFilamentSequence,
  type ProcessConfig
} from '@printstream/shared'
import { formatSettingValueForDisplay } from '../../components/settings/settingValueDisplay'
import { formatPlateTypeLabel, matchPlateTypeByLabel } from '../../lib/slicingPresetMatching'
import { FormDialog } from '../../components/FormDialog'
import { DialogSection } from '../../components/DialogSection'
import { useResolvedProcessConfig } from './lib/useResolvedProcessConfig'
import type { ProcessConfigResolver } from '../../components/ProcessSettingsDialog'

/** The subset of a plate this dialog edits. */
export interface PlateSettingsDraft {
  plateTypeOverride: string | null
  printSequence: 'by layer' | 'by object' | null
  firstLayerFilamentSequence: number[] | null
  otherLayerFilamentSequences: PlateLayerFilamentSequence[] | null
  spiralMode: boolean | null
  locked: boolean
}

interface PlateSettingsDialogProps {
  /** The plate's display name, for the title (the strip's own label). */
  plateLabel: string
  settings: PlateSettingsDraft
  /** Bed types the target printer supports, matching the project-global selector. */
  plateTypeOptions: string[]
  /** The global bed type, named in the inherit option so the choice is not blind. */
  globalPlateType: string | null
  /** Process context used to resolve the advisory skirt-collision warning. */
  processContext: {
    slicerTargetId: string
    processProfileId: string
    sourceFileId: string | null
    /** Must remain stable because it participates in the resolver hook's dependencies. */
    resolveConfig?: ProcessConfigResolver
  } | null
  /** Session-wide process overrides layered over the resolved preset. */
  globalProcessOverrides: ProcessConfig
  /** Physical project materials in current session-id order. */
  filaments: Array<{ id: number; label: string; color: string }>
  /** Bambu disables custom ordering when any virtual mixed material exists. */
  hasMixedFilaments: boolean
  onApply: (settings: PlateSettingsDraft) => void
  onClose: () => void
}

/** Stands in for "same as global" in the selects; see the module header for why null cannot. */
const GLOBAL = '__same_as_global__'

/**
 * The inherit option's label, naming the value being inherited where it is known.
 *
 * One helper for all three controls: bed type named its global from the start while the other two
 * did not, so "Same as global" meant "and here is what that is" on one row and gave no way to find
 * out on the others, which is the question the row exists to answer.
 */
function inheritLabel(globalValue: string | null): string {
  return globalValue ? `Same as global (${globalValue})` : 'Same as global'
}

/** Joy re-fires `onChange` with null on its own, so only a real string is a user pick. */
function pick<T>(value: string | null, resolve: (value: string) => T): T | undefined {
  return value == null ? undefined : resolve(value)
}

export function PlateSettingsDialog({
  plateLabel,
  settings,
  plateTypeOptions,
  globalPlateType,
  processContext,
  globalProcessOverrides,
  filaments,
  hasMixedFilaments,
  onApply,
  onClose
}: PlateSettingsDialogProps) {
  const filamentIds = filaments.map((filament) => filament.id)
  const [draft, setDraft] = useState<PlateSettingsDraft>(() => ({
    ...settings,
    firstLayerFilamentSequence: settings.firstLayerFilamentSequence
      ? reconcilePlateFilamentSequence(settings.firstLayerFilamentSequence, filamentIds)
      : null,
    otherLayerFilamentSequences: settings.otherLayerFilamentSequences?.map((range) => ({
      ...range,
      filamentIds: reconcilePlateFilamentSequence(range.filamentIds, filamentIds)
    })) ?? null
  }))

  /**
   * The option that REPRESENTS the stored override, matched by label rather than by value.
   *
   * The two spellings differ by design: the bake canonicalises what it writes (`canonicalCurrBedType`),
   * so a reopened plate carries `Cool Plate`, while the printer's option list may offer the code-form
   * `cool_plate` for the same plate. Comparing them directly matches nothing, and a Joy `Select`
   * whose value is in no option renders BLANK, so a saved override looked like it had been lost.
   */
  const selectedPlateTypeOption = matchPlateTypeByLabel(plateTypeOptions, draft.plateTypeOverride)
  /**
   * An override the CURRENT printer does not offer, kept as an option of its own.
   *
   * It is still the plate's own value, so neither of the easy answers is honest: falling back to
   * "Same as global" claims the plate inherits when it does not, and rendering blank hides an
   * override the file genuinely carries. Showing it lets the user see it and decide.
   */
  const unlistedPlateType = draft.plateTypeOverride && !selectedPlateTypeOption
    ? draft.plateTypeOverride
    : null

  const { config: presetConfig } = useResolvedProcessConfig({
    enabled: processContext != null,
    slicerTargetId: processContext?.slicerTargetId ?? '',
    processProfileId: processContext?.processProfileId ?? '',
    sourceFileId: processContext?.sourceFileId ?? null,
    ...(processContext?.resolveConfig ? { resolveConfig: processContext.resolveConfig } : {})
  })

  /**
   * What the project will actually slice at: the resolved preset with the session's own overrides
   * laid over it. Reading the preset alone would miss a `print_sequence` or `skirt_height` the user
   * changed in THIS session, which is precisely when the warning is most worth showing.
   */
  const effectiveProcessConfig = useMemo(
    () => (presetConfig ? { ...presetConfig, ...globalProcessOverrides } : null),
    [presetConfig, globalProcessOverrides]
  )
  const skirtCollisionRisk = effectiveProcessConfig != null
    && plateSkirtCollisionRisk(draft.printSequence, effectiveProcessConfig)
  const sequenceError = validatePlateFilamentSequences(draft, filamentIds)

  /**
   * What the PROJECT currently sets for one process key, formatted as its own dialog shows it.
   *
   * Through `formatSettingValueForDisplay` rather than the raw value, so "by object" reads as
   * "By object" and `spiral_mode: '0'` reads as "Off", matching the process settings dialog for the
   * same key. Null when unknown, and the caller must leave the label unqualified there: the config
   * resolves asynchronously and a host may supply none at all, so naming a value we have not read
   * would be a confident guess about what the plate inherits.
   */
  const globalProcessValue = (key: string): string | null => {
    if (!effectiveProcessConfig) {
      return null
    }

    const accessor = createProcessConfigAccessor(effectiveProcessConfig)

    if (!accessor.has(key)) {
      return null
    }

    const formatted = formatSettingValueForDisplay(
      processSettingsCatalog.options[key],
      accessor.str(key),
      { sentenceCase: true }
    )

    return formatted.trim() || null
  }

  const setFirstLayerSequenceMode = (value: string | null) => {
    if (value === 'auto') {
      setDraft((current) => ({
        ...current,
        firstLayerFilamentSequence: null
      }))
    }

    if (value === 'custom') {
      setDraft((current) => ({
        ...current,
        firstLayerFilamentSequence: [...filamentIds]
      }))
    }
  }

  const setOtherLayerSequenceMode = (value: string | null) => {
    if (value === 'auto') {
      setDraft((current) => ({
        ...current,
        otherLayerFilamentSequences: null
      }))
    }

    if (value === 'custom') {
      setDraft((current) => ({
        ...current,
        otherLayerFilamentSequences: [newLayerSequenceRange(2, filamentIds)]
      }))
    }
  }

  const removeRange = (index: number) => {
    setDraft((current) => {
      const remainingRanges = current.otherLayerFilamentSequences?.filter(
        (_entry, candidate) => candidate !== index
      ) ?? []

      return {
        ...current,
        otherLayerFilamentSequences: remainingRanges.length > 0 ? remainingRanges : null
      }
    })
  }

  const appendRange = () => {
    const previousRange = draft.otherLayerFilamentSequences?.at(-1)

    if (previousRange?.endLayer == null) {
      return
    }

    const startLayer = previousRange.endLayer + 1

    setDraft((current) => ({
      ...current,
      otherLayerFilamentSequences: [
        ...(current.otherLayerFilamentSequences ?? []),
        newLayerSequenceRange(startLayer, filamentIds)
      ]
    }))
  }

  return (
    <FormDialog
      title={`${plateLabel} settings`}
      description="These apply to this plate only. Anything left as “Same as global” follows the project's own settings."
      submitLabel="Apply"
      error={sequenceError}
      submitDisabled={sequenceError != null}
      onSubmit={() => onApply(draft)}
      onClose={onClose}
    >
      <DialogSection
        title="Bed type"
        description="The build surface this plate prints on, which also sets its first-layer temperature."
      >
        <Select
          size="sm"
          value={selectedPlateTypeOption ?? unlistedPlateType ?? GLOBAL}
          onChange={(_event, value) => {
            const next = pick(value, (raw) => (raw === GLOBAL ? null : raw))
            if (next !== undefined) setDraft((current) => ({ ...current, plateTypeOverride: next }))
          }}
        >
          <Option value={GLOBAL}>
            {inheritLabel(globalPlateType ? formatPlateTypeLabel(globalPlateType) : null)}
          </Option>
          {unlistedPlateType && (
            <Option value={unlistedPlateType}>{formatPlateTypeLabel(unlistedPlateType)}</Option>
          )}
          {plateTypeOptions.map((option) => (
            // Through `formatPlateTypeLabel`, exactly as the project-global selector renders the
            // SAME list. The options arrive in mixed spellings (code-form `cool_plate` from one
            // source, serialized `High Temp Plate` from another), so rendering them raw showed
            // half the list as identifiers and made one list read as two.
            <Option key={option} value={option}>{formatPlateTypeLabel(option)}</Option>
          ))}
        </Select>
      </DialogSection>

      <DialogSection
        title="Filament sequence"
        description="Choose which physical material prints first on this plate. Custom ranges apply from their first layer through their last layer."
      >
        {hasMixedFilaments && (
          <Alert size="sm" color="warning" variant="soft" sx={{ mb: 1 }}>
            Custom filament sequence does not take effect while the project contains a mixed material.
          </Alert>
        )}
        <Stack spacing={1.5}>
          <FormControl>
            <FormLabel>First layer</FormLabel>
            <Select
              size="sm"
              value={draft.firstLayerFilamentSequence ? 'custom' : 'auto'}
              disabled={hasMixedFilaments}
              onChange={(_event, value) => setFirstLayerSequenceMode(value)}
            >
              <Option value="auto">Auto</Option>
              <Option value="custom">Customize</Option>
            </Select>
          </FormControl>
          {draft.firstLayerFilamentSequence && (
            <FilamentSequenceOrder
              filaments={filaments}
              order={draft.firstLayerFilamentSequence}
              onChange={(order) => setDraft((current) => ({ ...current, firstLayerFilamentSequence: order }))}
            />
          )}

          <FormControl>
            <FormLabel>Other layers</FormLabel>
            <Select
              size="sm"
              value={draft.otherLayerFilamentSequences ? 'custom' : 'auto'}
              disabled={hasMixedFilaments}
              onChange={(_event, value) => setOtherLayerSequenceMode(value)}
            >
              <Option value="auto">Auto</Option>
              <Option value="custom">Customize by layer range</Option>
            </Select>
          </FormControl>
          {draft.otherLayerFilamentSequences?.map((range, index) => (
            <Sheet key={index} variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} alignItems="flex-end">
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>Start layer</FormLabel>
                    <Input
                      size="sm"
                      type="number"
                      value={range.startLayer}
                      slotProps={{ input: { min: 2, step: 1 } }}
                      onChange={(event) => updateRange(index, { startLayer: Math.max(2, Math.round(Number(event.target.value))) })}
                    />
                  </FormControl>
                  <FormControl sx={{ flex: 1 }}>
                    <FormLabel>End layer</FormLabel>
                    <Input
                      size="sm"
                      type="number"
                      placeholder="End"
                      value={range.endLayer ?? ''}
                      slotProps={{ input: { min: range.startLayer, step: 1 } }}
                      onChange={(event) => updateRange(index, {
                        endLayer: event.target.value === '' ? null : Math.max(range.startLayer, Math.round(Number(event.target.value)))
                      })}
                    />
                  </FormControl>
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="danger"
                    aria-label={`Remove range ${index + 1}`}
                    onClick={() => removeRange(index)}
                  >
                    <DeleteRoundedIcon />
                  </IconButton>
                </Stack>
                <FilamentSequenceOrder
                  filaments={filaments}
                  order={range.filamentIds}
                  onChange={(filamentIds) => updateRange(index, { filamentIds })}
                />
              </Stack>
            </Sheet>
          ))}
          {draft.otherLayerFilamentSequences && (
            <Button
              type="button"
              size="sm"
              variant="soft"
              startDecorator={<AddRoundedIcon />}
              onClick={appendRange}
              disabled={draft.otherLayerFilamentSequences.at(-1)?.endLayer == null}
            >
              Add range
            </Button>
          )}
        </Stack>
      </DialogSection>

      <DialogSection
        title="Print sequence"
        description="By object prints each model to its full height before starting the next."
      >
        <Select
          size="sm"
          value={draft.printSequence ?? GLOBAL}
          onChange={(_event, value) => {
            const next = pick(value, (raw) => (raw === GLOBAL ? null : (raw as 'by layer' | 'by object')))
            if (next !== undefined) setDraft((current) => ({ ...current, printSequence: next }))
          }}
        >
          <Option value={GLOBAL}>{inheritLabel(globalProcessValue('print_sequence'))}</Option>
          <Option value="by layer">By layer</Option>
          <Option value="by object">By object</Option>
        </Select>
        {skirtCollisionRisk && (
          // Advisory, and it names the setting rather than offering to change it: `skirt_height` is
          // project-wide, so a plate dialog editing it would reach outside its own scope.
          <Alert
            size="sm"
            color="warning"
            variant="soft"
            startDecorator={<WarningAmberRoundedIcon />}
            sx={{ mt: 1 }}
          >
            <Typography level="body-xs">
              Printing by object with a multi-layer skirt can make the extruder hit the skirt.
              Set the project's skirt layers to 1 in Process settings to avoid it.
            </Typography>
          </Alert>
        )}
      </DialogSection>

      <DialogSection title="Spiral vase" description="Prints the model as a single continuous outer wall.">
        <Select
          size="sm"
          value={draft.spiralMode == null ? GLOBAL : String(draft.spiralMode)}
          onChange={(_event, value) => {
            const next = pick(value, (raw) => (raw === GLOBAL ? null : raw === 'true'))
            if (next !== undefined) setDraft((current) => ({ ...current, spiralMode: next }))
          }}
        >
          <Option value={GLOBAL}>{inheritLabel(globalProcessValue('spiral_mode'))}</Option>
          {/* On/Off rather than Enabled/Disabled: the inherit row above renders its value through
              the shared formatter, which spells a bool that way, and the process settings dialog
              spells the same key that way. Two wordings in one select read as two settings. */}
          <Option value="true">On</Option>
          <Option value="false">Off</Option>
        </Select>
      </DialogSection>

      <DialogSection title="Arrange" wrapInSheet={false}>
        <Stack spacing={0.5}>
          <Checkbox
            size="sm"
            label="Lock this plate"
            checked={draft.locked}
            onChange={(event) => {
              const locked = event.target.checked
              setDraft((current) => ({ ...current, locked }))
            }}
          />
          <Typography level="body-xs" textColor="text.tertiary">
            Auto-arrange leaves a locked plate's models where they are.
          </Typography>
        </Stack>
      </DialogSection>
    </FormDialog>
  )

  function updateRange(index: number, patch: Partial<PlateLayerFilamentSequence>): void {
    setDraft((current) => ({
      ...current,
      otherLayerFilamentSequences: current.otherLayerFilamentSequences?.map((range, candidate) => (
        candidate === index ? { ...range, ...patch } : range
      )) ?? null
    }))
  }
}

/**
 * Validates the first-layer order and every later-layer range as one policy.
 * Returns user-facing guidance instead of throwing so the dialog can retain an
 * incomplete draft while disabling Apply.
 */
function validatePlateFilamentSequences(
  draft: PlateSettingsDraft,
  physicalFilamentIds: number[]
): string | null {
  if (
    draft.firstLayerFilamentSequence
    && !sequenceContainsEveryFilament(draft.firstLayerFilamentSequence, physicalFilamentIds)
  ) {
    return 'The first-layer sequence must contain every physical material exactly once.'
  }

  if (
    draft.otherLayerFilamentSequences
    && !laterLayerSequencesAreValid(draft.otherLayerFilamentSequences, physicalFilamentIds)
  ) {
    return 'Later-layer ranges must not overlap, and each sequence must contain every physical material exactly once.'
  }

  return null
}

/** Checks that an order is an exact permutation of the physical filament ids. */
function sequenceContainsEveryFilament(order: readonly number[], filamentIds: number[]): boolean {
  return order.length === filamentIds.length
    && new Set(order).size === order.length
    && order.every((id) => filamentIds.includes(id))
}

/** Validates ordered, non-overlapping later-layer ranges and their filament orders. */
function laterLayerSequencesAreValid(
  ranges: PlateLayerFilamentSequence[],
  filamentIds: number[]
): boolean {
  return ranges.every((range, index) => {
    if (!sequenceContainsEveryFilament(range.filamentIds, filamentIds)) {
      return false
    }

    if (range.startLayer < 2) {
      return false
    }

    if (range.endLayer != null && range.endLayer < range.startLayer) {
      return false
    }

    const previousRange = ranges[index - 1]
    if (!previousRange) {
      return true
    }

    return previousRange.endLayer != null && range.startLayer > previousRange.endLayer
  })
}

/** Creates one open-ended range with a defensive copy of the current filament order. */
function newLayerSequenceRange(
  startLayer: number,
  filamentIds: number[]
): PlateLayerFilamentSequence {
  return {
    startLayer,
    endLayer: null,
    filamentIds: [...filamentIds]
  }
}

interface FilamentSequenceOrderProps {
  filaments: Array<{ id: number; label: string; color: string }>
  order: number[]
  onChange: (order: number[]) => void
}

/** Renders and reorders one complete physical-filament sequence. */
function FilamentSequenceOrder({
  filaments,
  order,
  onChange
}: FilamentSequenceOrderProps): JSX.Element {
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset

    if (target < 0 || target >= order.length) {
      return
    }

    const next = [...order]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }

  return (
    <Stack spacing={0.5}>
      {order.map((id, index) => {
        const filament = filaments.find((candidate) => candidate.id === id)
        return (
          <Stack key={id} direction="row" spacing={0.75} alignItems="center">
            <Typography level="body-xs" sx={{ width: 18 }}>{index + 1}</Typography>
            <Box
              sx={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                bgcolor: filament?.color ?? '#FFFFFF',
                border: '1px solid',
                borderColor: 'divider'
              }}
            />
            <Typography level="body-sm" sx={{ flex: 1 }}>{filament?.label ?? `Material ${id}`}</Typography>
            <IconButton
              size="sm"
              variant="plain"
              disabled={index === 0}
              aria-label={`Move ${filament?.label ?? id} earlier`}
              onClick={() => move(index, -1)}
            >
              <ArrowUpwardRoundedIcon />
            </IconButton>
            <IconButton
              size="sm"
              variant="plain"
              disabled={index === order.length - 1}
              aria-label={`Move ${filament?.label ?? id} later`}
              onClick={() => move(index, 1)}
            >
              <ArrowDownwardRoundedIcon />
            </IconButton>
          </Stack>
        )
      })}
    </Stack>
  )
}
