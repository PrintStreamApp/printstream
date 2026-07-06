/**
 * Right-click context menu for the selected PART(S) of one object (BambuStudio's
 * multi-volume menu): change type, change material, and per-part process settings,
 * each applied to every selected part.
 *
 * Presentational: the parent owns the part selection, the menu's open state (shared
 * click-away/Escape wiring with the object context menu), and the bulk mutations.
 * Submenus swap the menu's content in place (see {@link ContextMenuBackItem}).
 */
import { useState, type MutableRefObject } from 'react'
import { ListDivider, ListItemDecorator, Menu, MenuItem } from '@mui/joy'
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import type { SceneEditPartSubtype } from '@printstream/shared'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
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
  /** Hidden when the project has no materials. */
  filamentOptions: ReadonlyArray<FilamentOption>
  onChangeMaterial: (filamentId: number) => void
  /** Opens the per-part process settings dialog for the selection; absent without slice settings. */
  onEditSettings?: () => void
}

export function EditorPartContextMenu({
  contextMenu, count, listboxRef, onClose, onChangeType, filamentOptions, onChangeMaterial, onEditSettings
}: EditorPartContextMenuProps) {
  const [view, setView] = useState<'root' | 'type' | 'material'>('root')
  const suffix = count > 1 ? ` (${count} parts)` : ''
  return (
    <Menu
      open
      ref={listboxRef}
      onClose={onClose}
      anchorEl={{ getBoundingClientRect: () => new DOMRect(contextMenu.x, contextMenu.y, 0, 0) }}
      placement="bottom-start"
      sx={{
        zIndex: (theme) => theme.zIndex.tooltip,
        [`& .${listItemDecoratorClasses.root}`]: { minInlineSize: '1.75rem' },
        '& svg': { fontSize: '1.25rem' }
      }}
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
      ) : (
        <>
          <MenuItem onClick={(event) => { event.stopPropagation(); setView('type') }}>
            <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
            Change type{suffix}…
          </MenuItem>
          {filamentOptions.length > 0 && (
            <MenuItem onClick={(event) => { event.stopPropagation(); setView('material') }}>
              <ListItemDecorator><PaletteRoundedIcon /></ListItemDecorator>
              Change material{suffix}…
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
