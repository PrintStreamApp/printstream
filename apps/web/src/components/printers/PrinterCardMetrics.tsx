/**
 * The printer-card metrics row: temperature readouts (nozzle — single or dual, bed, chamber) plus
 * print-speed, door, and duct chips. Each readout/chip is gated by the card's content settings and
 * live status; temperature and speed readouts deep-link into the controls dialog when permitted.
 * Extracted from PrinterCard to keep the card body render-focused.
 */
import { Stack } from '@mui/joy'
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded'
import AirRoundedIcon from '@mui/icons-material/AirRounded'
import MeetingRoomRoundedIcon from '@mui/icons-material/MeetingRoomRounded'
import type { PrinterCardContentSettings, PrinterStatus } from '@printstream/shared'
import { DualTempReadout, HeaterThermometerIcon, MetricChip, TempReadout } from './PrinterMetricChips'
import { formatDuctMode, printerNozzles, speedLabel } from '../../lib/printersViewHelpers'

export interface PrinterCardMetricsProps {
  status: PrinterStatus
  contentSettings: PrinterCardContentSettings
  compact?: boolean
  nozzleReadouts: ReturnType<typeof printerNozzles>
  canOpenControls: boolean
  onOpenTemperatureControls: () => void
  onOpenSpeedControls: () => void
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
    </Stack>
  )
}
