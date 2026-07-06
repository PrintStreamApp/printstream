import { useEffect, useState } from 'react'
import {
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Input,
  ModalDialog,
  Typography
} from '@mui/joy'
import React from 'react'
import { BackAwareModal as Modal } from './BackAwareModal'

export function PasskeyRegistrationDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  loading,
  error,
  onClose,
  onConfirm
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  loading: boolean
  error: string | null
  onClose: () => void
  onConfirm: (nickname: string | null) => void
}) {
  const [nickname, setNickname] = useState('')

  useEffect(() => {
    if (!open) {
      setNickname('')
    }
  }, [open])

  return (
    <Modal open={open} onClose={() => { if (!loading) onClose() }}>
      <ModalDialog variant="outlined" sx={{ width: 'min(520px, 100%)' }}>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" textColor="text.tertiary">
            {description}
          </Typography>
        </DialogContent>

        <FormControl size="sm">
          <FormLabel>Passkey name</FormLabel>
          <Input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Desk laptop"
            autoFocus
            disabled={loading}
          />
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.75 }}>
            Optional. If you leave this blank, PrintStream will show a device-based default label.
          </Typography>
        </FormControl>

        {error && (
          <Typography level="body-sm" color="danger">
            {error}
          </Typography>
        )}

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button loading={loading} onClick={() => onConfirm(nickname.trim() ? nickname.trim() : null)}>
            {confirmLabel}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}