/**
 * The printer-card metrics row: temperature readouts (nozzle: single or dual, bed, chamber) plus
 * print-speed, door, and duct chips. Each readout/chip is gated by the card's content settings and
 * live status; temperature, speed, and nozzle-changer readouts deep-link into the matching
 * controls-dialog tab when permitted.
 * Extracted from PrinterCard to keep the card body render-focused.
 */
import { Stack } from '@mui/joy'
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded'
import AirRoundedIcon from '@mui/icons-material/AirRounded'
import MeetingRoomRoundedIcon from '@mui/icons-material/MeetingRoomRounded'
import SwapVertRoundedIcon from '@mui/icons-material/SwapVertRounded'
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded'
import { summarizeFilamentTrackSwitch, type PrinterCardContentSettings, type PrinterStatus } from '@printstream/shared'
import { DualTempReadout, HeaterThermometerIcon, MetricChip, TempReadout } from './PrinterMetricChips'
import { formatDuctMode, printerNozzles, speedLabel } from '../../lib/printersViewHelpers'
import { formatNozzleSlotHardware, summarizeNozzleRack } from '../../lib/nozzleRackHelpers'
import { formatFilamentTrackSwitchState } from '../../lib/filamentTrackSwitchHelpers'

export interface PrinterCardMetricsProps {
  status: PrinterStatus
  contentSettings: PrinterCardContentSettings
  compact?: boolean
  nozzleReadouts: ReturnType<typeof printerNozzles>
  canOpenControls: boolean
  onOpenTemperatureControls: () => void
  onOpenSpeedControls: () => void
  /** Opens the controls dialog on the Nozzles (nozzle changer) tab. */
  onOpenNozzleControls: () => void
  /** Opens the controls dialog on the Track switch (FTS) tab. */
  onOpenTrackSwitchControls: () => void
  showChamberTemperature: boolean
  chamberTemperature: number | null
  chamberTarget: number | null
  showDoorStateChip: boolean
  showDuctStateChip: boolean
}

export function PrinterCardMetrics({
  status,
  contentSettings,
  compact,
  nozzleReadouts,
  canOpenControls,
  onOpenTemperatureControls,
  onOpenSpeedControls,
  onOpenNozzleControls,
  onOpenTrackSwitchControls,
  showChamberTemperature,
  chamberTemperature,
  chamberTarget,
  showDoorStateChip,
  showDuctStateChip
}: PrinterCardMetricsProps) {
  return (
    <Stack
      direction="row"
      spacing={{ xs: 0.5, sm: 0.75 }}
      sx={{ flexWrap: 'wrap', alignItems: 'center' }}
    >
      {contentSettings.nozzleTemperatures && nozzleReadouts.length > 1 ? (
        <DualTempReadout
          icon={<HeaterThermometerIcon color="warning" />}
          ariaLabel="Nozzle temperatures"
          values={nozzleReadouts}
          showTargets={!compact}
          onClick={canOpenControls ? onOpenTemperatureControls : undefined}
        />
      ) : contentSettings.nozzleTemperatures ? (
        <TempReadout
          icon={<HeaterThermometerIcon color="warning" />}
          ariaLabel="Nozzle temperature"
          current={status.nozzleTemp}
          target={compact ? null : status.nozzleTarget}
          tooltipTarget={status.nozzleTarget}
          onClick={canOpenControls ? onOpenTemperatureControls : undefined}
        />
      ) : null}
      {contentSettings.bedTemperature && (
        <TempReadout
          icon={<HeaterThermometerIcon color="primary" />}
          ariaLabel="Bed temperature"
          current={status.bedTemp}
          target={compact ? null : status.bedTarget}
          tooltipTarget={status.bedTarget}
          onClick={canOpenControls ? onOpenTemperatureControls : undefined}
        />
      )}
      {contentSettings.chamberTemperature && showChamberTemperature && (
        <TempReadout
          icon={<HeaterThermometerIcon color="success" />}
          ariaLabel="Chamber temperature"
          current={chamberTemperature}
          target={compact ? null : chamberTarget}
          tooltipTarget={chamberTarget}
          onClick={canOpenControls ? onOpenTemperatureControls : undefined}
        />
      )}
      {contentSettings.printSpeed && status.speedLevel != null && (
        <MetricChip
          icon={<SpeedRoundedIcon fontSize="inherit" />}
          ariaLabel="Print speed"
          value={speedLabel(status.speedLevel)}
          onClick={canOpenControls ? onOpenSpeedControls : undefined}
        />
      )}
      {showDoorStateChip && (
        <MetricChip
          icon={<MeetingRoomRoundedIcon fontSize="inherit" />}
          ariaLabel="Door state"
          value={status.doorOpen ? 'Door open' : 'Door closed'}
        />
      )}
      {showDuctStateChip && status.ductMode && (
        <MetricChip
          icon={<AirRoundedIcon fontSize="inherit" />}
          ariaLabel="Duct mode"
          value={`Duct ${formatDuctMode(status.ductMode)}`}
        />
      )}
      {status.nozzleRack ? (() => {
        const summary = summarizeNozzleRack(status.nozzleRack)
        const mountedLabel = summary.mounted.map(formatNozzleSlotHardware).join(', ')
        const rackLabel = summary.spares.map(formatNozzleSlotHardware).join(', ')
        const tooltip = [
          mountedLabel ? `Loaded: ${mountedLabel}` : null,
          rackLabel ? `Rack: ${rackLabel}` : null
        ].filter(Boolean).join('. ') || 'Nozzle changer'
        return (
          <MetricChip
            icon={<SwapVertRoundedIcon fontSize="inherit" />}
            ariaLabel={`Nozzle changer: ${summary.chipLabel}`}
            value={summary.chipLabel}
            tooltipTitle={tooltip}
            onClick={canOpenControls ? onOpenNozzleControls : undefined}
          />
        )
      })() : null}
      {/* Only once the module is actually FITTED. The parser reports a switch object whenever the
          printer mentions `device.fila_switch`, even with the installed bit clear, and a permanent
          "Track switch not fitted" chip is noise on a machine that never had one. */}
      {status.filamentTrackSwitch?.installed === true ? (() => {
        const summary = summarizeFilamentTrackSwitch(status)
        if (!summary) return null
        const state = formatFilamentTrackSwitchState(summary)
        return (
          <MetricChip
            icon={<AltRouteRoundedIcon fontSize="inherit" />}
            ariaLabel={`Filament Track Switch: ${state}`}
            value={`Track switch ${state.toLowerCase()}`}
            tooltipTitle="Filament Track Switch: an AMS behind it can feed either nozzle."
            onClick={canOpenControls ? onOpenTrackSwitchControls : undefined}
          />
        )
      })() : null}
    </Stack>
  )
}
