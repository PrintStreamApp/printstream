/**
 * Multi-state printer settings whose wire values cannot be represented by the
 * boolean `setPrintOption` rows. Visibility comes only from live printer state;
 * unsupported controls are omitted rather than guessed from the selected model.
 */
import { FormControl, FormLabel, Option, Select, Sheet, Stack, Typography } from '@mui/joy'
import type { PrinterStatus } from '@printstream/shared'
import type { ReactNode } from 'react'
import type { PrinterSettingsDialogCommand } from '../../lib/printerViewTypes'

interface PrinterModeSettingsProps {
  settings: PrinterStatus['printOptions']
  submitting: boolean
  onSubmit: (command: PrinterSettingsDialogCommand) => void
}

/** Render the capability-backed mode and camera-resolution controls. */
export function PrinterModeSettings({ settings, submitting, onSubmit }: PrinterModeSettingsProps) {
  const hasProtectionModes = settings.purifyAirAtPrintEnd?.supported === true
    || settings.openDoorDetection?.supported === true
    || settings.smartNozzleBlobDetection?.supported === true

  return (
    <>
      {hasProtectionModes && (
        <Stack spacing={1}>
          <Typography level="title-sm">Protection modes</Typography>
          <Stack spacing={1}>
            {settings.purifyAirAtPrintEnd?.supported === true && (
              <ModeSetting label="Purify air at print end" description="Purifies chamber air using the selected circulation path when a print finishes.">
                <Select
                  value={settings.purifyAirAtPrintEnd.current}
                  placeholder="Choose"
                  disabled={submitting}
                  onChange={(_event, mode) => mode && onSubmit({ type: 'setPurifyAirAtPrintEnd', mode })}
                >
                  <Option value="off">Off</Option>
                  <Option value="internal">Internal circulation</Option>
                  <Option value="exhaust">Exhaust</Option>
                </Select>
              </ModeSetting>
            )}
            {settings.openDoorDetection?.supported === true && (
              <ModeSetting label="Open door detection" description="Choose what the printer does when its door opens during a task.">
                <Select
                  value={settings.openDoorDetection.current}
                  placeholder="Choose"
                  disabled={submitting}
                  onChange={(_event, mode) => mode && onSubmit({ type: 'setOpenDoorDetection', mode })}
                >
                  <Option value="off">Off</Option>
                  <Option value="notify">Notification</Option>
                  <Option value="pause">Pause printing</Option>
                </Select>
              </ModeSetting>
            )}
            {settings.smartNozzleBlobDetection?.supported === true && (
              <ModeSetting label="Smart nozzle blob detection" description="Controls when the printer checks for blobs accumulating around the nozzle.">
                <Select
                  value={settings.smartNozzleBlobDetection.current}
                  placeholder="Choose"
                  disabled={submitting}
                  onChange={(_event, mode) => mode && onSubmit({ type: 'setSmartNozzleBlobDetection', mode })}
                >
                  <Option value="auto">Auto</Option>
                  <Option value="on">On</Option>
                  <Option value="off">Off</Option>
                </Select>
              </ModeSetting>
            )}
          </Stack>
        </Stack>
      )}

      {settings.cameraResolution?.supported === true && (
        <Stack spacing={1}>
          <Typography level="title-sm">Camera quality</Typography>
          <ModeSetting label="Resolution" description="Changes the resolution used by the printer camera.">
            <Select
              value={settings.cameraResolution.current}
              placeholder="Choose"
              disabled={submitting}
              onChange={(_event, resolution) => resolution && onSubmit({ type: 'setCameraResolution', resolution })}
            >
              {settings.cameraResolution.available.map((resolution) => (
                <Option key={resolution} value={resolution}>{resolution}</Option>
              ))}
            </Select>
          </ModeSetting>
        </Stack>
      )}
    </>
  )
}

function ModeSetting({
  label,
  description,
  children
}: {
  label: string
  description: string
  children: ReactNode
}) {
  return (
    <Sheet variant="soft" sx={{ p: 1.25, borderRadius: 'md' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
        <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm">{label}</Typography>
          <Typography level="body-xs" textColor="text.tertiary">{description}</Typography>
        </Stack>
        <FormControl size="sm" sx={{ minWidth: { xs: '100%', sm: 190 } }}>
          <FormLabel sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {label}
          </FormLabel>
          {children}
        </FormControl>
      </Stack>
    </Sheet>
  )
}
