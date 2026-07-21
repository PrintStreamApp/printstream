/**
 * Right-click context menu for the selected PART(S) of one object (BambuStudio's
 * multi-volume menu): change type, change material, export the selection as one STL
 * (download or save to the library; items appear per granted library permission),
 * and per-part process settings, each applied to every selected part.
 *
 * Presentational: the parent owns the part selection, the menu's open state (shared
 * click-away/Escape wiring with the object context menu), and the bulk mutations.
 * Submenus swap the menu's content in place (see {@link ContextMenuBackItem}).
 */
import { useState, type MutableRefObject } from 'react'
import { ListDivider, ListItemDecorator, Menu, MenuItem } from '@mui/joy'
import type { SceneEditPartSubtype } from '@printstream/shared'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import FileDownloadRoundedIcon from '@mui/icons-material/FileDownloadRounded'
import IosShareRoundedIcon from '@mui/icons-material/IosShareRounded'
import LibraryAddRoundedIcon from '@mui/icons-material/LibraryAddRounded'
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import { CONTEXT_MENU_POPPER_MODIFIERS, CONTEXT_MENU_SX } from './contextMenuChrome'
import { ContextMenuBackItem, FilamentMenuItems, PartTypeMenuItems } from './contextMenuItems'
import type { FilamentOption } from './EditorView'

export interface EditorPartContextMenuProps {
  /** Open position (viewport coordinates). */
  contextMenu: { x: number; y: number }
  /** How many parts the actions apply to (labels pluralize). */
  count: number
  /** The menu's listbox element, for the parent's click-away/Escape wiring. */
  listboxRef: MutableRefObject<HTMLDivElement | null>
  onClose: () => void
  onChangeType: (subtype: SceneEditPartSubtype) => void
  /** Hidden when the project has no materials, or when no selected part can hold one. */
  filamentOptions: ReadonlyArray<FilamentOption>
  /**
   * Whether any selected part accepts a material at all. False for a selection made up purely of
   * support blockers/enforcers and negative volumes, which have none (BambuStudio shows no
   * extruder for them either) — the item is hidden rather than offered as a no-op.
   */
  materialAssignable: boolean
  onChangeMaterial: (filamentId: number) => void
  /**
   * Export-the-selected-parts-as-one-STL targets. Each is present only when the user
   * holds the matching library permission (download / upload); when both are absent
   * the Export item is hidden.
   */
  onExportDownload?: () => void
  onExportToLibrary?: () => void
  /** Opens the per-part process settings dialog for the selection; absent without slice settings. */
  onEditSettings?: () => void
}

export function EditorPartContextMenu({
  contextMenu, count, listboxRef, onClose, onChangeType, filamentOptions, materialAssignable,
  onChangeMaterial, onExportDownload, onExportToLibrary, onEditSettings
}: EditorPartContextMenuProps) {
  const [view, setView] = useState<'root' | 'type' | 'material' | 'export'>('root')
  const suffix = count > 1 ? ` (${count} parts)` : ''
  return (
    <Menu
      open
      ref={listboxRef}
      onClose={onClose}
      anchorEl={{ getBoundingClientRect: () => new DOMRect(contextMenu.x, contextMenu.y, 0, 0) }}
      placement="bottom-start"
      modifiers={CONTEXT_MENU_POPPER_MODIFIERS}
      sx={CONTEXT_MENU_SX}
    >
      {view === 'type' ? (
        <>
          <ContextMenuBackItem label={`Change type${suffix}`} onBack={() => setView('root')} />
          <ListDivider />
          <PartTypeMenuItems onPick={(subtype) => { onChangeType(subtype); onClose() }} />
        </>
      ) : view === 'material' ? (
        <>
          <ContextMenuBackItem label={`Change material${suffix}`} onBack={() => setView('root')} />
          <ListDivider />
          <FilamentMenuItems options={filamentOptions} onPick={(filamentId) => { onChangeMaterial(filamentId); onClose() }} />
        </>
      ) : view === 'export' ? (
        <>
          <ContextMenuBackItem label={`Export as STL${suffix}`} onBack={() => setView('root')} />
          <ListDivider />
          {onExportDownload && (
            <MenuItem onClick={() => { onClose(); onExportDownload() }}>
              <ListItemDecorator><FileDownloadRoundedIcon /></ListItemDecorator>
              Download
            </MenuItem>
          )}
          {onExportToLibrary && (
            <MenuItem onClick={() => { onClose(); onExportToLibrary() }}>
              <ListItemDecorator><LibraryAddRoundedIcon /></ListItemDecorator>
              Save to library…
            </MenuItem>
          )}
        </>
      ) : (
        <>
          <MenuItem onClick={(event) => { event.stopPropagation(); setView('type') }}>
            <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
            Change type{suffix}…
          </MenuItem>
          {filamentOptions.length > 0 && materialAssignable && (
            <MenuItem onClick={(event) => { event.stopPropagation(); setView('material') }}>
              <ListItemDecorator><PaletteRoundedIcon /></ListItemDecorator>
              Change material{suffix}…
            </MenuItem>
          )}
          {(onExportDownload || onExportToLibrary) && (
            <MenuItem onClick={(event) => { event.stopPropagation(); setView('export') }}>
              <ListItemDecorator><IosShareRoundedIcon /></ListItemDecorator>
              Export as STL{suffix}…
            </MenuItem>
          )}
          {onEditSettings && (
            <>
              <ListDivider />
              <MenuItem onClick={() => { onClose(); onEditSettings() }}>
                <ListItemDecorator><TuneRoundedIcon /></ListItemDecorator>
                Part settings{suffix}…
              </MenuItem>
            </>
          )}
        </>
      )}
    </Menu>
  )
}
