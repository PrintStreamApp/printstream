/**
 * Per-plate settings: BambuStudio's Plate Settings dialog.
 *
 * OWNS the editing UI for the settings ONE plate may override on the project (bed type, print
 * sequence and vase mode) plus its arrange lock. It edits a draft and applies once, so a
 * half-changed plate is never committed and Cancel needs no undo.
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
import { Alert, Checkbox, Option, Select, Stack, Typography } from '@mui/joy'
import { useMemo, useState } from 'react'
import {
  createProcessConfigAccessor,
  plateSkirtCollisionRisk,
  processSettingsCatalog,
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
  spiralMode: boolean | null
  locked: boolean
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
  onApply,
  onClose
}: {
  /** The plate's display name, for the title (the strip's own label). */
  plateLabel: string
  settings: PlateSettingsDraft
  /** Bed types the TARGET PRINTER supports, the same list the project-global selector offers. */
  plateTypeOptions: string[]
  /** The project-global bed type, named in the inherit option so the choice is not a blind one. */
  globalPlateType: string | null
  /**
   * How to resolve the project's process preset, for the skirt-collision warning. Null when the
   * host has no process context yet, which simply means no warning: see the module header.
   *
   * `resolveConfig` must be a STABLE reference, as it is in the resolve hook's effect deps.
   */
  processContext: {
    slicerTargetId: string
    processProfileId: string
    sourceFileId: string | null
    resolveConfig?: ProcessConfigResolver
  } | null
  /** The session's project-wide process overrides, layered over the resolved preset. */
  globalProcessOverrides: ProcessConfig
  onApply: (settings: PlateSettingsDraft) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<PlateSettingsDraft>(settings)

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
    if (!effectiveProcessConfig) return null
    const accessor = createProcessConfigAccessor(effectiveProcessConfig)
    if (!accessor.has(key)) return null
    const formatted = formatSettingValueForDisplay(
      processSettingsCatalog.options[key],
      accessor.str(key),
      { sentenceCase: true }
    )
    return formatted.trim() || null
  }

  return (
    <FormDialog
      title={`${plateLabel} settings`}
      description="These apply to this plate only. Anything left as “Same as global” follows the project's own settings."
      submitLabel="Apply"
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
}
