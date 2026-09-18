/** Keeps printer compatibility overrides in a secondary dialog beside inventory actions. */
import { useState, type ReactNode } from 'react'
import { Button, DialogActions, DialogContent, DialogTitle, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy'
import { BackAwareModal } from './BackAwareModal'

/** Edits the parent draft only; the slot dialog's Save sends the settings to the printer. */
export function PrinterMaterialSettings({ error, children, libraryAction }: {
  error: string | null
  children: ReactNode
  libraryAction?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <Stack spacing={0.5}>
      <Stack direction="row" alignItems="stretch" sx={{
        gap: 1,
        width: '100%',
        display: 'grid',
        gridAutoFlow: 'column',
        gridAutoColumns: 'minmax(0, 1fr)',
        '& > *': { minWidth: 0 },
        '& > * > button': { width: '100%', height: '100%' }
      }}>
        {libraryAction}
        <Button variant="plain" size="sm" color={error ? 'danger' : 'primary'} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          Advanced
        </Button>
      </Stack>
      {error && <Typography level="body-xs" color="danger">Choose a compatible printer material in Advanced.</Typography>}
      <BackAwareModal open={open} onClose={() => setOpen(false)}>
        <ModalDialog variant="outlined" sx={{ width: 'min(440px, 100%)' }}>
          <ModalClose />
          <DialogTitle>Printer material settings</DialogTitle>
          <DialogContent>
            <Stack spacing={2}>
              <Typography level="body-sm">
                This is the material your printer understands. PrintStream chooses it automatically to set suitable temperatures. You can change it here without changing your filament details.
              </Typography>
              {children}
              <Typography level="body-xs" textColor="text.tertiary">Use Save in the filament dialog to send these settings to the printer.</Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </DialogActions>
        </ModalDialog>
      </BackAwareModal>
    </Stack>
  )
}
