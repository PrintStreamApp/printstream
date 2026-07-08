/**
 * New-calibration wizard: pick the printer + the AMS slot the test filament is
 * loaded in, the calibration test + its parameters, and the slicing profiles,
 * then start the run (which slices in the background). Profiles are auto-picked
 * from the slicer catalogue for the printer's model and can be overridden.
 */
import { memo, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Alert, Button, FormControl, FormLabel, Modal, ModalClose, Option, Select, Stack, Typography } from '@mui/joy'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_PA_TOWER,
  FLOW_PASS_1_OFFSETS,
  FLOW_PASS_2_OFFSETS,
  type CreateCalibrationRun,
  type Printer,
  type PrinterStatus,
  type SlicingCapabilities,
  type SlicingProfilesResponse
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import { buildTenantWorkspacePath, parseWorkspacePathname } from '../../lib/workspaceRoute'
import {
  BAMBU_STUDIO_PLATE_TYPES,
  formatPlateTypeLabel,
  isFilamentProfileCompatible,
  isMachineProfileCompatible,
  isProcessProfileCompatible,
  slicingProfilesResponseIsUsable
} from '../../lib/sliceProfileMatching'
import { toast } from '../../lib/toast'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'
import { DialogSection } from '../../components/DialogSection'
import { NumberField } from './NumberField'
import { calibrationKeys, startCalibrationRun } from './api'

type TestKind = 'pressureAdvance' | 'flowPass1' | 'flowPass2'

const TEST_LABELS: Record<TestKind, string> = {
  pressureAdvance: 'Pressure advance tower',
  flowPass1: 'Flow ratio — coarse (pass 1)',
  flowPass2: 'Flow ratio — fine (pass 2)'
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
  const navigate = useNavigate()
  const location = useLocation()

  const [printerId, setPrinterId] = useState<string>(() => lockedTarget?.printerId ?? printers[0]?.id ?? '')
  const [slotKey, setSlotKey] = useState<string>(() => (lockedTarget ? `${lockedTarget.amsId}:${lockedTarget.slotId}` : ''))
  const [test, setTest] = useState<TestKind>(lockedTest ?? 'pressureAdvance')
  const [startK, setStartK] = useState<number>(DEFAULT_PA_TOWER.startK)
  const [endK, setEndK] = useState<number>(DEFAULT_PA_TOWER.endK)
  const [step, setStep] = useState<number>(DEFAULT_PA_TOWER.step)
  const [currentFlowRatio, setCurrentFlowRatio] = useState<number>(0.98)
  const [plateTypeOverride, setPlateTypeOverride] = useState<string>()
  const [machineId, setMachineId] = useState<string>()
  const [processId, setProcessId] = useState<string>()
  const [filamentId, setFilamentId] = useState<string>()
  const [showProfiles, setShowProfiles] = useState(false)

  const selectedPrinter = printers.find((printer) => printer.id === printerId)

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
      const slots = (status?.ams ?? []).flatMap((unit) => unit.slots.map((slot) => ({
        amsId: unit.unitId,
        slotId: slot.slot,
        label: `AMS ${unit.unitId} · slot ${slot.slot + 1}${slot.filamentType ? ` (${slot.filamentType})` : ''}`,
        filamentType: slot.filamentType
      })))
      // The printer's live reported nozzle(s). The persisted printer row's `currentNozzleDiameters`
      // is frequently empty, so read the diameter from live status too — otherwise the machine
      // profile auto-pick can't tell 0.4 from 0.2 and a 0.2-nozzle profile slices the wrong way.
      const nozzleDiameters = (status?.nozzles ?? [])
        .map((nozzle) => Number(nozzle.diameter))
        .filter((diameter) => Number.isFinite(diameter) && diameter > 0)
      return { slots, nozzleDiameters }
    }
  })
  const slots = useMemo(() => slotsQuery.data?.slots ?? [], [slotsQuery.data])
  const selectedSlot = slots.find((slot) => `${slot.amsId}:${slot.slotId}` === slotKey)
    ?? (lockedTarget
      ? { amsId: lockedTarget.amsId, slotId: lockedTarget.slotId, label: lockedTarget.label ?? '', filamentType: lockedTarget.filamentType ?? null }
      : undefined)

  const capabilitiesQuery = useQuery<SlicingCapabilities>({
    queryKey: ['slicing-capabilities'],
    queryFn: async ({ signal }) => apiFetch<SlicingCapabilities>('/api/slicing/capabilities', { signal }),
    staleTime: 5 * 60_000
  })
  const targetId = capabilitiesQuery.data?.defaultTargetId ?? capabilitiesQuery.data?.targets[0]?.id ?? ''
  const profilesQuery = useQuery<SlicingProfilesResponse>({
    queryKey: ['slicing-profiles', targetId],
    queryFn: async ({ signal }) => apiFetch<SlicingProfilesResponse>(`/api/slicing/profiles?targetId=${encodeURIComponent(targetId)}`, { signal }),
    enabled: Boolean(targetId),
    staleTime: 5 * 60_000
  })
  const profiles = useMemo(() => profilesQuery.data?.profiles ?? [], [profilesQuery.data])
  const profilesUsable = slicingProfilesResponseIsUsable(profiles)

  // Scope the huge catalogue (2000+ filaments, 700+ processes, 400+ machines) down to what is
  // compatible with the chosen printer BEFORE rendering it — otherwise the dropdowns mount
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
  // When the printer reports no nozzle diameter the compatible set spans 0.2/0.4/0.6/0.8; default to
  // the 0.4 nozzle (by far the most common) rather than whichever variant sorts first — a 0.2 profile
  // makes a 0.20mm-layer process invalid and crashes the slice.
  const resolvedMachine = machineId
    ?? (machineProfiles.find((profile) => /\b0\.4\b/.test(profile.name)) ?? machineProfiles[0])?.id
  const selectedMachineProfile = machineProfiles.find((profile) => profile.id === resolvedMachine) ?? null
  const processProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === 'process' && isProcessProfileCompatible(profile, selectedMachineProfile, model, nozzleDiameters, '')),
    [profiles, selectedMachineProfile, model, nozzleDiameters]
  )
  const resolvedProcess = processId
    ?? (processProfiles.find((profile) => /0\.20mm\s+standard/i.test(profile.name)) ?? processProfiles.find((profile) => /standard/i.test(profile.name)) ?? processProfiles[0])?.id
  const selectedProcessProfile = processProfiles.find((profile) => profile.id === resolvedProcess) ?? null
  const filamentProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === 'filament' && isFilamentProfileCompatible(profile, selectedMachineProfile, selectedProcessProfile, model, nozzleDiameters)),
    [profiles, selectedMachineProfile, selectedProcessProfile, model, nozzleDiameters]
  )
  const slotFilamentType = selectedSlot?.filamentType ?? null
  const typeLc = slotFilamentType?.toLowerCase() ?? ''
  // Default to the neutral builtin "Generic <type>" (e.g. Generic PLA), NOT a plain substring
  // match: the catalogue lists custom presets first, so a substring match would pick an unrelated
  // custom preset (e.g. "Bambu PLA Basic - Custom") over the generic base a new filament wants.
  const resolvedFilament = filamentId
    ?? ((typeLc ? filamentProfiles.find((profile) => profile.name.toLowerCase() === `generic ${typeLc}`) : undefined)
      ?? (typeLc ? filamentProfiles.find((profile) => new RegExp(`^generic ${typeLc}\\b`, 'i').test(profile.name)) : undefined)
      ?? filamentProfiles.find((profile) => /^generic pla\b/i.test(profile.name))
      ?? (typeLc ? filamentProfiles.find((profile) => profile.name.toLowerCase().includes(typeLc)) : undefined)
      ?? filamentProfiles[0])?.id

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
  // re-render hundreds of dropdown options — Joy renders every Select's options into the DOM, so
  // stable element references let React skip that subtree when unrelated state changes.
  const printerOptions = useMemo(() => printers.map((printer) => <Option key={printer.id} value={printer.id}>{printer.name}</Option>), [printers])
  const slotOptions = useMemo(() => slots.map((slot) => <Option key={`${slot.amsId}:${slot.slotId}`} value={`${slot.amsId}:${slot.slotId}`}>{slot.label}</Option>), [slots])
  const machineOptions = useMemo(() => machineProfiles.map((profile) => <Option key={profile.id} value={profile.id}>{profile.name}</Option>), [machineProfiles])
  const processOptions = useMemo(() => processProfiles.map((profile) => <Option key={profile.id} value={profile.id}>{profile.name}</Option>), [processProfiles])
  const filamentOptions = useMemo(() => filamentProfiles.map((profile) => <Option key={profile.id} value={profile.id}>{profile.name}</Option>), [filamentProfiles])

  const start = useMutation({
    mutationFn: () => {
      if (!selectedPrinter || !selectedSlot) throw new Error('Pick a printer and the AMS slot with your test filament')
      if (!resolvedMachine || !resolvedProcess || !resolvedFilament) throw new Error('Slicer profiles are still loading')
      const parameters: CreateCalibrationRun['parameters'] = test === 'pressureAdvance'
        ? { kind: 'pressureAdvance', startK, endK, step }
        : { kind: 'flowRatio', pass: test === 'flowPass1' ? 1 : 2, currentFlowRatio, offsets: [...(test === 'flowPass1' ? FLOW_PASS_1_OFFSETS : FLOW_PASS_2_OFFSETS)] }
      const body: CreateCalibrationRun = {
        printerId: selectedPrinter.id,
        amsId: selectedSlot.amsId,
        slotId: selectedSlot.slotId,
        parameters,
        printerProfileId: resolvedMachine,
        processProfileId: resolvedProcess,
        filamentProfileId: resolvedFilament,
        ...(resolvedPlate ? { plateType: resolvedPlate } : {}),
        filamentType: selectedSlot.filamentType,
        ...(lockedTarget?.spoolId ? { spoolId: lockedTarget.spoolId } : {})
      }
      return startCalibrationRun(body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: calibrationKeys.runs })
      toast.success('Calibration started — slicing now')
      onClose()
      // Take the user to the Calibration view where the run's live status and next step (print →
      // measure → save) live — otherwise "Start" just closes the dialog and leaves them stranded
      // wherever they launched it (often the printer's AMS slot dialog).
      const { tenantSlug } = parseWorkspacePathname(location.pathname)
      if (tenantSlug) navigate(buildTenantWorkspacePath(tenantSlug, '/calibration'))
    }
    // Errors surface once via the global mutation error handler (main.tsx) — no local onError toast.
  })

  return (
    <Modal open onClose={onClose}>
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
                  {selectedPrinter?.name ?? 'Printer'} · {selectedSlot?.label || `AMS ${lockedTarget.amsId} · slot ${lockedTarget.slotId + 1}`}
                </Typography>
              </DialogSection>
            ) : (
              <DialogSection title="Printer and filament" description="Load the filament you want to calibrate into an AMS slot first.">
                <Stack spacing={1.5}>
                  <FormControl>
                    <FormLabel>Printer</FormLabel>
                    <Select value={printerId} onChange={(_event, value) => { setPrinterId(value ?? ''); setSlotKey('') }}>
                      {printerOptions}
                    </Select>
                  </FormControl>
                  <FormControl>
                    <FormLabel>AMS slot</FormLabel>
                    <Select value={slotKey} placeholder={slots.length ? 'Select a slot' : 'No AMS slots reported'} onChange={(_event, value) => setSlotKey(value ?? '')}>
                      {slotOptions}
                    </Select>
                  </FormControl>
                </Stack>
              </DialogSection>
            )}

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
                {test === 'pressureAdvance' ? (
                  <Stack direction="row" spacing={1}>
                    <NumberField label="Start K" value={startK} step={0.001} min={0} max={2} onChange={setStartK} />
                    <NumberField label="End K" value={endK} step={0.001} min={0} max={2} onChange={setEndK} />
                    <NumberField label="Step" value={step} step={0.001} min={0.001} max={2} onChange={setStep} />
                  </Stack>
                ) : (
                  <NumberField label="Current flow ratio" value={currentFlowRatio} step={0.01} min={0.5} max={1.5} onChange={setCurrentFlowRatio} helperText="From the filament profile you are tuning; each patch prints relative to this." />
                )}
              </Stack>
            </DialogSection>

            <DialogSection title="Slicer profiles" description="Auto-picked for this printer.">
              {!profilesUsable ? (
                <Alert color="warning" size="sm">Loading slicer profiles…</Alert>
              ) : showProfiles ? (
                // Rendered only on demand: each Joy Select mounts its full option list into the DOM,
                // so keeping them out of the default flow keeps the dialog snappy while typing.
                <Stack spacing={1.5}>
                  <FormControl>
                    <FormLabel>Printer profile</FormLabel>
                    <Select value={resolvedMachine ?? ''} onChange={(_event, value) => setMachineId(value ?? undefined)}>
                      {machineOptions}
                    </Select>
                  </FormControl>
                  <FormControl>
                    <FormLabel>Process profile</FormLabel>
                    <Select value={resolvedProcess ?? ''} onChange={(_event, value) => setProcessId(value ?? undefined)}>
                      {processOptions}
                    </Select>
                  </FormControl>
                  <FormControl>
                    <FormLabel>Filament profile</FormLabel>
                    <Select value={resolvedFilament ?? ''} onChange={(_event, value) => setFilamentId(value ?? undefined)}>
                      {filamentOptions}
                    </Select>
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
                    {[selectedMachineProfile?.name, selectedProcessProfile?.name, filamentProfiles.find((profile) => profile.id === resolvedFilament)?.name, resolvedPlate].filter(Boolean).join(' · ') || 'Using defaults'}
                  </Typography>
                  <Button size="sm" variant="plain" onClick={() => setShowProfiles(true)}>Customize</Button>
                </Stack>
              )}
            </DialogSection>
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Cancel</Button>
          <Button onClick={() => start.mutate()} loading={start.isPending} disabled={!selectedSlot || !profilesUsable}>Start calibration</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
})
