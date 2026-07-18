/**
 * Right-click context menu for editor objects. Single object: duplicate / split /
 * assemble, rename, replace from library or file, export (STL download / STL to library /
 * single-object 3MF project download or to library; items appear per granted library
 * permission), repair mesh, add part volumes
 * (negative/modifier/blocker), change material, object settings, centre / drop / reset /
 * mirror transforms, move to another plate, and delete. Multi-selection (the clicked
 * object is a member): a reduced bulk menu (BambuStudio-style) — duplicate, assemble,
 * export as STL (merged into one, or one file per object), change material, set
 * printable / skip, object settings, move to plate, delete — each applied to the
 * whole selection.
 *
 * Presentational: every action is a callback and the parent owns the menu's open state
 * and the mutations. The menu closes itself after each action. The "Change material"
 * submenu swaps the menu content in place (see {@link ContextMenuBackItem}).
 */
import { useState, type MutableRefObject } from 'react'
import { ListDivider, ListItemDecorator, Menu, MenuItem } from '@mui/joy'
import type { SceneEditAddedPartSubtype } from '@printstream/shared'
import AspectRatioRoundedIcon from '@mui/icons-material/AspectRatioRounded'
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import CenterFocusStrongRoundedIcon from '@mui/icons-material/CenterFocusStrongRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import DriveFileRenameOutlineRoundedIcon from '@mui/icons-material/DriveFileRenameOutlineRounded'
import DriveFileMoveRoundedIcon from '@mui/icons-material/DriveFileMoveRounded'
import FileDownloadRoundedIcon from '@mui/icons-material/FileDownloadRounded'
import FlipRoundedIcon from '@mui/icons-material/FlipRounded'
import IosShareRoundedIcon from '@mui/icons-material/IosShareRounded'
import LibraryAddRoundedIcon from '@mui/icons-material/LibraryAddRounded'
import MergeTypeRoundedIcon from '@mui/icons-material/MergeTypeRounded'
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import PrintDisabledRoundedIcon from '@mui/icons-material/PrintDisabledRounded'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded'
import ThreeSixtyRoundedIcon from '@mui/icons-material/ThreeSixtyRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import VerticalAlignBottomRoundedIcon from '@mui/icons-material/VerticalAlignBottomRounded'
import { ADDED_PART_SPECS, ADDED_PART_SUBTYPES } from './editorGeometry'
import { CONTEXT_MENU_POPPER_MODIFIERS, CONTEXT_MENU_SX } from './contextMenuChrome'
import { ContextMenuBackItem, FilamentMenuItems } from './contextMenuItems'
import type { FilamentOption } from './EditorView'

type Axis = 'x' | 'y' | 'z'

export interface EditorContextMenuProps {
  /** Open position + the right-clicked object's instance key. */
  contextMenu: { x: number; y: number; key: string }
  /** The menu's listbox element, for the parent's click-away/Escape wiring. */
  listboxRef: MutableRefObject<HTMLDivElement | null>
  onClose: () => void
  /**
   * How many objects the actions apply to (the whole multi-selection when the clicked
   * object is a member, else 1). Above 1 the menu shows the reduced bulk item set.
   */
  selectionCount: number
  onDuplicate: (key: string) => void
  /** Rename the object (single selection only) — the object list rows have no rename shortcut. */
  onRename: (key: string) => void
  onSplitToObjects: (key: string) => void
  /** Whether the "Assemble N objects" item shows (a multi-selection includes this object). */
  canAssemble: boolean
  assembleCount: number
  onAssemble: () => void
  onReplaceFromLibrary: (key: string) => void
  onReplaceFromFile: (key: string) => void
  /**
   * Export targets (BambuStudio's "Export as one STL" / "Export as STLs…", plus the
   * beyond-parity single-object 3MF project export — download or save to library —
   * which keeps parts/materials/paint). Single selection uses the per-key handlers;
   * a multi-selection uses the merged pair (whole selection → one STL) plus the
   * separate pair (one STL per object). Each is present only when the user holds the
   * matching library permission (download / upload); when none is present the Export
   * item is hidden.
   */
  onExportDownload?: (key: string) => void
  onExportToLibrary?: (key: string) => void
  onExportProjectDownload?: (key: string) => void
  onExportProjectToLibrary?: (key: string) => void
  onExportMergedDownload?: () => void
  onExportMergedToLibrary?: () => void
  onExportSeparateDownload?: () => void
  onExportSeparateToLibrary?: () => void
  /** In-project object (not an imported mesh) — gates the add-part-volume + repair items. */
  isObject: boolean
  /** Mark this object's mesh for repair on save (welds cracked vertices, drops junk facets). */
  onRepairMesh: (key: string) => void
  /** Already marked for repair this session — the item reports that instead of re-marking. */
  isRepairMarked: boolean
  onAddPartVolume: (key: string, subtype: SceneEditAddedPartSubtype) => void
  /** Project materials for the "Change material" submenu; hidden when empty. */
  filamentOptions: ReadonlyArray<FilamentOption>
  /** Assign one material to every part of every selected object. */
  onChangeMaterial: (filamentId: number) => void
  /** Set the whole selection's Printable flag (multi-selection only). */
  onSetPrintable: (printable: boolean) => void
  /** Open per-object process settings for the selection; absent without slice settings. */
  onEditObjectSettings?: () => void
  /** Centre/reset/mirror act on the SELECTED object (parity with the old inline menu). */
  onCenterOnPlate: () => void
  onDropToBed: () => void
  onResetRotation: () => void
  onResetScale: () => void
  onMirror: (axis: Axis) => void
  /** Plates other than the active one (for the move-to-plate items). */
  otherPlates: Array<{ index: number }>
  onMoveToPlate: (key: string, plateIndex: number) => void
  onDelete: (key: string) => void
}

export function EditorContextMenu({
  contextMenu, listboxRef, onClose, selectionCount, onDuplicate, onRename, onSplitToObjects, canAssemble,
  assembleCount, onAssemble, onReplaceFromLibrary, onReplaceFromFile, onExportDownload, onExportToLibrary,
  onExportProjectDownload, onExportProjectToLibrary, onExportMergedDownload, onExportMergedToLibrary, onExportSeparateDownload,
  onExportSeparateToLibrary, isObject, onRepairMesh,
  isRepairMarked, onAddPartVolume,
  filamentOptions, onChangeMaterial, onSetPrintable, onEditObjectSettings, onCenterOnPlate,
  onDropToBed, onResetRotation, onResetScale, onMirror, otherPlates, onMoveToPlate, onDelete
}: EditorContextMenuProps) {
  const { key } = contextMenu
  const [view, setView] = useState<'root' | 'material' | 'export'>('root')
  const multi = selectionCount > 1
  const suffix = multi ? ` (${selectionCount} objects)` : ''
  const changeMaterialItem = filamentOptions.length > 0 && (
    <MenuItem onClick={(event) => { event.stopPropagation(); setView('material') }}>
      <ListItemDecorator><PaletteRoundedIcon /></ListItemDecorator>
      Change material{suffix}…
    </MenuItem>
  )
  const objectSettingsItem = onEditObjectSettings && (
    <MenuItem onClick={() => { onClose(); onEditObjectSettings() }}>
      <ListItemDecorator><TuneRoundedIcon /></ListItemDecorator>
      Object settings{suffix}…
    </MenuItem>
  )
  const moveToPlateItems = otherPlates.length > 0 && (
    <>
      <ListDivider />
      {otherPlates.map((plate) => (
        <MenuItem key={`move-${plate.index}`} onClick={() => { onMoveToPlate(key, plate.index); onClose() }}>
          <ListItemDecorator><DriveFileMoveRoundedIcon /></ListItemDecorator>
          Move to plate {plate.index}
        </MenuItem>
      ))}
    </>
  )
  const deleteItem = (
    <MenuItem color="danger" onClick={() => { onDelete(key); onClose() }}>
      <ListItemDecorator><DeleteRoundedIcon /></ListItemDecorator>
      Delete{suffix}
    </MenuItem>
  )
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
      {view === 'material' ? (
        <>
          <ContextMenuBackItem label={`Change material${suffix}`} onBack={() => setView('root')} />
          <ListDivider />
          <FilamentMenuItems options={filamentOptions} onPick={(filamentId) => { onChangeMaterial(filamentId); onClose() }} />
        </>
      ) : view === 'export' ? (
        multi ? (
          <>
            <ContextMenuBackItem label={`Export as STL${suffix}`} onBack={() => setView('root')} />
            <ListDivider />
            {onExportMergedDownload && (
              <MenuItem onClick={() => { onClose(); onExportMergedDownload() }}>
                <ListItemDecorator><FileDownloadRoundedIcon /></ListItemDecorator>
                Download as one STL
              </MenuItem>
            )}
            {onExportSeparateDownload && (
              <MenuItem onClick={() => { onClose(); onExportSeparateDownload() }}>
                <ListItemDecorator><FileDownloadRoundedIcon /></ListItemDecorator>
                Download as separate STLs
              </MenuItem>
            )}
            {onExportMergedToLibrary && (
              <MenuItem onClick={() => { onClose(); onExportMergedToLibrary() }}>
                <ListItemDecorator><LibraryAddRoundedIcon /></ListItemDecorator>
                Save one STL to library…
              </MenuItem>
            )}
            {onExportSeparateToLibrary && (
              <MenuItem onClick={() => { onClose(); onExportSeparateToLibrary() }}>
                <ListItemDecorator><LibraryAddRoundedIcon /></ListItemDecorator>
                Save separate STLs to library…
              </MenuItem>
            )}
          </>
        ) : (
          <>
            <ContextMenuBackItem label="Export" onBack={() => setView('root')} />
            <ListDivider />
            {onExportDownload && (
              <MenuItem onClick={() => { onClose(); onExportDownload(key) }}>
                <ListItemDecorator><FileDownloadRoundedIcon /></ListItemDecorator>
                Download STL
              </MenuItem>
            )}
            {onExportToLibrary && (
              <MenuItem onClick={() => { onClose(); onExportToLibrary(key) }}>
                <ListItemDecorator><LibraryAddRoundedIcon /></ListItemDecorator>
                Save STL to library…
              </MenuItem>
            )}
            {onExportProjectDownload && (
              <MenuItem onClick={() => { onClose(); onExportProjectDownload(key) }}>
                <ListItemDecorator><FileDownloadRoundedIcon /></ListItemDecorator>
                Download 3MF project
              </MenuItem>
            )}
            {onExportProjectToLibrary && (
              <MenuItem onClick={() => { onClose(); onExportProjectToLibrary(key) }}>
                <ListItemDecorator><LibraryAddRoundedIcon /></ListItemDecorator>
                Save 3MF project to library…
              </MenuItem>
            )}
          </>
        )
      ) : multi ? (
        // Bulk menu for a multi-selection (BambuStudio's multiple-object menu): only
        // actions with real N-object semantics; per-object items live in the single menu.
        <>
          <MenuItem onClick={() => { onDuplicate(key); onClose() }}>
            <ListItemDecorator><ContentCopyRoundedIcon /></ListItemDecorator>
            Duplicate{suffix}
          </MenuItem>
          {canAssemble && (
            <MenuItem onClick={() => { onAssemble(); onClose() }}>
              <ListItemDecorator><MergeTypeRoundedIcon /></ListItemDecorator>
              Assemble {assembleCount} objects
            </MenuItem>
          )}
          {(onExportMergedDownload || onExportMergedToLibrary || onExportSeparateDownload || onExportSeparateToLibrary) && (
            <MenuItem onClick={(event) => { event.stopPropagation(); setView('export') }}>
              <ListItemDecorator><IosShareRoundedIcon /></ListItemDecorator>
              Export as STL{suffix}…
            </MenuItem>
          )}
          <ListDivider />
          {changeMaterialItem}
          {objectSettingsItem}
          <MenuItem onClick={() => { onSetPrintable(true); onClose() }}>
            <ListItemDecorator><PrintRoundedIcon /></ListItemDecorator>
            Set printable{suffix}
          </MenuItem>
          <MenuItem onClick={() => { onSetPrintable(false); onClose() }}>
            <ListItemDecorator><PrintDisabledRoundedIcon /></ListItemDecorator>
            Skip printing{suffix}
          </MenuItem>
          {moveToPlateItems}
          <ListDivider />
          {deleteItem}
        </>
      ) : (
        <>
          <MenuItem onClick={() => { onDuplicate(key); onClose() }}>
            <ListItemDecorator><ContentCopyRoundedIcon /></ListItemDecorator>
            Duplicate
          </MenuItem>
          <MenuItem onClick={() => { onClose(); onRename(key) }}>
            <ListItemDecorator><DriveFileRenameOutlineRoundedIcon /></ListItemDecorator>
            Rename…
          </MenuItem>
          <MenuItem onClick={() => { onSplitToObjects(key); onClose() }}>
            <ListItemDecorator><CallSplitRoundedIcon /></ListItemDecorator>
            Split to objects
          </MenuItem>
          {canAssemble && (
            <MenuItem onClick={() => { onAssemble(); onClose() }}>
              <ListItemDecorator><MergeTypeRoundedIcon /></ListItemDecorator>
              Assemble {assembleCount} objects
            </MenuItem>
          )}
          <ListDivider />
          <MenuItem onClick={() => { onClose(); onReplaceFromLibrary(key) }}>
            <ListItemDecorator><SwapHorizRoundedIcon /></ListItemDecorator>
            Replace from library…
          </MenuItem>
          <MenuItem onClick={() => { onClose(); onReplaceFromFile(key) }}>
            <ListItemDecorator><SwapHorizRoundedIcon /></ListItemDecorator>
            Replace from file…
          </MenuItem>
          {(onExportDownload || onExportToLibrary || onExportProjectToLibrary) && (
            <MenuItem onClick={(event) => { event.stopPropagation(); setView('export') }}>
              <ListItemDecorator><IosShareRoundedIcon /></ListItemDecorator>
              Export…
            </MenuItem>
          )}
          {isObject && !multi && (
            <MenuItem disabled={isRepairMarked} onClick={() => { onClose(); onRepairMesh(key) }}>
              <ListItemDecorator><AutoFixHighRoundedIcon /></ListItemDecorator>
              {isRepairMarked ? 'Mesh repair runs on save' : 'Repair mesh'}
            </MenuItem>
          )}
          {isObject && (
            <>
              <ListDivider />
              {ADDED_PART_SUBTYPES.map((subtype) => (
                <MenuItem key={subtype} onClick={() => { onAddPartVolume(key, subtype); onClose() }}>
                  <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
                  Add {ADDED_PART_SPECS[subtype].label.toLowerCase()}
                </MenuItem>
              ))}
            </>
          )}
          {(changeMaterialItem || objectSettingsItem) && (
            <>
              <ListDivider />
              {changeMaterialItem}
              {objectSettingsItem}
            </>
          )}
          <ListDivider />
          <MenuItem onClick={() => { onCenterOnPlate(); onClose() }}>
            <ListItemDecorator><CenterFocusStrongRoundedIcon /></ListItemDecorator>
            Center on plate
          </MenuItem>
          <MenuItem onClick={() => { onDropToBed(); onClose() }}>
            <ListItemDecorator><VerticalAlignBottomRoundedIcon /></ListItemDecorator>
            Drop to bed
          </MenuItem>
          <MenuItem onClick={() => { onResetRotation(); onClose() }}>
            <ListItemDecorator><ThreeSixtyRoundedIcon /></ListItemDecorator>
            Reset rotation
          </MenuItem>
          <MenuItem onClick={() => { onResetScale(); onClose() }}>
            <ListItemDecorator><AspectRatioRoundedIcon /></ListItemDecorator>
            Reset scale
          </MenuItem>
          <ListDivider />
          {(['x', 'y', 'z'] as const).map((axis) => (
            <MenuItem key={`mirror-${axis}`} onClick={() => { onMirror(axis); onClose() }}>
              <ListItemDecorator><FlipRoundedIcon /></ListItemDecorator>
              Mirror {axis.toUpperCase()}
            </MenuItem>
          ))}
          {moveToPlateItems}
          <ListDivider />
          {deleteItem}
        </>
      )}
    </Menu>
  )
}
