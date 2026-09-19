/**
 * New-calibration wizard: pick the printer + the AMS slot the test filament is
 * loaded in, the calibration test + its parameters, and the slicing profiles,
 * then start the run (which slices in the background). The built-in machine and
 * calibration process are matched to the printer and can be overridden;
 * the filament preset is always an explicit user choice because it owns the values being tested.
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Alert, Button, FormControl, FormLabel, ModalClose, Option, Select, Stack, Typography } from '@mui/joy'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PrinterPickerDialog } from '../../components/PrinterPickerDialog'
import {
  DEFAULT_PA_TOWER,
  DEFAULT_TEMPERATURE_TOWER,
  DEFAULT_MAX_VOLUMETRIC_SPEED_TOWER,
  DEFAULT_VFA_TOWER,
  DEFAULT_RETRACTION_TOWER,
  supportsAutomaticPressureAdvance,
  FLOW_PASS_1_OFFSETS,
  FLOW_PASS_2_OFFSETS,
  amsUnitLetter,
  calibrationFilamentIdentityFromTray,
  type CalibrationRun,
  type CreateCalibrationRun,
  type Printer,
  type PrinterStatus,
  type SlicingCapabilities,
  type SlicingPresetsResponse
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { useSlotFilamentIdentityLookup } from '../../lib/slotFilamentIdentity'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import { slicingPresetsQueryOptions } from '../../lib/slicingPresetsQuery'
import {
  BAMBU_STUDIO_PLATE_TYPES,
  formatPlateTypeLabel,
  buildSliceMaterialOptions,
  isFilamentProfileCompatible,
  isMachineProfileCompatible,
  isProcessProfileCompatible,
  narrowMaterialOptions,
  resolveLoadedMaterialType,
  slicingPresetsResponseIsUsable
} from '../../lib/slicingPresetMatching'
import { BackAwareModal } from '../../components/BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { DialogSection } from '../../components/DialogSection'
import { SlotOptionLabel, type MappingTrayOption } from '../../components/library/PrinterMapping'
import { MaterialPresetAutocomplete } from '../../components/library/MaterialPresetAutocomplete'
import { SlicingPresetAutocomplete } from '../../components/library/SlicingPresetAutocomplete'
import { resolveWorkspaceFilamentConfig } from '../../components/library/workspaceFilamentResolver'
import { buildPrinterTrayGroups, resolvePrinterNozzleCount } from '../../lib/libraryViewHelpers'
import { pickSlicingPresetByDeclaredName, pickStandardProcessProfile } from '../../lib/slicingPresetSelection'
import { NumberField } from './NumberField'
import { calibrationKeys, startCalibrationRun } from './api'
import { CalibrationSlicePrintModal } from './CalibrationSlicePrintModal'

type TestKind = 'pressureAdvance' | 'flowPass1' | 'flowPass2' | 'temperature' | 'maxVolumetricSpeed' | 'vfa' | 'retraction'

const TEST_LABELS: Record<TestKind, string> = {
  pressureAdvance: 'Pressure advance tower',
  flowPass1: 'Flow ratio: coarse (pass 1)',
  flowPass2: 'Flow ratio: fine (pass 2)',
  temperature: 'Temperature tower',
  maxVolumetricSpeed: 'Max volumetric speed',
  vfa: 'VFA tower',
  retraction: 'Retraction tower'
}

/**
 * A pre-resolved printer + AMS slot + filament to calibrate. When passed, the wizard locks the
 * printer/slot pickers (and optionally the test) so it can be launched straight from an AMS slot.
 */
export interface CalibrationLockedTarget {
  printerId: string
  amsId: number
  slotId: number
  filamentType?: string | null
  spoolId?: string | null
  brand?: string | null
  materialSubtype?: string | null
  colorName?: string | null
  /** Optional label for the read-only summary, e.g. "AMS 1 · slot 2 (PLA)". */
  label?: string
}

export const NewCalibrationDialog = memo(function NewCalibrationDialog({ printers, onClose, lockedTarget, lockedTest }: {
  printers: Printer[]
  onClose: () => void
  lockedTarget?: CalibrationLockedTarget
  lockedTest?: TestKind
}) {
  const queryClient = useQueryClient()
  const scopeKey = readCurrentWorkspaceScopeKey()

  // Once a run is started the dialog swaps to a slice-progress tracker (like the library's
  // slice-then-print flow) instead of closing and leaving the user to watch a toast.
  const [startedRun, setStartedRun] = useState<CalibrationRun | null>(null)
  const [printerId, setPrinterId] = useState<string>(() => lockedTarget?.printerId ?? printers[0]?.id ?? '')
  const [slotKey, setSlotKey] = useState<string>(() => (lockedTarget ? `${lockedTarget.amsId}:${lockedTarget.slotId}` : ''))
  const [printerPickerOpen, setPrinterPickerOpen] = useState(false)
  const [test, setTest] = useState<TestKind>(lockedTest ?? 'pressureAdvance')
  const [startK, setStartK] = useState<number>(DEFAULT_PA_TOWER.startK)
  const [endK, setEndK] = useState<number>(DEFAULT_PA_TOWER.endK)
  const [step, setStep] = useState<number>(DEFAULT_PA_TOWER.step)
  const [paMethod, setPaMethod] = useState<'tower' | 'automatic'>('tower')
  const [startRetraction, setStartRetraction] = useState<number>(DEFAULT_RETRACTION_TOWER.startLength)
  const [endRetraction, setEndRetraction] = useState<number>(DEFAULT_RETRACTION_TOWER.endLength)
  const [retractionStep, setRetractionStep] = useState<number>(DEFAULT_RETRACTION_TOWER.step)
  // No placeholder baseline: the selected filament preset is the authority and must resolve first.
  const [currentFlowRatio, setCurrentFlowRatio] = useState<number>(Number.NaN)
  const [startTemperature, setStartTemperature] = useState<number>(DEFAULT_TEMPERATURE_TOWER.startTemperature)
  const [endTemperature, setEndTemperature] = useState<number>(DEFAULT_TEMPERATURE_TOWER.endTemperature)
  const [startVolumetricSpeed, setStartVolumetricSpeed] = useState<number>(DEFAULT_MAX_VOLUMETRIC_SPEED_TOWER.startSpeed)
  const [endVolumetricSpeed, setEndVolumetricSpeed] = useState<number>(DEFAULT_MAX_VOLUMETRIC_SPEED_TOWER.endSpeed)
  const [volumetricSpeedStep, setVolumetricSpeedStep] = useState<number>(DEFAULT_MAX_VOLUMETRIC_SPEED_TOWER.step)
  const [startVfaSpeed, setStartVfaSpeed] = useState<number>(DEFAULT_VFA_TOWER.startSpeed)
  const [endVfaSpeed, setEndVfaSpeed] = useState<number>(DEFAULT_VFA_TOWER.endSpeed)
  const [vfaSpeedStep, setVfaSpeedStep] = useState<number>(DEFAULT_VFA_TOWER.step)
  const [plateTypeOverride, setPlateTypeOverride] = useState<string>()
  const [machineId, setMachineId] = useState<string>()
  const [processId, setProcessId] = useState<string>()
  const [filamentId, setFilamentId] = useState<string>()
  const [showProfiles, setShowProfiles] = useState(false)

  const clearFilamentPreset = () => {
    setFilamentId(undefined)
    setCurrentFlowRatio(Number.NaN)
  }

  const selectedPrinter = printers.find((printer) => printer.id === printerId)
  const lookupLoadedSpool = useSlotFilamentIdentityLookup()

  // The WebSocket subscription owns this cache key (no-op queryFn, never refetch);
  // `select` narrows it to just the chosen printer's slots so unrelated status ticks
  // (temps, progress, other printers) don't re-render the dialog and its dropdowns.
  const slotsQuery = useQuery({
    queryKey: workspaceQueryKeys.printerStatus(scopeKey),
    queryFn: () => Promise.resolve<Record<string, PrinterStatus>>({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    select: (statuses: Record<string, PrinterStatus>) => {
      const status = printerId ? statuses[printerId] : undefined
      const trayGroups = buildPrinterTrayGroups(status)
        .map((group) => ({
          ...group,
          trays: group.trays
            .filter((tray) => tray.kind === 'ams')
            .map((tray): MappingTrayOption => {
              const spool = lookupLoadedSpool(printerId, tray.amsUnitId ?? null, tray.amsSlotId ?? null)
              return spool?.remainingGrams != null ? { ...tray, remainingGrams: spool.remainingGrams } : tray
            })
        }))
        .filter((group) => group.trays.length > 0)
      const slots = trayGroups.flatMap((group) => group.trays.map((tray) => {
        const spool = lookupLoadedSpool(printerId, tray.amsUnitId, tray.amsSlotId)
        const rawTray = status?.ams.find((unit) => unit.unitId === tray.amsUnitId)
          ?.slots.find((slot) => slot.slot === tray.amsSlotId)
        return {
          amsId: tray.amsUnitId!,
          slotId: tray.amsSlotId!,
          label: `${tray.groupLabel} · slot ${tray.amsSlotId! + 1}${tray.filamentType ? ` (${tray.filamentType})` : ''}`,
          ...calibrationFilamentIdentityFromTray(rawTray, spool),
          tray
        }
      }))
      // The printer's live reported nozzle(s). The persisted printer row's `currentNozzleDiameters`
      // is frequently empty, so read the diameter from live status too, otherwise the machine
      // profile auto-pick can't tell 0.4 from 0.2 and a 0.2-nozzle profile slices the wrong way.
      const nozzleDiameters = (status?.nozzles ?? [])
        .map((nozzle) => Number(nozzle.diameter))
        .filter((diameter) => Number.isFinite(diameter) && diameter > 0)
      return { status, slots, trayGroups, nozzleDiameters }
    }
  })
  const slots = useMemo(() => slotsQuery.data?.slots ?? [], [slotsQuery.data])
  const slotTrays = useMemo(() => slots.map((slot) => slot.tray), [slots])
  const slotNozzleCount = selectedPrinter
    ? resolvePrinterNozzleCount(selectedPrinter, slotsQuery.data?.status)
    : null
  const selectedSlot = slots.find((slot) => `${slot.amsId}:${slot.slotId}` === slotKey)
    ?? (lockedTarget
      ? {
          amsId: lockedTarget.amsId,
          slotId: lockedTarget.slotId,
          label: lockedTarget.label ?? '',
          filamentType: lockedTarget.filamentType ?? null,
          spoolId: lockedTarget.spoolId ?? null,
          brand: lockedTarget.brand ?? null,
          materialSubtype: lockedTarget.materialSubtype ?? null,
          colorName: lockedTarget.colorName ?? null
        }
      : undefined)
  const capabilitiesQuery = useQuery<SlicingCapabilities>({
    queryKey: ['slicing-capabilities'],
    queryFn: async ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal }),
    staleTime: 5 * 60_000
  })
  const targetId = capabilitiesQuery.data?.defaultTargetId ?? capabilitiesQuery.data?.targets[0]?.id ?? ''
  const profilesQuery = useQuery<SlicingPresetsResponse>({
    ...slicingPresetsQueryOptions(targetId),
    enabled: Boolean(targetId)
  })
  const profiles = useMemo(() => profilesQuery.data?.profiles ?? [], [profilesQuery.data])
  const profilesUsable = slicingPresetsResponseIsUsable(profiles)

  // Scope the huge catalogue (2000+ filaments, 700+ processes, 400+ machines) down to what is
  // compatible with the chosen printer BEFORE rendering it, otherwise the dropdowns mount
  // thousands of <Option> nodes and every interaction re-renders them, freezing the dialog.
  // Each list is memoized so the Selects render a stable, small set of options.
  const model = selectedPrinter?.model ?? ''
  const nozzleDiameters = useMemo(() => {
    const fromStatus = slotsQuery.data?.nozzleDiameters ?? []
    if (fromStatus.length > 0) return fromStatus
    return (selectedPrinter?.currentNozzleDiameters ?? [])
      .map((nozzle) => Number(nozzle.diameter))
      .filter((diameter) => Number.isFinite(diameter) && diameter > 0)
  }, [slotsQuery.data, selectedPrinter])
  const machineProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === 'machine' && isMachineProfileCompatible(profile, model, nozzleDiameters)),
    [profiles, model, nozzleDiameters]
  )
  // Automatic suggestions are built-in only. Custom presets sort ahead of built-ins in the
  // catalogue, but choosing one silently is surprising in a calibration whose baseline matters.
  // When the printer reports no nozzle diameter, prefer the conventional 0.4 nozzle among those
  // built-ins rather than whichever nozzle variant happens to sort first.
  const builtinMachineProfiles = machineProfiles.filter((profile) => profile.source === 'builtin')
  const resolvedMachine = machineId
    ?? (builtinMachineProfiles.find((profile) => /\b0\.4\b/.test(profile.name))
      ?? builtinMachineProfiles[0])?.id
  const selectedMachineProfile = machineProfiles.find((profile) => profile.id === resolvedMachine) ?? null
  const processProfiles = useMemo(
    // The catalogue is passed for the same reason the slice dialog passes it: a project preset is
    // judged by its PARENT's declared compatibility rather than by its name. Inert here today (this
    // list carries no `project:` presets), and passed anyway so the two surfaces cannot answer
    // differently the moment one does.
    () => profiles.filter((profile) => profile.kind === 'process' && isProcessProfileCompatible(profile, selectedMachineProfile, model, nozzleDiameters, '', profiles)),
    [profiles, selectedMachineProfile, model, nozzleDiameters]
  )
  const defaultProcessProfiles = processProfiles.filter((profile) => profile.source === 'builtin')
  const resolvedProcess = processId
    ?? (pickSlicingPresetByDeclaredName(defaultProcessProfiles, selectedMachineProfile?.defaultProcessProfile)
      ?? pickStandardProcessProfile(defaultProcessProfiles))?.id
  const selectedProcessProfile = processProfiles.find((profile) => profile.id === resolvedProcess) ?? null
  const filamentProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === 'filament' && isFilamentProfileCompatible(profile, selectedMachineProfile, selectedProcessProfile, model, nozzleDiameters)),
    [profiles, selectedMachineProfile, selectedProcessProfile, model, nozzleDiameters]
  )
  const slotMaterialType = resolveLoadedMaterialType(
    selectedSlot?.filamentType,
    null,
    selectedSlot?.filamentType ?? ''
  )
  // Use the same option builder and exact material-type narrowing as the slice material editor.
  // Machine/process compatibility alone admits every polymer the printer can handle, which is why
  // an ASA preset previously appeared while calibrating a PETG slot.
  const filamentOptions = useMemo(
    () => narrowMaterialOptions(buildSliceMaterialOptions(filamentProfiles, []), slotMaterialType),
    [filamentProfiles, slotMaterialType]
  )
  // Calibration changes the values owned by a FILAMENT preset. Do not silently substitute a
  // generic preset based on the slot's broad material type: two PLA profiles can intentionally
  // differ in temperature, flow and volumetric limits, which are exactly the baselines being tested.
  const selectedFilamentProfile = filamentProfiles.find((profile) => profile.id === filamentId) ?? null
  const selectedFilamentOption = filamentOptions.find((option) => option.profileId === filamentId) ?? null
  const resolvedFilament = selectedFilamentProfile?.id

  const filamentConfigQuery = useQuery({
    queryKey: ['slicing-profile-config', 'filament', targetId, resolvedFilament],
    queryFn: ({ signal }) => resolveWorkspaceFilamentConfig({
      filamentProfileId: resolvedFilament!, targetId, sourceFileId: null, projectFilamentId: null
    }, { signal }),
    enabled: Boolean(targetId && resolvedFilament),
    staleTime: 5 * 60_000
  })
  useEffect(() => {
    const config = filamentConfigQuery.data?.config
    if (!config) return
    const scalar = (value: unknown): number | null => {
      const candidate = Array.isArray(value) ? value[0] : value
      const parsed = Number(candidate)
      return Number.isFinite(parsed) ? parsed : null
    }
    const flow = scalar(config.filament_flow_ratio)
    if (flow != null && flow > 0 && flow < 2) setCurrentFlowRatio(flow)
    const high = scalar(config.nozzle_temperature_range_high) ?? scalar(config.nozzle_temperature)
    const low = scalar(config.nozzle_temperature_range_low)
    if (high != null) setStartTemperature(Math.min(350, Math.max(180, Math.round(high / 5) * 5)))
    if (low != null) setEndTemperature(Math.min(350, Math.max(180, Math.round(low / 5) * 5)))
  }, [filamentConfigQuery.data, resolvedFilament])

  // Plate/bed type to slice for: defaults to the plate installed on the printer so bed temps match,
  // overridable below. Offer the standard Bambu plates plus the installed one if it is non-standard.
  const currentPlate = selectedPrinter?.currentPlateType ?? null
  const plateOptions = useMemo(() => {
    const standard = BAMBU_STUDIO_PLATE_TYPES.map(formatPlateTypeLabel)
    return currentPlate && !standard.some((plate) => plate.toLowerCase() === currentPlate.toLowerCase())
      ? [currentPlate, ...standard]
      : standard
  }, [currentPlate])
  const resolvedPlate = plateTypeOverride ?? currentPlate ?? plateOptions[0] ?? null

  // Memoize the <Option> element arrays so editing a number field (start K, flow ratio, …) does not
  // re-render hundreds of dropdown options: Joy renders every Select's options into the DOM, so
  // stable element references let React skip that subtree when unrelated state changes.
  const slotOptions = useMemo(() => slotsQuery.data?.trayGroups.flatMap((group) => [
    <Typography
      key={`header-${group.key}`}
      level="body-xs"
      textColor="text.tertiary"
      sx={{ px: 1, pt: 0.5, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}
    >
      {group.label}
    </Typography>,
    ...group.trays.map((tray) => (
      <Option key={tray.key} value={`${tray.amsUnitId}:${tray.amsSlotId}`}>
        <SlotOptionLabel
          tray={tray}
          trays={slotTrays}
          printerId={printerId}
          nozzleCount={slotNozzleCount}
        />
      </Option>
    ))
  ]) ?? [], [printerId, slotNozzleCount, slotTrays, slotsQuery.data])

  const automatic = test === 'pressureAdvance' && paMethod === 'automatic'

  const start = useMutation({
    mutationFn: () => {
      if (!selectedPrinter || !selectedSlot) throw new Error('Pick a printer and the AMS slot with your test filament')
      if (!resolvedFilament || (!automatic && (!resolvedMachine || !resolvedProcess))) throw new Error('Slicing presets are still loading')
      let parameters: CreateCalibrationRun['parameters']
      switch (test) {
        case 'pressureAdvance': parameters = { kind: 'pressureAdvance', startK, endK, step, method: paMethod }; break
        case 'flowPass1': parameters = { kind: 'flowRatio', pass: 1, currentFlowRatio, offsets: [...FLOW_PASS_1_OFFSETS] }; break
        case 'flowPass2': parameters = { kind: 'flowRatio', pass: 2, currentFlowRatio, offsets: [...FLOW_PASS_2_OFFSETS] }; break
        case 'temperature': parameters = { kind: 'temperature', startTemperature, endTemperature, step: 5 }; break
        case 'maxVolumetricSpeed': parameters = { kind: 'maxVolumetricSpeed', startSpeed: startVolumetricSpeed, endSpeed: endVolumetricSpeed, step: volumetricSpeedStep, currentFlowRatio }; break
        case 'vfa': parameters = { kind: 'vfa', startSpeed: startVfaSpeed, endSpeed: endVfaSpeed, step: vfaSpeedStep }; break
        case 'retraction': parameters = { kind: 'retraction', startLength: startRetraction, endLength: endRetraction, step: retractionStep }; break
      }
      const body: CreateCalibrationRun = {
        printerId: selectedPrinter.id,
        amsId: selectedSlot.amsId,
        slotId: selectedSlot.slotId,
        parameters,
        printerProfileId: resolvedMachine,
        processProfileId: resolvedProcess,
        filamentProfileId: resolvedFilament,
        ...(resolvedPlate ? { plateType: resolvedPlate } : {}),
        brand: selectedSlot.brand ?? selectedFilamentOption?.brand ?? null,
        filamentType: selectedSlot.filamentType ?? selectedFilamentOption?.materialType ?? null,
        materialSubtype: selectedSlot.materialSubtype ?? null,
        colorName: selectedSlot.colorName ?? null,
        ...(selectedSlot.spoolId ? { spoolId: selectedSlot.spoolId } : {})
      }
      return startCalibrationRun(body)
    },
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.runs })
      // Hand off to the slice-progress tracker (rendered below) rather than closing, it carries the
      // user through slicing to the Print action and then lands them on the Calibration page.
      setStartedRun(run)
    }
    // Errors surface once via the global mutation error handler (main.tsx), no local onError toast.
  })

  if (startedRun) return <CalibrationSlicePrintModal run={startedRun} onClose={onClose} />

  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog aria-labelledby="new-calibration-title" sx={{ maxWidth: 520 }}>
        <Typography id="new-calibration-title" level="h4" startDecorator={<ScienceRoundedIcon />}>
          {lockedTest === 'pressureAdvance' ? 'Pressure advance calibration' : 'New calibration'}
        </Typography>
        <ModalClose />
        <ScrollableDialogBody>
          <Stack spacing={2}>
            {lockedTarget ? (
              <DialogSection title="Filament" description="Calibrating the filament loaded in this slot.">
                <Typography level="body-sm">
                  {selectedPrinter?.name ?? 'Printer'} · {selectedSlot?.label || `AMS ${amsUnitLetter(lockedTarget.amsId)} · slot ${lockedTarget.slotId + 1}`}
                </Typography>
              </DialogSection>
            ) : (
              <DialogSection title="Printer and filament" description="Load the filament you want to calibrate into an AMS slot first.">
                <Stack spacing={1.5}>
                  <FormControl>
                    <FormLabel>Printer</FormLabel>
                    {/* The shared picker, so a farm is searched and filtered here exactly as it is
                        in the slice settings and the queue. */}
                    <Button
                      type="button"
                      variant="outlined"
                      color="neutral"
                      onClick={() => setPrinterPickerOpen(true)}
                      sx={{ justifyContent: 'flex-start', fontWeight: 'normal' }}
                    >
                      {selectedPrinter?.name ?? 'Choose a printer'}
                    </Button>
                  </FormControl>
                  {printerPickerOpen && (
                    <PrinterPickerDialog
                      open
                      entries={printers.map((printer) => ({ printer }))}
                      selectedPrinterId={printerId || null}
                      onSelect={(printer) => {
                        // Slots belong to the previous machine, so a printer change clears the pick.
                        setPrinterId(printer?.id ?? '')
                        setPaMethod('tower')
                        setSlotKey('')
                        setMachineId(undefined)
                        setProcessId(undefined)
                        clearFilamentPreset()
                      }}
                      onClose={() => setPrinterPickerOpen(false)}
                    />
                  )}
                  <FormControl>
                    <FormLabel>AMS slot</FormLabel>
                    <Select
                      value={slotKey || null}
                      placeholder={slots.length ? 'Select a slot' : slotsQuery.data?.status ? 'No AMS slots reported' : 'Waiting for printer status…'}
                      disabled={slots.length === 0}
                      onChange={(_event, value) => {
                        setSlotKey(value ?? '')
                        clearFilamentPreset()
                      }}
                      renderValue={(option) => {
                        const slot = option ? slots.find((candidate) => `${candidate.amsId}:${candidate.slotId}` === option.value) : null
                        if (!slot) return <Typography level="body-sm">Select a slot</Typography>
                        return (
                          <SlotOptionLabel
                            tray={slot.tray}
                            trays={slotTrays}
                            printerId={printerId}
                            nozzleCount={slotNozzleCount}
                          />
                        )
                      }}
                      slotProps={{
                        button: { sx: { textAlign: 'left', justifyContent: 'flex-start', minHeight: 48 } },
                        listbox: {
                          placement: 'bottom-start',
                          modifiers: [{ name: 'equalWidth', enabled: false }],
                          sx: { minWidth: { xs: 'min(92vw, 360px)', sm: 360 }, maxWidth: 'calc(100vw - 32px)', width: 'max-content' }
                        }
                      }}
                    >
                      {slotOptions}
                    </Select>
                  </FormControl>
                </Stack>
              </DialogSection>
            )}

            <DialogSection title="Filament preset" description="Choose the exact preset whose current values you want to calibrate.">
              {!profilesUsable ? (
                <Alert color="warning" size="sm">Loading slicing presets…</Alert>
              ) : (
                <FormControl required>
                  <FormLabel>Preset</FormLabel>
                  <MaterialPresetAutocomplete
                    options={filamentOptions}
                    value={selectedFilamentOption}
                    placeholder={selectedSlot?.filamentType ? `Choose a ${selectedSlot.filamentType} preset` : 'Choose a filament preset'}
                    onChange={(option) => {
                      // Clear the previous baseline immediately. The newly selected preset's
                      // resolved value becomes authoritative when its config request completes.
                      setCurrentFlowRatio(Number.NaN)
                      setFilamentId(option?.profileId ?? undefined)
                    }}
                  />
                </FormControl>
              )}
            </DialogSection>

            <DialogSection title="Test">
              <Stack spacing={1.5}>
                {lockedTest ? null : (
                  <FormControl>
                    <FormLabel>Calibration</FormLabel>
                    <Select value={test} onChange={(_event, value) => value && setTest(value)}>
                      {(Object.keys(TEST_LABELS) as TestKind[]).map((key) => <Option key={key} value={key}>{TEST_LABELS[key]}</Option>)}
                    </Select>
                  </FormControl>
                )}
                {test === 'pressureAdvance' && supportsAutomaticPressureAdvance(selectedPrinter?.model ?? '') ? (
                  <FormControl>
                    <FormLabel>Method</FormLabel>
                    <Select value={paMethod} onChange={(_event, value) => value && setPaMethod(value)}>
                      <Option value="tower">Print and measure a tower</Option>
                      <Option value="automatic">Automatic (Micro Lidar)</Option>
                    </Select>
                  </FormControl>
                ) : null}
                {test === 'pressureAdvance' && paMethod === 'automatic' ? (
                  <Alert color="neutral">The printer prints and scans its own pattern. Review the measured value, then save it in PrintStream. PrintStream does not write a printer calibration profile.</Alert>
                ) : test === 'pressureAdvance' ? (
                  <Stack direction="row" spacing={1}>
                    <NumberField label="Start K" value={startK} step={0.001} min={0} max={2} onChange={setStartK} />
                    <NumberField label="End K" value={endK} step={0.001} min={0} max={2} onChange={setEndK} />
                    <NumberField label="Step" value={step} step={0.001} min={0.001} max={2} onChange={setStep} />
                  </Stack>
                ) : (test === 'flowPass1' || test === 'flowPass2') && !resolvedFilament ? (
                  <Alert color="neutral" size="sm">Choose the filament preset above to load its current flow ratio.</Alert>
                ) : (test === 'flowPass1' || test === 'flowPass2') && filamentConfigQuery.isPending ? (
                  <Alert color="neutral" size="sm">Loading the preset’s current flow ratio…</Alert>
                ) : (test === 'flowPass1' || test === 'flowPass2') && filamentConfigQuery.isError ? (
                  <Alert color="danger" size="sm">Could not load the selected preset’s flow ratio.</Alert>
                ) : (test === 'flowPass1' || test === 'flowPass2') && !Number.isFinite(currentFlowRatio) ? (
                  <Alert color="warning" size="sm">The selected preset does not provide a valid flow ratio.</Alert>
                ) : test === 'flowPass1' || test === 'flowPass2' ? (
                  <NumberField label="Current flow ratio" value={currentFlowRatio} step={0.01} min={0.5} max={1.5} onChange={setCurrentFlowRatio} helperText="From the material preset you are tuning; each patch prints relative to this." />
                ) : test === 'temperature' ? (
                  <Stack direction="row" spacing={1}>
                    <NumberField label="Start" value={startTemperature} step={5} min={180} max={350} endDecorator="C" onChange={setStartTemperature} />
                    <NumberField label="End" value={endTemperature} step={5} min={180} max={350} endDecorator="C" onChange={setEndTemperature} />
                  </Stack>
                ) : test === 'maxVolumetricSpeed' ? (
                  <Stack direction="row" spacing={1}>
                    <NumberField label="Start" value={startVolumetricSpeed} step={1} min={0} max={60} onChange={setStartVolumetricSpeed} />
                    <NumberField label="End" value={endVolumetricSpeed} step={1} min={0} max={60} onChange={setEndVolumetricSpeed} />
                    <NumberField label="Step" value={volumetricSpeedStep} step={1} min={0.1} max={60} onChange={setVolumetricSpeedStep} />
                  </Stack>
                ) : test === 'retraction' ? (
                  <Stack direction="row" spacing={1}>
                    <NumberField label="Start" value={startRetraction} step={0.1} min={0} max={10} endDecorator="mm" onChange={setStartRetraction} />
                    <NumberField label="End" value={endRetraction} step={0.1} min={0} max={10} endDecorator="mm" onChange={setEndRetraction} />
                    <NumberField label="Step" value={retractionStep} step={0.1} min={0.01} max={2} endDecorator="mm" onChange={setRetractionStep} />
                  </Stack>
                ) : (
                  <Stack direction="row" spacing={1}>
                    <NumberField label="Start" value={startVfaSpeed} step={10} min={10} max={300} onChange={setStartVfaSpeed} />
                    <NumberField label="End" value={endVfaSpeed} step={10} min={10} max={300} onChange={setEndVfaSpeed} />
                    <NumberField label="Step" value={vfaSpeedStep} step={10} min={1} max={100} onChange={setVfaSpeedStep} />
                  </Stack>
                )}
              </Stack>
            </DialogSection>

            <DialogSection title="Print setup" description={automatic ? 'The selected plate determines the calibration bed temperature.' : 'Printer and process are matched to the hardware; review them when using a custom setup.'}>
              {automatic ? (
                <FormControl>
                  <FormLabel>Plate</FormLabel>
                  <Select value={resolvedPlate ?? ''} onChange={(_event, value) => setPlateTypeOverride(value ?? undefined)}>
                    {plateOptions.map((plate) => <Option key={plate} value={plate}>{plate}</Option>)}
                  </Select>
                </FormControl>
              ) : !profilesUsable ? (
                <Alert color="warning" size="sm">Loading slicing presets…</Alert>
              ) : showProfiles ? (
                // Rendered only on demand: each Joy Select mounts its full option list into the DOM,
                // so keeping the machine/process lists out of the default flow keeps the dialog snappy.
                <Stack spacing={1.5}>
                  <FormControl>
                    <FormLabel>Printer preset</FormLabel>
                    <SlicingPresetAutocomplete
                      profiles={machineProfiles}
                      value={selectedMachineProfile}
                      placeholder="Choose a printer preset"
                      ariaLabel="Printer preset"
                      onChange={(profile) => {
                        setMachineId(profile?.id)
                        setProcessId(undefined)
                        clearFilamentPreset()
                      }}
                    />
                  </FormControl>
                  <FormControl>
                    <FormLabel>Process preset</FormLabel>
                    <SlicingPresetAutocomplete
                      profiles={processProfiles}
                      value={selectedProcessProfile}
                      placeholder="Choose a process preset"
                      ariaLabel="Process preset"
                      onChange={(profile) => {
                        setProcessId(profile?.id)
                        clearFilamentPreset()
                      }}
                    />
                  </FormControl>
                  <FormControl>
                    <FormLabel>Plate</FormLabel>
                    <Select value={resolvedPlate ?? ''} onChange={(_event, value) => setPlateTypeOverride(value ?? undefined)}>
                      {plateOptions.map((plate) => <Option key={plate} value={plate}>{plate}</Option>)}
                    </Select>
                  </FormControl>
                </Stack>
              ) : (
                <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ flexWrap: 'wrap' }}>
                  <Typography level="body-sm" textColor="text.tertiary" sx={{ minWidth: 0, flex: 1 }}>
                    {[selectedMachineProfile?.name, selectedProcessProfile?.name, resolvedPlate].filter(Boolean).join(' · ') || 'Using defaults'}
                  </Typography>
                  <Button size="sm" variant="plain" onClick={() => setShowProfiles(true)}>Customize</Button>
                </Stack>
              )}
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => start.mutate()}
            loading={start.isPending}
            disabled={
              !selectedSlot
              || !profilesUsable
              || (!automatic && (!resolvedMachine || !resolvedProcess))
              || !resolvedFilament
              || !filamentConfigQuery.isSuccess
              || ((test === 'flowPass1' || test === 'flowPass2' || test === 'maxVolumetricSpeed')
                && !Number.isFinite(currentFlowRatio))
            }
          >
            Start calibration
          </Button>
        </Stack>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
})
