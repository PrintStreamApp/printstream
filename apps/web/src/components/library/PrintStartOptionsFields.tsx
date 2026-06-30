/**
 * Shared "Print settings" field group used by the Print dialog and the print-queue's
 * Add/Edit dialog so the two surfaces stay identical. Renders the start-of-print
 * calibration toggles (timelapse, bed leveling, vibration compensation, flow dynamics,
 * nozzle offset) as labelled on/off(/auto) selects.
 *
 * `capabilities` gates which rows render to what a chosen printer supports; omit it
 * (the queue's "any eligible printer" case has no single printer) to show the full set.
 */
import { Box, FormControl, FormLabel, Option, Select, Tooltip } from '@mui/joy'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import type { PrintNozzleOffsetCalibrationMode, PrintOnOffAutoMode } from '@printstream/shared'

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

export function PrintOptionLabel({ label, tooltip }: { label: string; tooltip?: string }) {
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

/** Which rows to render, and whether bed-level / flow support an "Auto" mode. */
export interface PrintStartOptionsCapabilities {
  timelapse: boolean
  bedLevel: boolean
  bedLevelAuto: boolean
  vibrationCompensation: boolean
  flowCalibration: boolean
  flowCalibrationAuto: boolean
  nozzleOffsetCalibration: boolean
}

const ALL_CAPABILITIES: PrintStartOptionsCapabilities = {
  timelapse: true,
  bedLevel: true,
  bedLevelAuto: true,
  vibrationCompensation: true,
  flowCalibration: true,
  flowCalibrationAuto: true,
  nozzleOffsetCalibration: true
}

export interface PrintStartOptionsFieldsProps {
  timelapse: boolean
  onTimelapseChange: (value: boolean) => void
  bedLevel: PrintOnOffAutoMode
  onBedLevelChange: (value: PrintOnOffAutoMode) => void
  vibrationCompensation: boolean
  onVibrationCompensationChange: (value: boolean) => void
  flowCalibration: PrintOnOffAutoMode
  onFlowCalibrationChange: (value: PrintOnOffAutoMode) => void
  nozzleOffsetCalibration: PrintNozzleOffsetCalibrationMode
  onNozzleOffsetCalibrationChange: (value: PrintNozzleOffsetCalibrationMode) => void
  /** Gate rows + Auto options to a printer's support; omit to show the full set. */
  capabilities?: PrintStartOptionsCapabilities | null
}

export function PrintStartOptionsFields({
  timelapse,
  onTimelapseChange,
  bedLevel,
  onBedLevelChange,
  vibrationCompensation,
  onVibrationCompensationChange,
  flowCalibration,
  onFlowCalibrationChange,
  nozzleOffsetCalibration,
  onNozzleOffsetCalibrationChange,
  capabilities
}: PrintStartOptionsFieldsProps) {
  const caps = capabilities ?? ALL_CAPABILITIES
  return (
    <Box sx={{ minWidth: 0, width: '100%', display: 'grid', gap: 1 }}>
      {caps.timelapse && (
        <FormControl sx={printOptionFieldSx}>
          <PrintOptionLabel label="Timelapse" />
          <Select<'off' | 'on'>
            value={timelapse ? 'on' : 'off'}
            onChange={(_event, value) => value && onTimelapseChange(value === 'on')}
            size="sm"
            sx={printOptionSelectSx}
          >
            <Option value="off">Off</Option>
            <Option value="on">On</Option>
          </Select>
        </FormControl>
      )}
      {caps.bedLevel && (
        <FormControl sx={printOptionFieldSx}>
          <PrintOptionLabel label="Auto Bed Leveling" tooltip={printOptionHelpText.bedLevel} />
          <Select<PrintOnOffAutoMode>
            value={bedLevel}
            onChange={(_event, value) => value && onBedLevelChange(value)}
            size="sm"
            sx={printOptionSelectSx}
          >
            <Option value="off">Off</Option>
            <Option value="on">On</Option>
            {caps.bedLevelAuto && <Option value="auto">Auto</Option>}
          </Select>
        </FormControl>
      )}
      {caps.vibrationCompensation && (
        <FormControl sx={printOptionFieldSx}>
          <PrintOptionLabel label="Vibration Compensation" tooltip={printOptionHelpText.vibrationCompensation} />
          <Select<'off' | 'on'>
            value={vibrationCompensation ? 'on' : 'off'}
            onChange={(_event, value) => value && onVibrationCompensationChange(value === 'on')}
            size="sm"
            sx={printOptionSelectSx}
          >
            <Option value="off">Off</Option>
            <Option value="on">On</Option>
          </Select>
        </FormControl>
      )}
      {caps.flowCalibration && (
        <FormControl sx={printOptionFieldSx}>
          <PrintOptionLabel label="Flow Dynamics Calibration" tooltip={printOptionHelpText.flowCalibration} />
          <Select<PrintOnOffAutoMode>
            value={flowCalibration}
            onChange={(_event, value) => value && onFlowCalibrationChange(value)}
            size="sm"
            sx={printOptionSelectSx}
          >
            <Option value="off">Off</Option>
            <Option value="on">On</Option>
            {caps.flowCalibrationAuto && <Option value="auto">Auto</Option>}
          </Select>
        </FormControl>
      )}
      {caps.nozzleOffsetCalibration && (
        <FormControl sx={printOptionFieldSx}>
          <PrintOptionLabel label="Nozzle Offset Calibration" tooltip={printOptionHelpText.nozzleOffsetCalibration} />
          <Select<PrintNozzleOffsetCalibrationMode>
            value={nozzleOffsetCalibration}
            onChange={(_event, value) => value && onNozzleOffsetCalibrationChange(value)}
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
  )
}
