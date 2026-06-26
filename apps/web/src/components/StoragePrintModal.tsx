/**
 * "Send to printer" dialog for files stored directly on a Bambu printer.
 *
 * Extracted from `PrinterStorageModal` (its sole caller). Owns plate
 * selection, AMS filament-to-tray mapping, print-option preferences, and
 * the readiness/compatibility checks for printing an on-printer file. It is
 * a callback-only surface: the parent owns the print mutation and passes
 * `onSubmit`/`onCancel`, so this dialog stays free of dispatch concerns.
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  Alert, Box, Button, Checkbox, DialogActions, FormControl, FormLabel, Option, Select, Stack, Tooltip, Typography
} from '@mui/joy'
import { useQuery } from '@tanstack/react-query'
import {
  findFilamentCompatibilityIssues,
  formatNozzleLabel,
  getPrinterPrintOptionCapabilities,
  trayCanSatisfyRequirement,
  type FilamentCompatibilityIssue,
  type PrintNozzleOffsetCalibrationMode,
  type PrintOnOffAutoMode,
  type PrinterModel,
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
import { OverflowTooltipText } from './OverflowTooltipText'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'
import { filamentBackground, filamentTextColor, hasLoadedFilament, resolveFilamentDisplay, resolveProjectFilamentColorName } from '../lib/filamentColor'
import { AmsSpoolSetupDialog, type AmsSpoolSetupTarget } from './AmsSpoolSetupDialog'
import { getSlotRemainingState } from '../lib/slotRemaining'
import { amsUnitLetter, filterTrayGroupsForFilament, sanitizeTrayMapping, type PrinterTrayGroup } from '../lib/printerTrayMapping'

export function StoragePrintModal({
  printerId,
  printerModel,
  filePath,
  submitting,
  error,
  onSubmit,
  onCancel
}: {
  printerId: string
  printerModel: PrinterModel
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
  }) => void
  onCancel: () => void
}) {
  const [plate, setPlate] = useState(1)
  const [bedLevel, setBedLevel] = useState<PrintOnOffAutoMode>('on')
  const [vibrationCompensation, setVibrationCompensation] = useState(false)
  const [flowCalibration, setFlowCalibration] = useState<PrintOnOffAutoMode>('off')
  const [timelapse, setTimelapse] = useState(false)
  const [nozzleOffsetCalibration, setNozzleOffsetCalibration] = useState<PrintNozzleOffsetCalibrationMode>('auto')
  const [printOptionsTouched, setPrintOptionsTouched] = useState(false)
  const [printOptionsInitialized, setPrintOptionsInitialized] = useState(false)
  const [allowIncompatibleFilament, setAllowIncompatibleFilament] = useState(false)
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
      printerModel,
      status
        ? {
            printOptions: status.printOptions,
            printStartOptions: status.printStartOptions
          }
        : null
    ),
    [printerModel, status]
  )
  const storedPrintOptionsKey = useMemo(
    () => buildPrintStartPreferenceKey(authBootstrapQuery.data, [printerModel]),
    [authBootstrapQuery.data, printerModel]
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
  const activePlate = useMemo(
    () => plates.find((entry) => entry.index === plate) ?? plates[0],
    [plates, plate]
  )
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
  const trayGroups = useMemo(() => buildStorageTrayGroups(status), [status])
  const trayByMappingValue = useMemo(
    () => new Map(trayGroups.flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))),
    [trayGroups]
  )
  const [mappings, setMappings] = useState<number[]>([])

  useEffect(() => {
    setMappings(buildDefaultStorageMapping(visibleFilaments, trayGroups))
  }, [filePath, plate, trayGroups, visibleFilaments])

  const mappingCapable = trayGroups.length > 0 && visibleFilaments.length > 0
  const mappedCompatibilityIssues = useMemo(
    () => getStorageMappedCompatibilityIssues(visibleFilaments, trayByMappingValue, mappings),
    [mappings, trayByMappingValue, visibleFilaments]
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
  const selectedTrayWarnings = useMemo(
    () => getStorageSelectedTrayWarnings({ mappings, trayByMappingValue, visibleFilaments, timelapse, status }),
    [mappings, status, timelapse, trayByMappingValue, visibleFilaments]
  )
  const allMappingsComplete = useMemo(() => {
    if (!mappingCapable) return true
    return visibleFilaments.every((filament) => {
      const selectedValue = mappings[filament.id - 1] ?? -1
      if (selectedValue < 0) return false
      const allowedValues = new Set(
        filterTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
          .flatMap((group) => group.trays)
          .map((tray) => tray.mappingValue)
      )
      return allowedValues.has(selectedValue)
    })
  }, [mappingCapable, mappings, trayGroups, visibleFilaments])
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
              <StoragePrinterMapping
                printerId={printerId}
                status={status}
                filaments={filamentEntries}
                usedIds={usedIds}
                usedGramsById={usedGramsById}
                trayGroups={trayGroups}
                mapping={mappings}
                issues={mappedCompatibilityIssues}
                onChange={(filamentId, tray) => {
                  setMappings((current) => {
                    const updated = [...current]
                    while (updated.length <= filamentId - 1) updated.push(-1)
                    updated[filamentId - 1] = tray
                    return updated
                  })
                }}
              />
            </DialogSection>
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
                {mappingCapable && hardCompatibilityIssues.length > 0 && (
                  <Alert color="danger" variant="soft">
                    <Stack spacing={1}>
                      <Typography level="title-sm">Tray assignment must be fixed</Typography>
                      {hardCompatibilityIssues.map((issue) => (
                        <Typography key={issue.filamentId} level="body-xs">
                          {formatStorageMappedCompatibilityIssue(issue, status?.nozzles.length ?? null)}
                        </Typography>
                      ))}
                    </Stack>
                  </Alert>
                )}
                {mappingCapable && softCompatibilityIssues.length > 0 && (
                  <Alert color="warning" variant="soft">
                    <Stack spacing={1}>
                      <Typography level="title-sm">Filament mismatch detected</Typography>
                      {softCompatibilityIssues.map((issue) => (
                        <Typography key={issue.filamentId} level="body-xs">
                          {formatStorageMappedCompatibilityIssue(issue, status?.nozzles.length ?? null)}
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
            onClick={() => onSubmit({
              plate,
              bedLevel,
              vibrationCompensation,
              flowCalibration,
              timelapse,
              nozzleOffsetCalibration,
              amsMapping: sanitizeTrayMapping(mappings) as PrinterTrayMapping[] | undefined,
              allowIncompatibleFilament
            })}
            loading={submitting}
            disabled={
              (mappingCapable && !allMappingsComplete)
              || hardCompatibilityIssues.length > 0
              || (softCompatibilityIssues.length > 0 && !allowIncompatibleFilament)
              || (!mappingCapable && automaticCompatibilityIssues.length > 0 && !allowIncompatibleFilament)
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

interface StorageTrayOption {
  mappingValue: PrinterTrayMapping
  key: string
  kind: 'ams' | 'external'
  label: string
  badgeLabel: string
  groupLabel: string
  color: string | null
  colors: string[]
  filamentType: string | null
  trayName: string | null
  trayInfoIdx: string | null
  remainPercent: number | null
  /** Spool identity (RFID/Bambu tag). Null for third-party spools that cannot report remaining. */
  trayUuid: string | null
  nozzleId: number | null
  active: boolean
  /** Slot reports a physical spool even though its identity is unreadable. */
  occupied?: boolean | null
  /** AMS coordinates for the spool-setup dialog (AMS trays only). */
  amsUnitId?: number
  amsSlotId?: number
}

type StorageTrayGroup = PrinterTrayGroup<StorageTrayOption>

function getStorageAutomaticCompatibilityIssues(
  plate: ThreeMfIndex['plates'][number] | undefined,
  status: PrinterStatus | undefined
): StorageCompatibilityIssue[] {
  if (!plate || !status) return []
  const trays = buildStorageTrayCandidates(status)
  return plate.filaments
    .filter((filament) => !trays.some((tray) => trayCanSatisfyRequirement({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }, tray)))
    .map((filament) => ({
      filamentId: filament.id,
      filamentType: filament.filamentType,
      filamentName: filament.filamentName,
      nozzleId: filament.nozzleId
    }))
}

function getStorageMappedCompatibilityIssues(
  filaments: ThreeMfProjectFilament[],
  trayByMappingValue: Map<number, StorageTrayOption>,
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
      label: tray.kind === 'external' ? tray.label : `${tray.groupLabel} ${tray.label}`,
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

function buildStorageTrayCandidates(status: PrinterStatus): Array<{ filamentType: string | null; label: string; nozzleId: number | null }> {
  const trays: Array<{ filamentType: string | null; label: string; nozzleId: number | null }> = []
  for (const spool of status.externalSpools) {
    trays.push({
      filamentType: spool.filamentType,
      label: status.externalSpools.length > 1 ? (spool.amsId === 255 ? 'Ext-R' : 'Ext-L') : 'Ext',
      nozzleId: spool.nozzleId
    })
  }
  for (const unit of status.ams) {
    for (const slot of unit.slots) {
      trays.push({
        filamentType: slot.filamentType,
        label: `AMS ${amsUnitLetter(unit.unitId)} Slot ${slot.slot + 1}`,
        nozzleId: null
      })
    }
  }
  return trays
}

function buildStorageTrayGroups(status: PrinterStatus | undefined): StorageTrayGroup[] {
  if (!status) return []
  const groups: StorageTrayGroup[] = []

  if (status.externalSpools.length > 0) {
    groups.push({
      key: 'external',
      label: 'External Spool',
      trays: status.externalSpools.map((spool) => ({
        mappingValue: spool.amsId,
        key: `external-${spool.amsId}`,
        kind: 'external',
        label: status.externalSpools.length > 1 ? (spool.amsId === 255 ? 'Ext-R' : 'Ext-L') : 'Ext',
        badgeLabel: status.externalSpools.length > 1 ? (spool.amsId === 255 ? 'Ext-R' : 'Ext-L') : 'Ext',
        groupLabel: 'External Spool',
        color: spool.color,
        colors: spool.colors,
        filamentType: spool.filamentType,
        trayName: spool.trayName,
        trayInfoIdx: spool.trayInfoIdx,
        remainPercent: spool.remainPercent,
        trayUuid: spool.trayUuid,
        nozzleId: spool.nozzleId,
        active: spool.active
      }))
    })
  }

  for (const unit of status.ams) {
    const groupLabel = `AMS ${amsUnitLetter(unit.unitId)}`
    groups.push({
      key: `ams-${unit.unitId}`,
      label: groupLabel,
      trays: unit.slots.map((slot) => ({
        mappingValue: unit.unitId * 4 + slot.slot,
        key: `ams-${unit.unitId}-${slot.slot}`,
        kind: 'ams',
        label: `Slot ${slot.slot + 1}`,
        badgeLabel: `${amsUnitLetter(unit.unitId)}${slot.slot + 1}`,
        groupLabel,
        color: slot.color,
        colors: slot.colors,
        filamentType: slot.filamentType,
        trayName: slot.trayName,
        trayInfoIdx: slot.trayInfoIdx,
        remainPercent: slot.remainPercent,
        trayUuid: slot.trayUuid,
        nozzleId: unit.nozzleId,
        active: slot.active,
        occupied: slot.occupied ?? null,
        amsUnitId: unit.unitId,
        amsSlotId: slot.slot
      }))
    })
  }

  return groups
}

function buildDefaultStorageMapping(
  filaments: ThreeMfProjectFilament[],
  trayGroups: StorageTrayGroup[]
): number[] {
  const mapping: number[] = []
  for (const filament of filaments) {
    const allowedTrays = filterTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
      .flatMap((group) => group.trays)
      .filter((tray) => trayCanSatisfyRequirement({
        filamentId: filament.id,
        filamentType: filament.filamentType,
        filamentName: filament.filamentName,
        nozzleId: filament.nozzleId ?? null
      }, {
        filamentType: tray.filamentType,
        label: tray.kind === 'external' ? tray.label : `${tray.groupLabel} ${tray.label}`,
        nozzleId: tray.nozzleId
      }))

    const preferred = allowedTrays.find((tray) => tray.active) ?? (allowedTrays.length === 1 ? allowedTrays[0] : null)
    if (!preferred) continue
    while (mapping.length <= filament.id - 1) mapping.push(-1)
    mapping[filament.id - 1] = preferred.mappingValue
  }
  return mapping
}

function StoragePrinterMapping({
  printerId,
  status,
  filaments,
  usedIds,
  usedGramsById,
  trayGroups,
  mapping,
  issues,
  onChange
}: {
  printerId: string
  status: PrinterStatus | undefined
  filaments: ThreeMfProjectFilament[]
  usedIds: Set<number>
  usedGramsById: Map<number, number>
  trayGroups: StorageTrayGroup[]
  mapping: number[]
  issues: FilamentCompatibilityIssue[]
  onChange: (filamentId: number, tray: number) => void
}) {
  const visible = filaments.filter((filament) => usedIds.size === 0 || usedIds.has(filament.id))
  const trays = useMemo(() => trayGroups.flatMap((group) => group.trays), [trayGroups])
  const nozzleCount = status?.nozzles.length ?? null
  // Spool-setup dialog for unrecognized-but-occupied slots picked in the mapping.
  const [spoolSetupTarget, setSpoolSetupTarget] = useState<AmsSpoolSetupTarget | null>(null)
  const issueByFilamentId = useMemo(
    () => new Map(issues.map((issue) => [issue.filamentId, issue] as const)),
    [issues]
  )

  return (
    <Stack spacing={0.5} sx={{ mt: 0.5 }}>
      {visible.map((filament) => {
        const allowedGroups = filterTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
        const allowedTrayByValue = new Map(
          allowedGroups.flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))
        )
        const slotIndex = filament.id - 1
        const value = mapping[slotIndex] ?? -1
        const selectedTray = trays.find((tray) => tray.mappingValue === value)
        const selectedUnknownTray = selectedTray && storageTrayHasUnknownSpool(selectedTray) ? selectedTray : null
        const grams = usedGramsById.get(filament.id)
        const colorLabel = resolveProjectFilamentColorName({
          color: filament.color,
          filamentName: filament.filamentName,
          filamentType: filament.filamentType
        })
        const issue = issueByFilamentId.get(filament.id)
        const nozzleLabel = formatNozzleLabel(filament.nozzleId ?? null, 'short', nozzleCount)
        const filamentPrimaryLabel = [
          filament.filamentName ?? filament.filamentType ?? 'filament',
          colorLabel
        ].filter(Boolean).join(' · ')
        const filamentMetaLabel = [
          nozzleLabel,
          grams != null ? `${grams.toFixed(grams < 10 ? 1 : 0)}g` : null
        ].filter(Boolean).join(' · ')

        return (
          <Stack key={filament.id} spacing={0.25}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: '1 1 0', minWidth: 0 }}>
                <Box
                  sx={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    backgroundColor: filament.color ?? 'var(--joy-palette-neutral-700)',
                    border: '1px solid var(--joy-palette-neutral-700)',
                    flexShrink: 0,
                    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
                  }}
                />
                <Stack spacing={0} sx={{ minWidth: 0, flex: '1 1 0' }}>
                  <OverflowTooltipText
                    level="body-xs"
                    sx={{ minWidth: 0 }}
                    noWrap
                    text={filamentPrimaryLabel}
                  />
                  {filamentMetaLabel ? (
                    <OverflowTooltipText
                      level="body-xs"
                      textColor="text.tertiary"
                      sx={{ minWidth: 0 }}
                      noWrap
                      text={filamentMetaLabel}
                    />
                  ) : null}
                </Stack>
              </Stack>
              <Select<number>
                size="sm"
                value={value === -1 ? null : value}
                placeholder="Choose slot…"
                color={value === -1 || issue ? 'warning' : 'neutral'}
                onChange={(_event, next) => next != null && onChange(filament.id, next)}
                renderValue={(option) => {
                  if (!option) return <Typography level="body-xs">Choose slot…</Typography>
                  const tray = allowedTrayByValue.get(option.value as number)
                  if (!tray) return <Typography level="body-xs">Choose slot…</Typography>
                  return (
                    <StorageTrayOptionLabel
                      tray={tray}
                      trays={trays}
                      nozzleCount={nozzleCount}
                      requiredFilamentType={filament.filamentType}
                      requiredNozzleId={filament.nozzleId ?? null}
                      requiredGrams={grams ?? null}
                      autoRefillEnabled={status?.amsSettings.autoRefill === true}
                    />
                  )
                }}
                sx={{ flex: '1 1 0', minWidth: 0 }}
                slotProps={{
                  button: { sx: { textAlign: 'left', justifyContent: 'flex-start', minHeight: 40 } },
                  listbox: {
                    placement: 'bottom-end',
                    modifiers: [{ name: 'equalWidth', enabled: false }],
                    sx: {
                      minWidth: { xs: 'min(92vw, 360px)', sm: 360 },
                      maxWidth: 'calc(100vw - 32px)',
                      width: 'max-content'
                    }
                  }
                }}
              >
                {buildStorageMappingOptionNodes({
                  groups: allowedGroups,
                  trays,
                  nozzleCount,
                  filament,
                  requiredGrams: grams ?? null,
                  autoRefillEnabled: status?.amsSettings.autoRefill === true
                })}
              </Select>
            </Stack>
            {issue && (
              <Typography level="body-xs" color="warning" sx={{ pl: 'calc(32px + 8px)' }}>
                {formatStorageMappedCompatibilityIssue(issue, nozzleCount)}
              </Typography>
            )}
            {selectedUnknownTray && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ pl: 'calc(32px + 8px)' }}>
                <Typography level="body-xs" color="warning">
                  This slot holds an unrecognized spool.
                </Typography>
                <Button
                  size="sm"
                  variant="plain"
                  sx={{ minHeight: 0, py: 0 }}
                  onClick={() => setSpoolSetupTarget({
                    printerId,
                    kind: selectedUnknownTray.kind,
                    amsId: selectedUnknownTray.kind === 'ams' ? selectedUnknownTray.amsUnitId ?? 0 : selectedUnknownTray.mappingValue,
                    ...(selectedUnknownTray.kind === 'ams' ? { slotId: selectedUnknownTray.amsSlotId ?? 0 } : {}),
                    label: `${selectedUnknownTray.groupLabel} ${selectedUnknownTray.badgeLabel}`,
                    initial: {
                      filamentType: selectedUnknownTray.filamentType,
                      color: selectedUnknownTray.color,
                      trayInfoIdx: selectedUnknownTray.trayInfoIdx
                    }
                  })}
                >
                  Set up spool…
                </Button>
              </Stack>
            )}
          </Stack>
        )
      })}
      {spoolSetupTarget && (
        <AmsSpoolSetupDialog target={spoolSetupTarget} onClose={() => setSpoolSetupTarget(null)} />
      )}
    </Stack>
  )
}

function buildStorageMappingOptionNodes({
  groups,
  trays,
  nozzleCount,
  filament,
  requiredGrams,
  autoRefillEnabled
}: {
  groups: StorageTrayGroup[]
  trays: StorageTrayOption[]
  nozzleCount: number | null
  filament: ThreeMfProjectFilament
  requiredGrams: number | null
  autoRefillEnabled: boolean
}): ReactNode[] {
  const nodes: ReactNode[] = []
  for (const group of groups) {
    nodes.push(
      <Typography
        key={`header-${filament.id}-${group.key}`}
        level="body-xs"
        textColor="text.tertiary"
        sx={{ px: 1, pt: 0.5, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        {group.label}
      </Typography>
    )
    for (const tray of group.trays) {
      nodes.push(
        <Option key={`${filament.id}-${tray.key}`} value={tray.mappingValue}>
          <StorageTrayOptionLabel
            tray={tray}
            trays={trays}
            nozzleCount={nozzleCount}
            requiredFilamentType={filament.filamentType}
            requiredNozzleId={filament.nozzleId ?? null}
            requiredGrams={requiredGrams}
            autoRefillEnabled={autoRefillEnabled}
          />
        </Option>
      )
    }
  }
  return nodes
}

function StorageTrayOptionLabel({
  tray,
  trays,
  nozzleCount,
  requiredFilamentType,
  requiredNozzleId,
  requiredGrams,
  autoRefillEnabled
}: {
  tray: StorageTrayOption
  trays: readonly StorageTrayOption[]
  nozzleCount?: number | null
  requiredFilamentType?: string | null
  requiredNozzleId?: number | null
  requiredGrams?: number | null
  autoRefillEnabled?: boolean
}) {
  const source = tray.kind === 'external' ? tray.label : `${tray.groupLabel} ${tray.label}`
  const hasFilament = storageTrayHasLoadedFilament(tray)
  const unknownSpool = storageTrayHasUnknownSpool(tray)
  const filament = resolveFilamentDisplay(tray)
  const brandLabel = filament.material ? `Bambu ${filament.material}` : tray.filamentType
  const filamentDetail = unknownSpool
    ? 'Unknown spool'
    : [brandLabel ?? 'Empty', filament.name].filter(Boolean).join(' · ')
  const remainingState = getSlotRemainingState({
    tray,
    trays,
    requiredFilamentType,
    requiredNozzleId,
    requiredGrams,
    autoRefillEnabled
  })
  const badgeBackground = filamentBackground(filament.colors, tray.color, 'var(--joy-palette-neutral-800)')
  const badgeForeground = filamentTextColor(filament.colors, tray.color, 'var(--joy-palette-text-primary)')
  const remainGrams = remainingState.remainGrams
  // Only spools with a readable RFID/Bambu tag (trayUuid) report remaining; third-party
  // spools have no reliable figure, so we omit the estimate rather than show a guess.
  const remainingDetail = hasFilament && tray.trayUuid != null && tray.remainPercent != null && remainGrams != null
    ? `${Math.round(tray.remainPercent)}% (~${remainGrams}g)`
    : null
  const typeMismatch = Boolean(
    requiredFilamentType
    && tray.filamentType
    && findFilamentCompatibilityIssues(
      [{ filamentId: 1, filamentType: requiredFilamentType, filamentName: null, nozzleId: requiredNozzleId ?? null }],
      new Map([[1, { filamentType: tray.filamentType, label: tray.label, nozzleId: tray.nozzleId }]])
    )[0]?.typeMismatch
  )
  const nozzleMismatch = Boolean(
    requiredNozzleId != null
    && (tray.nozzleId == null || requiredNozzleId !== tray.nozzleId)
  )
  const incompatibilityLabel = typeMismatch
    ? `Incompatible material: requires ${requiredFilamentType ?? 'the selected material'}${tray.filamentType ? `, slot has ${tray.filamentType}` : ''}.`
    : nozzleMismatch
      ? `Incompatible nozzle: requires ${formatNozzleLabel(requiredNozzleId ?? null, 'short', nozzleCount) ?? 'the target nozzle'}${tray.nozzleId != null ? `, slot is ${formatNozzleLabel(tray.nozzleId, 'short', nozzleCount)}` : ''}.`
      : null

  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%', minWidth: 0 }}>
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '1px solid var(--joy-palette-neutral-700)',
          background: badgeBackground,
          color: badgeForeground,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.7rem',
          fontWeight: 'lg',
          lineHeight: 1,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)'
        }}
      >
        {tray.badgeLabel}
      </Box>
      <Box
        sx={{
          minWidth: 0,
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          columnGap: 1,
          rowGap: 0.125
        }}
      >
        <Typography level="body-xs" textColor="text.primary" noWrap sx={{ minWidth: 0, gridColumn: '1 / 2' }}>
          {source}
        </Typography>
        <Typography level="body-xs" textColor={unknownSpool ? 'warning.300' : 'text.tertiary'} noWrap sx={{ minWidth: 0, gridColumn: '1 / 2' }}>
          {filamentDetail || 'No filament reported'}
        </Typography>
        {incompatibilityLabel && (
          <StorageIncompatibilityWarningGlyph label={incompatibilityLabel} />
        )}
        {remainingDetail && (
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ gridColumn: '1 / 2', minWidth: 0 }}>
            <Typography
              level="body-xs"
              textColor={remainingState.insufficient ? 'danger.plainColor' : 'text.primary'}
              noWrap
              sx={{ minWidth: 0, fontWeight: remainingState.insufficient ? 'md' : undefined }}
            >
              {remainingDetail}
            </Typography>
            {remainingState.usesAutoRefill && (
              <Tooltip title="AMS auto-refill can continue this filament from another matching AMS slot." variant="soft" size="sm">
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', color: 'primary.plainColor', flexShrink: 0 }}>
                  <StorageAutoRefillGlyph />
                </Box>
              </Tooltip>
            )}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}

function StorageIncompatibilityWarningGlyph({ label }: { label: string }) {
  return (
    <Tooltip title={label} variant="soft" size="sm">
      <Box
        component="span"
        aria-label={label}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          color: 'warning.plainColor',
          flexShrink: 0,
          gridColumn: '2 / 3',
          gridRow: '1 / span 2',
          alignSelf: 'center',
          justifySelf: 'end',
          cursor: 'help'
        }}
      >
        <StorageWarningGlyph />
      </Box>
    </Tooltip>
  )
}

function StorageAutoRefillGlyph() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: 14, height: 14, display: 'block', fill: 'currentColor' }}>
      <path d="M12 5a7 7 0 0 1 6.42 4.22H16v2h6V5h-2v2.38A9 9 0 0 0 3 12h2a7 7 0 0 1 7-7zm7 6a7 7 0 0 1-13.42 2.78H8v-2H2v6h2v-2.38A9 9 0 0 0 21 12h-2a7 7 0 0 1-7 7z" />
    </Box>
  )
}

function StorageWarningGlyph() {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: 14, height: 14, display: 'block', fill: 'currentColor' }}>
      <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </Box>
  )
}

function storageTrayHasLoadedFilament(tray: Pick<StorageTrayOption, 'filamentType' | 'color' | 'colors' | 'trayInfoIdx' | 'trayName'>): boolean {
  return hasLoadedFilament(tray.filamentType, tray.color, tray.colors, {
    trayInfoIdx: tray.trayInfoIdx,
    trayName: tray.trayName
  })
}

/** Spool physically present but unidentified — must not read as "Empty". */
function storageTrayHasUnknownSpool(tray: Pick<StorageTrayOption, 'filamentType' | 'color' | 'colors' | 'trayInfoIdx' | 'trayName' | 'occupied'>): boolean {
  return !storageTrayHasLoadedFilament(tray) && tray.occupied === true
}

function getStorageSelectedTrayWarnings(input: {
  mappings: number[]
  trayByMappingValue: Map<number, StorageTrayOption>
  visibleFilaments: ThreeMfProjectFilament[]
  timelapse: boolean
  status: PrinterStatus | undefined
}): string[] {
  const warnings = new Set<string>()
  let hasAms = false
  let hasExternal = false

  for (const filament of input.visibleFilaments) {
    const mappingValue = input.mappings[filament.id - 1]
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

function formatStorageMappedCompatibilityIssue(issue: FilamentCompatibilityIssue, nozzleCount?: number | null): string {
  const subject = `#${issue.filamentId} ${issue.requiredFilamentName ?? issue.requiredFilamentType ?? 'filament'}`
  const trayLabel = issue.trayLabel ?? 'selected tray'
  const parts: string[] = []

  if (issue.typeMismatch) {
    parts.push(`${trayLabel} has ${issue.selectedFilamentType ?? 'an unknown material'}, expected ${issue.requiredFilamentType ?? 'the sliced material'}`)
  }
  if (issue.nozzleMismatch) {
    parts.push(`${trayLabel} feeds ${formatNozzleLabel(issue.trayNozzleId, 'long', nozzleCount) ?? 'the wrong nozzle'}, expected ${formatNozzleLabel(issue.nozzleId, 'long', nozzleCount) ?? 'the target nozzle'}`)
  }

  return `${subject}: ${parts.join('; ')}`
}
