import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { Alert, Button, DialogActions, DialogContent, DialogTitle, ModalDialog, Typography, type ColorPaletteProp } from '@mui/joy'
import type { ReactNode } from 'react'
import { BackAwareModal as Modal } from './BackAwareModal'

export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  color = 'danger',
  confirmDecorator = <DeleteRoundedIcon />,
  pending = false,
  error = null,
  onClose,
  onConfirm
}: {
  open: boolean
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  color?: ColorPaletteProp
  confirmDecorator?: ReactNode
  pending?: boolean
  error?: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open={open} onClose={() => { if (!pending) onClose() }}>
      <ModalDialog variant="outlined" role="alertdialog" sx={{ width: { xs: '95vw', sm: 480 }, maxWidth: '95vw' }}>
        {title ? <DialogTitle>{title}</DialogTitle> : null}
        <DialogContent>
          {typeof description === 'string' ? (
            <Typography level="body-sm">{description}</Typography>
          ) : (
            description
          )}
          {error && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />} sx={{ mt: 1.5 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant="solid"
            color={color}
            loading={pending}
            startDecorator={confirmDecorator}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}