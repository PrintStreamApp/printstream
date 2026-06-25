/**
 * Overflow actions for a spool row/card: edit, adjust remaining, unload, and
 * recycle. Pure presentational leaf — the parent view owns the mutations and
 * confirmations and passes handlers in.
 */
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded'
import EjectRoundedIcon from '@mui/icons-material/EjectRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import { Dropdown, IconButton, ListDivider, Menu, MenuButton, MenuItem } from '@mui/joy'
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
  return (
    <Dropdown>
      <MenuButton slots={{ root: IconButton }} slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'aria-label': 'Spool actions' } }}>
        <MoreVertRoundedIcon />
      </MenuButton>
      <Menu size="sm" placement="bottom-end">
        <MenuItem onClick={() => onEdit(spool)}><EditRoundedIcon /> Edit</MenuItem>
        <MenuItem onClick={() => onAdjust(spool)}><StraightenRoundedIcon /> Adjust remaining</MenuItem>
        {spool.loadedPrinterId && (
          <MenuItem onClick={() => onUnassign(spool)}><EjectRoundedIcon /> Unload from printer</MenuItem>
        )}
        <ListDivider />
        <MenuItem color="danger" onClick={() => onRecycle(spool)}>
          <DeleteOutlineRoundedIcon /> Move to recycle bin
        </MenuItem>
      </Menu>
    </Dropdown>
  )
}
