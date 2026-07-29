/**
 * Slicing presets dialog — the manager for the BambuStudio presets a workspace has uploaded
 * (printer, material, process).
 *
 * Split out of the editor settings dialog once the slice sidebar grew its own "Manage" action:
 * managing presets is a job of its own, and stacking it as a tab inside a settings dialog meant
 * nesting the manager's kind tabs inside a second tab strip. It is opened straight from the
 * sidebar's Manage buttons, and from `EditorSettingsDialog`'s footer for anyone who went looking
 * under the gear.
 *
 * Core, not part of the model-studio plugin, because both the editor (a plugin) and the shared
 * slice settings panel (core) open it — core must never import a plugin.
 */
import { Box, Button, DialogActions, Typography } from '@mui/joy'
import { useScrollbarGutter } from '../../hooks/useScrollbarGutter'
import { BackAwareModal } from '../BackAwareModal'
import { ScrollableModalDialog } from '../ScrollableDialog'
import { SlicingPresetsSettingsSection } from '../settings/slicing-presets/SlicingPresetsSection'

export function SlicingPresetsDialog({ open, onClose }: {
  open: boolean
  /**
   * Callers refresh their slicing catalogue here: the editor renders from a snapshot taken at
   * open, so a preset edited in this dialog reaches it only because closing says so.
   */
  onClose: () => void
}): JSX.Element {
  // The dialog body is the scroll container the manager's toolbar pins to, so it takes the
  // scrollbar treatment directly rather than through ScrollableDialogBody.
  const gutter = useScrollbarGutter()
  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 860, width: '100%' }}>
        <Typography level="h4">Slicing presets</Typography>
        <Box
          ref={gutter.scrollRef}
          sx={{ flex: 1, minHeight: 0, minWidth: 0, overflowX: 'hidden', mt: 1.5, ...gutter.scrollAreaSx }}
        >
          <Box sx={gutter.contentSx}>
            <SlicingPresetsSettingsSection stickyTop={0} stickySurface="background.surface" />
          </Box>
        </Box>
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
