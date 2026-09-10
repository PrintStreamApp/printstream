/**
 * AMS-level dialogs extracted from `pages/PrintersView.tsx`: the AMS settings modal and the AMS
 * drying modal. Both are controlled modals that emit printer commands to their caller.
 *
 * The settings modal's rows live in `AmsSettingsRows.tsx`, moved there once the sheet held three
 * different row shapes (a toggle, a choice, and a one-shot action) that must still line up as one
 * list.
 */
import { useState } from 'react'
import {
  Alert, Box, Button, Checkbox, Chip, DialogActions, FormControl, FormHelperText, FormLabel, Input, ListDivider, ModalClose, ModalDialog, Option, Select, Sheet, Stack, Typography
} from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  AMS_DRYING_FILAMENT_TYPES,
  amsDryingTemperatureRange,
  assessAmsDryingRisk,
  clampDryingTemperature,
  defaultAmsDryingProfile,
  dryingCoolingTemperature,
  recommendedAmsDryingDurationHours,
  recommendedAmsDryingTemperature,
  formatAmsDryingRiskLabel,
  type AmsUnit,
  type PrinterCommand,
  type PrinterStatus
} from '@printstream/shared'
import { AmsOrderResetRow, AmsSettingsRow } from './AmsSettingsRows'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { DialogSection } from '../DialogSection'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { amsUnitLetter } from '../../lib/printerTrayMapping'
import { formatAmsDryingPhaseDescription, formatAmsDryingPhaseLabel } from '../../lib/amsDrying'
import { formatRemaining } from '../../lib/printersViewHelpers'

export function AmsSettingsModal({
  printerName,
  settings,
  canReorderAmsUnits,
  submitting,
  onClose,
  onUpdateUserSettings,
  onUpdateFilamentBackup,
  onResetAmsOrder
}: {
  printerName: string
  settings: PrinterStatus['amsSettings']
  /** From `supportsAmsSettingsReorder`: A2L only, so the row is absent everywhere else. */
  canReorderAmsUnits: boolean
  submitting: boolean
  onClose: () => void
  onUpdateUserSettings: (command: Extract<PrinterCommand, { type: 'setAmsUserSettings' }>) => void
  onUpdateFilamentBackup: (enabled: boolean) => void
  onResetAmsOrder: () => void
}) {
  const userSettingsReady =
    settings.detectOnInsert != null &&
    settings.detectOnPowerup != null &&
    settings.remainEnabled != null

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: { xs: '100%', sm: 640 } }}>
        <ModalClose />
        <Typography level="h4">AMS settings</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {printerName}
        </Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, p: 0 }}>
          <Stack spacing={1.5}>
            <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
              <Stack divider={<ListDivider inset="gutter" />}>
                {/* Hardware actions go first, where BambuStudio puts them: they describe the
                    hardware that everything below is a setting for. AMS type switching remains
                    hidden until status exposes the filament-in-extruder safety prerequisite. */}
                {canReorderAmsUnits && (
                  <AmsOrderResetRow disabled={submitting} onReset={onResetAmsOrder} />
                )}
                <AmsSettingsRow
                  title="Read on insert"
                  description="Automatically read filament details when a spool is inserted into the AMS."
                  value={settings.detectOnInsert}
                  disabled={!userSettingsReady || submitting}
                  onToggle={(nextValue) => {
                    if (!userSettingsReady) return
                    onUpdateUserSettings({
                      type: 'setAmsUserSettings',
                      trayReadOption: nextValue,
                      startupReadOption: settings.detectOnPowerup ?? false,
                      calibrateRemainFlag: settings.remainEnabled ?? false
                    })
                  }}
                />
                <AmsSettingsRow
                  title="Read on startup"
                  description="Read inserted filament automatically when the printer starts up."
                  value={settings.detectOnPowerup}
                  disabled={!userSettingsReady || submitting}
                  onToggle={(nextValue) => {
                    if (!userSettingsReady) return
                    onUpdateUserSettings({
                      type: 'setAmsUserSettings',
                      trayReadOption: settings.detectOnInsert ?? false,
                      startupReadOption: nextValue,
                      calibrateRemainFlag: settings.remainEnabled ?? false
                    })
                  }}
                />
                <AmsSettingsRow
                  title="Update filament remain"
                  description="Use AMS spool metadata to track remaining filament instead of always showing a full spool."
                  value={settings.remainEnabled}
                  disabled={!userSettingsReady || submitting}
                  onToggle={(nextValue) => {
                    if (!userSettingsReady) return
                    onUpdateUserSettings({
                      type: 'setAmsUserSettings',
                      trayReadOption: settings.detectOnInsert ?? false,
                      startupReadOption: settings.detectOnPowerup ?? false,
                      calibrateRemainFlag: nextValue
                    })
                  }}
                />
                <AmsSettingsRow
                  title="AMS filament backup"
                  description="Automatically continue on another matching spool when the active one runs out."
                  value={settings.autoRefill}
                  unsupported={settings.supportFilamentBackup === false}
                  disabled={settings.autoRefill == null || submitting || settings.supportFilamentBackup === false}
                  onToggle={(nextValue) => onUpdateFilamentBackup(nextValue)}
                />
              </Stack>
            </Sheet>
          </Stack>
        </ScrollableDialogBody>
        <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ pt: 1 }}>
          <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
        </Stack>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function AmsDryingModal({
  printerName,
  unit,
  printing,
  submitting,
  onClose,
  onStart,
  onStop
}: {
  printerName: string
  unit: AmsUnit
  /**
   * Whether a print is running. Bambu recommends a lower drying temperature while one is, for
   * eight materials; the suggestion follows it, and the user can still override.
   */
  printing: boolean
  submitting: boolean
  onClose: () => void
  onStart: (command: Extract<PrinterCommand, { type: 'startAmsDrying' }>) => void
  onStop: (amsId: number) => void
}) {
  const defaultProfile = defaultAmsDryingProfile(unit, { printing })
  const [filamentType, setFilamentType] = useState(defaultProfile.filamentType)
  const [temperature, setTemperature] = useState(String(defaultProfile.temperature))
  const [durationHours, setDurationHours] = useState(String(defaultProfile.durationHours))
  const [rotateTray, setRotateTray] = useState(defaultProfile.rotateTray)
  const parsedTemperature = Number(temperature)
  const parsedDurationHours = Number(durationHours)
  const dryingPhaseLabel = formatAmsDryingPhaseLabel(unit)
  const dryingPhaseDescription = formatAmsDryingPhaseDescription(unit)
  const temperatureRange = amsDryingTemperatureRange(unit.type)
  // Live: recomputes as tray state updates, so unloading a flagged spool
  // clears the warning without reopening the dialog. Risks are advisory:
  // starting anyway sends `acknowledgeRisks` so the API lets it through.
  const dryingRisks = assessAmsDryingRisk(unit, parsedTemperature)
  const canStart =
    filamentType !== '' &&
    Number.isFinite(parsedTemperature) &&
    parsedTemperature >= temperatureRange.min &&
    parsedTemperature <= temperatureRange.max &&
    Number.isFinite(parsedDurationHours) &&
    parsedDurationHours >= 1 &&
    parsedDurationHours <= 24

  const handleFilamentTypeChange = (_event: unknown, nextValue: string | null) => {
    if (!nextValue) return
    setFilamentType(nextValue)
    setTemperature(String(clampDryingTemperature(
      recommendedAmsDryingTemperature(nextValue, { printing }),
      temperatureRange
    )))
    setDurationHours(String(recommendedAmsDryingDurationHours(nextValue, unit.type)))
  }

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: { xs: '96vw', sm: 460 } }}>
        <ModalClose />
        <Typography level="h4">AMS {amsUnitLetter(unit.unitId)} drying</Typography>
        <Typography level="body-sm" textColor="text.tertiary">{printerName}</Typography>
        <Stack spacing={2} sx={{ mt: 1.5 }}>
          <DialogSection title="Status">
            <Stack spacing={1}>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                {unit.temperature != null && <Chip size="sm" variant="soft">{`${Math.round(unit.temperature)}°C`}</Chip>}
                {unit.humidityPercent != null && <Chip size="sm" variant="soft">{`${Math.round(unit.humidityPercent)}% RH`}</Chip>}
                <Chip size="sm" variant="soft" color={unit.dryingActive ? 'warning' : 'neutral'}>
                  {dryingPhaseLabel}
                </Chip>
                {unit.dryTimeRemainingMinutes != null && unit.dryTimeRemainingMinutes > 0 && (
                  <Chip size="sm" variant="soft">{`${formatRemaining(unit.dryTimeRemainingMinutes)} left`}</Chip>
                )}
              </Stack>
              <Typography level="body-sm">{dryingPhaseDescription}</Typography>
            </Stack>
          </DialogSection>

          {unit.dryingActive ? (
            <DialogSection title="Cycle">
              <Stack spacing={1}>
                <Typography level="body-sm">
                  {unit.dryFilament ? `${unit.dryFilament} profile` : 'Current drying profile'}
                  {unit.dryTemperature != null ? ` at ${Math.round(unit.dryTemperature)}°C` : ''}
                  {unit.dryDurationHours != null ? ` for ${unit.dryDurationHours}h` : ''}
                </Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  Stop the current cycle from here. Starting a new cycle is only available after the AMS returns to idle.
                </Typography>
              </Stack>
            </DialogSection>
          ) : (
            <DialogSection
              title="Settings"
              description="Cooling temperature is derived automatically from the selected filament profile."
            >
              <Stack spacing={1.25}>
                <FormControl>
                  <FormLabel>Filament type</FormLabel>
                  <Select value={filamentType} onChange={handleFilamentTypeChange}>
                    {AMS_DRYING_FILAMENT_TYPES.map((type) => (
                      <Option key={type} value={type}>{type}</Option>
                    ))}
                  </Select>
                </FormControl>
                <Box
                  sx={{
                    display: 'grid',
                    gap: 1,
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    '& > *': { minWidth: 0 }
                  }}
                >
                  <FormControl>
                    <FormLabel>Temperature</FormLabel>
                    <Input
                      type="number"
                      value={temperature}
                      onChange={(event) => setTemperature(event.target.value)}
                      endDecorator="°C"
                      slotProps={{ input: { min: temperatureRange.min, max: temperatureRange.max } }}
                    />
                    <FormHelperText>{`${temperatureRange.min} to ${temperatureRange.max}°C on this AMS`}</FormHelperText>
                  </FormControl>
                  <FormControl>
                    <FormLabel>Duration</FormLabel>
                    <Input
                      type="number"
                      value={durationHours}
                      onChange={(event) => setDurationHours(event.target.value)}
                      endDecorator="h"
                      slotProps={{ input: { min: 1, max: 24 } }}
                    />
                  </FormControl>
                </Box>
                <Checkbox
                  label="Rotate trays while drying"
                  checked={rotateTray}
                  onChange={(event) => setRotateTray(event.target.checked)}
                />
                {dryingRisks.length > 0 && (
                  <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
                      <Typography level="title-sm">Too hot for loaded filament</Typography>
                      {dryingRisks.map((risk) => (
                        <Typography key={risk.slot} level="body-sm">
                          {formatAmsDryingRiskLabel(unit.unitId, risk)}
                        </Typography>
                      ))}
                      <Typography level="body-sm">
                        {'Unload the flagged filament or lower the temperature to dry safely. Starting anyway may deform it.'}
                        {dryingRisks.some((risk) => risk.filamentType == null) ? ' Unidentified filament is treated as PLA.' : ''}
                      </Typography>
                    </Stack>
                  </Alert>
                )}
              </Stack>
            </DialogSection>
          )}
        </Stack>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={submitting}>Close</Button>
          {unit.dryingActive ? (
            <Button color="danger" variant="soft" loading={submitting} onClick={() => onStop(unit.unitId)}>
              Stop
            </Button>
          ) : (
            <Button
              loading={submitting}
              disabled={!canStart}
              onClick={() => onStart({
                type: 'startAmsDrying',
                amsId: unit.unitId,
                filamentType,
                temperature: Math.round(parsedTemperature),
                durationHours: Math.round(parsedDurationHours),
                rotateTray,
                coolingTemp: dryingCoolingTemperature(filamentType),
                closePowerConflict: false,
                acknowledgeRisks: dryingRisks.length > 0
              })}
            >
              Start drying
            </Button>
          )}
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}
