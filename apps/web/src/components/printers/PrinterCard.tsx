import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Card, CardContent, Chip, Divider, Stack, Typography } from '@mui/joy'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Printer3dRoundedIcon } from '../../components/Printer3dRoundedIcon'
import { getAmsLoadFilamentAvailability, getAmsRescanAvailability, getAmsUnloadFilamentAvailability, getPrinterCalibrationCapabilities, getPrinterDisplayCapabilities, getPrinterControlCapabilities, isPrinterActiveJobStage, isPrinterIdleCompatibleStage, type AmsSlot, type AmsUnit, type ExternalSpool, type PrintJob, type PrinterActivePrintObjects, type PrinterCardContentSettings, type Printer, type PrinterCommand, type PrinterStatus } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { buildApiUrl } from '../../lib/apiUrl'
import { usePluginCatalogQuery } from '../../lib/pluginCatalogQuery'
import { isActiveDispatchJob } from '../../lib/dispatchToastVisibility'
import { type LinkedDispatchJob } from '../../lib/trackedPrintJobs'
import { toast } from '../../lib/toast'
import { formatPrinterJobDisplayName } from '../../lib/printerJobName'
import { PrinterJobMediaStrip } from '../../components/PrinterJobMediaStrip'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { PrinterJobProgressBlock } from '../../components/PrinterJobProgressBlock'
import { PrinterCardStatusChips } from './PrinterCardStatusChips'
import { useFooterActionOverflow } from './useFooterActionOverflow'
import { PrinterCardFooterActions } from './PrinterCardFooterActions'
import { PrinterCardActionsMenu } from './PrinterCardActionsMenu'
import {
  dispatchProgressColor,
  dispatchProgressFill,
  dispatchProgressTrack,
  progressBarColor,
  progressBarFill,
  progressBarTrack,
  secondaryStageTextColor
} from '../../components/printerJobProgressTone'
import { OverflowTooltipText } from '../../components/OverflowTooltipText'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import {
  formatSecondaryStageLabel,
  getPrinterAttentionSummary
} from '../../lib/printerProgressSummary'
import { useBufferedCoverImage } from '../../hooks/useBufferedCoverImage'
import { useControlledMenuClickAway } from '../../hooks/useControlledMenuClickAway'
import { PrinterStorageDialogs } from './PrinterStorageDialogs'
import { PluginSlot } from '../../plugin/PluginSlot'
import { webPluginRegistry } from '../../plugin/registry'
import { isPluginActiveByName } from '../../lib/pluginSettings'
import { usePlateClearingState } from '../../lib/plateClearing'
import { computeFilamentRecoverySources } from '../../lib/printerFilamentRecovery'
import { printerHistoryResultColor, dispatchStatusColor, dispatchStatusLabel, formatDispatchProgress, formatPrinterCardNozzleSizes, resolveFilamentChangeTargetTemp, formatPrinterAttentionSummaryText, formatRemaining, formatFinishedAgo, formatLayerSummary, formatEstimatedCompletionTime, formatWifiSignal, isActiveLightMode, lightModeForControl, isPrinterControlCommand, printerControlSuccessMessage, shouldPreferTrackedActiveJobName, printerCardAmsGridColumns, parseStoredBoolean, printerNozzles } from '../../lib/printersViewHelpers'
import { DISPATCHED_START_WARNING_TIMEOUT_MS, PRINTER_SETTINGS_LABELS } from '../../lib/printerViewConstants'
import {
  type PrinterControlsDialogTab
} from '../../lib/printerViewTypes'
import { SkipObjectsModal } from './PrinterCardDialogs'
import { PrinterControlDialogs } from './PrinterControlDialogs'
import { PrinterAttentionDialogs } from './PrinterAttentionDialogs'
import { PrinterCardAmsGrid } from './PrinterCardAmsGrid'
import { PrinterCardMetrics } from './PrinterCardMetrics'
import { PrinterCardAttentionSummary } from './PrinterCardAttentionSummary'
import { usePrinterCardFooterActions } from './usePrinterCardFooterActions'
import { usePrinterRecoveryActions } from './usePrinterRecoveryActions'
import { useLayerSummaryFit } from './useLayerSummaryFit'
import { PrinterCardIdentity } from './PrinterCardIdentity'
import { PrinterAmsDialogs } from './PrinterAmsDialogs'

/**
 * PrinterCard: the per-printer status/control hub rendered on the
 * printers dashboard. Shows live status, temps, job progress, AMS/spool
 * state, and launches the printer's settings, controls, calibration,
 * recovery, and AMS dialogs.
 *
 * Wrapped in `memo` (exported below): the printers dashboard re-renders on
 * every WS status tick from any printer, but a card should only re-render when
 * its own props change. The parent passes a per-printer `status` reference
 * (stable for printers that did not tick) and stable callbacks, so memoization
 * keeps the whole grid from re-rendering on every tick. The action callbacks
 * therefore take the `printer` as an argument rather than closing over it,
 * letting the parent supply one stable `useCallback` per action.
 */

function PrinterCardComponent({
  printer,
  status,
  dispatchLink,
  activeJob,
  latestJob,
  contentSettings,
  compact,
  cardsPerRow,
  demoMode,
  canControlPrinter,
  canManagePrinter,
  canViewPrinterStorage,
  canDownloadPrinterStorage,
  canDispatchPrints,
  canViewCamera,
  onEdit,
  onPrint,
  onPrintLocal,
  onOpenDetails
}: {
  printer: Printer
  status: PrinterStatus | undefined
  dispatchLink: LinkedDispatchJob | undefined
  activeJob: PrintJob | undefined
  latestJob: PrintJob | undefined
  contentSettings: PrinterCardContentSettings
  /** Hide target temps to save space on compact cards. */
  compact?: boolean
  /** How many printer cards are shown per row. */
  cardsPerRow: number
  demoMode: boolean
  canControlPrinter: boolean
  canManagePrinter: boolean
  canViewPrinterStorage: boolean
  canDownloadPrinterStorage: boolean
  canDispatchPrints: boolean
  canViewCamera: boolean
  onEdit: (printer: Printer) => void
  onPrint: (printer: Printer) => void
  /** Open the “Print from local file” flow (uploads as hidden, then dispatches). */
  onPrintLocal: (printer: Printer) => void
  onOpenDetails?: (printer: Printer) => void
}) {
  const { confirm } = usePromptDialog()
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [storageDialogOpen, setStorageDialogOpen] = useState(false)
  // Two specialized variants of the storage browser. Models opens at the
  // root and filters to printable slices; Timelapses opens at /timelapse
  // and limits to .mp4 files (read-only — no print action).
  const [modelsDialogOpen, setModelsDialogOpen] = useState(false)
  const [timelapsesDialogOpen, setTimelapsesDialogOpen] = useState(false)
  const [amsSettingsDialogOpen, setAmsSettingsDialogOpen] = useState(false)
  const [printerSettingsDialogOpen, setPrinterSettingsDialogOpen] = useState(false)
  const [amsDryingUnitId, setAmsDryingUnitId] = useState<number | null>(null)
  const [assistantDialogOpen, setAssistantDialogOpen] = useState(false)
  const [filamentRecoveryDialogOpen, setFilamentRecoveryDialogOpen] = useState(false)
  const [cameraDialogOpenRequestedAt, setCameraDialogOpenRequestedAt] = useState<number | null>(null)
  const activeTrackedJobName = activeJob?.jobName ?? null
  // A calibration routine has no model or printable objects, so suppress the
  // model preview (cover) and the skip-object action while one is the active job.
  const isCalibrationJob = activeJob?.jobKind === 'calibration'
  const historyJobName = latestJob?.jobName ?? null
  const latestJobProgressPercent = latestJob?.progressPercent ?? status?.progressPercent ?? (latestJob?.result === 'success' ? 100 : null)
  // Elapsed-since-finish label for the history footer, using the same compact duration
  // format as the live "X left" remaining time. Computed every render so it refreshes as
  // the card re-renders on incoming status events.
  const latestJobFinishedAgo = latestJob?.result === 'success' ? formatFinishedAgo(latestJob.finishedAt) : null
  const displayJobName = status?.jobName ?? historyJobName
  const displayGcodeFile = status?.gcodeFile ?? null
  const activeDisplayJobName = formatPrinterJobDisplayName({
    jobName: status?.jobName ?? null,
    gcodeFile: status?.gcodeFile ?? null
  })
  const activeTrackedDisplayJobName = formatPrinterJobDisplayName({
    jobName: activeTrackedJobName,
    plate: activeJob?.plate ?? null
  })
  const preferredActiveDisplayJobName = shouldPreferTrackedActiveJobName(status?.jobName ?? null, activeTrackedJobName)
    ? activeTrackedDisplayJobName || activeDisplayJobName
    : activeDisplayJobName
  const historyDisplayJobName = formatPrinterJobDisplayName({
    jobName: historyJobName,
    plate: latestJob?.plate ?? null
  })
  const displayJobLabel = preferredActiveDisplayJobName || historyDisplayJobName || displayJobName || ''
  const activeCoverPlateQuery = activeJob?.plate ? `&plate=${encodeURIComponent(String(activeJob.plate))}` : ''
  const activeCoverTaskQuery = status?.taskId ? `&task=${encodeURIComponent(status.taskId)}` : ''
  const activeCoverRequestUrl = status?.jobName && isPrinterActiveJobStage(status?.stage)
    ? buildApiUrl(`/api/printers/${printer.id}/cover?job=${encodeURIComponent(status.jobName)}&gcode=${encodeURIComponent(displayGcodeFile ?? '')}${activeCoverPlateQuery}${activeCoverTaskQuery}`)
    : null
  const historyCoverRequestUrl = latestJob && (latestJob.thumbnailPath || latestJob.fileId)
    ? buildApiUrl(`/api/jobs/${latestJob.id}/thumbnail`)
    : null
  const coverRequestUrl = isCalibrationJob ? null : (activeCoverRequestUrl ?? historyCoverRequestUrl)
  const { coverUrl, coverLoaded, coverFailed } = useBufferedCoverImage({
    coverRequestUrl,
    enabled: Boolean(contentSettings.modelThumbnail && coverRequestUrl),
    mode: 'blob'
  })
  const [coverLoadStatus, setCoverLoadStatus] = useState<'idle' | 'resolving' | 'downloading' | 'extracting'>('idle')
  const [coverProgress, setCoverProgress] = useState<number | null>(null)
  const [editingSlot, setEditingSlot] = useState<{ unit: AmsUnit; slot: AmsSlot } | null>(null)
  const [editingExternalSpool, setEditingExternalSpool] = useState<ExternalSpool | null>(null)
  const [externalSpoolsExpanded, setExternalSpoolsExpanded] = useLocalStorageState<boolean>(
    `bambu.printers.externalSpoolsExpanded.${printer.id}`,
    false,
    parseStoredBoolean,
    String
  )
  const [printMenuOpen, setPrintMenuOpen] = useState(false)
  const [calibrationDialogOpen, setCalibrationDialogOpen] = useState(false)
  const [controlsDialogOpen, setControlsDialogOpen] = useState(false)
  const [controlsDialogInitialTab, setControlsDialogInitialTab] = useState<PrinterControlsDialogTab>('printer')
  const [skipObjectDialogOpen, setSkipObjectDialogOpen] = useState(false)
  const queryClient = useQueryClient()
  const printAnchorRef = useRef<HTMLDivElement>(null)
  useControlledMenuClickAway(printMenuOpen, `print-menu-${printer.id}`, () => setPrintMenuOpen(false), [printAnchorRef])
  const dispatchJob = dispatchLink?.dispatchJob
  const dispatchPrintJob = dispatchLink?.printJob
  const [pendingStartWarning, setPendingStartWarning] = useState(false)
  const sendCommand = useMutation({
    mutationFn: (command: PrinterCommand) =>
      apiFetch(`/api/printers/${printer.id}/command`, { method: 'POST', body: command }),
    onSuccess: (_data, command) => {
      if (command.type === 'calibrate') {
        setCalibrationDialogOpen(false)
        toast.success('Calibration started')
      } else if (command.type === 'rescanAmsSlot') {
        toast.success('Rescan requested')
      } else if (command.type === 'resetAmsSlot') {
        toast.success('Slot reset')
      } else if (command.type === 'loadAmsFilament') {
        toast.success('Filament load requested')
      } else if (command.type === 'unloadAmsFilament') {
        toast.success('Filament unload requested')
      } else if (command.type === 'setPrintOption') {
        toast.success(`${PRINTER_SETTINGS_LABELS[command.option]} updated`)
      } else if (command.type === 'setAmsUserSettings') {
        toast.success('AMS settings updated')
      } else if (command.type === 'setAmsFilamentBackup') {
        toast.success(command.enabled ? 'AMS filament backup enabled' : 'AMS filament backup disabled')
      } else if (command.type === 'startAmsDrying') {
        setAmsDryingUnitId(null)
        toast.success('AMS drying started')
      } else if (command.type === 'stopAmsDrying') {
        setAmsDryingUnitId(null)
        toast.success('AMS drying stop requested')
      } else if (command.type === 'skipObjects') {
        setSkipObjectDialogOpen(false)
        toast.success(command.objectIds.length === 1 ? 'Object skip requested' : 'Object skips requested')
      } else if (isPrinterControlCommand(command)) {
        toast.success(printerControlSuccessMessage(command))
      }
    },
    onError: (error, command) => {
      if (
        command.type === 'calibrate' ||
        command.type === 'rescanAmsSlot' ||
        command.type === 'resetAmsSlot' ||
        command.type === 'loadAmsFilament' ||
        command.type === 'unloadAmsFilament' ||
        command.type === 'setPrintOption' ||
        command.type === 'setAmsUserSettings' ||
        command.type === 'setAmsFilamentBackup' ||
        command.type === 'startAmsDrying' ||
        command.type === 'stopAmsDrying' ||
        command.type === 'skipObjects' ||
        isPrinterControlCommand(command)
      ) {
        toast.error((error as Error).message)
      }
    }
  })

  const displayCapabilities = getPrinterDisplayCapabilities(printer.model)
  const cameraSupported = displayCapabilities.camera
  const coverVisible = contentSettings.modelThumbnail
  const stage = status?.stage
  const isOnline = status?.online ?? false
  const isIdleLikeStage = isPrinterIdleCompatibleStage(stage)
  const isActivePrintStage = isPrinterActiveJobStage(stage)
  const showJobSummary = isOnline && isActivePrintStage && (status?.jobName || status?.progressPercent != null)
  const showDispatchSummary = dispatchJob != null && isActiveDispatchJob(dispatchJob)
  const showPendingDispatchSummary = !showJobSummary
    && !showDispatchSummary
    && isOnline
    && isIdleLikeStage
    && activeJob != null
  const printerAttentionSummary = getPrinterAttentionSummary(status, {
    includeHmsErrors: contentSettings.hmsErrors
  })
  const terminalJobSummaryVisible = isOnline
    && !showJobSummary
    && !showDispatchSummary
    && !showPendingDispatchSummary
    && stage === 'failed'
    && Boolean(status?.jobName || status?.taskId || status?.progressPercent != null)
  const showHistoryJobSummary = isOnline
    && !showJobSummary
    && !showDispatchSummary
    && !showPendingDispatchSummary
    && !terminalJobSummaryVisible
    && Boolean(latestJob)
  const deferCameraSnapshotsForCover = Boolean(
    coverVisible
    && coverRequestUrl
    && !coverLoaded
    && !coverFailed
    && status?.jobName
    && status.stage
    && status.stage !== 'paused'
    && isPrinterActiveJobStage(status.stage)
  )
  const freezeCameraThumbnail = demoMode && (stage === 'idle' || stage === 'finished')
  // Reset the cover-image fallback whenever the active job changes so a
  // newly started print gets a fresh fetch attempt.
  useEffect(() => {
    setCoverLoadStatus(coverVisible && coverRequestUrl && showJobSummary ? 'resolving' : 'idle')
    setCoverProgress(null)
  }, [coverRequestUrl, coverVisible, showJobSummary])
  const calibrationCapabilities = getPrinterCalibrationCapabilities(printer.model)
  const controlCapabilities = getPrinterControlCapabilities(printer.model)
  const chamberTemperature = status?.chamberTemp ?? null
  const chamberTarget = status?.chamberTarget ?? null
  const showChamberTemperature = chamberTemperature != null
    && displayCapabilities.chamberTemperature
  const nozzleSizeLabel = formatPrinterCardNozzleSizes(status, printer.currentNozzleDiameters)
  const secondaryStageLabel = formatSecondaryStageLabel(status)
  const printerAttentionSummaryText = printerAttentionSummary
    ? formatPrinterAttentionSummaryText(printerAttentionSummary)
    : null
  const cameraVisible = canViewCamera
    && isOnline
    && cameraSupported
    && (contentSettings.cameraThumbnail || contentSettings.fullWidthSnapshot)
  const showWideCamera = Boolean(
    canViewCamera
    && isOnline
    && cameraSupported
    && contentSettings.fullWidthSnapshot
  )
  const openFilamentRecovery = useCallback(() => setFilamentRecoveryDialogOpen(true), [])
  const openAssistant = useCallback(() => setAssistantDialogOpen(true), [])
  const {
    pauseAvailability,
    resumeAvailability,
    loadFilamentAvailability,
    ignoreHmsErrorAvailability,
    checkAssistantAvailability,
    jumpToLiveViewAvailability,
    retryAmsFilamentChangeAvailability,
    confirmAmsFilamentExtrudedAvailability,
    stopAvailability,
    showPauseAction,
    showResumeAction,
    showLoadFilamentAction,
    showIgnoreHmsContinueAction,
    showCheckAssistantAction,
    canOpenAssistantLiveView,
    showRetryAmsFilamentChangeAction,
    showConfirmAmsFilamentExtrudedAction,
    showStopAction,
    requestStopPrint,
    requestResumePrint,
    requestIgnoreHmsError,
    requestLoadFilament,
    requestCheckAssistant,
    requestRetryAmsFilamentChange,
    requestConfirmAmsFilamentExtruded
  } = usePrinterRecoveryActions({
    status,
    printerName: printer.name,
    canManagePrinter,
    canViewCamera,
    cameraSupported,
    sendCommand,
    confirm,
    onOpenFilamentRecovery: openFilamentRecovery,
    onOpenAssistant: openAssistant
  })
  const pausedOnDeviceError = stage === 'paused' && status?.deviceError != null
  const canSkipObjects = isOnline && (stage === 'printing' || stage === 'paused') && !pausedOnDeviceError && !isCalibrationJob
  const activePrintObjectsQuery = useQuery({
    queryKey: ['printer-active-print-objects', printer.id, status?.jobName, status?.gcodeFile, status?.taskId],
    queryFn: ({ signal }) => apiFetch<PrinterActivePrintObjects>(`/api/printers/${printer.id}/active-print-objects`, { signal }),
    enabled: skipObjectDialogOpen && canSkipObjects,
    staleTime: 30_000,
    refetchInterval: (query) => query.state.data?.loading ? 2_000 : false
  })
  const activePrintObjects = activePrintObjectsQuery.data?.objects ?? []
  const activePrintObjectsLoading = activePrintObjectsQuery.data?.loading ?? activePrintObjectsQuery.isLoading
  const activePrintObjectsUnavailableReason = activePrintObjectsQuery.data?.unavailableReason ?? null
  const activePrintObjectsUnavailableMessage = activePrintObjectsQuery.data?.unavailableMessage ?? null
  const { cleared: plateCleared } = usePlateClearingState(printer.id)
  // Keep the Print affordance visible for online idle-like printers,
  // even when plate clearing is blocking the next job, so the footer
  // does not disappear entirely on affected printers.
  const canShowPrintAction = canDispatchPrints && isOnline && isIdleLikeStage
  const dispatchInProgress = dispatchJob != null && isActiveDispatchJob(dispatchJob)
  const printDisabledReason = plateCleared
    ? (dispatchInProgress ? 'A print is already being dispatched to this printer. Wait for that transfer to finish or cancel it first.' : null)
    : 'Plate has not been confirmed cleared. Confirm in PrintStream before printing again.'
  const canPrint = canShowPrintAction && plateCleared && !dispatchInProgress
  // Show Calibrate whenever the printer model supports it; keep it visible but disabled while the
  // printer is offline or busy (mid-print) rather than hiding the item, so its availability reads
  // as a temporary state. `canCalibrate` is the enable gate: online, idle, and plate confirmed clear.
  const canShowCalibrate = Object.values(calibrationCapabilities).some(Boolean)
  const canCalibrate = canShowCalibrate && isOnline && isIdleLikeStage && plateCleared
  const canOpenControls = canControlPrinter && isOnline
  const canPrintFromPrinter = canPrint
  const openControlsDialog = useCallback((tab: PrinterControlsDialogTab = 'printer') => {
    setControlsDialogInitialTab(tab)
    setControlsDialogOpen(true)
  }, [])

  useEffect(() => {
    if (!showPendingDispatchSummary || !activeJob) {
      setPendingStartWarning(false)
      return undefined
    }

    const warningAt = Date.parse(activeJob.startedAt) + DISPATCHED_START_WARNING_TIMEOUT_MS
    const remainingMs = warningAt - Date.now()
    if (remainingMs <= 0) {
      setPendingStartWarning(true)
      return undefined
    }

    setPendingStartWarning(false)
    const timer = window.setTimeout(() => {
      setPendingStartWarning(true)
    }, remainingMs)

    return () => window.clearTimeout(timer)
  }, [activeJob, showPendingDispatchSummary])

  useEffect(() => {
    if (!coverVisible || !coverRequestUrl || !showJobSummary || coverLoaded || coverFailed) {
      if (!showJobSummary || coverLoaded || coverFailed) {
        setCoverLoadStatus('idle')
        setCoverProgress(null)
      }
      return undefined
    }

    let cancelled = false
    let pollTimer: number | null = null
    const controller = new AbortController()

    const stopPolling = () => {
      if (pollTimer != null) {
        window.clearTimeout(pollTimer)
        pollTimer = null
      }
    }

    const pollProgress = async () => {
      try {
        const response = await apiFetch<{ status: 'idle' | 'resolving' | 'downloading' | 'extracting'; progressPercent: number | null }>(
          `/api/printers/${printer.id}/cover/status`,
          { signal: controller.signal }
        )
        if (cancelled) return
        setCoverLoadStatus(response.status)
        if (response.status === 'downloading' && typeof response.progressPercent === 'number') {
          setCoverProgress(Math.max(0, Math.min(100, response.progressPercent)))
        } else {
          setCoverProgress(null)
        }
      } catch {
        // Ignore polling failures; the cover fetch itself is authoritative.
      }
      if (!cancelled) {
        pollTimer = window.setTimeout(pollProgress, 250)
      }
    }

    void pollProgress()

    return () => {
      cancelled = true
      controller.abort()
      stopPolling()
    }
  }, [coverFailed, coverLoaded, coverRequestUrl, coverVisible, printer.id, showJobSummary])

  useEffect(() => {
    if (!canSkipObjects && skipObjectDialogOpen) {
      setSkipObjectDialogOpen(false)
    }
  }, [canSkipObjects, skipObjectDialogOpen])

  const showDeterminateCoverProgress = !coverFailed && !coverLoaded && coverLoadStatus === 'downloading' && coverProgress != null
  const showIndeterminateCoverProgress = !coverFailed && !coverLoaded && !showDeterminateCoverProgress

  const amsUnits = useMemo(() => status?.ams ?? [], [status?.ams])
  const externalSpools = useMemo(() => status?.externalSpools ?? [], [status?.externalSpools])
  const currentEditingUnit = editingSlot
    ? amsUnits.find((unit) => unit.unitId === editingSlot.unit.unitId) ?? editingSlot.unit
    : null
  const currentEditingSlot = editingSlot && currentEditingUnit
    ? currentEditingUnit.slots.find((slot) => slot.slot === editingSlot.slot.slot) ?? editingSlot.slot
    : null
  const currentEditingExternalSpool = editingExternalSpool
    ? externalSpools.find((spool) => spool.amsId === editingExternalSpool.amsId) ?? editingExternalSpool
    : null
  const currentDryingUnit = amsDryingUnitId != null
    ? amsUnits.find((unit) => unit.unitId === amsDryingUnitId) ?? null
    : null
  const defaultExternalSpoolTemp = resolveFilamentChangeTargetTemp(currentEditingExternalSpool) ?? 220
  const filamentRecoverySources = useMemo(
    () => computeFilamentRecoverySources(status, amsUnits, externalSpools),
    [amsUnits, externalSpools, status]
  )
  const amsGridColumns = printerCardAmsGridColumns(cardsPerRow)
  const hasAmsUnits = amsUnits.length > 0
  const hasExternalSpools = externalSpools.length > 0
  const canOpenAmsSettings = canManagePrinter && hasAmsUnits && isOnline
  const canToggleExternalSpools = contentSettings.amsCards && hasAmsUnits && hasExternalSpools
  const showExternalSpools = !hasAmsUnits || externalSpoolsExpanded
  const editAmsSlot = canManagePrinter
    ? (unit: AmsUnit, slot: AmsSlot) => setEditingSlot({ unit, slot })
    : undefined
  const rescanAmsSlot = canManagePrinter
    ? (unit: AmsUnit, slot: AmsSlot) => sendCommand.mutate({
      type: 'rescanAmsSlot',
      amsId: unit.unitId,
      slotId: slot.slot
    })
    : undefined
  const resetAmsSlot = canManagePrinter
    ? (unit: AmsUnit, slot: AmsSlot) => sendCommand.mutate({
      type: 'resetAmsSlot',
      amsId: unit.unitId,
      slotId: slot.slot
    })
    : undefined
  // Slot context-menu load/unload mirror the slot edit modal's filament actions: same
  // commands, same default heater target from the slot's configured filament profile.
  const loadAmsSlotFilament = canManagePrinter
    ? (unit: AmsUnit, slot: AmsSlot) => sendCommand.mutate({
      type: 'loadAmsFilament',
      amsId: unit.unitId,
      slotId: slot.slot,
      extruderId: unit.nozzleId ?? undefined,
      nozzleTemp: resolveFilamentChangeTargetTemp(slot) ?? 220
    })
    : undefined
  const unloadAmsSlotFilament = canManagePrinter
    ? (unit: AmsUnit, slot: AmsSlot) => sendCommand.mutate({
      type: 'unloadAmsFilament',
      amsId: unit.unitId,
      slotId: slot.slot,
      extruderId: unit.nozzleId ?? undefined,
      nozzleTemp: resolveFilamentChangeTargetTemp(slot) ?? 220
    })
    : undefined
  const nozzleReadouts = printerNozzles(status)
  const showCoverTile = Boolean((showJobSummary || terminalJobSummaryVisible || showHistoryJobSummary) && coverRequestUrl && coverVisible)
  const showCameraTile = Boolean(cameraVisible && contentSettings.cameraThumbnail)
  const cameraSurfaceVisible = canViewCamera
    && isOnline
    && cameraSupported
    && (contentSettings.cameraThumbnail || contentSettings.fullWidthSnapshot || canOpenAssistantLiveView)
  const cameraLightControls = status ? [
    {
      key: 'chamber',
      label: 'Chamber',
      on: isActiveLightMode(lightModeForControl(status, 'chamber')),
      onToggle: () => {
        const lightOn = isActiveLightMode(lightModeForControl(status, 'chamber'))
        sendCommand.mutate({ type: 'light', node: 'chamber', on: !lightOn })
      }
    }
  ] : []
  const showPrintStatusBlock = Boolean(contentSettings.printStatus && (showJobSummary || showDispatchSummary || showPendingDispatchSummary || terminalJobSummaryVisible || showHistoryJobSummary || cameraVisible))
  const showMediaStrip = showCoverTile || showWideCamera || showCameraTile || showPrintStatusBlock || cameraDialogOpenRequestedAt != null
  const printerIpAddress = status?.ipAddress ?? printer.host
  const wifiSignalLabel = formatWifiSignal(status?.wifiSignalDbm)
  const clearActivePrinterError = canControlPrinter
    ? () => sendCommand.mutate({ type: 'clearHmsErrors' })
    : undefined
  const {
    layerSummaryRowRef,
    layerSummaryTextRef,
    setRemainingSummaryWidth,
    setEtaSummaryWidth,
    showCenteredLayerSummary
  } = useLayerSummaryFit(cardsPerRow, status)
  const showHistoryResultChip = latestJob != null
    && latestJob.result !== 'success'
    && latestJob.result !== 'unknown'
  const showDoorStateChip = Boolean(
    displayCapabilities.doorState
    && contentSettings.doorState
    && status?.doorOpen != null
  )
  const showDuctStateChip = Boolean(
    displayCapabilities.airductMode
    && contentSettings.ductState
    && status?.ductMode
  )
  const pluginStateQuery = usePluginCatalogQuery({ suppressGlobalErrorToast: true })
  const apiPluginsByName = useMemo(
    () => new Map((pluginStateQuery.data?.plugins ?? []).map((plugin) => [plugin.name, plugin] as const)),
    [pluginStateQuery.data?.plugins]
  )
  const footerPluginSlots = useMemo(
    () => webPluginRegistry
      .slots('printer.card.actions')
      .filter((slot) => slot.runtimeSurfaces.includes('tenant'))
      .filter((slot) => isPluginActiveByName(slot.pluginName, apiPluginsByName, pluginStateQuery.data?.plugins != null)),
    [apiPluginsByName, pluginStateQuery.data?.plugins]
  )
  const runCommand = useCallback((command: PrinterCommand) => sendCommand.mutate(command), [sendCommand])
  const openSkipObjectsDialog = useCallback(() => setSkipObjectDialogOpen(true), [])
  const footerActions = usePrinterCardFooterActions({
    footerPluginSlots,
    printerId: printer.id,
    printerName: printer.name,
    canControlPrinter,
    canSkipObjects,
    submitting: sendCommand.isPending,
    onCommand: runCommand,
    onSkipObjects: openSkipObjectsDialog,
    showPauseAction,
    showResumeAction,
    showLoadFilamentAction,
    showRetryAmsFilamentChangeAction,
    showIgnoreHmsContinueAction,
    showCheckAssistantAction,
    showConfirmAmsFilamentExtrudedAction,
    showStopAction,
    pauseAvailability,
    resumeAvailability,
    loadFilamentAvailability,
    retryAmsFilamentChangeAvailability,
    ignoreHmsErrorAvailability,
    checkAssistantAvailability,
    confirmAmsFilamentExtrudedAvailability,
    stopAvailability,
    onResume: requestResumePrint,
    onLoadFilament: requestLoadFilament,
    onRetryAmsFilamentChange: requestRetryAmsFilamentChange,
    onIgnoreHmsError: requestIgnoreHmsError,
    onCheckAssistant: requestCheckAssistant,
    onConfirmAmsFilamentExtruded: requestConfirmAmsFilamentExtruded,
    onStop: requestStopPrint
  })

  const {
    footerActionRowRef,
    footerActionMeasureRootRef,
    footerOverflowMenuMeasureRef,
    footerActionMeasureRefs,
    visibleFooterActions,
    overflowFooterActions,
    measurableFooterActions
  } = useFooterActionOverflow(footerActions, contentSettings.footerControls)
  const hasFooterControls = canShowPrintAction || measurableFooterActions.length > 0

  return (
    <Card
      ref={cardRef}
      variant="outlined"
      sx={{
        height: '100%',
        minWidth: 0,
        containerType: 'inline-size',
        containerName: 'printer-card',
        borderRadius: { xs: 'sm', sm: 'md' },
        '--Card-padding': { xs: '0.625rem', sm: '0.85rem' },
        pb: contentSettings.footerControls && hasFooterControls ? 0 : undefined
      }}
    >
      <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 0.75, sm: 1 } }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <PrinterCardIdentity
            printer={printer}
            cardRef={cardRef}
            printerIpAddress={printerIpAddress}
            wifiSignalLabel={wifiSignalLabel}
            nozzleSizeLabel={nozzleSizeLabel}
            onOpenDetails={onOpenDetails}
          />
          <PrinterCardStatusChips
            status={status}
            isIdleLikeStage={isIdleLikeStage}
            showPendingDispatchSummary={showPendingDispatchSummary}
            hasActiveJob={Boolean(activeJob)}
            pendingStartWarning={pendingStartWarning}
            isOnline={isOnline}
            showHmsErrors={contentSettings.hmsErrors}
            printerModel={printer.model}
            printerSerial={printer.serial}
          />
          <PluginSlot name="printer.card.headerChips" context={{ printerId: printer.id, printerName: printer.name }} />
          <PrinterCardActionsMenu
            printer={printer}
            isOnline={isOnline}
            canManagePrinter={canManagePrinter}
            canControlPrinter={canControlPrinter}
            canOpenAmsSettings={canOpenAmsSettings}
            canShowCalibrate={canShowCalibrate}
            canCalibrate={canCalibrate}
            canViewPrinterStorage={canViewPrinterStorage}
            canToggleExternalSpools={canToggleExternalSpools}
            showExternalSpools={showExternalSpools}
            onEdit={onEdit}
            onRefresh={() => sendCommand.mutate({ type: 'refresh' })}
            onOpenPrinterSettings={() => setPrinterSettingsDialogOpen(true)}
            onOpenControls={() => openControlsDialog()}
            onOpenAmsSettings={() => setAmsSettingsDialogOpen(true)}
            onOpenCalibration={() => setCalibrationDialogOpen(true)}
            onBrowseFiles={() => setStorageDialogOpen(true)}
            onBrowseModels={() => setModelsDialogOpen(true)}
            onBrowseTimelapses={() => setTimelapsesDialogOpen(true)}
            onToggleExternalSpools={() => setExternalSpoolsExpanded(!externalSpoolsExpanded)}
          />
          <PluginSlot name="printer.card.dialogs" context={{ printerId: printer.id, printerName: printer.name }} />
        </Stack>

        <Divider sx={{ mb: 0.75 }} inset="context" />

        {!isOnline && (
          <Box
            sx={{
              flexGrow: 1,
              minHeight: { xs: 92, sm: 108 },
              borderRadius: 'sm',
              border: '1px dashed var(--joy-palette-neutral-outlinedBorder)',
              backgroundColor: 'var(--joy-palette-background-level1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              px: { xs: 1.25, sm: 1.5 },
              py: { xs: 1.25, sm: 1.5 }
            }}
          >
            <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
              <Printer3dRoundedIcon color="disabled" fontSize="small" />
              <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                <Typography level="title-sm">Printer offline</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  Live status is unavailable.
                </Typography>
              </Stack>
            </Stack>
          </Box>
        )}

        {isOnline && showMediaStrip && (
          <PrinterJobMediaStrip
            cover={showCoverTile ? {
              title: displayJobLabel,
              src: coverUrl,
              loaded: coverLoaded,
              failed: coverFailed,
              progress: showDeterminateCoverProgress ? coverProgress : null,
              loading: showIndeterminateCoverProgress || showDeterminateCoverProgress
            } : null}
            camera={cameraSurfaceVisible ? {
              printerId: printer.id,
              printerName: printer.name,
              showTile: showCameraTile,
              showWide: showWideCamera,
              openRequestedAt: cameraDialogOpenRequestedAt,
              onDialogClose: () => setCameraDialogOpenRequestedAt(null),
              paused: deferCameraSnapshotsForCover,
              freezeThumbnail: freezeCameraThumbnail,
              lightControls: cameraLightControls
            } : null}
            mobileTileSize={68}
            layout={contentSettings.fullWidthSnapshot ? 'snapshot-above' : 'inline'}
            showCenter={showPrintStatusBlock}
            centerJustify={showJobSummary || showDispatchSummary || showPendingDispatchSummary || terminalJobSummaryVisible || showHistoryJobSummary ? 'space-between' : 'center'}
          >
            {showPrintStatusBlock ? <>
              {showDispatchSummary && dispatchJob && (
                <>
                  <PrinterJobProgressBlock
                    header={<Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>{dispatchPrintJob?.jobName ?? dispatchJob.jobName}</Typography>}
                    headerAside={(
                      <Chip
                        size="sm"
                        variant="soft"
                        color={dispatchStatusColor(dispatchJob.status)}
                        sx={{ flexShrink: 0 }}
                      >
                        {dispatchStatusLabel(dispatchJob.status)}
                      </Chip>
                    )}
                    determinate={dispatchJob.uploadPercent != null}
                    value={dispatchJob.uploadPercent ?? 0}
                    color={dispatchProgressColor(dispatchJob.status)}
                    fillColor={dispatchProgressFill(dispatchJob.status)}
                    trackColor={dispatchProgressTrack(dispatchJob.status)}
                    footer={<Typography level="body-xs" textColor="text.tertiary" noWrap>{formatDispatchProgress(dispatchJob)}</Typography>}
                  />
                </>
              )}
              {showPendingDispatchSummary && activeJob && (
                <>
                  <PrinterJobProgressBlock
                    header={<Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>{activeTrackedDisplayJobName || activeJob.jobName}</Typography>}
                    determinate={false}
                    value={0}
                    color={pendingStartWarning ? 'warning' : 'success'}
                    footer={(
                      <Typography level="body-xs" textColor="text.tertiary" sx={{ textWrap: 'pretty' }}>
                        {pendingStartWarning
                          ? 'The job was dispatched, but the printer still has not reported activity. Check the printer for any prompt, error, or start failure.'
                          : 'Print dispatched. Waiting for printer...'}
                      </Typography>
                    )}
                  />
                </>
              )}
              {showJobSummary && status?.progressPercent != null && (
                <PrinterJobProgressBlock
                  header={status?.jobName ? (
                    <OverflowTooltipText
                      level="body-xs"
                      noWrap
                      sx={{ minWidth: 0, flex: 1, flexShrink: 1 }}
                      text={activeDisplayJobName || status.jobName}
                      observeRef={cardRef}
                    />
                  ) : (
                    <Box sx={{ minWidth: 0, flex: 1 }} />
                  )}
                  headerAside={status?.progressPercent != null ? (
                    <Typography level="body-xs">{Math.round(status.progressPercent)}%</Typography>
                  ) : undefined}
                  determinate
                  value={status.progressPercent}
                  color={progressBarColor(status)}
                  fillColor={progressBarFill(status)}
                  trackColor={progressBarTrack(status)}
                  afterProgress={secondaryStageLabel ? (
                    <OverflowTooltipText
                      level="body-xs"
                      textColor={secondaryStageTextColor(status)}
                      noWrap
                      sx={{ minWidth: 0 }}
                      text={secondaryStageLabel}
                      observeRef={cardRef}
                    />
                  ) : undefined}
                  footer={!secondaryStageLabel ? (
                    <Stack
                      ref={layerSummaryRowRef}
                      direction="row"
                      justifyContent="space-between"
                      alignItems="center"
                      spacing={1}
                      sx={showCenteredLayerSummary
                        ? {
                            minWidth: 0,
                            display: 'grid',
                            // Size the side cells to their content so the finish-time ETA keeps
                            // its full width (incl. the AM/PM suffix) instead of sharing an equal
                            // 1fr split with the shorter "X left" label and getting clipped.
                            // hideLayerSummaryForWidth already guarantees the measured widths fit.
                            gridTemplateColumns: 'minmax(max-content, 1fr) auto minmax(max-content, 1fr)',
                            alignItems: 'center'
                          }
                        : { minWidth: 0 }}
                    >
                      {status.remainingMinutes != null ? (
                        <OverflowTooltipText
                          level="body-xs"
                          textColor="text.tertiary"
                          noWrap
                          sx={showCenteredLayerSummary
                            ? { minWidth: 0, textAlign: 'left' }
                            : { minWidth: 0, flex: 1, flexShrink: 0 }}
                          text={`${formatRemaining(status.remainingMinutes)} left`}
                          observeRef={cardRef}
                          onMetricsChange={({ naturalWidth }) => setRemainingSummaryWidth(Math.round(naturalWidth))}
                        />
                      ) : (
                        <Box sx={showCenteredLayerSummary ? { minWidth: 0 } : { minWidth: 0, flex: 1 }} />
                      )}
                      {showCenteredLayerSummary && (
                        <Typography
                          ref={layerSummaryTextRef}
                          level="body-xs"
                          textColor="text.tertiary"
                          noWrap
                          sx={{ flexShrink: 0, px: 0.5, textAlign: 'center' }}
                        >
                          {formatLayerSummary(status)}
                        </Typography>
                      )}
                      {status.remainingMinutes != null && !secondaryStageLabel && (
                        <OverflowTooltipText
                          level="body-xs"
                          textColor="text.tertiary"
                          noWrap
                          sx={showCenteredLayerSummary
                            ? { minWidth: 0, textAlign: 'right' }
                            : { minWidth: 0, flex: 1, flexShrink: 0, textAlign: 'right' }}
                          text={formatEstimatedCompletionTime(status.remainingMinutes)}
                          observeRef={cardRef}
                          onMetricsChange={({ naturalWidth }) => setEtaSummaryWidth(Math.round(naturalWidth))}
                        />
                      )}
                    </Stack>
                  ) : undefined}
                />
              )}
              {terminalJobSummaryVisible && (
                <PrinterJobProgressBlock
                  header={(
                    <OverflowTooltipText
                      level="body-xs"
                      noWrap
                      sx={{ minWidth: 0, flex: 1, flexShrink: 1 }}
                      text={activeDisplayJobName || historyDisplayJobName || status?.jobName || latestJob?.jobName || 'Last job'}
                      observeRef={cardRef}
                    />
                  )}
                  determinate
                  value={100}
                  color="danger"
                  afterProgress={(
                    <OverflowTooltipText
                      level="body-xs"
                      noWrap
                      sx={{
                        minWidth: 0,
                        flex: 1,
                        color: printerAttentionSummary?.kind === 'hmsError'
                          ? 'var(--joy-palette-warning-300)'
                          : 'var(--joy-palette-danger-300)'
                      }}
                      text={printerAttentionSummaryText ?? 'Printer reported this job as failed.'}
                      observeRef={cardRef}
                    />
                  )}
                />
              )}
              {showHistoryJobSummary && latestJob && (
                <PrinterJobProgressBlock
                  header={(
                    <OverflowTooltipText
                      level="body-xs"
                      noWrap
                      sx={{ minWidth: 0, flex: 1, flexShrink: 1 }}
                      text={historyDisplayJobName || latestJob.jobName}
                      observeRef={cardRef}
                    />
                  )}
                  showProgress={latestJobProgressPercent != null}
                  determinate
                  value={latestJobProgressPercent ?? 0}
                  color={printerHistoryResultColor(latestJob.result)}
                  footer={(
                    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                      <Typography level="body-xs" textColor="text.tertiary" noWrap>
                        {latestJob.result === 'success'
                          ? latestJobFinishedAgo
                            ? `Print finished ${latestJobFinishedAgo}`
                            : 'Print finished'
                          : latestJobProgressPercent != null
                            ? `${Math.round(latestJobProgressPercent)}%`
                            : 'Last job'}
                      </Typography>
                      {showHistoryResultChip && (
                        <Chip
                          size="sm"
                          variant="soft"
                          color={printerHistoryResultColor(latestJob.result)}
                          sx={{ flexShrink: 0 }}
                        >
                          {latestJob.result}
                        </Chip>
                      )}
                    </Stack>
                  )}
                />
              )}
              {!showJobSummary && !showDispatchSummary && !showPendingDispatchSummary && !showHistoryJobSummary && !terminalJobSummaryVisible && cameraVisible && (
                <Typography level="body-xs" textColor="text.tertiary">No active job</Typography>
              )}
            </> : null}
          </PrinterJobMediaStrip>
        )}

        {isOnline && printerAttentionSummaryText && !terminalJobSummaryVisible && (
          <PrinterCardAttentionSummary
            text={printerAttentionSummaryText}
            isHmsError={printerAttentionSummary?.kind === 'hmsError'}
            observeRef={cardRef}
            clearing={sendCommand.isPending}
            onClear={clearActivePrinterError}
          />
        )}

        {isOnline && status && (
          contentSettings.nozzleTemperatures
          || contentSettings.bedTemperature
          || contentSettings.chamberTemperature
          || contentSettings.printSpeed
          || showDoorStateChip
          || showDuctStateChip
        ) && (
          <PrinterCardMetrics
            status={status}
            contentSettings={contentSettings}
            compact={compact}
            nozzleReadouts={nozzleReadouts}
            canOpenControls={canOpenControls}
            onOpenTemperatureControls={() => openControlsDialog('temperature')}
            onOpenSpeedControls={() => openControlsDialog('speed')}
            onOpenNozzleControls={() => openControlsDialog('nozzles')}
            showChamberTemperature={showChamberTemperature}
            chamberTemperature={chamberTemperature}
            chamberTarget={chamberTarget}
            showDoorStateChip={showDoorStateChip}
            showDuctStateChip={showDuctStateChip}
          />
        )}

        {contentSettings.amsCards && isOnline && (amsUnits.length > 0 || externalSpools.length > 0) && (
          <PrinterCardAmsGrid
            amsUnits={amsUnits}
            amsGridColumns={amsGridColumns}
            externalSpools={externalSpools}
            showExternalSpools={showExternalSpools}
            cardsPerRow={cardsPerRow}
            submitting={sendCommand.isPending}
            printerId={printer.id}
            printerModel={printer.model}
            onRefresh={canControlPrinter ? () => sendCommand.mutate({ type: 'refresh' }) : undefined}
            onOpenDrying={canManagePrinter ? (unitId) => setAmsDryingUnitId(unitId) : undefined}
            onEditSlot={editAmsSlot}
            onLoadSlot={loadAmsSlotFilament}
            loadSlotDisabledReason={loadAmsSlotFilament ? (unit, slot) => getAmsLoadFilamentAvailability(status, unit.unitId, slot.slot).reason : undefined}
            onUnloadSlot={unloadAmsSlotFilament}
            unloadSlotDisabledReason={unloadAmsSlotFilament ? (unit, slot) => getAmsUnloadFilamentAvailability(status, unit.unitId, slot.slot).reason : undefined}
            onRescanSlot={rescanAmsSlot}
            rescanSlotDisabledReason={rescanAmsSlot ? (unit, slot) => getAmsRescanAvailability(status, unit.unitId, slot.slot).reason : undefined}
            onResetSlot={resetAmsSlot}
            onEditExternalSpool={canManagePrinter ? (spool) => setEditingExternalSpool(spool) : undefined}
          />
        )}

        {/* HMS errors are surfaced via the chip in the card header. */}
      </CardContent>
      {contentSettings.footerControls && hasFooterControls && (
        <PrinterCardFooterActions
          printer={printer}
          footerActions={footerActions}
          visibleFooterActions={visibleFooterActions}
          overflowFooterActions={overflowFooterActions}
          footerActionRowRef={footerActionRowRef}
          footerActionMeasureRootRef={footerActionMeasureRootRef}
          footerOverflowMenuMeasureRef={footerOverflowMenuMeasureRef}
          footerActionMeasureRefs={footerActionMeasureRefs}
          canShowPrintAction={canShowPrintAction}
          canPrintFromPrinter={canPrintFromPrinter}
          printDisabledReason={printDisabledReason}
          printAnchorRef={printAnchorRef}
          printMenuOpen={printMenuOpen}
          setPrintMenuOpen={setPrintMenuOpen}
          onPrint={onPrint}
          onPrintLocal={onPrintLocal}
        />
      )}
      <PrinterStorageDialogs
        printer={printer}
        canDispatchPrints={canDispatchPrints}
        canManagePrinter={canManagePrinter}
        canDownloadPrinterStorage={canDownloadPrinterStorage}
        demoMode={demoMode}
        storageOpen={storageDialogOpen}
        modelsOpen={modelsDialogOpen}
        timelapsesOpen={timelapsesDialogOpen}
        onCloseStorage={() => setStorageDialogOpen(false)}
        onCloseModels={() => setModelsDialogOpen(false)}
        onCloseTimelapses={() => setTimelapsesDialogOpen(false)}
      />
      <PrinterAmsDialogs
        printer={printer}
        status={status}
        canManagePrinter={canManagePrinter}
        submitting={sendCommand.isPending}
        onCommand={(command) => sendCommand.mutate(command)}
        amsSettingsOpen={amsSettingsDialogOpen}
        onCloseAmsSettings={() => setAmsSettingsDialogOpen(false)}
        dryingUnit={currentDryingUnit}
        onCloseDrying={() => setAmsDryingUnitId(null)}
        editingSlot={editingSlot}
        currentEditingUnit={currentEditingUnit}
        currentEditingSlot={currentEditingSlot}
        onCloseSlot={() => setEditingSlot(null)}
        editingExternalSpool={editingExternalSpool}
        currentEditingExternalSpool={currentEditingExternalSpool}
        externalSpoolCount={externalSpools.length}
        defaultExternalSpoolTemp={defaultExternalSpoolTemp}
        onCloseExternalSpool={() => setEditingExternalSpool(null)}
      />
      <PrinterAttentionDialogs
        printer={printer}
        status={status}
        submitting={sendCommand.isPending}
        onCommand={(command) => sendCommand.mutate(command)}
        filamentRecoveryOpen={filamentRecoveryDialogOpen}
        filamentRecoverySources={filamentRecoverySources}
        onCloseFilamentRecovery={() => setFilamentRecoveryDialogOpen(false)}
        onOpenFilamentRecovery={() => setFilamentRecoveryDialogOpen(true)}
        assistantOpen={assistantDialogOpen}
        assistantCanOpenLiveView={canOpenAssistantLiveView && jumpToLiveViewAvailability.allowed}
        assistantCanLoadFilament={showLoadFilamentAction && filamentRecoverySources.length > 0}
        onCloseAssistant={() => setAssistantDialogOpen(false)}
        onRequestLiveView={() => setCameraDialogOpenRequestedAt(Date.now())}
      />
      <PrinterControlDialogs
        printer={printer}
        status={status}
        canControlPrinter={canControlPrinter}
        canManagePrinter={canManagePrinter}
        submitting={sendCommand.isPending}
        onCommand={(command) => sendCommand.mutate(command)}
        calibrationOpen={calibrationDialogOpen}
        calibrationCapabilities={calibrationCapabilities}
        onCloseCalibration={() => setCalibrationDialogOpen(false)}
        controlsOpen={controlsDialogOpen}
        controlCapabilities={controlCapabilities}
        controlsInitialTab={controlsDialogInitialTab}
        onCloseControls={() => setControlsDialogOpen(false)}
        printerSettingsOpen={printerSettingsDialogOpen}
        onClosePrinterSettings={() => setPrinterSettingsDialogOpen(false)}
      />
      {canControlPrinter && skipObjectDialogOpen && canSkipObjects && (
        <SkipObjectsModal
          printerName={printer.name}
          objects={activePrintObjects}
          loading={activePrintObjectsLoading}
          unavailable={activePrintObjectsQuery.isError || (!activePrintObjectsLoading && activePrintObjects.length === 0)}
          unavailableReason={activePrintObjectsUnavailableReason}
          unavailableMessage={activePrintObjectsUnavailableMessage}
          submitting={sendCommand.isPending}
          onClose={() => {
            void queryClient.cancelQueries({ queryKey: ['printer-active-print-objects', printer.id] })
            setSkipObjectDialogOpen(false)
          }}
          onSkip={(objectIds) => sendCommand.mutate({ type: 'skipObjects', objectIds })}
        />
      )}
    </Card>
  )
}

export const PrinterCard = memo(PrinterCardComponent)
