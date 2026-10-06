/**
 * Owns the overview header's responsive actions and saved-view selector.
 * Route changes and dialog lifetimes remain with PrintersView.
 */
import { Box, Button, Divider, ListItemDecorator, MenuItem, Option, Select, Stack, Typography } from '@mui/joy'
import AddIcon from '@mui/icons-material/Add'
import FolderCopyRoundedIcon from '@mui/icons-material/FolderCopyRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded'
import type { PrinterView } from '@printstream/shared'
import { Printer3dRoundedIcon } from '../Printer3dRoundedIcon'
import { SplitButton } from '../SplitButton'
import { PluginSlot } from '../../plugin/PluginSlot'
import { formatPrinterViewSelectValue, OVERVIEW_VIEW_LABEL } from '../../lib/printersViewHelpers'
import { NEW_VIEW_OPTION_VALUE, OVERVIEW_VIEW_OPTION_VALUE } from '../../lib/printerViewConstants'

type SavedViewSelectProps = {
  activeViewId: string | null
  views: PrinterView[]
  defaultViewId: string | null
  isOverviewDefault: boolean
  onSelectView: (_event: unknown, value: string | null) => void
  mobile: boolean
}

/** Keep the desktop and mobile pickers' options and selected label in sync. */
function SavedPrinterViewSelect({
  activeViewId,
  views,
  defaultViewId,
  isOverviewDefault,
  onSelectView,
  mobile
}: SavedViewSelectProps) {
  return (
    <Select
      size="sm"
      value={activeViewId ?? OVERVIEW_VIEW_OPTION_VALUE}
      onChange={onSelectView}
      sx={mobile ? { flex: '1 1 0', minWidth: 0 } : { minWidth: 168, flex: '0 0 auto' }}
      renderValue={() => `View: ${formatPrinterViewSelectValue(activeViewId, views, defaultViewId, isOverviewDefault)}`}
      slotProps={{ button: { 'aria-label': 'Saved printer views' } }}
    >
      <Option value={NEW_VIEW_OPTION_VALUE}>
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
          <AddIcon fontSize="small" />
          <span>New view…</span>
        </Box>
      </Option>
      <Option value={OVERVIEW_VIEW_OPTION_VALUE}>
        {isOverviewDefault ? `${OVERVIEW_VIEW_LABEL} (Default)` : OVERVIEW_VIEW_LABEL}
      </Option>
      {views.map((view) => (
        <Option key={view.id} value={view.id}>
          {defaultViewId === view.id ? `${view.name} (Default)` : view.name}
        </Option>
      ))}
    </Select>
  )
}

/** Offer the same print sources at both responsive breakpoints. */
function PrintSourceButton({
  onPrintFromLibrary,
  onPrintFromLocalFile
}: {
  onPrintFromLibrary: () => void
  onPrintFromLocalFile: () => void
}) {
  return (
    <SplitButton
      size="sm"
      label="Print"
      ariaLabel="print"
      menuAriaLabel="More print sources"
      startDecorator={<PrintRoundedIcon />}
      onClick={onPrintFromLibrary}
      groupSx={{ flex: '0 0 auto', minWidth: 0 }}
    >
      <MenuItem onClick={onPrintFromLibrary}>
        <ListItemDecorator><FolderCopyRoundedIcon /></ListItemDecorator>
        Print from library…
      </MenuItem>
      <MenuItem onClick={onPrintFromLocalFile}>
        <ListItemDecorator><UploadFileRoundedIcon /></ListItemDecorator>
        Print from local file…
      </MenuItem>
      <PluginSlot name="printers.print.menu" />
    </SplitButton>
  )
}

/** Render overview actions while the page owns their route and modal effects. */
export function PrinterOverviewHeader({
  activeViewId,
  views,
  defaultViewId,
  isOverviewDefault,
  canManagePrinters,
  canDispatchPrints,
  hasBridges,
  onSelectView,
  onOpenViewSettings,
  onAddPrinter,
  onPrintFromLibrary,
  onPrintFromLocalFile
}: Omit<SavedViewSelectProps, 'mobile'> & {
  canManagePrinters: boolean
  canDispatchPrints: boolean
  hasBridges: boolean
  onOpenViewSettings: () => void
  onAddPrinter: () => void
  onPrintFromLibrary: () => void
  onPrintFromLocalFile: () => void
}) {
  const viewSelectProps = { activeViewId, views, defaultViewId, isOverviewDefault, onSelectView }

  return (
    <Stack spacing={1}>
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="space-between"
        sx={{ flexWrap: 'wrap' }}
      >
        <Typography level="h3" startDecorator={<Printer3dRoundedIcon />}>Printers</Typography>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ display: { xs: 'none', sm: 'flex' }, flexWrap: 'wrap', justifyContent: 'flex-end', ml: 'auto', '& > *': { minWidth: 0 } }}
        >
          <SavedPrinterViewSelect {...viewSelectProps} mobile={false} />
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            startDecorator={<TuneRoundedIcon />}
            onClick={onOpenViewSettings}
            sx={{ flex: '0 0 auto' }}
          >
            View settings
          </Button>
          {canManagePrinters && <Divider orientation="vertical" sx={{ alignSelf: 'stretch', mx: 0.25 }} />}
          {canManagePrinters && (
            <Button
              size="sm"
              aria-label="Add printer"
              startDecorator={<AddIcon />}
              sx={{ flex: '0 0 auto', minWidth: 0 }}
              disabled={!hasBridges}
              onClick={onAddPrinter}
            >
              Add
            </Button>
          )}
          {canDispatchPrints && <Divider orientation="vertical" sx={{ alignSelf: 'stretch', mx: 0.25 }} />}
          {canDispatchPrints && (
            <PrintSourceButton onPrintFromLibrary={onPrintFromLibrary} onPrintFromLocalFile={onPrintFromLocalFile} />
          )}
        </Stack>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ display: { xs: 'flex', sm: 'none' }, ml: 'auto', '& > *': { minWidth: 0 } }}
        >
          {canManagePrinters && (
            <Button
              size="sm"
              aria-label="Add printer"
              onClick={onAddPrinter}
              startDecorator={<AddIcon />}
              sx={{ flex: '0 0 auto' }}
            >
              Add
            </Button>
          )}
          {canDispatchPrints && (
            <PrintSourceButton onPrintFromLibrary={onPrintFromLibrary} onPrintFromLocalFile={onPrintFromLocalFile} />
          )}
        </Stack>
      </Stack>
      <Stack spacing={1} sx={{ display: { xs: 'flex', sm: 'none' }, width: '100%' }}>
        <Stack direction="row" spacing={1} sx={{ width: '100%', '& > *': { minWidth: 0 } }}>
          <SavedPrinterViewSelect {...viewSelectProps} mobile />
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            startDecorator={<TuneRoundedIcon />}
            onClick={onOpenViewSettings}
            sx={{ flex: '0 0 auto', minWidth: 132, px: 1.5 }}
          >
            View settings
          </Button>
        </Stack>
      </Stack>
    </Stack>
  )
}
