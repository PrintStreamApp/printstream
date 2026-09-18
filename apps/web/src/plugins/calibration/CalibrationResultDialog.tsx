/**
 * Shared result entry for a printed calibration or an externally measured value.
 * Manual entry omits the run and never submits a measurement or printer command.
 * For a printed calibration, the user reports the
 * measurement (best band height for a tower, smoothest patch for a flow plate),
 * sees the computed value, then chooses how widely to save it: to this spool, or
 * to a filament identity (toggle which fields must match), with an independent
 * choice of printer models or named printers. Saving never writes a printer profile.
 *
 * For new results, one button submits the CURRENT form measurement and then
 * saves. Editing a saved result writes an absolute value without changing the
 * original printed measurement. (A
 * two-step Record-then-Save flow shipped first and burned a user: a reopened
 * dialog reset its inputs but "Save" persisted the server's earlier measurement,
 * saving a different K than the preview showed.) Reopening a measured run seeds
 * the inputs from the recorded measurement for the same reason.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, FormControl, FormLabel, ModalClose, Option, Radio, RadioGroup, Select, Stack, Typography } from '@mui/joy'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  COMMON_FILAMENT_COLOR_SWATCHES,
  calibrationSavedValueSchema,
  calibrationKindSchema,
  calibrationPrinterTargetSchema,
  isAutomaticPressureAdvance,
  type CalibrationPrinterTarget,
  type CalibrationKind,
  type Printer,
  normalizeFilamentFamily,
  flowRatioFromOffset,
  pressureAdvanceFromHeight,
  type CalibrationResult,
  type CalibrationRun,
  type SaveCalibrationResult
} from '@printstream/shared'
import { toast } from '../../lib/toast'
import { BackAwareModal } from '../../components/BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { DialogSection } from '../../components/DialogSection'
import { NumberField } from './NumberField'
import { CalibrationPrinterTargetFields } from './CalibrationPrinterTargetFields'
import { FlowPatchPicker } from './FlowPatchPicker'
import { calibrationKeys, saveCalibrationRun, saveManualCalibration, submitCalibrationMeasurement } from './api'
import { calibrationKindLabel, calibrationValueLabel } from './runPresentation'
import { PluginSlot } from '../../plugin/PluginSlot'
import { usePluginSlots } from '../../plugin/usePluginSlots'
import { DeferredKeyboardAutocomplete } from '../../components/DeferredKeyboardAutocomplete'
import {
  FILAMENT_BRAND_SUGGESTIONS,
  FILAMENT_MATERIAL_SUGGESTIONS,
  FILAMENT_PRODUCT_LINE_SUGGESTIONS
} from '../../lib/filamentSuggestions'

export interface CalibrationIdentitySuggestions {
  brand: string[]
  filamentType: string[]
  materialSubtype: Array<{ filamentType: string | null; label: string }>
  colorName: string[]
}

type IdentityField = keyof CalibrationIdentitySuggestions
type IdentityOption = { label: string; group: 'Filament library' | 'Calibration history' | 'Suggestions' }

const EMPTY_IDENTITY_SUGGESTIONS: CalibrationIdentitySuggestions = {
  brand: [],
  filamentType: [],
  materialSubtype: [],
  colorName: []
}

/** Merge user data and app defaults while keeping the most useful source label. */
function buildIdentityOptions(
  library: readonly string[],
  history: readonly string[],
  suggestions: readonly string[]
): IdentityOption[] {
  const seen = new Set<string>()
  const result: IdentityOption[] = []
  const append = (values: readonly string[], group: IdentityOption['group']) => {
    for (const rawValue of values) {
      const label = rawValue.trim()
      const key = label.toLowerCase()
      if (!label || seen.has(key)) continue
      seen.add(key)
      result.push({ label, group })
    }
  }
  append(library, 'Filament library')
  append(history, 'Calibration history')
  append(suggestions, 'Suggestions')
  return result
}

export const CalibrationResultDialog = memo(function CalibrationResultDialog({ run, printers = [], savedResults = [], identitySuggestions, onClose }: {
  run?: CalibrationRun
  printers?: Printer[]
  savedResults?: CalibrationResult[]
  identitySuggestions?: CalibrationIdentitySuggestions
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const priorResult = savedResults[0] ?? null
  const [kind, setKind] = useState<CalibrationKind>(priorResult?.kind ?? run?.kind ?? 'flowRatio')
  const [printerModel, setPrinterModel] = useState(priorResult?.printerModel ?? run?.printerModel ?? printers[0]?.model ?? '')
  const [printerTarget, setPrinterTarget] = useState<CalibrationPrinterTarget>(priorResult?.printerTarget
    ?? { scope: 'models', models: [printerModel].filter(Boolean) })
  const automatic = Boolean(run && isAutomaticPressureAdvance(run.parameters))
  const [nozzleDiameter, setNozzleDiameter] = useState<'0.2' | '0.4' | '0.6' | '0.8'>(() => {
    const saved = priorResult?.nozzleDiameter ?? run?.nozzleDiameter
    return saved === '0.2' || saved === '0.6' || saved === '0.8' ? saved : '0.4'
  })
  const models = [...new Set(printers.map((printer) => printer.model).filter(Boolean))]
  const isFlow = kind === 'flowRatio'
  const isPressureAdvance = kind === 'pressureAdvance'
  const [pressureAdvanceMode, setPressureAdvanceMode] = useState<'native' | 'linear'>(
    priorResult?.pressureAdvanceMode ?? (run?.parameters.kind === 'pressureAdvance' ? run.parameters.pressureAdvanceMode : undefined) ?? 'native'
  )
  const hasSpoolPicker = usePluginSlots('calibration.spoolPicker').length > 0
  const editing = !run || run.status === 'saved'
  const [savedValue, setSavedValue] = useState<number | null>(priorResult?.value ?? run?.resultValue ?? null)
  const savedValueValid = calibrationSavedValueSchema.safeParse({ kind, value: savedValue }).success

  const [heightMm, setHeightMm] = useState(() => (run?.measurement?.kind === 'pressureAdvance' ? run?.measurement.bestHeightMm : 0))
  const [offset, setOffset] = useState<number>(() => {
    if (run?.measurement?.kind === 'flowRatio') return run?.measurement.selectedOffset
    return run?.parameters?.kind === 'flowRatio' ? (run?.parameters.offsets[0] ?? 0) : 0
  })
  const directOptions = useMemo(() => {
    const parameters = run?.parameters
    if (parameters?.kind === 'temperature') {
      return Array.from({ length: Math.floor((parameters.startTemperature - parameters.endTemperature) / parameters.step) + 1 }, (_unused, index) => parameters.startTemperature - index * parameters.step)
    }
    if (parameters?.kind === 'maxVolumetricSpeed' || parameters?.kind === 'vfa') {
      return Array.from({ length: Math.floor((parameters.endSpeed - parameters.startSpeed) / parameters.step) + 1 }, (_unused, index) => parameters.startSpeed + index * parameters.step)
    }
    if (parameters?.kind === 'retraction') {
      return Array.from({ length: Math.floor((parameters.endLength - parameters.startLength) / parameters.step) + 1 }, (_unused, index) => parameters.startLength + index * parameters.step)
    }
    return []
  }, [run?.parameters])
  const [directValue, setDirectValue] = useState<number>(() => {
    const measurement = run?.measurement
    if (measurement?.kind === 'temperature') return measurement.selectedTemperature
    if (measurement?.kind === 'maxVolumetricSpeed' || measurement?.kind === 'vfa') return measurement.selectedSpeed
    if (measurement?.kind === 'retraction') return measurement.selectedLength
    const parameters = run?.parameters
    if (parameters?.kind === 'temperature') return parameters.startTemperature
    if (parameters?.kind === 'maxVolumetricSpeed' || parameters?.kind === 'vfa') return parameters.startSpeed
    if (parameters?.kind === 'retraction') return parameters.startLength
    return 0
  })
  const priorSpoolIds = savedResults
    .filter((result) => result.scope === 'spool' && result.spoolId != null)
    .map((result) => result.spoolId!)
  const [selectedSpoolIds, setSelectedSpoolIds] = useState<string[]>(() => priorSpoolIds.length > 0
    ? priorSpoolIds
    : run?.spoolId ? [run?.spoolId] : [])
  const [scope, setScope] = useState<'spool' | 'identity'>(() => priorResult?.scope
    ?? (run?.spoolId || hasSpoolPicker ? 'spool' : 'identity'))
  const [match, setMatch] = useState({
    brand: priorResult?.scope === 'identity' ? priorResult.brand != null : run?.brand != null,
    filamentType: priorResult?.scope === 'identity' ? priorResult.filamentType != null : run?.filamentType != null,
    materialSubtype: priorResult?.scope === 'identity' ? priorResult.materialSubtype != null : run?.materialSubtype != null,
    colorName: priorResult?.scope === 'identity' ? priorResult.colorName != null : false
  })
  const [identity, setIdentity] = useState({
    brand: priorResult?.brand ?? run?.brand ?? '',
    filamentType: priorResult?.filamentType ?? run?.filamentType ?? '',
    materialSubtype: priorResult?.materialSubtype ?? run?.materialSubtype ?? '',
    colorName: priorResult?.colorName ?? run?.colorName ?? ''
  })
  const [libraryIdentitySuggestions, setLibraryIdentitySuggestions] = useState<CalibrationIdentitySuggestions>(EMPTY_IDENTITY_SUGGESTIONS)
  const identityOptions = useMemo<Record<IdentityField, IdentityOption[]>>(() => ({
    brand: buildIdentityOptions(libraryIdentitySuggestions.brand, identitySuggestions?.brand ?? [], FILAMENT_BRAND_SUGGESTIONS),
    filamentType: buildIdentityOptions(libraryIdentitySuggestions.filamentType, identitySuggestions?.filamentType ?? [], FILAMENT_MATERIAL_SUGGESTIONS),
    materialSubtype: buildIdentityOptions(
      libraryIdentitySuggestions.materialSubtype
        .filter((option) => !identity.filamentType.trim() || normalizeFilamentFamily(option.filamentType) === normalizeFilamentFamily(identity.filamentType))
        .map((option) => option.label),
      (identitySuggestions?.materialSubtype ?? [])
        .filter((option) => !identity.filamentType.trim() || normalizeFilamentFamily(option.filamentType) === normalizeFilamentFamily(identity.filamentType))
        .map((option) => option.label),
      FILAMENT_PRODUCT_LINE_SUGGESTIONS.filter((value) => !identity.filamentType.trim() || normalizeFilamentFamily(value) === normalizeFilamentFamily(identity.filamentType))
    ),
    colorName: buildIdentityOptions(
      libraryIdentitySuggestions.colorName,
      identitySuggestions?.colorName ?? [],
      COMMON_FILAMENT_COLOR_SWATCHES.map((swatch) => swatch.name)
    )
  }), [identitySuggestions, libraryIdentitySuggestions, identity.filamentType])
  const hasIdentityMatch = (Object.keys(match) as Array<keyof typeof match>)
    .some((field) => match[field] && identity[field].trim().length > 0)
  const hasEmptyCheckedField = (Object.keys(match) as Array<keyof typeof match>)
    .some((field) => match[field] && identity[field].trim().length === 0)

  const updateIdentity = (field: keyof typeof identity, value: string) => {
    // A subtype belongs to its selected type, including custom library names
    // that cannot be inferred from text. Do not retain it after changing type.
    if (field === 'filamentType' && normalizeFilamentFamily(value) !== normalizeFilamentFamily(identity.filamentType)) {
      setIdentity((previous) => ({ ...previous, filamentType: value, materialSubtype: '' }))
      return
    }
    setIdentity((previous) => ({ ...previous, [field]: value }))
  }

  // A newly tracked run normally carries its loaded spool already. If the
  // inventory association arrives shortly after the dialog opens, the picker
  // contribution can still seed it through its controlled value.
  useEffect(() => {
    if (selectedSpoolIds.length === 0 && run?.spoolId) setSelectedSpoolIds([run?.spoolId])
  }, [run?.spoolId, selectedSpoolIds.length])

  const computedValue = useMemo(() => {
    if (editing) return savedValue ?? Number.NaN
    if (automatic) return run?.resultValue ?? Number.NaN
    if (run?.parameters?.kind === 'flowRatio') return flowRatioFromOffset(run?.parameters.currentFlowRatio, offset)
    if (run?.parameters?.kind === 'pressureAdvance') return pressureAdvanceFromHeight(run?.parameters.startK, run?.parameters.step, heightMm)
    return directValue
  }, [run?.parameters, run?.resultValue, automatic, offset, heightMm, directValue, editing, savedValue])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: calibrationKeys.runs })

  const save = useMutation({
    mutationFn: async () => {
      if (scope === 'identity' && (!hasIdentityMatch || hasEmptyCheckedField)) {
        throw new Error('Enter a value for every checked filament detail.')
      }
      if (editing && (savedValue == null || !savedValueValid)) {
        throw new Error('Enter a valid calibration value before saving.')
      }
      // Always submit the measurement currently on screen before saving, never trust a
      // previously recorded one, so the previewed value is the one that gets saved.
      if (!editing && run && !automatic) {
        const measurement = run.parameters.kind === 'flowRatio'
          ? { kind: 'flowRatio' as const, selectedOffset: offset }
          : run.parameters.kind === 'pressureAdvance'
            ? { kind: 'pressureAdvance' as const, bestHeightMm: heightMm }
            : run.parameters.kind === 'temperature'
              ? { kind: 'temperature' as const, selectedTemperature: directValue }
              : run.parameters.kind === 'retraction'
                ? { kind: 'retraction' as const, selectedLength: directValue }
                : { kind: run.parameters.kind, selectedSpeed: directValue }
        // Editing preserves the original measurement; manual entry has no measurement.
        await submitCalibrationMeasurement(run.id, { measurement })
      }
      const body: SaveCalibrationResult = {
        printerTarget,
        scope,
        ...(editing && savedValue != null ? { value: savedValue } : {}),
        applyToPrinter: false,
        ...(scope === 'spool'
          ? { spoolIds: selectedSpoolIds }
          : {
              match,
              identity: {
                brand: identity.brand.trim() || null,
                filamentType: identity.filamentType.trim() || null,
                materialSubtype: identity.materialSubtype.trim() || null,
                colorName: identity.colorName.trim() || null
              }
            })
      }
      if (!run) {
        if (savedValue == null) throw new Error('Enter a calibration value before saving.')
        await saveManualCalibration({ calibration: { kind, value: savedValue, ...(kind === 'pressureAdvance' ? { pressureAdvanceMode } : {}) }, printerModel, nozzleDiameter, target: body }, priorResult?.id)
        return
      }
      await saveCalibrationRun(run.id, body)
    },
    onSuccess: () => {
      void invalidate()
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.results })
      toast.success('Calibration saved')
      onClose()
    }
    // Errors surface once via the global mutation error handler (main.tsx), no local onError toast.
  })


  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog aria-labelledby="calibration-result-title" sx={{ maxWidth: 520 }}>
        <Typography id="calibration-result-title" level="h4">{priorResult || run?.status === 'saved' ? 'Edit saved calibration' : !run ? 'Add saved value' : 'Enter calibration result'}</Typography>
        <ModalClose />
        <ScrollableDialogBody>
          <Stack spacing={2}>
            {!run ? (
              <DialogSection title="Calibration" description="Enter a value measured elsewhere. No test will be printed. Saving replaces an existing value for the same target.">
                <Stack spacing={1}>
                  <FormControl><FormLabel>Calibration type</FormLabel>
                    <Select value={kind} disabled={Boolean(priorResult?.runId)} onChange={(_event, value) => {
                      if (value && value !== kind) {
                        setKind(value)
                        setSavedValue(null)
                      }
                    }}>
                      {calibrationKindSchema.options.map((value) => <Option key={value} value={value}>{calibrationKindLabel(value)}</Option>)}
                    </Select>
                  </FormControl>
                  <FormControl><FormLabel>Model used for measurement</FormLabel>
                    <DeferredKeyboardAutocomplete freeSolo options={models} inputValue={printerModel} onInputChange={(_event, value) => setPrinterModel(value)} onChange={(_event, value) => setPrinterModel(value ?? '')} />
                  </FormControl>
                  <FormControl><FormLabel>Nozzle diameter</FormLabel>
                    <Select value={nozzleDiameter} onChange={(_event, value) => { if (value) setNozzleDiameter(value) }}>
                      {(['0.2', '0.4', '0.6', '0.8'] as const).map((value) => <Option key={value} value={value}>{value} mm</Option>)}
                    </Select>
                  </FormControl>
                </Stack>
              </DialogSection>
            ) : null}
            {priorResult?.runId ? <Typography level="body-sm">Linked to calibration run {priorResult.runId}. Editing this value does not change the printed measurement.</Typography> : null}
            <DialogSection title="Printer applicability">
              {run ? <Typography level="body-sm">{run.nozzleDiameter} mm nozzle</Typography> : null}
              <CalibrationPrinterTargetFields value={printerTarget} onChange={setPrinterTarget} printers={printers}
                defaultModel={printerModel} defaultPrinterId={run?.printerId} />
            </DialogSection>
            <DialogSection title={editing ? 'Saved value' : 'Measurement'} description={automatic ? 'Measured by Micro Lidar. Saving stores this calibration in PrintStream.' : !run ? 'Enter the absolute calibrated value, not a percentage adjustment.' : editing
              ? 'Adjust the value directly, or leave it unchanged to edit where it applies.'
              : isFlow
              ? 'Pick the patch whose top surface felt smoothest.'
              : isPressureAdvance
                ? 'Measure the height of the best-looking band with calipers.'
                : 'Choose the labelled band that produced the best result.'}>
              {isPressureAdvance ? (
                <FormControl sx={{ mb: 1 }}>
                  <FormLabel>Compensation mode</FormLabel>
                  <Select value={pressureAdvanceMode} disabled={Boolean(run || priorResult?.runId)} onChange={(_event, value) => {
                    if (value) setPressureAdvanceMode(value)
                  }}>
                    <Option value="native">Native (Bambu Studio / printer)</Option>
                    <Option value="linear">Linear (OrcaSlicer / new PrintStream tests)</Option>
                  </Select>
                  <Typography level="body-xs" sx={{ mt: 0.5 }}>Use the mode the value was measured with. Changing mode does not convert the K value.</Typography>
                </FormControl>
              ) : null}
              {editing ? (
                <NumberField
                  key={kind}
                  label={isPressureAdvance ? 'K value' : calibrationKindLabel(kind)}
                  value={savedValue}
                  onChange={setSavedValue}
                  onClear={() => setSavedValue(null)}
                  helperText={isPressureAdvance ? 'Pressure advance, called Flow Dynamics Calibration in Bambu Studio. Enter your measured K value.' : undefined}
                  step={isFlow ? 0.001 : isPressureAdvance ? 0.0001 : 0.1}
                  endDecorator={kind === 'temperature' ? 'C' : kind === 'retraction' ? 'mm' : kind === 'maxVolumetricSpeed' ? 'mm3/s' : kind === 'vfa' ? 'mm/s' : undefined}
                />
              ) : automatic ? (
                <Typography level="body-sm">The printer supplied the measured K value below.</Typography>
              ) : run?.parameters?.kind === 'flowRatio' ? (
                <FlowPatchPicker offsets={run?.parameters.offsets} value={offset} onChange={setOffset} />
              ) : isPressureAdvance ? (
                <NumberField label="Best band height" value={heightMm} min={0} step={1} endDecorator="mm" onChange={setHeightMm} />
              ) : (
                <FormControl>
                  <FormLabel>Best band</FormLabel>
                  <Select value={directValue} onChange={(_event, value) => value != null && setDirectValue(value)}>
                    {directOptions.map((option) => (
                      <Option key={option} value={option}>
                        {calibrationValueLabel(kind, option)}
                      </Option>
                    ))}
                  </Select>
                </FormControl>
              )}
              {editing && savedValue != null && !savedValueValid ? <Alert color="warning" size="sm">Enter a value within the allowed range for this calibration.</Alert> : null}
              {!editing ? <Alert color="primary" size="sm" sx={{ mt: 1 }}>
                {run?.parameters?.kind === 'flowRatio' ? `New flow ratio: ${computedValue.toFixed(3)}`
                  : run?.parameters?.kind === 'pressureAdvance' ? `Pressure advance K: ${computedValue.toFixed(4)}`
                  : run?.parameters?.kind === 'temperature' ? `Nozzle temperature: ${Math.round(computedValue)} C`
                  : run?.parameters?.kind === 'maxVolumetricSpeed' ? `Max volumetric speed: ${computedValue.toFixed(1)} mm3/s`
                  : run?.parameters?.kind === 'vfa' ? `Preferred VFA speed: ${Math.round(computedValue)} mm/s`
                  : `Retraction length: ${computedValue.toFixed(1)} mm`}
              </Alert> : null}
            </DialogSection>

            <DialogSection title="Save for" description="Choose the spools that should use this value, or save it for all matching filament. If both match, the value saved for that spool is used.">
              <PluginSlot
                name="calibration.identitySuggestions"
                context={{ onSuggestionsChange: setLibraryIdentitySuggestions }}
              />
              {(run?.spoolId || hasSpoolPicker) ? (
                <RadioGroup value={scope} onChange={(event) => setScope(event.target.value as 'spool' | 'identity')}>
                  <Stack spacing={1}>
                    <Radio value="spool" label="Specific spools" />
                    <Radio value="identity" label="Matching filament family" />
                  </Stack>
                </RadioGroup>
              ) : null}
              {scope === 'spool' ? (
                <Stack spacing={1} sx={{ mt: 1 }}>
                  <PluginSlot
                    name="calibration.spoolPicker"
                    context={{
                      selectedSpoolIds,
                      onSelectedSpoolIdsChange: setSelectedSpoolIds,
                      filamentType: identity.filamentType.trim() || null,
                      brand: identity.brand.trim() || null,
                      materialSubtype: identity.materialSubtype.trim() || null,
                      colorName: identity.colorName.trim() || null,
                      currentSpoolId: run?.spoolId,
                      printerId: run?.printerId,
                      amsId: run?.amsId,
                      slotId: run?.slotId
                    }}
                    fallback={<Typography level="body-sm">{selectedSpoolIds.length} spool selected</Typography>}
                  />
                  {selectedSpoolIds.length === 0 ? (
                    <Alert color="warning" size="sm">{run ? 'Choose at least one managed spool, or add the currently loaded spool to the library here.' : 'Choose at least one spool from the filament library.'}</Alert>
                  ) : null}
                </Stack>
              ) : null}
              {scope === 'identity' ? (
                <Stack spacing={1} sx={{ mt: (run?.spoolId || hasSpoolPicker) ? 1 : 0 }}>
                  <FormLabel>Match these filament details</FormLabel>
                  <Typography level="body-sm">Check the details to match, then choose or enter a value for each.</Typography>
                  {([
                    ['brand', 'Brand', 'e.g. Polymaker'],
                    ['filamentType', 'Material type', 'e.g. PETG-CF'],
                    ['materialSubtype', 'Product line', 'e.g. PolyLite PETG'],
                    ['colorName', 'Colour', 'e.g. Red']
                  ] as const).map(([field, label, placeholder]) => (
                    <Stack key={field} direction="row" spacing={1} alignItems="center">
                      <Checkbox
                        size="sm"
                        label={label}
                        checked={match[field]}
                        onChange={(event) => setMatch((previous) => ({ ...previous, [field]: event.target.checked }))}
                        sx={{ width: 128, flexShrink: 0 }}
                      />
                      <DeferredKeyboardAutocomplete<IdentityOption, false, false, true>
                        size="sm"
                        disabled={!match[field]}
                        freeSolo
                        forcePopupIcon
                        popupIcon={<ArrowDropDownIcon />}
                        openOnFocus
                        selectOnFocus
                        handleHomeEndKeys
                        aria-label={label}
                        placeholder={placeholder}
                        options={identityOptions[field]}
                        groupBy={(option) => option.group}
                        getOptionLabel={(option) => typeof option === 'string' ? option : option.label}
                        inputValue={identity[field]}
                        onInputChange={(_event, value, reason) => {
                          if (reason !== 'reset') updateIdentity(field, value)
                        }}
                        onChange={(_event, value) => {
                          if (value != null) updateIdentity(field, typeof value === 'string' ? value : value.label)
                        }}
                        slotProps={{ listbox: { sx: { maxHeight: 240 } } }}
                        sx={{ flex: 1, minWidth: 0 }}
                      />
                    </Stack>
                  ))}
                  {hasEmptyCheckedField ? <Alert color="warning" size="sm">Enter a value for every checked detail.</Alert>
                    : !hasIdentityMatch ? <Alert color="warning" size="sm">Check at least one detail to match.</Alert> : null}
                </Stack>
              ) : null}
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!calibrationPrinterTargetSchema.safeParse(printerTarget).success || !Number.isFinite(computedValue) || (!run && !printerModel.trim()) || (editing && !savedValueValid) || (scope === 'identity' && (!hasIdentityMatch || hasEmptyCheckedField)) || (scope === 'spool' && selectedSpoolIds.length === 0)}
          >
            {priorResult || run?.status === 'saved' ? 'Save changes' : !run ? 'Save value' : 'Save result'}
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
})
