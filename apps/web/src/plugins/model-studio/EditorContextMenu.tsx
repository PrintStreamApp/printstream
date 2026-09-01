/**
 * Right-click context menu for editor objects. Single object: duplicate / clone-with-a-count /
 * split /
 * assemble, rename, replace from library or file, export (STL download / STL to library /
 * single-object 3MF project download or to library; items appear per granted library
 * permission), repair mesh, add part volumes
 * (negative/modifier/blocker), change material, object settings, centre / drop / reset /
 * mirror transforms, convert from inch or meter, move to another plate, and delete. Multi-selection (the clicked
 * object is a member): a reduced bulk menu (BambuStudio-style), duplicate, assemble,
 * export as STL (merged into one, or one file per object), change material, set
 * printable / skip, object settings, move to plate, delete, each applied to the
 * whole selection.
 *
 * Presentational: every action is a callback and the parent owns the menu's open state
 * and the mutations. The menu closes itself after each action. The "Change material"
 * submenu swaps the menu content in place (see {@link ContextMenuBackItem}).
 */
import { Fragment, useState, type MutableRefObject } from 'react'
import { ListDivider, ListItemDecorator, Menu, MenuItem } from '@mui/joy'
import type { SceneEditPartSubtype } from '@printstream/shared'
import { CONVERTIBLE_MODEL_UNITS, type ConvertibleModelUnit } from '@printstream/shared/three-mf'
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
import GridOnRoundedIcon from '@mui/icons-material/GridOnRounded'
import LayersRoundedIcon from '@mui/icons-material/LayersRounded'
import LineWeightRoundedIcon from '@mui/icons-material/LineWeightRounded'
import IosShareRoundedIcon from '@mui/icons-material/IosShareRounded'
import LibraryAddRoundedIcon from '@mui/icons-material/LibraryAddRounded'
import MergeTypeRoundedIcon from '@mui/icons-material/MergeTypeRounded'
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded'
import PaletteRoundedIcon from '@mui/icons-material/PaletteRounded'
import PrintRoundedIcon from '@mui/icons-material/PrintRounded'
import PrintDisabledRoundedIcon from '@mui/icons-material/PrintDisabledRounded'
import AlignHorizontalLeftRoundedIcon from '@mui/icons-material/AlignHorizontalLeftRounded'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded'
import ThreeSixtyRoundedIcon from '@mui/icons-material/ThreeSixtyRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import VerticalAlignBottomRoundedIcon from '@mui/icons-material/VerticalAlignBottomRounded'
import { ADDED_PART_SUBTYPES, addedPartLabel } from './lib/addedParts'
import { ALIGN_DISTRIBUTE_OPERATIONS, minimumMembersFor, type AlignDistributeOperation } from './lib/alignDistribute'
import type { PrimitiveKind } from './lib/primitives'
import { CONTEXT_MENU_POPPER_MODIFIERS, CONTEXT_MENU_SX, type ContextMenuAnchor } from './contextMenuChrome'
import { AddPartSourceMenuItems, ContextMenuBackItem, FilamentMenuItems } from './contextMenuItems'
import type { FilamentOption } from './EditorView'

type Axis = 'x' | 'y' | 'z'

/**
 * Which list the menu is showing. Submenus swap the content in place rather than cascading a
 * nested popup, so the view carries whatever the submenu needs: the add-part list needs to know
 * which volume type the user picked before choosing its geometry.
 */
type MenuView =
  | { kind: 'root' }
  | { kind: 'material' }
  | { kind: 'export' }
  | { kind: 'addPart'; subtype: SceneEditPartSubtype }
  | { kind: 'align' }
  | { kind: 'split' }

export interface EditorContextMenuProps {
  /** Open position + the right-clicked object's instance key. */
  contextMenu: ContextMenuAnchor & { key: string }
  /** The menu's listbox element, for the parent's click-away/Escape wiring. */
  listboxRef: MutableRefObject<HTMLDivElement | null>
  onClose: () => void
  /**
   * How many objects the actions apply to (the whole multi-selection when the clicked
   * object is a member, else 1). Above 1 the menu shows the reduced bulk item set.
   */
  selectionCount: number
  /** Linked copy (BambuStudio's "+"): another instance of the same object. */
  onDuplicate: (key: string) => void
  /** Independent copy (BambuStudio's Ctrl+C/V): a new object that diverges from the source. */
  onDuplicateIndependent: (key: string) => void
  /**
   * BambuStudio's "Clone" (Ctrl+K): prompt for a count and make that many independent copies.
   * Independent, not linked, because Studio's clone is copy-then-paste-N-times.
   */
  onCloneWithCount: (key: string) => void
  /** BambuStudio's "Fill bed with copies": linked copies packed into the plate's free space. */
  onFillBedWithCopies: (key: string) => void
  /**
   * Align or distribute the selection (BambuStudio's Align/Distribute submenu). Multi-selection
   * only: aligning one object to itself is a no-op, which is why the row does not appear for one.
   */
  onAlignDistribute: (operation: AlignDistributeOperation) => void
  /** Unlink this copy from the others. Absent when the model has no other copies. */
  onMakeIndependent?: (key: string) => void
  /** Rename the object (single selection only): the object list rows have no rename shortcut. */
  onRename: (key: string) => void
  onSplitToObjects: (key: string) => void
  /**
   * BambuStudio's "Split -> To parts": the same connected-shell split, but the shells stay inside
   * ONE object as its parts instead of becoming objects of their own.
   */
  onSplitToParts: (key: string) => void
  /** Whether the "Assemble N objects" item shows (a multi-selection includes this object). */
  canAssemble: boolean
  assembleCount: number
  onAssemble: () => void
  /** Omitted on a host with no library (`EditorImportStore.supportsLibrarySource`), which hides the row. */
  onReplaceFromLibrary?: (key: string) => void
  onReplaceFromFile: (key: string) => void
  /**
   * Export targets (BambuStudio's "Export as one STL" / "Export as STLs…", plus the
   * beyond-parity single-object 3MF project export, download or save to library,
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
  /** Whether "Repair mesh" applies: any model with an identity, including an unsaved import. */
  canRepair: boolean
  /** Mark this object's mesh for repair on save (welds cracked vertices, drops junk facets). */
  onRepairMesh: (key: string) => void
  /** Already marked for repair this session: the item reports that instead of re-marking. */
  isRepairMarked: boolean
  /** Add a part of `subtype` built from a generated primitive. */
  onAddPartVolume: (key: string, subtype: SceneEditPartSubtype, shape: PrimitiveKind) => void
  /** Add a part of `subtype` from a model file on the user's device (opens the file picker). */
  onAddPartFromFile: (key: string, subtype: SceneEditPartSubtype) => void
  /**
   * Add a part of `subtype` from a library model (opens the library picker). Omitted on a host
   * with no library (`EditorImportStore.supportsLibrarySource`), which hides the row.
   */
  onAddPartFromLibrary?: (key: string, subtype: SceneEditPartSubtype) => void
  /** Project materials for the "Change material" submenu; hidden when empty. */
  filamentOptions: ReadonlyArray<FilamentOption>
  /** Assign one material to every part of every selected object. */
  onChangeMaterial: (filamentId: number) => void
  /** Set the selection's Printable flag. Handles one object as readily as many. */
  onSetPrintable: (printable: boolean) => void
  /**
   * Whether the CLICKED instance is currently printable, so the single-object menu can offer the
   * one action that applies rather than both. Null when the caller cannot resolve it, which hides
   * the item instead of guessing a state and mislabelling the action.
   *
   * Only the single-object branch uses it: a multi-selection can be mixed, so that branch keeps its
   * two explicit items rather than deriving one label from several instances.
   */
  printable?: boolean | null
  /** Open per-object process settings for the selection; absent without slice settings. */
  onEditObjectSettings?: () => void
  /** BambuStudio's height range modifiers: per-object Z bands with their own settings. */
  onEditHeightRanges?: (key: string) => void
  /** BambuStudio's variable layer height: the per-object thickness profile. */
  onEditLayerHeight?: (key: string) => void
  /** Centre/reset/mirror act on the SELECTED object (parity with the old inline menu). */
  onCenterOnPlate: () => void
  onDropToBed: () => void
  onResetRotation: () => void
  onResetScale: () => void
  onMirror: (axis: Axis) => void
  /**
   * BambuStudio's "Convert from inch" / "Convert from meter": rescale a model whose author worked
   * in another unit. Applies to the whole selection, as Studio's does, which is why it takes no key.
   */
  onConvertUnits: (unit: ConvertibleModelUnit) => void
  /**
   * BambuStudio's "Scale to print volume": one uniform factor so the selection fits the machine,
   * height included. Omitted when the project states no printable height, which hides the row
   * rather than offering a fit that could only be checked in X and Y.
   */
  onScaleToPrintVolume?: () => void
  /** Plates other than the active one (for the move-to-plate items). */
  otherPlates: Array<{ index: number }>
  onMoveToPlate: (key: string, plateIndex: number) => void
  onDelete: (key: string) => void
}

export function EditorContextMenu({
  contextMenu, listboxRef, onClose, selectionCount, onDuplicate, onDuplicateIndependent, onCloneWithCount, onFillBedWithCopies, onAlignDistribute, onMakeIndependent, onRename, onSplitToObjects, canAssemble,
  assembleCount, onAssemble, onSplitToParts, onReplaceFromLibrary, onReplaceFromFile, onExportDownload, onExportToLibrary,
  onExportProjectDownload, onExportProjectToLibrary, onExportMergedDownload, onExportMergedToLibrary, onExportSeparateDownload,
  onExportSeparateToLibrary, canRepair, onRepairMesh,
  isRepairMarked, onAddPartVolume, onAddPartFromFile, onAddPartFromLibrary,
  filamentOptions, onChangeMaterial, onSetPrintable, printable, onEditObjectSettings, onEditHeightRanges, onEditLayerHeight, onCenterOnPlate,
  onDropToBed, onResetRotation, onResetScale, onMirror, onConvertUnits, onScaleToPrintVolume, otherPlates, onMoveToPlate, onDelete
}: EditorContextMenuProps) {
  const { key } = contextMenu
  const [view, setView] = useState<MenuView>({ kind: 'root' })
  const multi = selectionCount > 1
  const suffix = multi ? ` (${selectionCount} objects)` : ''
  const changeMaterialItem = filamentOptions.length > 0 && (
    <MenuItem onClick={(event) => { event.stopPropagation(); setView({ kind: 'material' }) }}>
      <ListItemDecorator><PaletteRoundedIcon /></ListItemDecorator>
      Change material{suffix}…
    </MenuItem>
  )
  /**
   * Printability for ONE object, offered as the single action that applies rather than as both.
   *
   * The only affordance used to be the Switch on the sidebar row, which is invisible to anyone
   * working in the viewport, so a right-click could not skip a model. BambuStudio carries a
   * Printable item in its object menu too (`append_menu_item_printable`), beside the per-object
   * settings items, which is where this sits.
   *
   * The multi branch keeps its two explicit items instead: a mixed selection has no single state to
   * label, and "Set printable" / "Skip printing" says plainly what it will do to all of them.
   */
  const printableItem = !multi && printable != null && (
    <MenuItem onClick={() => { onSetPrintable(!printable); onClose() }}>
      <ListItemDecorator>{printable ? <PrintDisabledRoundedIcon /> : <PrintRoundedIcon />}</ListItemDecorator>
      {printable ? 'Skip printing' : 'Set printable'}
    </MenuItem>
  )
  /**
   * BambuStudio carries these in the object, part AND multi-selection menus, so they sit outside
   * the single/multi branch here too. The suffix names the whole selection for the same reason
   * every other bulk row does: a 25.4x rescale of five objects should not read as one.
   */
  const scaleToPrintVolumeItem = onScaleToPrintVolume && (
    <MenuItem onClick={() => { onScaleToPrintVolume(); onClose() }}>
      <ListItemDecorator><OpenInFullRoundedIcon /></ListItemDecorator>
      Scale to print volume{suffix}
    </MenuItem>
  )
  const convertUnitItems = CONVERTIBLE_MODEL_UNITS.map((unit) => (
    <MenuItem key={`convert-${unit}`} onClick={() => { onConvertUnits(unit); onClose() }}>
      <ListItemDecorator><StraightenRoundedIcon /></ListItemDecorator>
      Convert from {unit}{suffix}
    </MenuItem>
  ))
  const cloneItem = (
    <MenuItem onClick={() => { onClose(); onCloneWithCount(key) }}>
      <ListItemDecorator><ContentCopyRoundedIcon /></ListItemDecorator>
      Clone{suffix}…
    </MenuItem>
  )
  const objectSettingsItem = onEditObjectSettings && (
    <MenuItem onClick={() => { onClose(); onEditObjectSettings() }}>
      <ListItemDecorator><TuneRoundedIcon /></ListItemDecorator>
      Object settings{suffix}…
    </MenuItem>
  )
  // Single-object only: bands are per object, so an N-object selection has no shared answer.
  const heightRangesItem = onEditHeightRanges && !multi && (
    <MenuItem onClick={() => { onClose(); onEditHeightRanges(key) }}>
      <ListItemDecorator><LayersRoundedIcon /></ListItemDecorator>
      Height ranges…
    </MenuItem>
  )
  const layerHeightItem = onEditLayerHeight && !multi && (
    <MenuItem onClick={() => { onClose(); onEditLayerHeight(key) }}>
      <ListItemDecorator><LineWeightRoundedIcon /></ListItemDecorator>
      Variable layer height…
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
      placement={contextMenu.align === 'end' ? 'bottom-end' : 'bottom-start'}
      modifiers={CONTEXT_MENU_POPPER_MODIFIERS}
      sx={CONTEXT_MENU_SX}
    >
      {view.kind === 'material' ? (
        <>
          <ContextMenuBackItem label={`Change material${suffix}`} onBack={() => setView({ kind: 'root' })} />
          <ListDivider />
          <FilamentMenuItems options={filamentOptions} onPick={(filamentId) => { onChangeMaterial(filamentId); onClose() }} />
        </>
      ) : view.kind === 'addPart' ? (
        <>
          <ContextMenuBackItem label={`Add ${addedPartLabel(view.subtype).toLowerCase()}`} onBack={() => setView({ kind: 'root' })} />
          <ListDivider />
          <AddPartSourceMenuItems
            onPickPrimitive={(shape) => { onAddPartVolume(key, view.subtype, shape); onClose() }}
            onPickFile={() => { onClose(); onAddPartFromFile(key, view.subtype) }}
            onPickLibrary={onAddPartFromLibrary ? () => { onClose(); onAddPartFromLibrary(key, view.subtype) } : undefined}
          />
        </>
      ) : view.kind === 'split' ? (
        <>
          <ContextMenuBackItem label="Split" onBack={() => setView({ kind: 'root' })} />
          <ListDivider />
          <MenuItem onClick={() => { onSplitToObjects(key); onClose() }}>
            <ListItemDecorator><CallSplitRoundedIcon /></ListItemDecorator>
            To objects
          </MenuItem>
          <MenuItem onClick={() => { onSplitToParts(key); onClose() }}>
            <ListItemDecorator><CallSplitRoundedIcon /></ListItemDecorator>
            To parts
          </MenuItem>
        </>
      ) : view.kind === 'align' ? (
        <>
          <ContextMenuBackItem label={`Align/Distribute${suffix}`} onBack={() => setView({ kind: 'root' })} />
          <ListDivider />
          {ALIGN_DISTRIBUTE_OPERATIONS.map((operation, index) => (
            <Fragment key={operation.id}>
              {/* Studio's own grouping: the three distribute rows, then one block per axis. A
                  Fragment, not a wrapper element: Joy's Menu walks its children for keyboard
                  navigation and a div between it and the MenuItems breaks arrow-key focus. */}
              {index > 0 && index % 3 === 0 && <ListDivider />}
              <MenuItem
                disabled={selectionCount < minimumMembersFor(operation)}
                onClick={() => { onAlignDistribute(operation); onClose() }}
              >
                {operation.label}
              </MenuItem>
            </Fragment>
          ))}
        </>
      ) : view.kind === 'export' ? (
        multi ? (
          <>
            <ContextMenuBackItem label={`Export as STL${suffix}`} onBack={() => setView({ kind: 'root' })} />
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
            <ContextMenuBackItem label="Export" onBack={() => setView({ kind: 'root' })} />
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
            Duplicate{suffix} (linked)
          </MenuItem>
          <MenuItem onClick={() => { onDuplicateIndependent(key); onClose() }}>
            <ListItemDecorator><ContentCopyRoundedIcon /></ListItemDecorator>
            Duplicate as independent copies{suffix}
          </MenuItem>
          {cloneItem}
          {canAssemble && (
            <MenuItem onClick={() => { onAssemble(); onClose() }}>
              <ListItemDecorator><MergeTypeRoundedIcon /></ListItemDecorator>
              Assemble {assembleCount} objects
            </MenuItem>
          )}
          {(onExportMergedDownload || onExportMergedToLibrary || onExportSeparateDownload || onExportSeparateToLibrary) && (
            <MenuItem onClick={(event) => { event.stopPropagation(); setView({ kind: 'export' }) }}>
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
          <ListDivider />
          {/* Centring has real N-object semantics: the selection moves as a unit and keeps its
              relative layout (BambuStudio's `Selection::center`), so it belongs here rather than
              being one of the per-object placement items below. */}
          <MenuItem onClick={() => { onCenterOnPlate(); onClose() }}>
            <ListItemDecorator><CenterFocusStrongRoundedIcon /></ListItemDecorator>
            Center on plate{suffix}
          </MenuItem>
          <MenuItem onClick={(event) => { event.stopPropagation(); setView({ kind: 'align' }) }}>
            <ListItemDecorator><AlignHorizontalLeftRoundedIcon /></ListItemDecorator>
            Align/Distribute…
          </MenuItem>
          {scaleToPrintVolumeItem}
          {convertUnitItems}
          {moveToPlateItems}
          <ListDivider />
          {deleteItem}
        </>
      ) : (
        <>
          <MenuItem onClick={() => { onDuplicate(key); onClose() }}>
            <ListItemDecorator><ContentCopyRoundedIcon /></ListItemDecorator>
            Duplicate (linked)
          </MenuItem>
          <MenuItem onClick={() => { onDuplicateIndependent(key); onClose() }}>
            <ListItemDecorator><ContentCopyRoundedIcon /></ListItemDecorator>
            Duplicate as independent copy
          </MenuItem>
          {cloneItem}
          <MenuItem onClick={() => { onClose(); onFillBedWithCopies(key) }}>
            <ListItemDecorator><GridOnRoundedIcon /></ListItemDecorator>
            Fill bed with copies
          </MenuItem>
          {onMakeIndependent && (
            <MenuItem onClick={() => { onMakeIndependent(key); onClose() }}>
              <ListItemDecorator><CallSplitRoundedIcon /></ListItemDecorator>
              Make this copy independent
            </MenuItem>
          )}
          <MenuItem onClick={() => { onClose(); onRename(key) }}>
            <ListItemDecorator><DriveFileRenameOutlineRoundedIcon /></ListItemDecorator>
            Rename…
          </MenuItem>
          <MenuItem onClick={(event) => { event.stopPropagation(); setView({ kind: 'split' }) }}>
            <ListItemDecorator><CallSplitRoundedIcon /></ListItemDecorator>
            Split…
          </MenuItem>
          {canAssemble && (
            <MenuItem onClick={() => { onAssemble(); onClose() }}>
              <ListItemDecorator><MergeTypeRoundedIcon /></ListItemDecorator>
              Assemble {assembleCount} objects
            </MenuItem>
          )}
          <ListDivider />
          {onReplaceFromLibrary && (
            <MenuItem onClick={() => { onClose(); onReplaceFromLibrary(key) }}>
              <ListItemDecorator><SwapHorizRoundedIcon /></ListItemDecorator>
              Replace from library…
            </MenuItem>
          )}
          <MenuItem onClick={() => { onClose(); onReplaceFromFile(key) }}>
            <ListItemDecorator><SwapHorizRoundedIcon /></ListItemDecorator>
            Replace from file…
          </MenuItem>
          {(onExportDownload || onExportToLibrary || onExportProjectToLibrary) && (
            <MenuItem onClick={(event) => { event.stopPropagation(); setView({ kind: 'export' }) }}>
              <ListItemDecorator><IosShareRoundedIcon /></ListItemDecorator>
              Export…
            </MenuItem>
          )}
          {canRepair && !multi && (
            <MenuItem disabled={isRepairMarked} onClick={() => { onClose(); onRepairMesh(key) }}>
              <ListItemDecorator><AutoFixHighRoundedIcon /></ListItemDecorator>
              {isRepairMarked ? 'Mesh repair runs on save' : 'Repair mesh'}
            </MenuItem>
          )}
          <ListDivider />
          {ADDED_PART_SUBTYPES.map((subtype) => (
            <MenuItem key={subtype} onClick={(event) => { event.stopPropagation(); setView({ kind: 'addPart', subtype }) }}>
              <ListItemDecorator><CategoryRoundedIcon /></ListItemDecorator>
              Add {addedPartLabel(subtype).toLowerCase()}…
            </MenuItem>
          ))}
          {(changeMaterialItem || objectSettingsItem || heightRangesItem || layerHeightItem || printableItem) && (
            <>
              <ListDivider />
              {changeMaterialItem}
              {objectSettingsItem}
              {heightRangesItem}
              {layerHeightItem}
              {printableItem}
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
          {scaleToPrintVolumeItem}
          {convertUnitItems}
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
