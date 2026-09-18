/**
 * Overflow actions for a spool row/card: edit, adjust remaining, unload, and
 * recycle. Pure presentational leaf: the parent view owns the mutations and
 * confirmations and passes handlers in.
 */
import { useEntityTags } from '../../hooks/useEntityTags'
import { useTagAssignment } from '../../hooks/useTagAssignment'
import LabelIcon from '@mui/icons-material/LabelOutlined'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import EjectRoundedIcon from '@mui/icons-material/EjectRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import { Dropdown, IconButton, ListDivider, ListItemDecorator, Menu, MenuButton, MenuItem } from '@mui/joy'
import type { FilamentSpool } from '@printstream/shared'

export function SpoolActionsMenu({
  spool,
  onEdit,
  onAdjust,
  onUnassign,
  onRecycle
}: {
  spool: FilamentSpool
  onEdit: (spool: FilamentSpool) => void
  onAdjust: (spool: FilamentSpool) => void
  onUnassign: (spool: FilamentSpool) => void
  onRecycle: (spool: FilamentSpool) => void
}) {
  const { openTags, tagDialog } = useTagAssignment('spool')
  const { canAssign } = useEntityTags('spool')
  return (
    <>
    {tagDialog}
    <Dropdown>
      <MenuButton slots={{ root: IconButton }} slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': 'Spool actions' } }}>
        <MoreVertRoundedIcon />
      </MenuButton>
      <Menu size="sm" placement="bottom-end">
        {canAssign && <MenuItem onClick={() => openTags([spool.id])}><ListItemDecorator><LabelIcon /></ListItemDecorator>Assign tags</MenuItem>}
        <MenuItem onClick={() => onEdit(spool)}>
          <ListItemDecorator><EditRoundedIcon /></ListItemDecorator>
          Edit
        </MenuItem>
        <MenuItem onClick={() => onAdjust(spool)}>
          <ListItemDecorator><StraightenRoundedIcon /></ListItemDecorator>
          Adjust remaining
        </MenuItem>
        {spool.loadedPrinterId && (
          <MenuItem onClick={() => onUnassign(spool)}>
            <ListItemDecorator><EjectRoundedIcon /></ListItemDecorator>
            Unload from printer
          </MenuItem>
        )}
        <ListDivider />
        <MenuItem color="danger" onClick={() => onRecycle(spool)}>
          <ListItemDecorator><DeleteOutlineRoundedIcon /></ListItemDecorator>
          Move to recycle bin
        </MenuItem>
      </Menu>
    </Dropdown>
    </>
  )
}
