/**
 * The printer-card header overflow ("⋮") menu: edit, refresh, settings, controls, calibration,
 * storage browsing, and the external-spool toggle, each gated by the caller's permissions and the
 * printer's online state. Plugins can inject extra items via the `printer.card.menuItems` slot.
 * Extracted from PrinterCard; printer operations remain caller-owned. The tag dialog is mounted
 * outside the menu so closing the menu does not discard it.
 */
import { useTagAssignment } from '../../hooks/useTagAssignment'
import { Dropdown, IconButton, Menu, MenuButton, MenuItem } from '@mui/joy'
import type { Printer } from '@printstream/shared'
import { MoreVertIcon } from './PrinterGlyphs'
import { PluginSlot } from '../../plugin/PluginSlot'

export interface PrinterCardActionsMenuProps {
  printer: Printer
  isOnline: boolean
  canManagePrinter: boolean
  canControlPrinter: boolean
  canOpenAmsSettings: boolean
  canShowCalibrate: boolean
  canCalibrate: boolean
  canViewPrinterStorage: boolean
  canToggleExternalSpools: boolean
  showExternalSpools: boolean
  onEdit: (printer: Printer) => void
  onRefresh: () => void
  onOpenPrinterSettings: () => void
  onOpenControls: () => void
  onOpenAmsSettings: () => void
  onOpenCalibration: () => void
  onBrowseFiles: () => void
  onBrowseModels: () => void
  onBrowseTimelapses: () => void
  onToggleExternalSpools: () => void
}

export function PrinterCardActionsMenu({
  printer,
  isOnline,
  canManagePrinter,
  canControlPrinter,
  canOpenAmsSettings,
  canShowCalibrate,
  canCalibrate,
  canViewPrinterStorage,
  canToggleExternalSpools,
  showExternalSpools,
  onEdit,
  onRefresh,
  onOpenPrinterSettings,
  onOpenControls,
  onOpenAmsSettings,
  onOpenCalibration,
  onBrowseFiles,
  onBrowseModels,
  onBrowseTimelapses,
  onToggleExternalSpools
}: PrinterCardActionsMenuProps) {
  const { openTags, tagDialog } = useTagAssignment('printer')
  return (
    <>
    {tagDialog}
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': 'Actions' } }}
      >
        <MoreVertIcon />
      </MenuButton>
      <Menu size="sm" placement="bottom-end">
        {canManagePrinter && <MenuItem onClick={() => onEdit(printer)}>Edit</MenuItem>}
        {canManagePrinter && <MenuItem onClick={() => openTags([printer.id])}>Assign tags</MenuItem>}
        {canControlPrinter && <MenuItem disabled={!isOnline} onClick={onRefresh}>Refresh</MenuItem>}
        {canManagePrinter && <MenuItem disabled={!isOnline} onClick={onOpenPrinterSettings}>Printer settings…</MenuItem>}
        <PluginSlot name="printer.card.menuItems" context={{ printerId: printer.id, printerName: printer.name, isOnline }} />
        {canControlPrinter && <MenuItem disabled={!isOnline} onClick={onOpenControls}>Controls…</MenuItem>}
        {canOpenAmsSettings && <MenuItem disabled={!isOnline} onClick={onOpenAmsSettings}>AMS settings…</MenuItem>}
        {canControlPrinter && canShowCalibrate && (
          <MenuItem disabled={!canCalibrate} onClick={onOpenCalibration}>Calibrate…</MenuItem>
        )}
        {canViewPrinterStorage && <MenuItem disabled={!isOnline} onClick={onBrowseFiles}>Browse files…</MenuItem>}
        {canViewPrinterStorage && <MenuItem disabled={!isOnline} onClick={onBrowseModels}>Browse models…</MenuItem>}
        {canViewPrinterStorage && <MenuItem disabled={!isOnline} onClick={onBrowseTimelapses}>Browse timelapses…</MenuItem>}
        {canToggleExternalSpools && (
          <MenuItem onClick={onToggleExternalSpools}>
            {showExternalSpools ? 'Hide external spool' : 'Show external spool'}
          </MenuItem>
        )}
      </Menu>
    </Dropdown>
    </>
  )
}
