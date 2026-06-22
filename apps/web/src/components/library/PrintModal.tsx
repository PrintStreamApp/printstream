/**
 * Print dialog stack extracted from `pages/LibraryView.tsx`.
 *
 * Owns the multi-printer "Send to printer" flow (`PrintModal`) and its
 * supporting render pieces: the per-printer AMS/external tray mapping editor
 * (`PrinterMapping`), the slot option label with remaining/compatibility
 * decorators (`SlotOptionLabel`), and the small inline glyph components. Pure
 * tray/compatibility derivations live in `../../lib/libraryViewHelpers`; this
 * file only owns the dialog's React surface.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert, Box, Button, Card, CardContent, Checkbox, Chip, DialogActions, FormControl, FormLabel, Option, Select, Sheet, Stack, Tooltip, Typography
} from '@mui/joy'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  FilamentCompatibilityIssue,
  LibraryFile,
  NozzleDiameterCompatibilityIssue,
  PrintDispatchJob,
  PrintNozzleOffsetCalibrationMode,
  PrintOnOffAutoMode,
  Printer,
  PrinterStatus,
  StartOrderPrintInput,
  ThreeMfIndex,
  ThreeMfProjectFilament
} from '@printstream/shared'
import {
  PRINTERS_CLEAR_PLATE_PERMISSION,
  buildRequiredNozzleDiametersByExtruder,
  findFilamentCompatibilityIssues,
  findNozzleDiameterCompatibilityIssues,
  formatNozzleDiameterLabel,
  formatNozzleLabel,
  getPrinterPrintStartOptions,
  getPrinterPrintOptionCapabilities,
  isPlateTypeCompatible,
  isPrinterModelCompatible,
  resolvePrinterNozzleDiameters
} from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { filamentBackground, filamentTextColor, resolveFilamentDisplay, resolveProjectFilamentColorName } from '../../lib/filamentColor'
import { getSlotRemainingState } from '../../lib/slotRemaining'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { readCurrentWorkspaceScopeKey, workspaceQueryKeys } from '../../lib/workspaceScope'
import {
  PLATE_CLEARING_STATE_QUERY_KEY,
  mergePlateClearingState,
  type PlateClearingStateResponse,
  usePlateClearingStates,
  usePlateClearingSync
} from '../../lib/plateClearing'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { OverflowTooltipText } from '../OverflowTooltipText'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { LibraryPlateCardPicker } from '../LibraryPlateSelect'
import { usePromptDialog } from '../PromptDialogProvider'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { PluginSlot } from '../../plugin/PluginSlot'
import { formatLibraryFileName } from '../../lib/libraryDisplay'
import { filterTrayGroupsForFilament, sanitizeTrayMapping } from '../../lib/printerTrayMapping'
import { AmsSpoolSetupDialog, type AmsSpoolSetupTarget } from '../AmsSpoolSetupDialog'
import {
  buildPrintStartPreferenceKey,
  DEFAULT_STORED_PRINT_START_OPTIONS,
  mergePrintStartOptions,
  parseStoredPrintStartOptions,
  resolveFirstLayerInspectionDefault,
  resolvePrintStartPreferenceDefaults
} from '../../lib/printStartOptions'
import {
  AVAILABLE_PRINT_STAGES,
  buildLibraryResourceBasePath,
  buildPrinterTrayGroups,
  buildPrinterTrayMap,
  visibleMappingFilaments,
  formatCompatibilityIssue,
  formatNozzleDiameterIssue,
  formatPlateTypeIssue,
  getSelectedTrayWarningMessages,
  isExternalSpoolMappingValue,
  printerHasChamber,
  printerHasSelectableTrays,
  printerStatusChipColor,
  printerStatusChipLabel,
  resolvePrinterNozzleCount,
  stopEventPropagation,
  trayHasLoadedFilament,
  trayHasUnknownSpool,
  type PlateTypeMismatchIssue,
  type PrinterTrayOption
} from '../../lib/libraryViewHelpers'
import { plateHasSliceData } from '../../lib/sliceProfileMatching'

const printOptionFieldSx = {
  display: 'grid',
  gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(7.5rem, 8.25rem)' },
  alignItems: 'center',
  gap: 0.75,
  minWidth: 0,
  width: '100%'
} as const

const printOptionSelectSx = {
  minWidth: 0,
  width: { xs: '100%', sm: '8.25rem' },
  maxWidth: '100%',
  justifySelf: { xs: 'stretch', sm: 'end' }
} as const

const printOptionHelpText = {
  bedLevel: 'This checks the flatness of the heatbed. Leveling makes the extruded height uniform.',
  vibrationCompensation: 'This calibrates printer vibrations before the print starts to reduce ringing and improve surface quality.',
  flowCalibration: 'This process determines the dynamic flow values to improve overall print quality. Automatic mode skips calibration if the filament was calibrated recently.',
  nozzleOffsetCalibration: 'Calibrate nozzle offsets to enhance print quality. Automatic mode checks for calibration before printing and skips it when unnecessary.'
} as const

function PrintOptionLabel({
  label,
  tooltip
}: {
  label: string
  tooltip?: string
}) {
  return (
    <FormLabel sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <Box component="span" sx={{ minWidth: 0 }}>{label}</Box>
        {tooltip ? (
          <Tooltip title={tooltip} variant="soft" size="sm">
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                color: 'text.tertiary',
                cursor: 'help',
                flexShrink: 0,
                '& svg': { fontSize: 18 }
              }}
            >
              <InfoOutlinedIcon />
            </Box>
          </Tooltip>
        ) : null}
      </Box>
    </FormLabel>
  )
}

interface PrintModalProps {
  file: LibraryFile
  versionId?: string | null
  printers: Printer[]
  onClose: () => void
  onBack?: () => void
  /**
   * Pre-select this printer when the dialog opens. Used when launching
   * the print flow from a specific printer card. Ignored if the printer
   * is currently busy or offline.
   */
  defaultPrinterId?: string
  lockPrinterSelection?: boolean
  defaultPlate?: number
  defaultBedLevel?: boolean
  defaultAmsMapping?: number[] | null
  projectFilamentOverrides?: ThreeMfProjectFilament[]
  selectionMode?: 'single' | 'multiple'
  submitPrint?: (input: {
    printerId: string
    body: Omit<StartOrderPrintInput, 'printerId'>
  }) => Promise<void>
  onSubmitted?: (printerIds: string[]) => void
}

interface AmsMappingsBySerial {
  /**
   * key = printer.id, value = array indexed by 0-based filament-id (project
   * filament `id - 1`) → dispatch tray mapping value. Standard AMS trays use
   * the global tray index; external spools use the virtual ids `255` / `254`.
   * `-1` (or absent) means “unset”, which we omit from the wire payload.
   */
  [printerId: string]: number[]
}

/**
 * Print dialog with multi-printer dispatch.
 *
 * The plate selector previews each plate's PNG. AMS mapping is keyed
 * by the project filament id, so the resulting `ams_mapping` payload
 * uses the same indices the printer firmware expects.
 */
export function PrintModal({
  file,
  versionId = null,
  printers,
  onClose,
  onBack,
  defaultPrinterId,
  lockPrinterSelection = false,
  defaultPlate,
  defaultBedLevel,
  defaultAmsMapping,
  projectFilamentOverrides,
  selectionMode = 'multiple',
  submitPrint,
  onSubmitted
}: PrintModalProps) {
  const { confirm } = usePromptDialog()
  const workspaceScopeKey = readCurrentWorkspaceScopeKey()
  const resourceBasePath = buildLibraryResourceBasePath(file.id, versionId)
  const queryClient = useQueryClient()
  usePlateClearingSync()
  const authBootstrapQuery = useAuthBootstrapQuery()
  const platesQuery = useQuery({
    queryKey: ['library-plates', file.id, versionId ?? 'current'],
    queryFn: ({ signal }) => apiFetch<ThreeMfIndex>(`${resourceBasePath}/plates`, { signal }),
    staleTime: 60_000,
    refetchOnMount: 'always'
  })
  const plates = useMemo(() => platesQuery.data?.plates ?? [], [platesQuery.data])
  const projectFilaments = useMemo(
    () => projectFilamentOverrides ?? platesQuery.data?.projectFilaments ?? [],
    [platesQuery.data, projectFilamentOverrides]
  )
  const compatiblePrinterModels = useMemo(
    () => platesQuery.data?.compatiblePrinterModels ?? file.compatiblePrinterModels,
    [file.compatiblePrinterModels, platesQuery.data]
  )

  const statusQuery = useQuery<Record<string, PrinterStatus>>({
    queryKey: workspaceQueryKeys.printerStatus(workspaceScopeKey),
    queryFn: () => Promise.resolve({}),
    initialData: {},
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })
  const statuses = useMemo(() => statusQuery.data ?? {}, [statusQuery.data])
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const canClearPlate = authBootstrapQuery.data
    ? !authEnabled || authBootstrapQuery.data.permissions.includes(PRINTERS_CLEAR_PLATE_PERMISSION)
    : false
  const { clearedByPrinterId } = usePlateClearingStates()
  const printerSelectionLocked = Boolean(lockPrinterSelection && defaultPrinterId && printers.some((printer) => printer.id === defaultPrinterId))
  const singlePrinterMode = useMemo(
    () => Boolean(defaultPrinterId && printers.some((printer) => printer.id === defaultPrinterId)),
    [defaultPrinterId, printers]
  )

  /**
   * A printer is "available" for a new job when it's reachable and not
   * already mid-job. We treat unknown stages as available so the user
   * can attempt to dispatch and let the firmware reject if needed.
   */
  const isAvailable = (printerId: string): boolean => {
    const status = statuses[printerId]
    if (!status || !status.online) return false
    return AVAILABLE_PRINT_STAGES.has(status.stage)
  }
  const availablePrinterIds = useMemo(
    () => new Set(Object.entries(statuses)
      .filter(([, status]) => status?.online && AVAILABLE_PRINT_STAGES.has(status.stage))
      .map(([printerId]) => printerId)),
    [statuses]
  )

  // Only pre-select a printer when the dialog was opened from a specific
  // printer card (defaultPrinterId provided). Page-level and library
  // entry points open with no printer selected so the user makes an
  // explicit choice.
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (
      defaultPrinterId
      && printers.some(
        (printer) =>
          printer.id === defaultPrinterId
          && isPrinterModelCompatible(file.compatiblePrinterModels, printer.model)
      )
    ) {
      return [defaultPrinterId]
    }
    return []
  })
  const selectedPrinters = useMemo(
    () => selectedIds
      .map((printerId) => printers.find((printer) => printer.id === printerId))
      .filter((printer): printer is Printer => Boolean(printer)),
    [printers, selectedIds]
  )
  const hasSelectedPrinters = selectedPrinters.length > 0
  const preferencePrinterModels = useMemo(() => {
    if (selectedPrinters.length > 0) {
      return selectedPrinters.map((printer) => printer.model)
    }
    if (singlePrinterMode && defaultPrinterId) {
      const defaultPrinter = printers.find((printer) => printer.id === defaultPrinterId)
      return defaultPrinter ? [defaultPrinter.model] : []
    }
    return []
  }, [defaultPrinterId, printers, selectedPrinters, singlePrinterMode])
  const storedPrintOptionsKey = useMemo(
    () => buildPrintStartPreferenceKey(authBootstrapQuery.data, preferencePrinterModels),
    [authBootstrapQuery.data, preferencePrinterModels]
  )
  const [storedPrintOptions, setStoredPrintOptions, storedPrintOptionsReady] = useLocalStorageState(
    storedPrintOptionsKey,
    DEFAULT_STORED_PRINT_START_OPTIONS,
    parseStoredPrintStartOptions
  )
  const [plateIndex, setPlateIndex] = useState<number>(defaultPlate ?? 1)
  const [bedLevel, setBedLevel] = useState<PrintOnOffAutoMode>('on')
  const [vibrationCompensation, setVibrationCompensation] = useState(false)
  const [flowCalibration, setFlowCalibration] = useState<PrintOnOffAutoMode>('off')
  const [timelapse, setTimelapse] = useState(false)
  const [nozzleOffsetCalibration, setNozzleOffsetCalibration] = useState<PrintNozzleOffsetCalibrationMode>('auto')
  const [printOptionsTouched, setPrintOptionsTouched] = useState(false)
  const [initializedPrintOptionsSelectionKey, setInitializedPrintOptionsSelectionKey] = useState<string | null>(null)
  const [mappings, setMappings] = useState<AmsMappingsBySerial>(() => {
    if (!defaultPrinterId || !defaultAmsMapping || defaultAmsMapping.length === 0) return {}
    return { [defaultPrinterId]: defaultAmsMapping }
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [allowIncompatibleFilament, setAllowIncompatibleFilament] = useState(false)
  const [allowPlateTypeMismatch, setAllowPlateTypeMismatch] = useState(false)
  const [showOtherPrinters, setShowOtherPrinters] = useState(false)
  const [previewFileId, setPreviewFileId] = useState<string | null>(null)
  const canOpenThreeDimensionalPreview = (file.kind === '3mf' || file.kind === 'gcode') && plates.length > 0

  const confirmPlateCleared = useMutation({
    mutationFn: async (printerId: string) => {
      await apiFetch(`/api/plugins/plate-clearing/state/${printerId}/clear`, { method: 'POST' })
      return printerId
    },
    onSuccess: (printerId) => {
      queryClient.setQueryData<PlateClearingStateResponse>(
        PLATE_CLEARING_STATE_QUERY_KEY,
        (existing) => mergePlateClearingState(existing, printerId, true)
      )
    }
  })

  const activePlate = useMemo(
    () => plates.find((plate) => plate.index === plateIndex) ?? plates[0],
    [plates, plateIndex]
  )
  /**
   * Filaments displayed for AMS mapping. Prefer the full project list
   * (Bambu Studio's view), but fall back to the per-plate filaments for
   * older 3MFs that omit `project_settings.config`.
   */
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
  /**
   * Whether the active plate carries real slice metadata. When false the plate's
   * filament list is only a geometry estimate that misses colour-painted filaments,
   * so the mapping list falls back to the full project palette (see
   * {@link visibleMappingFilaments}).
   */
  const activePlateIsSliced = useMemo(() => plateHasSliceData(activePlate), [activePlate])
  /**
   * Per-filament gram usage for the active plate. Used by the printer
   * mapping rows to show "this print needs 12g of #1 PLA" so the user
   * can compare against the remaining-spool estimate next to each AMS
   * slot.
   */
  const usedGramsById = useMemo(() => {
    const map = new Map<number, number>()
    for (const filament of activePlate?.filaments ?? []) {
      if (filament.usedGrams != null) map.set(filament.id, filament.usedGrams)
    }
    return map
  }, [activePlate])

  const visibleFilaments = useMemo(
    () => visibleMappingFilaments(filamentEntries, usedIds, activePlateIsSliced),
    [filamentEntries, usedIds, activePlateIsSliced]
  )
  const requiredNozzleDiameters = useMemo(
    () => buildRequiredNozzleDiametersByExtruder(activePlate?.filaments ?? [], activePlate?.nozzleSizes ?? []),
    [activePlate]
  )
  const setSlot = (printerId: string, filamentId: number, trayValue: number) => {
    setMappings((prev) => {
      const current = prev[printerId] ? [...prev[printerId]] : []
      const externalSpoolCount = statuses[printerId]?.externalSpools.length ?? 0
      const selectedTray = buildPrinterTrayMap(statuses[printerId]).get(trayValue)
      const selectedTrayNozzleId = selectedTray?.nozzleId ?? null
      const targetFilamentIds =
        externalSpoolCount === 1 && isExternalSpoolMappingValue(trayValue)
          ? visibleFilaments
            .filter(
              (filament) =>
                filament.nozzleId == null
                || (selectedTrayNozzleId != null && filament.nozzleId === selectedTrayNozzleId)
            )
            .map((filament) => filament.id)
          : [filamentId]
      for (const targetFilamentId of targetFilamentIds) {
        const slot = targetFilamentId - 1
        while (current.length <= slot) current.push(-1)
        current[slot] = trayValue
      }
      return { ...prev, [printerId]: current }
    })
  }

  /**
   * IDs of filaments the active plate actually consumes. Every one of
   * these must have an explicit AMS slot chosen for each selected
   * printer before we let the user dispatch.
   */
  const requiredFilamentIds = useMemo(
    () => activePlateIsSliced
      ? (activePlate?.filaments ?? []).map((filament) => filament.id)
      : visibleFilaments.map((filament) => filament.id),
    [activePlateIsSliced, activePlate, visibleFilaments]
  )
  const visibleFilamentById = useMemo(
    () => new Map(visibleFilaments.map((filament) => [filament.id, filament] as const)),
    [visibleFilaments]
  )
  const isMappingComplete = (printerId: string): boolean => {
    if (!printerHasSelectableTrays(statuses[printerId])) return true
    const mapping = mappings[printerId] ?? []
    const trayGroups = buildPrinterTrayGroups(statuses[printerId])
    return requiredFilamentIds.every((id) => {
      const selectedValue = mapping[id - 1] ?? -1
      if (selectedValue < 0) return false
      const filament = visibleFilamentById.get(id)
      const allowedTrayValues = new Set(
        filterTrayGroupsForFilament(trayGroups, filament?.nozzleId ?? null)
          .flatMap((group) => group.trays)
          .map((tray) => tray.mappingValue)
      )
      return allowedTrayValues.has(selectedValue)
    })
  }
  const allMappingsComplete = selectedIds.every(isMappingComplete)

  const compatibilityIssuesByPrinter = useMemo(() => {
    const next: Record<string, FilamentCompatibilityIssue[]> = {}
    for (const printerId of selectedIds) {
      const mapping = mappings[printerId] ?? []
      const trayByValue = buildPrinterTrayMap(statuses[printerId])
      const selectedTrays = new Map<number, { filamentType: string | null; label: string; nozzleId: number | null }>()
      for (const filament of visibleFilaments) {
        const trayValue = mapping[filament.id - 1]
        if (typeof trayValue !== 'number' || trayValue < 0) continue
        const tray = trayByValue.get(trayValue)
        if (!tray) continue
        selectedTrays.set(filament.id, {
          filamentType: tray.filamentType,
          label: tray.kind === 'external'
            ? tray.label
            : [tray.groupLabel ?? 'AMS', tray.label].join(' '),
          nozzleId: tray.nozzleId
        })
      }

      const issues = findFilamentCompatibilityIssues(
        visibleFilaments.map((filament) => ({
          filamentId: filament.id,
          filamentType: filament.filamentType,
          filamentName: filament.filamentName,
          nozzleId: filament.nozzleId ?? null
        })),
        selectedTrays
      )

      if (issues.length > 0) next[printerId] = issues
    }
    return next
  }, [mappings, selectedIds, statuses, visibleFilaments])
  const compatibilityIssueEntries = useMemo(
    () => selectedIds
      .map((printerId) => [printerId, compatibilityIssuesByPrinter[printerId] ?? []] as const)
      .filter(([, issues]) => issues.length > 0),
    [compatibilityIssuesByPrinter, selectedIds]
  )
  const hardCompatibilityIssueEntries = useMemo(
    () => compatibilityIssueEntries
      .map(([printerId, issues]) => [printerId, issues.filter((issue) => issue.nozzleMismatch)] as const)
      .filter(([, issues]) => issues.length > 0),
    [compatibilityIssueEntries]
  )
  const softCompatibilityIssueEntries = useMemo(
    () => compatibilityIssueEntries
      .map(([printerId, issues]) => [printerId, issues.filter((issue) => issue.typeMismatch && !issue.nozzleMismatch)] as const)
      .filter(([, issues]) => issues.length > 0),
    [compatibilityIssueEntries]
  )
  const hasHardCompatibilityIssues = hardCompatibilityIssueEntries.length > 0
  const hasSoftCompatibilityIssues = softCompatibilityIssueEntries.length > 0
  const highTemperatureFilamentLabels = useMemo(() => {
    const projectFilamentsById = new Map(filamentEntries.map((filament) => [filament.id, filament] as const))
    const labels = new Set<string>()
    for (const filament of activePlate?.filaments ?? []) {
      const projectFilament = projectFilamentsById.get(filament.id)
      const chamberTemperature = projectFilament?.chamberTemperature ?? filament.chamberTemperature ?? null
      if (chamberTemperature == null || chamberTemperature < 40) continue
      const label = projectFilament?.filamentType?.trim() || filament.filamentType?.trim() || null
      if (label) labels.add(label)
    }
    return Array.from(labels)
  }, [activePlate, filamentEntries])
  const compatibilitySignature = useMemo(
    () => JSON.stringify({ hardCompatibilityIssueEntries, softCompatibilityIssueEntries }),
    [hardCompatibilityIssueEntries, softCompatibilityIssueEntries]
  )

  useEffect(() => {
    setAllowIncompatibleFilament(false)
  }, [compatibilitySignature])

  const printersById = useMemo(
    () => new Map(printers.map((printer) => [printer.id, printer] as const)),
    [printers]
  )
  const environmentWarningEntries = useMemo(() => {
    if (highTemperatureFilamentLabels.length === 0 || selectedIds.length === 0) return []
    const filamentList = highTemperatureFilamentLabels.join(', ')
    return selectedIds
      .map((printerId) => {
        const printer = printersById.get(printerId)
        if (!printer) return null
        const message = printerHasChamber(printer.model)
          ? `[ ${filamentList} ] requires printing in a high-temperature environment. Reminder to close the door if not already closed.`
          : `[ ${filamentList} ] requires printing in a high-temperature environment.`
        return {
          printerId,
          printerName: printer.name,
          message
        }
      })
      .filter((entry): entry is { printerId: string; printerName: string; message: string } => entry != null)
  }, [highTemperatureFilamentLabels, printersById, selectedIds])
  const compatiblePrinters = useMemo(
    () => printers.filter((printer) => isPrinterModelCompatible(compatiblePrinterModels, printer.model)),
    [compatiblePrinterModels, printers]
  )
  const busyPrinters = useMemo(
    () => printers.filter((printer) => {
      const status = statuses[printer.id]
      return Boolean(status?.online && !AVAILABLE_PRINT_STAGES.has(status.stage))
    }),
    [printers, statuses]
  )
  const incompatiblePrinters = useMemo(
    () => printers.filter((printer) => !isPrinterModelCompatible(compatiblePrinterModels, printer.model)),
    [compatiblePrinterModels, printers]
  )
  const visiblePrinters = useMemo(
    () => {
      if (printerSelectionLocked) {
        return printers.filter((printer) => printer.id === defaultPrinterId)
      }
      if (singlePrinterMode) {
        return showOtherPrinters
          ? printers
          : printers.filter((printer) => printer.id === defaultPrinterId)
      }

      return showOtherPrinters
        ? printers
        : printers.filter((printer) => {
          if (selectedIds.includes(printer.id)) return true
          if (!isPrinterModelCompatible(compatiblePrinterModels, printer.model)) return false
          const status = statuses[printer.id]
          return !(status?.online && !AVAILABLE_PRINT_STAGES.has(status.stage))
        })
    },
    [compatiblePrinterModels, defaultPrinterId, printerSelectionLocked, printers, selectedIds, showOtherPrinters, singlePrinterMode, statuses]
  )
  const visiblePrintStartOptions = useMemo(() => {
    if (selectedPrinters.length === 0) return null

    return mergePrintStartOptions(
      selectedPrinters.map((printer) => {
        const printerStatus = statuses[printer.id]
        return getPrinterPrintStartOptions(
          printer.model,
          printerStatus
            ? {
                printOptions: printerStatus.printOptions,
                printStartOptions: printerStatus.printStartOptions
              }
            : null
        )
      })
    )
  }, [selectedPrinters, statuses])
  const visiblePrintOptionCapabilities = useMemo(() => ({
    bedLevel: visiblePrintStartOptions?.bedLevel.supported ?? false,
    bedLevelAuto: visiblePrintStartOptions?.bedLevel.autoSupported ?? false,
    vibrationCompensation: visiblePrintStartOptions?.vibrationCompensation.supported ?? false,
    flowCalibration: visiblePrintStartOptions?.flowCalibration.supported ?? false,
    flowCalibrationAuto: visiblePrintStartOptions?.flowCalibration.autoSupported ?? false,
    firstLayerInspection: visiblePrintStartOptions?.firstLayerInspection.supported ?? false,
    timelapse: visiblePrintStartOptions?.timelapse.supported ?? false,
    nozzleOffsetCalibration: visiblePrintStartOptions?.nozzleOffsetCalibration.supported ?? false
  }), [visiblePrintStartOptions])
  const resolvedStoredPrintOptions = useMemo(
    () => resolvePrintStartPreferenceDefaults(storedPrintOptions, visiblePrintStartOptions),
    [storedPrintOptions, visiblePrintStartOptions]
  )
  const selectedPrinterSelectionKey = useMemo(
    () => selectedIds.slice().sort().join(','),
    [selectedIds]
  )

  // Print options are remembered per printer-model set (the storage key). When the model set
  // changes, clear the "user touched" flag so the form re-seeds from the new model's own
  // remembered (capability-clamped) values instead of carrying the previous model's edits over
  // and writing them into the new model's key. Keyed on the storage key rather than the raw
  // selection so adding a same-model printer keeps any in-progress edits.
  useEffect(() => {
    setPrintOptionsTouched(false)
  }, [storedPrintOptionsKey])

  useEffect(() => {
    if (!hasSelectedPrinters) {
      setInitializedPrintOptionsSelectionKey(null)
      return
    }
    if (printOptionsTouched) return
    if (!storedPrintOptionsReady) return
    if (initializedPrintOptionsSelectionKey === selectedPrinterSelectionKey) return
    setBedLevel(defaultBedLevel == null ? resolvedStoredPrintOptions.bedLevel : defaultBedLevel ? 'on' : 'off')
    setVibrationCompensation(resolvedStoredPrintOptions.vibrationCompensation)
    setFlowCalibration(resolvedStoredPrintOptions.flowCalibration)
    setTimelapse(resolvedStoredPrintOptions.timelapse)
    setNozzleOffsetCalibration(resolvedStoredPrintOptions.nozzleOffsetCalibration)
    setInitializedPrintOptionsSelectionKey(selectedPrinterSelectionKey)
  }, [
    defaultBedLevel,
    hasSelectedPrinters,
    initializedPrintOptionsSelectionKey,
    printOptionsTouched,
    resolvedStoredPrintOptions,
    selectedPrinterSelectionKey,
    storedPrintOptionsReady
  ])

  const selectedTrayWarningEntries = useMemo(() => {
    return selectedIds
      .map((printerId) => {
        const printer = printersById.get(printerId)
        const warnings = getSelectedTrayWarningMessages({
          mapping: mappings[printerId] ?? [],
          trayByMappingValue: buildPrinterTrayMap(statuses[printerId]),
          filaments: visibleFilaments,
          timelapse,
          status: statuses[printerId]
        })
        if (!printer || warnings.length === 0) return null
        return {
          printerId,
          printerName: printer.name,
          warnings
        }
      })
      .filter((entry): entry is { printerId: string; printerName: string; warnings: string[] } => entry != null)
  }, [mappings, printersById, selectedIds, statuses, timelapse, visibleFilaments])

  const hardwareIssuesByPrinter = useMemo(() => {
    const next: Record<string, { plateType: PlateTypeMismatchIssue | null; nozzleDiameters: NozzleDiameterCompatibilityIssue[] }> = {}
    for (const printerId of selectedIds) {
      const printer = printersById.get(printerId)
      const selection = {
        plateType: printer?.currentPlateType ?? null,
        nozzleDiameters: resolvePrinterNozzleDiameters(statuses[printerId], printer?.currentNozzleDiameters ?? [])
      }
      const plateTypeIssue = activePlate?.plateType
        ? !selection.plateType || !isPlateTypeCompatible(activePlate.plateType, selection.plateType)
          ? {
            requiredPlateType: activePlate.plateType,
            selectedPlateType: selection.plateType ?? null
          }
          : null
        : null
      const nozzleDiameters = findNozzleDiameterCompatibilityIssues(requiredNozzleDiameters, selection.nozzleDiameters)
      if (plateTypeIssue || nozzleDiameters.length > 0) {
        next[printerId] = { plateType: plateTypeIssue, nozzleDiameters }
      }
    }
    return next
  }, [activePlate, printersById, requiredNozzleDiameters, selectedIds, statuses])
  const plateTypeIssueEntries = useMemo(
    () => selectedIds
      .map((printerId) => [printerId, hardwareIssuesByPrinter[printerId]?.plateType ?? null] as const)
      .filter(([, issue]) => issue != null),
    [hardwareIssuesByPrinter, selectedIds]
  )
  const nozzleDiameterIssueEntries = useMemo(
    () => selectedIds
      .map((printerId) => [printerId, hardwareIssuesByPrinter[printerId]?.nozzleDiameters ?? []] as const)
      .filter(([, issues]) => issues.length > 0),
    [hardwareIssuesByPrinter, selectedIds]
  )
  const hasPlateTypeIssues = plateTypeIssueEntries.length > 0
  const hasHardNozzleDiameterIssues = nozzleDiameterIssueEntries.length > 0
  const hardwareSignature = useMemo(
    () => JSON.stringify({ plateTypeIssueEntries, nozzleDiameterIssueEntries }),
    [nozzleDiameterIssueEntries, plateTypeIssueEntries]
  )

  useEffect(() => {
    setAllowPlateTypeMismatch(false)
  }, [hardwareSignature])

  useEffect(() => {
    if (!hasSelectedPrinters) return
    if (!storedPrintOptionsReady) return
    if (!printOptionsTouched && initializedPrintOptionsSelectionKey !== selectedPrinterSelectionKey) return
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
    hasSelectedPrinters,
    initializedPrintOptionsSelectionKey,
    timelapse,
    nozzleOffsetCalibration,
    printOptionsTouched,
    selectedPrinterSelectionKey,
    setStoredPrintOptions,
    storedPrintOptionsReady
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

  useEffect(() => {
    setSelectedIds((current) => {
      const next = current.filter((printerId) => {
        const printer = printers.find((entry) => entry.id === printerId)
        return printer
          ? isPrinterModelCompatible(compatiblePrinterModels, printer.model)
            && clearedByPrinterId[printerId] !== false
          : false
      })
      return next.length === current.length ? current : next
    })
  }, [clearedByPrinterId, compatiblePrinterModels, printers])

  useEffect(() => {
    if (!printerSelectionLocked || !defaultPrinterId) return
    const lockedPrinter = printers.find((printer) => printer.id === defaultPrinterId)
    const next = lockedPrinter
      && isPrinterModelCompatible(compatiblePrinterModels, lockedPrinter.model)
      && clearedByPrinterId[defaultPrinterId] !== false
      && availablePrinterIds.has(defaultPrinterId)
      ? [defaultPrinterId]
      : []
    setSelectedIds((current) => current.length === next.length && current.every((value, index) => value === next[index]) ? current : next)
  }, [availablePrinterIds, clearedByPrinterId, compatiblePrinterModels, defaultPrinterId, printerSelectionLocked, printers])

  const togglePrinter = (printer: Printer) => {
    if (printerSelectionLocked) return
    const modelCompatible = isPrinterModelCompatible(compatiblePrinterModels, printer.model)
    const plateNeedsClear = clearedByPrinterId[printer.id] === false
    if ((!isAvailable(printer.id) || !modelCompatible || plateNeedsClear) && !selectedIds.includes(printer.id)) return
    setSelectedIds((current) => {
      if (selectionMode === 'single') {
        return current.includes(printer.id) ? [] : [printer.id]
      }
      return current.includes(printer.id)
        ? current.filter((id) => id !== printer.id)
        : [...current, printer.id]
    })
  }

  const submitInFlightRef = useRef(false)

  const submit = async () => {
    if (submitInFlightRef.current) {
      return
    }

    submitInFlightRef.current = true
    setSubmitting(true)
    setErrors({})

    try {
      const next: Record<string, string> = {}
      const submittedPrinterIds: string[] = []
      await Promise.all(
        selectedIds.map(async (printerId) => {
          try {
            const printer = printersById.get(printerId)
            const capabilities = getPrinterPrintOptionCapabilities(
              printer?.model ?? 'unknown',
              statuses[printerId]
                ? {
                    printOptions: statuses[printerId].printOptions,
                    printStartOptions: statuses[printerId].printStartOptions
                  }
                : null
            )
            const printStartOptions = getPrinterPrintStartOptions(
              printer?.model ?? 'unknown',
              statuses[printerId]
                ? {
                    printOptions: statuses[printerId].printOptions,
                    printStartOptions: statuses[printerId].printStartOptions
                  }
                : null
            )
            const normalizedBedLevel = !capabilities.bedLevel
              ? 'off'
              : bedLevel === 'auto' && !capabilities.bedLevelAuto
                ? 'on'
                : bedLevel
            const normalizedFlowCalibration = !capabilities.flowCalibration
              ? 'off'
              : flowCalibration === 'auto' && !capabilities.flowCalibrationAuto
                ? 'on'
                : flowCalibration
            const body = {
              useAms: true,
              bedLevel: normalizedBedLevel,
              vibrationCompensation: capabilities.vibrationCompensation && vibrationCompensation,
              flowCalibration: normalizedFlowCalibration,
              firstLayerInspection: resolveFirstLayerInspectionDefault(printStartOptions),
              timelapse: capabilities.timelapse && timelapse,
              filamentDynamicsCalibration: false,
              nozzleOffsetCalibration:
                capabilities.nozzleOffsetCalibration ? nozzleOffsetCalibration : 'off',
              allowIncompatibleFilament,
              allowPlateTypeMismatch,
              currentPlateType: printer?.currentPlateType ?? null,
              currentNozzleDiameters: resolvePrinterNozzleDiameters(
                statuses[printerId],
                printer?.currentNozzleDiameters ?? []
              ),
              plate: activePlate?.index ?? 1,
              amsMapping: sanitizeTrayMapping(mappings[printerId])
            } satisfies Omit<StartOrderPrintInput, 'printerId'>

            if (submitPrint) {
              await submitPrint({ printerId, body })
            } else {
              await apiFetch<{ job: PrintDispatchJob }>(`${resourceBasePath}/print`, {
                method: 'POST',
                body: {
                  printerId,
                  ...body
                }
              })
            }
            submittedPrinterIds.push(printerId)
          } catch (error) {
            next[printerId] = (error as Error).message
          }
        })
      )

      setErrors(next)
      if (submittedPrinterIds.length > 0) {
        onSubmitted?.(submittedPrinterIds)
      }
      if (Object.keys(next).length === 0) {
        void queryClient.invalidateQueries({ queryKey: ['print-dispatch'] })
        onClose()
      }
    } finally {
      submitInFlightRef.current = false
      setSubmitting(false)
    }
  }

  const dismissCurrentStep = onBack ?? onClose

  return (
    <>
      <Modal open onClose={dismissCurrentStep}>
        <ScrollableModalDialog sx={{ maxWidth: 640, width: '100%' }}>
        <Typography level="h4">Send to printer</Typography>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          sx={{ mb: 1, minWidth: 0 }}
        >
          <Typography level="body-sm" textColor="text.tertiary" sx={{ minWidth: 0 }}>
            {formatLibraryFileName(file.name)}
          </Typography>
          {(compatiblePrinterModels.length > 0 || activePlate?.plateType || activePlate?.nozzleSizes.length) ? (
            <Stack
              direction="row"
              spacing={0.5}
              useFlexGap
              sx={{
                flexWrap: 'wrap',
                minWidth: 0,
                justifyContent: { xs: 'flex-start', sm: 'flex-end' },
                flexShrink: 0
              }}
            >
              {compatiblePrinterModels.map((model) => (
                <Chip key={model} size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>
                  {model}
                </Chip>
              ))}
              {(activePlate?.nozzleSizes ?? []).map((size) => (
                <Chip key={size} size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>
                  {formatNozzleDiameterLabel(size) ?? size}
                </Chip>
              ))}
              {activePlate?.plateType && (
                <Chip size="sm" variant="soft" color="warning" sx={{ flexShrink: 0 }}>
                  {activePlate.plateType}
                </Chip>
              )}
            </Stack>
          ) : null}
        </Stack>
        <ScrollableDialogBody sx={{ p: 0, overflowX: 'hidden' }}>
        <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
          {plates.length > 0 && (
            <>
              <Typography level="title-sm">Plate</Typography>
              <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
                <LibraryPlateCardPicker
                  fileId={file.id}
                  resourceBasePath={resourceBasePath}
                  thumbnailVersion={file.uploadedAt}
                  plates={plates}
                  value={plateIndex}
                  onChange={setPlateIndex}
                  label={null}
                  onPreview={canOpenThreeDimensionalPreview ? () => setPreviewFileId(file.id) : undefined}
                />
              </Sheet>
            </>
          )}

          <Typography level="title-sm">Printers</Typography>
          <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Typography level="body-sm" textColor="text.tertiary">
                  {printerSelectionLocked
                    ? 'This print is locked to the originating printer.'
                    : singlePrinterMode ? 'Select a printer for this plate.' : 'Select one or more printers for this plate.'}
                </Typography>
                {!printerSelectionLocked && ((singlePrinterMode && printers.length > 1) || (!singlePrinterMode && (incompatiblePrinters.length > 0 || busyPrinters.length > 0))) && (
                  <Typography
                    level="body-sm"
                    textColor="primary.softColor"
                    sx={{ cursor: 'pointer', flexShrink: 0 }}
                    onClick={() => setShowOtherPrinters((current) => !current)}
                  >
                    {showOtherPrinters ? 'Hide other printers' : 'Show other printers'}
                  </Typography>
                )}
              </Stack>
              {printers.length === 0 && (
                <Typography level="body-sm" textColor="text.tertiary">
                  No printers configured.
                </Typography>
              )}
              {printers.length > 0 && compatiblePrinterModels.length > 0 && compatiblePrinters.length === 0 && (
                <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                  No compatible printers are configured for this file. It can only be sent to {compatiblePrinterModels.join(', ')}.
                </Alert>
              )}
              {visiblePrinters.map((printer) => {
                const checked = selectedIds.includes(printer.id)
                const status = statuses[printer.id]
                const available = isAvailable(printer.id)
                const modelCompatible = isPrinterModelCompatible(compatiblePrinterModels, printer.model)
                const plateNeedsClear = clearedByPrinterId[printer.id] === false
                const plateClearActionable = available && modelCompatible && plateNeedsClear
                const selectable = available && modelCompatible && !plateNeedsClear
                const canToggleSelection = selectable && !printerSelectionLocked
                const canConfirmClear = canClearPlate && plateClearActionable
                const toggle = () => canToggleSelection && togglePrinter(printer)
                return (
                  <Card
                    key={printer.id}
                    variant="outlined"
                    size="sm"
                    onClick={toggle}
                    sx={{
                      opacity: selectable || plateClearActionable ? 1 : 0.6,
                      cursor: canToggleSelection ? 'pointer' : canConfirmClear ? 'default' : 'not-allowed',
                      borderColor: checked ? 'var(--joy-palette-primary-500)' : undefined,
                      boxShadow: checked ? '0 0 0 1px var(--joy-palette-primary-500)' : undefined,
                      transition: 'border-color 120ms, box-shadow 120ms'
                    }}
                  >
                    <CardContent>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Checkbox
                          checked={checked}
                          disabled={!canToggleSelection}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => togglePrinter(printer)}
                        />
                        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: 1, minWidth: 0 }}>
                          <Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>{printer.name}</Typography>
                          <Chip size="sm" variant="soft" color="neutral" sx={{ flexShrink: 0 }}>{printer.model}</Chip>
                        </Stack>
                        <Chip
                          size="sm"
                          variant="soft"
                          onClick={canConfirmClear
                            ? async (event) => {
                              event.stopPropagation()
                              const confirmed = await confirm({
                                title: 'Confirm build plate cleared?',
                                description: `Confirm that the build plate on ${printer.name} has been cleared?`,
                                confirmLabel: 'Plate is cleared',
                                color: 'warning'
                              })
                              if (!confirmed) {
                                return
                              }
                              try {
                                await confirmPlateCleared.mutateAsync(printer.id)
                                setSelectedIds((current) => {
                                  return current.includes(printer.id) ? current : [...current, printer.id]
                                })
                              } catch {
                                // Error state is surfaced by the mutation; keep selection unchanged.
                              }
                            }
                            : undefined}
                          color={
                            modelCompatible
                              ? plateNeedsClear
                                ? 'warning'
                                : printerStatusChipColor(status, available)
                              : 'danger'
                          }
                          sx={{
                            flexShrink: 0,
                            cursor: canConfirmClear ? 'pointer' : undefined,
                            pointerEvents: canConfirmClear ? 'auto' : undefined
                          }}
                        >
                          {modelCompatible
                            ? plateNeedsClear
                              ? 'clear plate'
                              : printerStatusChipLabel(status, available)
                            : 'model mismatch'}
                        </Chip>
                      </Stack>

                      {!modelCompatible && compatiblePrinterModels.length > 0 && (
                        <Typography level="body-xs" color="danger" sx={{ mt: 0.5 }}>
                          This file is only compatible with {compatiblePrinterModels.join(', ')}.
                        </Typography>
                      )}

                      {checked && filamentEntries.length > 0 && (
                        <Box
                          onClick={stopEventPropagation}
                          onMouseDown={stopEventPropagation}
                          onPointerDown={stopEventPropagation}
                          onTouchStart={stopEventPropagation}
                          sx={{ mt: 1 }}
                        >
                          <PrinterMapping
                            printer={printer}
                            status={status}
                            filaments={visibleFilaments}
                            usedGramsById={usedGramsById}
                            mapping={mappings[printer.id] ?? []}
                            issues={compatibilityIssuesByPrinter[printer.id] ?? []}
                            onChange={(filamentId, tray) => setSlot(printer.id, filamentId, tray)}
                          />
                        </Box>
                      )}

                      {errors[printer.id] && (
                        <Typography color="danger" level="body-xs" sx={{ mt: 0.5 }}>
                          {errors[printer.id]}
                        </Typography>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
              {environmentWarningEntries.length > 0 && (
                <Stack spacing={0.5}>
                  {environmentWarningEntries.map((warning) => (
                    <Stack
                      key={warning.printerId}
                      direction="row"
                      spacing={1}
                      alignItems="flex-start"
                      sx={{ px: 0, py: 0 }}
                    >
                      <WarningAmberRoundedIcon color="warning" fontSize="small" />
                      <Stack spacing={0.25}>
                        {environmentWarningEntries.length > 1 && (
                          <Typography level="body-xs" textColor="text.tertiary">{warning.printerName}</Typography>
                        )}
                        <Typography level="body-sm" color="warning">{warning.message}</Typography>
                      </Stack>
                    </Stack>
                  ))}
                </Stack>
              )}
              {selectedTrayWarningEntries.length > 0 && (
                <Stack spacing={0.5}>
                  {selectedTrayWarningEntries.map((entry) => (
                    <Stack
                      key={`selected-tray-${entry.printerId}`}
                      direction="row"
                      spacing={1}
                      alignItems="flex-start"
                      sx={{ px: 0, py: 0 }}
                    >
                      <WarningAmberRoundedIcon color="warning" fontSize="small" />
                      <Stack spacing={0.25}>
                        {selectedTrayWarningEntries.length > 1 && (
                          <Typography level="body-xs" textColor="text.tertiary">{entry.printerName}</Typography>
                        )}
                        {entry.warnings.map((warning) => (
                          <Typography key={`${entry.printerId}-${warning}`} level="body-sm" color="warning">{warning}</Typography>
                        ))}
                      </Stack>
                    </Stack>
                  ))}
                </Stack>
              )}
            </Stack>
          </Sheet>

          <Typography level="title-sm">Print settings</Typography>
          <Sheet variant="outlined" sx={{ p: 1, borderRadius: 'sm' }}>
            {!hasSelectedPrinters ? (
              <Typography level="body-sm" textColor="text.tertiary">
                Select at least one printer to review print settings.
              </Typography>
            ) : (
              <Box sx={{ minWidth: 0, width: '100%', display: 'grid', gap: 1 }}>
                {visiblePrintOptionCapabilities.timelapse && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Timelapse" />
                    <Select<'off' | 'on'>
                      value={timelapse ? 'on' : 'off'}
                      onChange={(_event, value) => value && updateTimelapse(value === 'on')}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                    </Select>
                  </FormControl>
                )}
                {visiblePrintOptionCapabilities.bedLevel && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Auto Bed Leveling" tooltip={printOptionHelpText.bedLevel} />
                    <Select<PrintOnOffAutoMode>
                      value={bedLevel}
                      onChange={(_event, value) => value && updateBedLevel(value)}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      {visiblePrintOptionCapabilities.bedLevelAuto && <Option value="auto">Auto</Option>}
                    </Select>
                  </FormControl>
                )}
                {visiblePrintOptionCapabilities.vibrationCompensation && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Vibration Compensation" tooltip={printOptionHelpText.vibrationCompensation} />
                    <Select<'off' | 'on'>
                      value={vibrationCompensation ? 'on' : 'off'}
                      onChange={(_event, value) => value && updateVibrationCompensation(value === 'on')}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                    </Select>
                  </FormControl>
                )}
                {visiblePrintOptionCapabilities.flowCalibration && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Flow Dynamics Calibration" tooltip={printOptionHelpText.flowCalibration} />
                    <Select<PrintOnOffAutoMode>
                      value={flowCalibration}
                      onChange={(_event, value) => value && updateFlowCalibration(value)}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      {visiblePrintOptionCapabilities.flowCalibrationAuto && <Option value="auto">Auto</Option>}
                    </Select>
                  </FormControl>
                )}
                {visiblePrintOptionCapabilities.nozzleOffsetCalibration && (
                  <FormControl sx={printOptionFieldSx}>
                    <PrintOptionLabel label="Nozzle Offset Calibration" tooltip={printOptionHelpText.nozzleOffsetCalibration} />
                    <Select<PrintNozzleOffsetCalibrationMode>
                      value={nozzleOffsetCalibration}
                      onChange={(_event, value) => value && updateNozzleOffsetCalibration(value)}
                      size="sm"
                      sx={printOptionSelectSx}
                    >
                      <Option value="off">Off</Option>
                      <Option value="on">On</Option>
                      <Option value="auto">Auto</Option>
                    </Select>
                  </FormControl>
                )}
              </Box>
            )}
          </Sheet>

          {(hasHardNozzleDiameterIssues || hasPlateTypeIssues) && (
            <Alert
              color={hasHardNozzleDiameterIssues ? 'danger' : 'warning'}
              variant="soft"
              startDecorator={hasHardNozzleDiameterIssues ? <ErrorOutlineRoundedIcon /> : <WarningAmberRoundedIcon />}
            >
              <Stack spacing={1} sx={{ width: '100%' }}>
                <Typography level="title-sm">
                  {hasHardNozzleDiameterIssues ? 'Printer hardware must be fixed' : 'Plate type mismatch detected'}
                </Typography>
                <Typography level="body-sm">
                  {hasHardNozzleDiameterIssues
                    ? 'The sliced nozzle diameter does not match the nozzle size saved in printer settings. Update the printer on the Printers page before dispatching.'
                    : 'The saved printer plate type does not match the sliced plate type. Review and confirm before dispatching.'}
                </Typography>
                {nozzleDiameterIssueEntries.map(([printerId, issues]) => {
                  const printer = printers.find((entry) => entry.id === printerId)
                  const printerName = printer?.name ?? printerId
                  const nozzleCount = printer ? resolvePrinterNozzleCount(printer, statuses[printerId]) : null
                  return (
                    <Stack key={`nozzle-${printerId}`} spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">{printerName}</Typography>
                      {issues.map((issue) => (
                        <Typography key={`nozzle-${printerId}-${issue.extruderId}`} level="body-xs">
                          {formatNozzleDiameterIssue(issue, nozzleCount)}
                        </Typography>
                      ))}
                    </Stack>
                  )
                })}
                {plateTypeIssueEntries.map(([printerId, issue]) => {
                  const printerName = printers.find((printer) => printer.id === printerId)?.name ?? printerId
                  return issue ? (
                    <Stack key={`plate-${printerId}`} spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">{printerName}</Typography>
                      <Typography level="body-xs">{formatPlateTypeIssue(issue)}</Typography>
                    </Stack>
                  ) : null
                })}
                {hasPlateTypeIssues && (
                  <Checkbox
                    label="Print anyway with the current plate type"
                    checked={allowPlateTypeMismatch}
                    onChange={(event) => setAllowPlateTypeMismatch(event.target.checked)}
                  />
                )}
              </Stack>
            </Alert>
          )}

          {(hasHardCompatibilityIssues || hasSoftCompatibilityIssues) && (
            <Alert
              color={hasHardCompatibilityIssues ? 'danger' : 'warning'}
              variant="soft"
              startDecorator={hasHardCompatibilityIssues ? <ErrorOutlineRoundedIcon /> : <WarningAmberRoundedIcon />}
            >
              <Stack spacing={1} sx={{ width: '100%' }}>
                <Typography level="title-sm">
                  {hasHardCompatibilityIssues ? 'Tray assignment must be fixed' : 'Filament mismatch detected'}
                </Typography>
                <Typography level="body-sm">
                  {hasHardCompatibilityIssues
                    ? 'One or more selected trays are bound to the wrong nozzle for this sliced file. Pick a tray on the matching nozzle before dispatching.'
                    : 'One or more selected trays do not match the sliced material. Review the warnings below before dispatching.'}
                </Typography>
                {hardCompatibilityIssueEntries.map(([printerId, issues]) => {
                  const printer = printers.find((entry) => entry.id === printerId)
                  const printerName = printer?.name ?? printerId
                  const nozzleCount = printer ? resolvePrinterNozzleCount(printer, statuses[printerId]) : null
                  return (
                    <Stack key={printerId} spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">{printerName}</Typography>
                      {issues.map((issue) => (
                        <Typography key={`${printerId}-${issue.filamentId}`} level="body-xs">
                          {formatCompatibilityIssue(issue, nozzleCount)}
                        </Typography>
                      ))}
                    </Stack>
                  )
                })}
                {softCompatibilityIssueEntries.map(([printerId, issues]) => {
                  const printer = printers.find((entry) => entry.id === printerId)
                  const printerName = printer?.name ?? printerId
                  const nozzleCount = printer ? resolvePrinterNozzleCount(printer, statuses[printerId]) : null
                  return (
                    <Stack key={`soft-${printerId}`} spacing={0.25}>
                      <Typography level="body-sm" fontWeight="lg">{printerName}</Typography>
                      {issues.map((issue) => (
                        <Typography key={`soft-${printerId}-${issue.filamentId}`} level="body-xs">
                          {formatCompatibilityIssue(issue, nozzleCount)}
                        </Typography>
                      ))}
                    </Stack>
                  )
                })}
                {hasSoftCompatibilityIssues && (
                  <Checkbox
                    label="Print anyway with the current tray assignments"
                    checked={allowIncompatibleFilament}
                    onChange={(event) => setAllowIncompatibleFilament(event.target.checked)}
                  />
                )}
              </Stack>
            </Alert>
          )}
        </Stack>
        </ScrollableDialogBody>
        <DialogActions sx={{ pt: 1, justifyContent: 'space-between' }}>
          {onBack ? (
            <Button
              variant="plain"
              color="neutral"
              startDecorator={<ArrowBackRoundedIcon />}
              onClick={onBack}
              disabled={submitting}
            >
              Back
            </Button>
          ) : (
            <Box />
          )}
          <Stack direction="row" spacing={1}>
            <Button variant="plain" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button
              loading={submitting}
              disabled={
                selectedIds.length === 0
                || !allMappingsComplete
                || hasHardCompatibilityIssues
                || hasHardNozzleDiameterIssues
                || (hasPlateTypeIssues && !allowPlateTypeMismatch)
                || (hasSoftCompatibilityIssues && !allowIncompatibleFilament)
              }
              onClick={submit}
            >
              Print on {selectedIds.length} printer{selectedIds.length === 1 ? '' : 's'}
            </Button>
          </Stack>
        </DialogActions>
        </ScrollableModalDialog>
      </Modal>
      <PluginSlot
        name="library.overlays"
        context={{ previewFileId, previewPlateIndex: plateIndex, onPreviewClose: () => setPreviewFileId(null) }}
      />
    </>
  )
}

/**
 * Per-printer tray mapping editor. For each project filament, the user
 * picks which printer tray should feed it. Filaments not
 * actually used by the selected plate are dimmed but still configurable
 * (so the user can pre-set values when later switching plates).
 *
 * Every used filament must have an explicit tray before the print can
 * be dispatched — there is no “auto” fallback because the printer
 * doesn’t actually pick slots itself.
 */
function PrinterMapping({
  printer,
  status,
  filaments,
  usedGramsById,
  mapping,
  issues,
  onChange
}: {
  printer: Printer
  status: PrinterStatus | undefined
  /** Already narrowed to the filaments to map (see {@link visibleMappingFilaments}). */
  filaments: ThreeMfProjectFilament[]
  usedGramsById: Map<number, number>
  mapping: number[]
  issues: FilamentCompatibilityIssue[]
  onChange: (filamentId: number, tray: number) => void
}) {
  const trayGroups = useMemo(() => buildPrinterTrayGroups(status), [status])
  const printerTrays = useMemo(() => trayGroups.flatMap((group) => group.trays), [trayGroups])
  const nozzleCount = resolvePrinterNozzleCount(printer, status)
  // Spool-setup dialog for unrecognized-but-occupied slots picked in the mapping.
  const [spoolSetupTarget, setSpoolSetupTarget] = useState<AmsSpoolSetupTarget | null>(null)
  const issueByFilamentId = useMemo(
    () => new Map(issues.map((issue) => [issue.filamentId, issue] as const)),
    [issues]
  )

  if (trayGroups.length === 0) {
    return (
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }}>
        {printer.name} has no reported printer trays yet — using printer default.
      </Typography>
    )
  }

  return (
    <Stack spacing={0.5} sx={{ mt: 1 }}>
      {filaments.map((filament) => {
        const allowedTrayGroups = filterTrayGroupsForFilament(trayGroups, filament.nozzleId ?? null)
        const slotIndex = filament.id - 1
        const value = mapping[slotIndex] ?? -1
        const selectedTray = printerTrays.find((tray) => tray.mappingValue === value)
        const selectedUnknownTray = selectedTray && trayHasUnknownSpool(selectedTray) ? selectedTray : null
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
        const allowedTrayByValue = new Map(
          allowedTrayGroups.flatMap((group) => group.trays.map((tray) => [tray.mappingValue, tray] as const))
        )
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
              <Select
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
                    <SlotOptionLabel
                      tray={tray}
                      trays={printerTrays}
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
                  // Joy's Select button centers its content by default;
                  // the rendered value here is a flex row that needs to
                  // hug the left edge so it visually matches the option
                  // rows in the dropdown.
                  button: {
                    onClick: stopEventPropagation,
                    onMouseDown: stopEventPropagation,
                    onPointerDown: stopEventPropagation,
                    onTouchStart: stopEventPropagation,
                    sx: { textAlign: 'left', justifyContent: 'flex-start', minHeight: 40 }
                  },
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
                {(() => {
                  const nodes: ReactNode[] = []
                  for (const group of allowedTrayGroups) {
                    if (allowedTrayGroups.length > 0) {
                      nodes.push(
                        <Typography
                          key={`header-${group.key}`}
                          level="body-xs"
                          textColor="text.tertiary"
                          sx={{ px: 1, pt: 0.5, pb: 0.25, fontWeight: 'lg', textTransform: 'uppercase', letterSpacing: '0.05em' }}
                        >
                          {group.label}
                        </Typography>
                      )
                    }
                    for (const tray of group.trays) {
                      nodes.push(
                        <Option key={tray.key} value={tray.mappingValue}>
                          <SlotOptionLabel
                            tray={tray}
                            trays={printerTrays}
                            nozzleCount={nozzleCount}
                            requiredFilamentType={filament.filamentType}
                            requiredNozzleId={filament.nozzleId ?? null}
                            requiredGrams={grams ?? null}
                            autoRefillEnabled={status?.amsSettings.autoRefill === true}
                          />
                        </Option>
                      )
                    }
                  }
                  return nodes
                })()}
              </Select>
            </Stack>
            {issue && (
              <Typography level="body-xs" color="warning" sx={{ pl: 'calc(14px + 8px)' }}>
                {formatCompatibilityIssue(issue, nozzleCount)}
              </Typography>
            )}
            {selectedUnknownTray && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ pl: 'calc(14px + 8px)' }}>
                <Typography level="body-xs" color="warning">
                  This slot holds an unrecognized spool.
                </Typography>
                <Button
                  size="sm"
                  variant="plain"
                  sx={{ minHeight: 0, py: 0 }}
                  onClick={() => setSpoolSetupTarget({
                    printerId: printer.id,
                    kind: selectedUnknownTray.kind,
                    amsId: selectedUnknownTray.kind === 'ams' ? selectedUnknownTray.amsUnitId ?? 0 : selectedUnknownTray.mappingValue,
                    ...(selectedUnknownTray.kind === 'ams' ? { slotId: selectedUnknownTray.amsSlotId ?? 0 } : {}),
                    label: `${selectedUnknownTray.groupLabel ?? 'Slot'} ${selectedUnknownTray.badgeLabel}`,
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

/** Color swatch + slot label + loaded filament type + remaining estimate, used in slot Selects. */
function SlotOptionLabel({
  tray,
  trays,
  nozzleCount,
  requiredFilamentType,
  requiredNozzleId,
  requiredGrams,
  autoRefillEnabled
}: {
  tray: PrinterTrayOption
  trays: readonly PrinterTrayOption[]
  nozzleCount?: number | null
  requiredFilamentType?: string | null
  requiredNozzleId?: number | null
  requiredGrams?: number | null
  autoRefillEnabled?: boolean
}) {
  const hasFilament = trayHasLoadedFilament(tray)
  const unknownSpool = trayHasUnknownSpool(tray)
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
  const remainGrams = remainingState.remainGrams
  // Only spools with a readable RFID/Bambu tag (trayUuid) report remaining; third-party
  // spools have no reliable figure, so we omit the estimate rather than show a guess.
  const remainingDetail =
    hasFilament && tray.trayUuid != null && tray.remainPercent != null && remainGrams != null
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
  const badgeBackground = filamentBackground(filament.colors, tray.color, 'var(--joy-palette-neutral-800)')
  const badgeForeground = filamentTextColor(filament.colors, tray.color, 'var(--joy-palette-text-primary)')
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
        <Typography level="body-xs" textColor={unknownSpool ? 'warning.300' : 'text.tertiary'} noWrap sx={{ minWidth: 0, gridColumn: '1 / 2' }}>
          {filamentDetail}
        </Typography>
        {incompatibilityLabel && (
          <IncompatibilityWarningGlyph label={incompatibilityLabel} />
        )}
        {remainingDetail && (
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{ gridColumn: '1 / 2', minWidth: 0 }}
          >
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
                <Box
                  component="span"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    color: 'primary.plainColor',
                    flexShrink: 0
                  }}
                >
                  <AutoRefillGlyph />
                </Box>
              </Tooltip>
            )}
          </Stack>
        )}
      </Box>
    </Stack>
  )
}

function IncompatibilityWarningGlyph({ label }: { label: string }) {
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
        <WarningGlyph />
      </Box>
    </Tooltip>
  )
}

function AutoRefillGlyph() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: 14, height: 14, display: 'block', fill: 'currentColor' }}
    >
      <path d="M12 5a7 7 0 0 1 6.42 4.22H16v2h6V5h-2v2.38A9 9 0 0 0 3 12h2a7 7 0 0 1 7-7zm7 6a7 7 0 0 1-13.42 2.78H8v-2H2v6h2v-2.38A9 9 0 0 0 21 12h-2a7 7 0 0 1-7 7z" />
    </Box>
  )
}

function WarningGlyph() {
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      aria-hidden
      sx={{ width: 16, height: 16, display: 'block', fill: 'currentColor' }}
    >
      <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </Box>
  )
}
