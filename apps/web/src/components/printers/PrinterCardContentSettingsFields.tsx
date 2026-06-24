import { Box, Checkbox, ListDivider, Stack, Typography } from '@mui/joy'
import type { PrinterCardContentSettings } from '@printstream/shared'

/**
 * The shared "Card content" toggle list: one switch per printer-card status
 * block, used by both the saved-view editor (PrinterViewsModal) and the
 * single-printer view editor (PrinterCardContentSettingsModal). Keeping the row
 * definitions in one place means a new toggle (or a copy tweak) lands in every
 * surface at once.
 *
 * The full-width snapshot and the camera thumbnail are independent: a card can
 * show both at once (the full-width view above, the thumbnail tile in the status
 * row), so each toggle stands alone.
 */

export function PrinterCardSettingsRow({
  title,
  description,
  checked,
  onChange
}: {
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="flex-start"
      onClick={() => onChange(!checked)}
      sx={{ px: 1.5, py: 1.25, cursor: 'pointer' }}
    >
      <Checkbox
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onChange(event.target.checked)}
        sx={{ mt: 0.25 }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="title-sm">{title}</Typography>
        <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
      </Box>
    </Stack>
  )
}

export function PrinterCardContentSettingsFields({
  value,
  onChange
}: {
  value: PrinterCardContentSettings
  onChange: (key: keyof PrinterCardContentSettings, checked: boolean) => void
}) {
  return (
    <Stack divider={<ListDivider inset="gutter" />}>
      <PrinterCardSettingsRow
        title="Full-width snapshot"
        description="Show the camera snapshot in a full-width row above the progress and status block."
        checked={value.fullWidthSnapshot}
        onChange={(checked) => onChange('fullWidthSnapshot', checked)}
      />
      <PrinterCardSettingsRow
        title="Model thumbnail"
        description="Show the plate preview image for the active print."
        checked={value.modelThumbnail}
        onChange={(checked) => onChange('modelThumbnail', checked)}
      />
      <PrinterCardSettingsRow
        title="Camera thumbnail"
        description="Show the live camera snapshot strip on each printer card."
        checked={value.cameraThumbnail}
        onChange={(checked) => onChange('cameraThumbnail', checked)}
      />
      <PrinterCardSettingsRow
        title="Print status"
        description="Show the active job name, progress, and ETA block alongside the media section."
        checked={value.printStatus}
        onChange={(checked) => onChange('printStatus', checked)}
      />
      <PrinterCardSettingsRow
        title="HMS errors"
        description="Show HMS health alerts the printer reports, as a header chip and warning summary."
        checked={value.hmsErrors}
        onChange={(checked) => onChange('hmsErrors', checked)}
      />
      <PrinterCardSettingsRow
        title="Nozzle temps"
        description="Show the live nozzle temperature readout on each printer card."
        checked={value.nozzleTemperatures}
        onChange={(checked) => onChange('nozzleTemperatures', checked)}
      />
      <PrinterCardSettingsRow
        title="Bed temp"
        description="Show the heated bed temperature on each printer card."
        checked={value.bedTemperature}
        onChange={(checked) => onChange('bedTemperature', checked)}
      />
      <PrinterCardSettingsRow
        title="Chamber temp"
        description="Show chamber temperature when the printer reports one."
        checked={value.chamberTemperature}
        onChange={(checked) => onChange('chamberTemperature', checked)}
      />
      <PrinterCardSettingsRow
        title="Print speed"
        description="Show the printer speed profile chip on each card."
        checked={value.printSpeed}
        onChange={(checked) => onChange('printSpeed', checked)}
      />
      <PrinterCardSettingsRow
        title="Door state"
        description="Show a door open or closed chip on supported printers."
        checked={value.doorState}
        onChange={(checked) => onChange('doorState', checked)}
      />
      <PrinterCardSettingsRow
        title="Duct state"
        description="Show the reported duct mode chip on supported printers."
        checked={value.ductState}
        onChange={(checked) => onChange('ductState', checked)}
      />
      <PrinterCardSettingsRow
        title="AMS cards"
        description="Show AMS units and external spool cards on printer cards."
        checked={value.amsCards}
        onChange={(checked) => onChange('amsCards', checked)}
      />
      <PrinterCardSettingsRow
        title="Footer controls"
        description="Show the action row with light, print, pause, resume, and stop controls."
        checked={value.footerControls}
        onChange={(checked) => onChange('footerControls', checked)}
      />
    </Stack>
  )
}
