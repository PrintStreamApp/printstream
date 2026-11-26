/** App-navigation menu entry that opens the About dialog (BRAND-8). */
import React from 'react'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { ListItemDecorator, MenuItem } from '@mui/joy'

export function AboutMenuItem({ onOpen }: { onOpen: () => void }) {
  return (
    <MenuItem onClick={onOpen}>
      <ListItemDecorator><InfoOutlinedIcon fontSize="small" /></ListItemDecorator>
      About
    </MenuItem>
  )
}
