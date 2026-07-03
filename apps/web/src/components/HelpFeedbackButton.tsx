/**
 * App-shell footer entry point for support: a quiet button that opens the
 * shared {@link HelpFeedbackDialog}. Rendered on every app page (footer
 * trailing slot in App.tsx) so help is always one click away.
 */
import { useState } from 'react'
import { Button } from '@mui/joy'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import { HelpFeedbackDialog } from './HelpFeedbackDialog'

export function HelpFeedbackButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="plain"
        color="neutral"
        size="sm"
        startDecorator={<HelpOutlineRoundedIcon fontSize="small" />}
        onClick={() => setOpen(true)}
        sx={{ color: 'neutral.500', fontWeight: 'md' }}
      >
        Help &amp; feedback
      </Button>
      {open && <HelpFeedbackDialog onClose={() => setOpen(false)} />}
    </>
  )
}
