/**
 * Editor/slicing settings dialog — the home for settings that belong to the 3D editor and the
 * slice flow rather than to the workspace.
 *
 * Slicer profile management lives here (it moved out of Settings > Slicing: managing presets is
 * something you do WHILE preparing a print, not a workspace administration task), alongside
 * viewport preferences contributed by the editor.
 *
 * Core, not part of the model-studio plugin, because both the editor (a plugin) and the shared
 * slice settings panel (core) open it — core must never import a plugin.
 */
import { useState } from 'react'
import { Box, Button, DialogActions, Option, Select, Stack, Switch, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy'
import type { ReactNode } from 'react'
import { BackAwareModal } from '../BackAwareModal'
import { ScrollableModalDialog } from '../ScrollableDialog'
import { SlicingProfilesSettingsSection } from '../settings/slicing-profiles/SlicingProfilesSection'

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
export type EditorSidebarSide = 'left' | 'right'

export interface EditorViewportSettings {
  /** Render BambuStudio's modelled build plate instead of the plain millimetre grid. */
  showBedModel: boolean
  onShowBedModelChange: (value: boolean) => void
  /** Sidebar side. Desktop only — the narrow layout always stacks the panel below the viewport. */
  sidebarSide: EditorSidebarSide
  onSidebarSideChange: (value: EditorSidebarSide) => void
}

export function EditorSettingsDialog({ open, onClose, viewport }: {
  open: boolean
  onClose: () => void
  /**
   * Viewport preferences, supplied by the 3D editor. Omitted elsewhere (e.g. the slim slice
   * dialog), where the Viewport tab has nothing to show and is hidden.
   */
  viewport?: EditorViewportSettings
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
                <Stack spacing={2} sx={SCROLL_GUTTER_SX}>
                  <ViewportSettingRow
                    title="3D build plate"
                    description="Show the printer’s modelled build plate instead of the plain grid. Turn it off for a plain grid on every printer, including those with no plate model."
                  >
                    <Switch
                      checked={viewport.showBedModel}
                      onChange={(event) => viewport.onShowBedModelChange(event.target.checked)}
                      slotProps={{ input: { 'aria-label': 'Show the 3D build plate' } }}
                    />
                  </ViewportSettingRow>
                  <ViewportSettingRow
                    title="Panel position"
                    description="Which side of the 3D view the settings and objects panel sits on. Narrow screens always stack it below the view."
                  >
                    <Select
                      size="sm"
                      value={viewport.sidebarSide}
                      onChange={(_event, value) => value && viewport.onSidebarSideChange(value)}
                      slotProps={{ button: { 'aria-label': 'Panel position' }, listbox: { disablePortal: true } }}
                      sx={{ minWidth: 120 }}
                    >
                      <Option value="left">Left</Option>
                      <Option value="right">Right</Option>
                    </Select>
                  </ViewportSettingRow>
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

/** One labelled viewport preference: title + helper copy on the left, its control on the right. */
function ViewportSettingRow({ title, description, children }: {
  title: string
  description: string
  children: ReactNode
}): JSX.Element {
  return (
    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
      <Stack spacing={0.25} sx={{ minWidth: 0 }}>
        <Typography level="title-sm">{title}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">{description}</Typography>
      </Stack>
      {children}
    </Stack>
  )
}
