/** App-navigation menu entry that opens the shared help and feedback dialog. */
import React, { useState } from 'react'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import { ListItemDecorator, MenuItem } from '@mui/joy'
import { HelpFeedbackDialog } from './HelpFeedbackDialog'

export function HelpFeedbackMenuItem() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <MenuItem onClick={() => setOpen(true)}>
        <ListItemDecorator><HelpOutlineRoundedIcon fontSize="small" /></ListItemDecorator>
        Help &amp; feedback
      </MenuItem>
      {open ? <HelpFeedbackDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}
