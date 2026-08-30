/**
 * "Send to printer" dialog for files stored directly on a Bambu printer.
 *
 * Extracted from `PrinterStorageModal` (its sole caller). Owns plate
 * selection, AMS filament-to-tray mapping, print-option preferences, and
 * the readiness/compatibility checks for printing an on-printer file. It is
 * a callback-only surface: the parent owns the print mutation and passes
 * `onSubmit`/`onCancel`, so this dialog stays free of dispatch concerns.
 *
 * The mapping UI is the shared {@link PrinterMapping} (this file used to carry
 * a drifted copy), and the default tray selection is the shared print matcher
 * via `lib/autoTrayMatch.ts`, exact type+colour matches only, nozzle- and
 * remaining-aware, layered UNDER the user's explicit picks with
 * `mergeAmsMapping` so a live status update can never clobber a chosen slot.
 */
import { useEffect, useMemo, useState } from 'react'
import { PrintObjectsSection } from './library/PrintObjectsSection'
import { plateHasSliceData } from '../lib/slicingPresetMatching'
import {
  Alert, Button, Checkbox, DialogActions, FormControl, FormLabel, Option, Select, Stack, Typography
} from '@mui/joy'
import { useQuery } from '@tanstack/react-query'
import {
  findFilamentCompatibilityIssues,
  formatNozzleLabel,
  getPrinterPrintOptionCapabilities,
  loadedSlotsFromStatus,
  mergeAmsMapping,
  platePrintSkipSelection,
  platePrintUnits,
  trayCanSatisfyRequirement,
  filamentTrackSwitchMismatch,
  type FilamentCompatibilityIssue,
  type PrintNozzleOffsetCalibrationMode,
  type PrintOnOffAutoMode,
  type Printer,
  type PrinterStatus,
  type PrinterTrayMapping,
  type ThreeMfIndex,
  type ThreeMfProjectFilament
} from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../lib/workspaceScope'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import {
  buildPrintStartPreferenceKey,
  DEFAULT_STORED_PRINT_START_OPTIONS,
  parseStoredPrintStartOptions,
  resolvePrintStartPreferenceDefaults
} from '../lib/printStartOptions'
import { BackAwareModal as Modal } from './BackAwareModal'
import { DialogSection } from './DialogSection'
import { FilamentTrackSwitchMismatchAlert } from './FilamentTrackSwitchMismatchAlert'
import { LowFilamentAlert } from './LowFilamentAlert'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { autoSelectedFilamentIds, computeAutoTrayMapping } from '../lib/autoTrayMatch'
import { findPrinterLowFilamentSlots, printerSlotLabeller } from '../lib/lowFilament'
import { useSlotFilamentIdentityLookup } from '../lib/slotFilamentIdentity'
import {
  buildPrinterTrayGroups,
  buildPrinterTrayMap,
  formatCompatibilityIssue,
  type PrinterTrayOption
} from '../lib/libraryViewHelpers'
import { PrinterMapping } from './library/PrinterMapping'
import { filterTrayGroupsForFilament, sanitizeTrayMapping } from '../lib/printerTrayMapping'

export function StoragePrintModal({
  printer,
  filePath,
  submitting,
  error,
  onSubmit,
  onCancel
}: {
  printer: Printer
  filePath: string
  submitting: boolean
  error: string | null
  onSubmit: (opts: {
    plate: number
    bedLevel: PrintOnOffAutoMode
    vibrationCompensation: boolean
    flowCalibration: PrintOnOffAutoMode
    timelapse: boolean
    nozzleOffsetCalibration: PrintNozzleOffsetCalibrationMode
    amsMapping?: PrinterTrayMapping[]
    allowIncompatibleFilament: boolean
    allowFilamentTrackSwitchMismatch: boolean
    allowInsufficientFilament: boolean
    /** Individual placements to exclude, by instance `identify_id`. */
    skipInstances?: number[]
  }) => void
  onCancel: () => void
}) {
  const printerId = printer.id
  const [plate, setPlate] = useState(1)
  const [bedLevel, setBedLevel] = useState<PrintOnOffAutoMode>('on')
  const [vibrationCompensation, setVibrationCompensation] = useState(false)
  const [flowCalibration, setFlowCalibration] = useState<PrintOnOffAutoMode>('off')
  const [timelapse, setTimelapse] = useState(false)
  const [nozzleOffsetCalibration, setNozzleOffsetCalibration] = useState<PrintNozzleOffsetCalibrationMode>('auto')
  const [printOptionsTouched, setPrintOptionsTouched] = useState(false)
  const [printOptionsInitialized, setPrintOptionsInitialized] = useState(false)
  const [allowIncompatibleFilament, setAllowIncompatibleFilament] = useState(false)
  const [allowFilamentTrackSwitchMismatch, setAllowFilamentTrackSwitchMismatch] = useState(false)
  const [allowInsufficientFilament, setAllowInsufficientFilament] = useState(false)
  /**
   * Explicit user tray picks only; `-1`/absent rows fall back to the matcher's
   * suggestion. Merged with `mergeAmsMapping` (the same precedence the queue
   * dispatch uses) so recomputing the suggestion on a status update can never
   * clobber a slot the user chose.
   */
  const [explicitMapping, setExplicitMapping] = useState<number[]>([])
  const fileName = filePath.split('/').pop() || filePath
  const authBootstrapQuery = useAuthBootstrapQuery()
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const statuses = useMemo(() => statusQuery.data ?? {}, [statusQuery.data])
  const status = statuses[printerId]
  const optionCapabilities = useMemo(
    () => getPrinterPrintOptionCapabilities(
      printer.model,
      status
        ? {
            printOptions: status.printOptions,
            printStartOptions: status.printStartOptions
          }
        : null
    ),
    [printer.model, status]
  )
  const storedPrintOptionsKey = useMemo(
    () => buildPrintStartPreferenceKey(authBootstrapQuery.data, [printer.model]),
    [authBootstrapQuery.data, printer.model]
  )
  const [storedPrintOptions, setStoredPrintOptions, storedPrintOptionsReady] = useLocalStorageState(
    storedPrintOptionsKey,
    DEFAULT_STORED_PRINT_START_OPTIONS,
    parseStoredPrintStartOptions
  )
  const resolvedStoredPrintOptions = useMemo(
    () => resolvePrintStartPreferenceDefaults(storedPrintOptions),
    [storedPrintOptions]
  )
  const platesQuery = useQuery({
    queryKey: ['printer-storage-plates', printerId, filePath],
    queryFn: ({ signal }) =>
      apiFetch<ThreeMfIndex>(
        `/api/printers/${printerId}/storage/plates?path=${encodeURIComponent(filePath)}`,
        { signal }
      ),
    enabled: /\.3mf$/i.test(fileName),
    staleTime: 60_000
  })
  const plates = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data])
  const projectFilaments = useMemo(() => platesQuery.data?.projectFilaments ?? [], [platesQuery.data])
  // Same rule and same alert as the library print dialog, a file already on the printer's storage
  // still has to have been sliced for the kind of machine it is about to print on. Undefined (an
  // older server that does not send the flag) reads as unknown, not as "no switch".
  const trackSwitchMismatches = useMemo(() => {
    const mismatch = filamentTrackSwitchMismatch(platesQuery.data?.slicedWithFilamentTrackSwitch, status)
    return mismatch
      ? [{ printerId, printerName: printer.name, printerHasSwitch: mismatch.printerHasSwitch }]
      : []
  }, [platesQuery.data, printer.name, printerId, status])
  const activePlate = useMemo(
    () => plates.find((entry) => entry.index === plate) ?? plates[0],
    [plates, plate]
  )
  /**
   * Per-COPY deselection (sliced plates with a real object list only). A unit is one placement,
   * so a duplicated object offers one row per copy. The selection rides the request as
   * `skipObjects` + `skipInstances`; the server maps both to instance identify_ids, sends them in
   * the start command, and keeps a mid-print skip fallback armed for firmware that ignores the
   * start-command field.
   */
  const plateObjects = useMemo(() => activePlate?.objects ?? [], [activePlate])
  const plateUnits = useMemo(() => platePrintUnits(plateObjects), [plateObjects])
  const showObjectSelection = plateHasSliceData(activePlate) && plateUnits.length >= 2
  const [deselectedUnitKeys, setDeselectedUnitKeys] = useState<string[]>([])
  const deselectedUnitKeySet = useMemo(() => new Set(deselectedUnitKeys), [deselectedUnitKeys])
  const activePlateIndex = activePlate?.index ?? null
  useEffect(() => {
    setDeselectedUnitKeys([])
    // The explicit tray picks are per-plate too; the auto layer re-derives on its own.
    setExplicitMapping([])
  }, [filePath, activePlateIndex])
  const toggleObjectSelected = (key: string, selected: boolean) => {
    setDeselectedUnitKeys((current) => {
      if (selected) return current.filter((entry) => entry !== key)
      return current.includes(key) ? current : [...current, key]
    })
  }
  const filamentEntries = useMemo<ThreeMfProjectFilament[]>(() => {
    if (projectFilaments.length > 0) return projectFilaments
    return (activePlate?.filaments ?? []).map((filament) => ({
      id: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      color: filament.color,
      nozzleId: filament.nozzleId ?? null,
      chamberTemperature: filament.chamberTemperature ?? null
    }))
  }, [projectFilaments, activePlate])
  const usedIds = useMemo(
    () => new Set((activePlate?.filaments ?? []).map((filament) => filament.id)),
    [activePlate]
  )
  const usedGramsById = useMemo(() => {
    const map = new Map<number, number>()
    for (const filament of activePlate?.filaments ?? []) {
      if (filament.usedGrams != null) map.set(filament.id, filament.usedGrams)
    }
    return map
  }, [activePlate])
  const visibleFilaments = useMemo(
    () => filamentEntries.filter((filament) => usedIds.size === 0 || usedIds.has(filament.id)),
    [filamentEntries, usedIds]
  )
  const trayGroups = useMemo(() => buildPrinterTrayGroups(status), [status])
  const trayByMappingValue = useMemo(() => buildPrinterTrayMap(status), [status])
  const resolveSlotFilament = useSlotFilamentIdentityLookup()
  const autoMapping = useMemo(
    () => computeAutoTrayMapping(printerId, status, visibleFilaments, usedGramsById, resolveSlotFilament),
    [printerId, resolveSlotFilament, status, usedGramsById, visibleFilaments]
  )
  const effectiveMapping = useMemo(
    () => mergeAmsMapping(explicitMapping, autoMapping) ?? [],
    [autoMapping, explicitMapping]
  )
  const autoSelectedIds = useMemo(
    () => autoSelectedFilamentIds(visibleFilaments, autoMapping, explicitMapping),
    [autoMapping, explicitMapping, visibleFilaments]
  )

  const mappingCapable = trayGroups.length > 0 && visibleFilaments.length > 0
  const mappedCompatibilityIssues = useMemo(
    () => getStorageMappedCompatibilityIssues(visibleFilaments, trayByMappingValue, effectiveMapping),
    [effectiveMapping, trayByMappingValue, visibleFilaments]
  )
  const automaticCompatibilityIssues = useMemo(
    () => getStorageAutomaticCompatibilityIssues(activePlate, status),
    [activePlate, status]
  )
  const hardCompatibilityIssues = useMemo(
    () => mappedCompatibilityIssues.filter((issue) => issue.nozzleMismatch),
    [mappedCompatibilityIssues]
  )
  const softCompatibilityIssues = useMemo(
    () => mappedCompatibilityIssues.filter((issue) => issue.typeMismatch && !issue.nozzleMismatch),
    [mappedCompatibilityIssues]
  )
  /**
   * Mapped slots that will run out. Grades `effectiveMapping`, the merge of the user's picks over
   * the matcher's suggestion, so it describes exactly what Start would send. One printer here, so
   * the entry needs no name to tell it apart.
   */
  const lowFilamentEntries = useMemo(
    () => [{
      printerId,
      printerName: null,
      issues: findPrinterLowFilamentSlots(
        printerId,
        status,
        visibleFilaments,
        usedGramsById,
        effectiveMapping,
        resolveSlotFilament
      ),
      slotLabel: printerSlotLabeller(status)
    }].filter((entry) => entry.issues.length > 0),
    [effectiveMapping, printerId, resolveSlotFilament, status, usedGramsById, visibleFilaments]
  )
  const selectedTrayWarnings = useMemo(
    () => getStorageSelectedTrayWarnings({ mapping: effectiveMapping, trayByMappingValue, visibleFilaments, timelapse, status }),
    [effectiveMapping, status, timelapse, trayByMappingValue, visibleFilaments]
  )
  const allMappingsComplete = useMemo(() => {
    if (!mappingCapable) return true
    return visibleFilaments.every((filament) => {
      const selectedValue = effectiveMapping[filament.id - 1] ?? -1
      if (selectedValue < 0) return false
      const allowedValues = new Set(
        filterTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
          .flatMap((group) => group.trays)
          .map((tray) => tray.mappingValue)
      )
      return allowedValues.has(selectedValue)
    })
  }, [effectiveMapping, mappingCapable, trayGroups, visibleFilaments])
  const issueSignature = useMemo(
    () => JSON.stringify({ mappedCompatibilityIssues, automaticCompatibilityIssues }),
    [automaticCompatibilityIssues, mappedCompatibilityIssues]
  )
  const hasPrintSettings =
    optionCapabilities.timelapse
    || optionCapabilities.bedLevel
    || optionCapabilities.vibrationCompensation
    || optionCapabilities.flowCalibration
    || optionCapabilities.nozzleOffsetCalibration
  const showCompatibilitySection =
    platesQuery.isLoading
    || selectedTrayWarnings.length > 0
    || (mappingCapable && hardCompatibilityIssues.length > 0)
    || (mappingCapable && softCompatibilityIssues.length > 0)
    || (!mappingCapable && automaticCompatibilityIssues.length > 0)
    || error != null

  useEffect(() => {
    setAllowIncompatibleFilament(false)
  }, [filePath, issueSignature])

  useEffect(() => {
    if (printOptionsTouched) return
    if (!storedPrintOptionsReady) return
    if (printOptionsInitialized) return
    setBedLevel(resolvedStoredPrintOptions.bedLevel)
    setVibrationCompensation(resolvedStoredPrintOptions.vibrationCompensation)
    setFlowCalibration(resolvedStoredPrintOptions.flowCalibration)
    setTimelapse(resolvedStoredPrintOptions.timelapse)
    setNozzleOffsetCalibration(resolvedStoredPrintOptions.nozzleOffsetCalibration)
    setPrintOptionsInitialized(true)
  }, [printOptionsInitialized, printOptionsTouched, resolvedStoredPrintOptions, storedPrintOptionsReady])

  useEffect(() => {
    if (!storedPrintOptionsReady) return
    if (!printOptionsInitialized && !printOptionsTouched) return
    setStoredPrintOptions({
      bedLevel,
      vibrationCompensation,
      flowCalibration,
      timelapse,
      nozzleOffsetCalibration
    })
  }, [
    bedLevel,
    vibrationCompensation,
    flowCalibration,
    nozzleOffsetCalibration,
    printOptionsInitialized,
    printOptionsTouched,
    setStoredPrintOptions,
    storedPrintOptionsReady,
    timelapse
  ])

  const updateBedLevel = (value: PrintOnOffAutoMode) => {
    setPrintOptionsTouched(true)
    setBedLevel(value)
  }

  const updateVibrationCompensation = (value: boolean) => {
    setPrintOptionsTouched(true)
    setVibrationCompensation(value)
  }

  const updateFlowCalibration = (value: PrintOnOffAutoMode) => {
    setPrintOptionsTouched(true)
    setFlowCalibration(value)
  }

  const updateTimelapse = (value: boolean) => {
    setPrintOptionsTouched(true)
    setTimelapse(value)
  }

  const updateNozzleOffsetCalibration = (value: PrintNozzleOffsetCalibrationMode) => {
    setPrintOptionsTouched(true)
    setNozzleOffsetCalibration(value)
  }

  return (
    <Modal open onClose={onCancel}>
      <ScrollableModalDialog sx={{ width: { xs: '96vw', sm: 560 }, maxWidth: '100%' }}>
        <Typography level="h4">Send to printer</Typography>
        <Typography level="body-sm" textColor="text.tertiary" sx={{ mb: 1 }} noWrap>
          {fileName}
        </Typography>
        <ScrollableDialogBody>
        <Stack spacing={2}>
          {plates.length > 1 && (
            <DialogSection title="Plate">
              <FormControl>
                <FormLabel>Plate</FormLabel>
                <Select value={plate} onChange={(_event, value) => value && setPlate(value)}>
                  {plates.map((entry) => (
                    <Option key={entry.index} value={entry.index}>
                      {entry.name?.trim() || `Plate ${entry.index}`}
                    </Option>
                  ))}
                </Select>
              </FormControl>
            </DialogSection>
          )}
          {mappingCapable && (
            <DialogSection title="Filament mapping">
              <PrinterMapping
                printer={printer}
                status={status}
                filaments={visibleFilaments}
                usedGramsById={usedGramsById}
                mapping={effectiveMapping}
                issues={mappedCompatibilityIssues}
                autoSelectedFilamentIds={autoSelectedIds}
                onChange={(filamentId, tray) => {
                  setExplicitMapping((current) => {
                    const updated = [...current]
                    while (updated.length <= filamentId - 1) updated.push(-1)
                    updated[filamentId - 1] = tray
                    return updated
                  })
                }}
              />
            </DialogSection>
          )}
          {showObjectSelection && (
            <PrintObjectsSection
              units={plateUnits}
              deselectedKeys={deselectedUnitKeySet}
              onToggle={toggleObjectSelected}
            />
          )}
          {hasPrintSettings && (
            <DialogSection title="Print settings">
              <Stack spacing={1.25}>
                {optionCapabilities.timelapse && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Timelapse</FormLabel>
                    <Select<'off' | 'on'> value={timelapse ? 'on' : 'off'} onChange={(_event, value) => value && updateTimelapse(value === 'on')}>
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                    </Select>
                  </FormControl>
                )}
                {optionCapabilities.bedLevel && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Auto Bed Leveling</FormLabel>
                    <Select<PrintOnOffAutoMode> value={bedLevel} onChange={(_event, value) => value && updateBedLevel(value)}>
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      {optionCapabilities.bedLevelAuto && <Option value="auto">Auto</Option>}
                    </Select>
                  </FormControl>
                )}
                {optionCapabilities.vibrationCompensation && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Vibration Compensation</FormLabel>
                    <Select<'off' | 'on'> value={vibrationCompensation ? 'on' : 'off'} onChange={(_event, value) => value && updateVibrationCompensation(value === 'on')}>
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                    </Select>
                  </FormControl>
                )}
                {optionCapabilities.flowCalibration && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Flow Dynamics Calibration</FormLabel>
                    <Select<PrintOnOffAutoMode> value={flowCalibration} onChange={(_event, value) => value && updateFlowCalibration(value)}>
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      {optionCapabilities.flowCalibrationAuto && <Option value="auto">Auto</Option>}
                    </Select>
                  </FormControl>
                )}
                {optionCapabilities.nozzleOffsetCalibration && (
                  <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
                    <FormLabel>Nozzle Offset Calibration</FormLabel>
                    <Select<PrintNozzleOffsetCalibrationMode>
                      value={nozzleOffsetCalibration}
                      onChange={(_event, value) => value && updateNozzleOffsetCalibration(value)}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      <Option value="auto">Auto</Option>
                    </Select>
                  </FormControl>
                )}
              </Stack>
            </DialogSection>
          )}
          {showCompatibilitySection && (
            <DialogSection title="Readiness">
              <Stack spacing={1.25}>
                {platesQuery.isLoading && (
                  <Typography level="body-xs" textColor="text.tertiary">
                    Reading print metadata…
                  </Typography>
                )}
                {selectedTrayWarnings.length > 0 && (
                  <Alert color="warning" variant="soft">
                    <Stack spacing={0.5}>
                      {selectedTrayWarnings.map((warning) => (
                        <Typography key={warning} level="body-xs">{warning}</Typography>
                      ))}
                    </Stack>
                  </Alert>
                )}
                <FilamentTrackSwitchMismatchAlert
                  entries={trackSwitchMismatches}
                  confirmed={allowFilamentTrackSwitchMismatch}
                  onConfirmedChange={setAllowFilamentTrackSwitchMismatch}
                />
                <LowFilamentAlert
                  entries={lowFilamentEntries}
                  confirmed={allowInsufficientFilament}
                  onConfirmedChange={setAllowInsufficientFilament}
                />
                {mappingCapable && hardCompatibilityIssues.length > 0 && (
                  <Alert color="danger" variant="soft">
                    <Stack spacing={1}>
                      <Typography level="title-sm">Tray nozzle mismatch detected</Typography>
                      <Typography level="body-sm">
                        One or more selected trays appear bound to the wrong nozzle for this sliced file. Pick a tray on the matching nozzle, or confirm below to print anyway if the nozzle assignment shown is wrong.
                      </Typography>
                      {hardCompatibilityIssues.map((issue) => (
                        <Typography key={issue.filamentId} level="body-xs">
                          {formatCompatibilityIssue(issue, status?.nozzles.length ?? null)}
                        </Typography>
                      ))}
                      <Checkbox
                        label="Print anyway with the current tray assignments"
                        checked={allowIncompatibleFilament}
                        onChange={(event) => setAllowIncompatibleFilament(event.target.checked)}
                      />
                    </Stack>
                  </Alert>
                )}
                {mappingCapable && softCompatibilityIssues.length > 0 && (
                  <Alert color="warning" variant="soft">
                    <Stack spacing={1}>
                      <Typography level="title-sm">Filament mismatch detected</Typography>
                      {softCompatibilityIssues.map((issue) => (
                        <Typography key={issue.filamentId} level="body-xs">
                          {formatCompatibilityIssue(issue, status?.nozzles.length ?? null)}
                        </Typography>
                      ))}
                      {/* The nozzle-mismatch alert above renders the same confirm
                          checkbox; never show two bound to one state. */}
                      {hardCompatibilityIssues.length === 0 && (
                        <Checkbox
                          label="Print anyway with the current tray assignments"
                          checked={allowIncompatibleFilament}
                          onChange={(event) => setAllowIncompatibleFilament(event.target.checked)}
                        />
                      )}
                    </Stack>
                  </Alert>
                )}
                {!mappingCapable && automaticCompatibilityIssues.length > 0 && (
                  <Alert color="warning" variant="soft">
                    <Stack spacing={1}>
                      <Typography level="title-sm">Loaded filament may be incompatible</Typography>
                      {automaticCompatibilityIssues.map((issue) => (
                        <Typography key={issue.filamentId} level="body-xs">
                          {formatStorageAutomaticCompatibilityIssue(issue, status?.nozzles.length ?? null)}
                        </Typography>
                      ))}
                      <Checkbox
                        label="Print anyway with the currently loaded filament"
                        checked={allowIncompatibleFilament}
                        onChange={(event) => setAllowIncompatibleFilament(event.target.checked)}
                      />
                    </Stack>
                  </Alert>
                )}
                {error && (
                  <Typography level="body-sm" color="danger">{error}</Typography>
                )}
              </Stack>
            </DialogSection>
          )}
        </Stack>
        </ScrollableDialogBody>
        <DialogActions sx={{ pt: 1 }}>
          <Button variant="plain" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button
            onClick={() => {
              // Resolved against the units on screen so a key left over from another plate can
              // never reach the request.
              const { skipInstances } = showObjectSelection
                ? platePrintSkipSelection(plateUnits, deselectedUnitKeySet)
                : { skipInstances: [] }
              onSubmit({
                // Submit the actually-selected plate's index: the picker can resolve to a
                // plate whose number differs from the 1-based default (e.g. a single-plate
                // sliced "Plate 2" output), and the skip selection is mapped against this plate.
                plate: activePlate?.index ?? plate,
                bedLevel,
                vibrationCompensation,
                flowCalibration,
                timelapse,
                nozzleOffsetCalibration,
                amsMapping: sanitizeTrayMapping(effectiveMapping) as PrinterTrayMapping[] | undefined,
                allowIncompatibleFilament,
                allowFilamentTrackSwitchMismatch,
                allowInsufficientFilament,
                ...(skipInstances.length > 0 ? { skipInstances } : {})
              })
            }}
            loading={submitting}
            disabled={
              (mappingCapable && !allMappingsComplete)
              || (hardCompatibilityIssues.length > 0 && !allowIncompatibleFilament)
              || (softCompatibilityIssues.length > 0 && !allowIncompatibleFilament)
              || (!mappingCapable && automaticCompatibilityIssues.length > 0 && !allowIncompatibleFilament)
              || (trackSwitchMismatches.length > 0 && !allowFilamentTrackSwitchMismatch)
              || (lowFilamentEntries.length > 0 && !allowInsufficientFilament)
            }
          >
            Start print
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

interface StorageCompatibilityIssue {
  filamentId: number
  filamentType: string | null
  filamentName: string | null
  nozzleId: number | null
}

/**
 * "Can any loaded slot satisfy each required filament?" for files whose trays
 * can't be mapped in this dialog (no selectable trays reported). Nozzle-aware
 * via the shared slot flattening.
 */
function getStorageAutomaticCompatibilityIssues(
  plate: ThreeMfIndex['plates'][number] | undefined,
  status: PrinterStatus | undefined
): StorageCompatibilityIssue[] {
  if (!plate || !status) return []
  const slots = loadedSlotsFromStatus(status)
  return plate.filaments
    .filter((filament) => !slots.some((slot) => trayCanSatisfyRequirement({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }, {
      filamentType: slot.filamentType,
      nozzleId: slot.nozzleId
    })))
    .map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }))
}

function getStorageMappedCompatibilityIssues(
  filaments: ThreeMfProjectFilament[],
  trayByMappingValue: Map<number, PrinterTrayOption>,
  mapping: number[]
): FilamentCompatibilityIssue[] {
  const selectedTrays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()
  for (const filament of filaments) {
    const mappingValue = mapping[filament.id - 1]
    if (typeof mappingValue !== 'number' || mappingValue < 0) continue
    const tray = trayByMappingValue.get(mappingValue)
    if (!tray) continue
    selectedTrays.set(filament.id, {
      filamentType: tray.filamentType,
      label: tray.kind === 'external' ? tray.label : [tray.groupLabel ?? 'AMS', tray.label].join(' '),
      nozzleId: tray.nozzleId
    })
  }

  return findFilamentCompatibilityIssues(
    filaments.map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId ?? null
    })),
    selectedTrays
  )
}

function getStorageSelectedTrayWarnings(input: {
  mapping: number[]
  trayByMappingValue: Map<number, PrinterTrayOption>
  visibleFilaments: ThreeMfProjectFilament[]
  timelapse: boolean
  status: PrinterStatus | undefined
}): string[] {
  const warnings = new Set<string>()
  let hasAms = false
  let hasExternal = false

  for (const filament of input.visibleFilaments) {
    const mappingValue = input.mapping[filament.id - 1]
    if (typeof mappingValue !== 'number' || mappingValue < 0) continue
    const tray = input.trayByMappingValue.get(mappingValue)
    if (!tray) continue
    hasAms = hasAms || tray.kind === 'ams'
    hasExternal = hasExternal || tray.kind === 'external'
    if (!tray.filamentType && !tray.trayInfoIdx) {
      warnings.add('One or more selected trays have unknown filament details. Check the printer before starting the print.')
    }
  }

  if (hasAms && hasExternal) {
    warnings.add('This tray assignment mixes AMS slots and external spools. Review the mapping before printing.')
  }
  if (input.timelapse && input.status?.sdCardPresent === false) {
    warnings.add('Timelapse is enabled, but the printer reports no SD card.')
  }

  return Array.from(warnings)
}

function formatStorageAutomaticCompatibilityIssue(issue: StorageCompatibilityIssue, nozzleCount?: number | null): string {
  const subject = `#${issue.filamentId} ${issue.filamentName ?? issue.filamentType ?? 'filament'}`
  const nozzle = formatNozzleLabel(issue.nozzleId, 'long', nozzleCount)
  return nozzle
    ? `${subject}: no compatible loaded tray was found for the ${nozzle}`
    : `${subject}: no compatible loaded tray was found`
}
