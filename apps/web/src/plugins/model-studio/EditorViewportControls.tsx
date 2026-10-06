/**
 * Owns the viewport's undo/help strip and the desktop/phone tool rails.
 * Actions stay with EditorView, which owns history, selection, and scene state;
 * this component keeps their placement and responsive visibility together.
 */
import React, { type ComponentProps } from 'react'
import { Box, ButtonGroup, IconButton, Tooltip } from '@mui/joy'
import AttachFileRoundedIcon from '@mui/icons-material/AttachFileRounded'
import RedoRoundedIcon from '@mui/icons-material/RedoRounded'
import TableRowsRoundedIcon from '@mui/icons-material/TableRowsRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import ViewSidebarRoundedIcon from '@mui/icons-material/ViewSidebarRounded'
import { FullScreenDialogButton } from '../../components/DialogPresentationToggles'
import { HorizontalOverflowScroller } from '../../components/HorizontalOverflowScroller'
import { safeFullscreenControlTop } from '../../lib/dialogPresentation'
import { GizmoToolbar, KeyboardHelpButton, RAIL_HOVER_LABEL_SX } from './editorPanels'
import { EDITOR_CHROME_Z_INDEX } from './editorLayers'

interface EditorViewportControlsProps {
  setStripElement: (element: HTMLElement | null) => void
  isMobile: boolean
  showEditorChrome: boolean
  fullScreen: boolean
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onToggleFullScreen: (next: boolean) => void
  canUndo: boolean
  canRedo: boolean
  controlsBusy: boolean
  onUndo: () => void
  onRedo: () => void
  hasProcessSettings: boolean
  hasProject: boolean
  onOpenParameterTable: () => void
  onOpenProjectFiles: () => void
  onOpenEditorSettings: () => void
  mode: ComponentProps<typeof GizmoToolbar>['mode']
  selectedKey: string | null
  arrangeDisabled: boolean
  onChangeMode: ComponentProps<typeof GizmoToolbar>['onChange']
  onDropToBed: ComponentProps<typeof GizmoToolbar>['onDropToBed']
  onAutoOrient: ComponentProps<typeof GizmoToolbar>['onAutoOrient']
  onArrangeAll: ComponentProps<typeof GizmoToolbar>['onArrangeAll']
}

/** Keep the same actions reachable on desktop and phones with one shared tool configuration. */
export function EditorViewportControls(props: EditorViewportControlsProps) {
  const {
    setStripElement, isMobile, showEditorChrome, fullScreen, sidebarCollapsed,
    onToggleSidebar, onToggleFullScreen, canUndo, canRedo, controlsBusy,
    onUndo, onRedo, hasProcessSettings, hasProject, onOpenParameterTable,
    onOpenProjectFiles, onOpenEditorSettings, mode, selectedKey,
    arrangeDisabled, onChangeMode, onDropToBed, onAutoOrient, onArrangeAll
  } = props
  const toolProps = {
    mode,
    disabled: !selectedKey || controlsBusy,
    busy: controlsBusy,
    arrangeDisabled,
    onChange: onChangeMode,
    onDropToBed,
    onAutoOrient,
    onArrangeAll
  }

  return (
    <>
      <Box
        ref={setStripElement}
        sx={{
          position: 'absolute',
          // Phones wrap this strip; desktop tools move to the left rail.
          top: safeFullscreenControlTop(fullScreen, 8),
          left: { xs: 8, sm: 'auto' },
          right: 8,
          zIndex: EDITOR_CHROME_Z_INDEX,
          display: 'flex',
          gap: 1,
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: { xs: 'center', sm: 'flex-end' },
          // Let clicks and drags reach the model through the full-width strip.
          pointerEvents: 'none',
          '& > *': { pointerEvents: 'auto' }
        }}
      >
        <ButtonGroup size="sm" variant="outlined" aria-label="Undo and redo">
          <Tooltip title="Undo (Ctrl/Cmd+Z)">
            <IconButton onClick={onUndo} disabled={!canUndo || controlsBusy} aria-label="Undo">
              <UndoRoundedIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Redo (Ctrl/Cmd+Shift+Z)">
            <IconButton onClick={onRedo} disabled={!canRedo || controlsBusy} aria-label="Redo">
              <RedoRoundedIcon />
            </IconButton>
          </Tooltip>
        </ButtonGroup>
        {/* The sidebar is a tab on phones and the viewport already fills a 3D-only view. */}
        {!isMobile && showEditorChrome && (
          <Tooltip title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
            <IconButton
              size="sm"
              variant="soft"
              color="neutral"
              aria-pressed={sidebarCollapsed}
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              <ViewSidebarRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
        <FullScreenDialogButton
          active={fullScreen}
          onToggle={onToggleFullScreen}
          contentLabel="3D only"
          variant="soft"
        />
        {showEditorChrome && hasProcessSettings && (
          <Tooltip title="Parameter table">
            <IconButton
              size="sm"
              variant="soft"
              color="neutral"
              onClick={onOpenParameterTable}
              aria-label="Parameter table"
            >
              <TableRowsRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
        {showEditorChrome && hasProject && (
          <Tooltip title="Project files and details">
            <IconButton
              size="sm"
              variant="soft"
              color="neutral"
              onClick={onOpenProjectFiles}
              aria-label="Project files and details"
            >
              <AttachFileRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
        {showEditorChrome && (
          <Tooltip title="Editor settings">
            <IconButton
              size="sm"
              variant="soft"
              color="neutral"
              onClick={onOpenEditorSettings}
              aria-label="Editor settings"
            >
              <TuneRoundedIcon />
            </IconButton>
          </Tooltip>
        )}
        {showEditorChrome && <KeyboardHelpButton />}
      </Box>
      {/* Desktop keeps modal tools down the left edge, clear of the transform readout. */}
      {!isMobile && (
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: EDITOR_CHROME_Z_INDEX,
            ...RAIL_HOVER_LABEL_SX
          }}
        >
          <GizmoToolbar {...toolProps} orientation="vertical" />
        </Box>
      )}
      {/* Phones use the bottom row so the tools and undo/help both fit without wrapping. */}
      {isMobile && (
        <Box
          sx={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 8,
            zIndex: EDITOR_CHROME_Z_INDEX,
            pointerEvents: 'auto'
          }}
        >
          <HorizontalOverflowScroller
            fadeColor="#0d1322"
            fadeWidth={40}
            sx={{ minWidth: 0 }}
            scrollerSx={{ display: 'flex', gap: 1, alignItems: 'center' }}
          >
            <GizmoToolbar {...toolProps} />
          </HorizontalOverflowScroller>
        </Box>
      )}
    </>
  )
}
