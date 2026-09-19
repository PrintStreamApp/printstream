/** App-navigation menu entry that requests the shared help and feedback dialog. */
import React from 'react'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import { ListItemDecorator, MenuItem } from '@mui/joy'

export function HelpFeedbackMenuItem({ onOpen }: { onOpen: () => void }) {
  return (
    <MenuItem onClick={onOpen}>
      <ListItemDecorator><HelpOutlineRoundedIcon fontSize="small" /></ListItemDecorator>
      Help &amp; feedback
    </MenuItem>
  )
}
