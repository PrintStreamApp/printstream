/**
 * Editor settings dialog — preferences that belong to the 3D editor itself.
 *
 * Only the viewport preferences live here. Slicing-preset management used to sit alongside them
 * as a second tab; it moved to `SlicingPresetsDialog` once the slice sidebar grew its own "Manage"
 * action, because managing presets is a task of its own rather than an editor preference — and
 * hosting it here meant nesting the manager's kind tabs inside this dialog's tab strip. This dialog
 * does not link to it: both are `BackAwareModal`s, and closing one to open the other pops the
 * history entry the first pushed, which shuts the second again the moment it appears.
 *
 * The viewport cards are self-contained (`settings/EditorViewportSettingsCards.tsx`) and own both
 * tiers of the standard setting shape — a workspace default plus a per-device override — so this
 * dialog only arranges them.
 *
 * Core, not part of the model-studio plugin, because the editor (a plugin) opens it and core must
 * never import a plugin.
 */
import { Button, DialogActions, Stack, Typography } from '@mui/joy'
import type { EditorSidebarSideSetting } from '@printstream/shared'
import { BackAwareModal } from '../BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../ScrollableDialog'
import { BuildPlateSettingCard, PanelPositionSettingCard } from '../settings/EditorViewportSettingsCards'

/** Which side of the 3D viewport the editor's settings/objects panel sits on. */
export type EditorSidebarSide = EditorSidebarSideSetting

export function EditorSettingsDialog({ open, onClose }: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 640, width: '100%' }}>
        <Typography level="h4">Editor settings</Typography>
        <ScrollableDialogBody sx={{ mt: 1.5, px: 0 }}>
          <Stack spacing={1.5}>
            <BuildPlateSettingCard />
            <PanelPositionSettingCard />
          </Stack>
        </ScrollableDialogBody>
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
