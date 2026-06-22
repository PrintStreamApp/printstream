/**
 * Right-click context menu for an editor object: duplicate / split / assemble, replace from
 * library or file, add part volumes (negative/modifier/blocker), centre / drop / reset / mirror
 * transforms, move to another plate, and delete.
 *
 * Presentational: every action is a callback and the parent owns the menu's open state and the
 * mutations. The menu closes itself after each action.
 */
import type { MutableRefObject } from 'react'
import { ListDivider, ListItemDecorator, Menu, MenuItem } from '@mui/joy'
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import type { SceneEditAddedPartSubtype } from '@printstream/shared'
import AspectRatioRoundedIcon from '@mui/icons-material/AspectRatioRounded'
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded'
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded'
import CenterFocusStrongRoundedIcon from '@mui/icons-material/CenterFocusStrongRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import DriveFileMoveRoundedIcon from '@mui/icons-material/DriveFileMoveRounded'
import FlipRoundedIcon from '@mui/icons-material/FlipRounded'
import MergeTypeRoundedIcon from '@mui/icons-material/MergeTypeRounded'
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded'
import ThreeSixtyRoundedIcon from '@mui/icons-material/ThreeSixtyRounded'
import VerticalAlignBottomRoundedIcon from '@mui/icons-material/VerticalAlignBottomRounded'
import { ADDED_PART_SPECS, ADDED_PART_SUBTYPES } from './editorGeometry'

type Axis = 'x' | 'y' | 'z'

export interface EditorContextMenuProps {
  /** Open position + the right-clicked object's instance key. */
  contextMenu: { x: number; y: number; key: string }
  /** The menu's listbox element, for the parent's click-away/Escape wiring. */
  listboxRef: MutableRefObject<HTMLDivElement | null>
  onClose: () => void
  onDuplicate: (key: string) => void
  onSplitToObjects: (key: string) => void
  /** Whether the "Assemble N objects" item shows (a multi-selection includes this object). */
  canAssemble: boolean
  assembleCount: number
  onAssemble: () => void
  onReplaceFromLibrary: (key: string) => void
  onReplaceFromFile: (key: string) => void
  /** In-project object (not an imported mesh) — gates the add-part-volume items. */
  isObject: boolean
  onAddPartVolume: (key: string, subtype: SceneEditAddedPartSubtype) => void
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
  contextMenu, listboxRef, onClose, onDuplicate, onSplitToObjects, canAssemble, assembleCount,
  onAssemble, onReplaceFromLibrary, onReplaceFromFile, isObject, onAddPartVolume, onCenterOnPlate,
  onDropToBed, onResetRotation, onResetScale, onMirror, otherPlates, onMoveToPlate, onDelete
}: EditorContextMenuProps) {
  const { key } = contextMenu
  return (
    <Menu
      open
      ref={listboxRef}
      onClose={onClose}
      anchorEl={{ getBoundingClientRect: () => new DOMRect(contextMenu.x, contextMenu.y, 0, 0) }}
      placement="bottom-start"
      sx={{
        zIndex: (theme) => theme.zIndex.tooltip,
        // In a vertical menu Joy's ListItemDecorator only reserves height, not width, so
        // icons of differing glyph widths leave the labels ragged. Pin a fixed icon column
        // and a uniform icon size so every label starts at the same x.
        [`& .${listItemDecoratorClasses.root}`]: { minInlineSize: '1.75rem' },
        '& svg': { fontSize: '1.25rem' }
      }}
    >
      <MenuItem onClick={() => { onDuplicate(key); onClose() }}>
        <ListItemDecorator><ContentCopyRoundedIcon /></ListItemDecorator>
        Duplicate
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
      {otherPlates.length > 0 && (
        <>
          <ListDivider />
          {otherPlates.map((plate) => (
            <MenuItem key={`move-${plate.index}`} onClick={() => { onMoveToPlate(key, plate.index); onClose() }}>
              <ListItemDecorator><DriveFileMoveRoundedIcon /></ListItemDecorator>
              Move to plate {plate.index}
            </MenuItem>
          ))}
        </>
      )}
      <ListDivider />
      <MenuItem color="danger" onClick={() => { onDelete(key); onClose() }}>
        <ListItemDecorator><DeleteRoundedIcon /></ListItemDecorator>
        Delete
      </MenuItem>
    </Menu>
  )
}
