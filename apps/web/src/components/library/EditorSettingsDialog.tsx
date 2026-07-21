/**
 * Editor/slicing settings dialog — the home for settings that belong to the 3D editor and the
 * slice flow rather than to the workspace.
 *
 * Slicer profile management lives here (it moved out of Settings > Slicing: managing presets is
 * something you do WHILE preparing a print, not a workspace administration task), alongside the
 * model studio's viewport preferences.
 *
 * The viewport cards are self-contained (`settings/EditorViewportSettingsCards.tsx`) and own both
 * tiers of the standard setting shape — a workspace default plus a per-device override — so this
 * dialog only decides whether the tab is shown at all.
 *
 * Core, not part of the model-studio plugin, because both the editor (a plugin) and the shared
 * slice settings panel (core) open it — core must never import a plugin.
 */
import { useState } from 'react'
import { Box, Button, DialogActions, Stack, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy'
import type { EditorSidebarSideSetting } from '@printstream/shared'
import { BackAwareModal } from '../BackAwareModal'
import { ScrollableModalDialog } from '../ScrollableDialog'
import { SlicingProfilesSettingsSection } from '../settings/slicing-profiles/SlicingProfilesSection'
import { BuildPlateSettingCard, PanelPositionSettingCard } from '../settings/EditorViewportSettingsCards'

/**
 * The scrolling tab panel, mirroring `ScrollableDialogBody`'s scrollbar treatment so this dialog
 * feels like every other one: a stable gutter (no width jump when switching to a tab that does
 * not overflow) and {@link SCROLL_GUTTER_SX} on the content so rows do not sit flush against the
 * scrollbar. Padding stays 0 here — the panel is the scroll container the pinned toolbar sticks
 * to, and any padding-top would push the pinned toolbar down by that much.
 */
const SCROLLING_TAB_PANEL_SX = {
  p: 0,
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  scrollbarGutter: 'stable'
} as const

/** Content inset matching `ScrollableDialogBody`'s inner wrapper. */
const SCROLL_GUTTER_SX = { minWidth: 0, pr: 0.75 } as const

/** The dialog's tabs, by identity rather than position — see the `tab` state. */
type EditorSettingsTab = 'viewport' | 'profiles'

/** Which side of the 3D viewport the editor's settings/objects panel sits on. */
export type EditorSidebarSide = EditorSidebarSideSetting

export function EditorSettingsDialog({ open, onClose, viewport = false }: {
  open: boolean
  onClose: () => void
  /**
   * Whether to offer the Viewport tab. True from the 3D editor; false elsewhere (e.g. the slim
   * slice dialog), which has no viewport to configure. The tab's cards read and write their own
   * state, so nothing is passed through here.
   */
  viewport?: boolean
}): JSX.Element {
  // Tabs carry explicit string values rather than positional indices, so reordering them cannot
  // silently repoint a panel. Opens on the leftmost tab that exists: Viewport for the editor,
  // Slicer profiles for callers with no viewport to configure.
  const [tab, setTab] = useState<EditorSettingsTab>(viewport ? 'viewport' : 'profiles')
  return (
    <BackAwareModal open={open} onClose={onClose}>
      <ScrollableModalDialog sx={{ maxWidth: 860, width: '100%' }}>
        <Typography level="h4">Editor settings</Typography>
        {/*
          ScrollableModalDialog is a flex column with overflowY hidden, and ScrollableDialogBody
          only scrolls when its ancestors pass a bounded height down. Tabs/TabPanel sit between
          the two, so both have to flex and allow shrinking — without this the tab content is
          simply clipped and nothing scrolls.
        */}
        <Tabs
          value={tab}
          onChange={(_event, value) => setTab(value === 'viewport' ? 'viewport' : 'profiles')}
          sx={{ mt: 1, bgcolor: 'transparent', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        >
          <TabList size="sm">
            {viewport && <Tab value="viewport">Viewport</Tab>}
            <Tab value="profiles">Slicer profiles</Tab>
          </TabList>
          {/* The panel IS the scroll region. A nested ScrollableDialogBody does not grow inside
              it, so it took a fixed slice of the dialog and left the rest of the height empty. */}
          <TabPanel value="profiles" sx={SCROLLING_TAB_PANEL_SX}>
            <Box sx={SCROLL_GUTTER_SX}>
              {/* The panel is the scroll container here, so the pinned toolbar sticks to its top. */}
              <SlicingProfilesSettingsSection stickyTop={0} stickySurface="background.surface" />
            </Box>
          </TabPanel>
          {viewport && (
            <TabPanel value="viewport" sx={SCROLLING_TAB_PANEL_SX}>
                <Stack spacing={1.5} sx={SCROLL_GUTTER_SX}>
                  <BuildPlateSettingCard />
                  <PanelPositionSettingCard />
                </Stack>
            </TabPanel>
          )}
        </Tabs>
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
