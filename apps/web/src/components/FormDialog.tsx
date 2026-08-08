/**
 * The shell every "fill this in and submit" dialog shares.
 *
 * Chrome only — the dialog surface, close affordance, title, description, error
 * banner and footer. Callers supply the fields, usually grouped with
 * {@link DialogSection}.
 *
 * Exists because the same shell was being retyped per dialog and drifting each
 * time: one grew a `ModalClose` and the others did not, errors appeared as a
 * danger `Alert` in one and bare red text in another, and — the reason this is
 * a correctness fix rather than a tidy-up — the footer's button ORDER was
 * inverted in a newer dialog, putting Cancel where every other dialog in the
 * app puts the confirm action. Joy's `DialogActions` lays its children out in
 * source order, so that is decided by whoever types the JSX, which is exactly
 * the kind of decision that should not be retyped.
 *
 * The footer follows the app convention documented in the web development notes:
 * confirm rightmost, dismiss to its left.
 */
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Typography
} from '@mui/joy'
import type { ReactNode } from 'react'

export function FormDialog({
  open = true,
  onClose,
  busy = false,
  title,
  description,
  error,
  submitLabel,
  onSubmit,
  submitDisabled = false,
  width = 'min(640px, 100%)',
  children
}: {
  open?: boolean
  onClose: () => void
  /** Blocks the dismiss paths while a submit is in flight, and spins the confirm. */
  busy?: boolean
  title: ReactNode
  description?: ReactNode
  error?: ReactNode
  submitLabel: ReactNode
  onSubmit: () => void
  submitDisabled?: boolean
  width?: string
  children: ReactNode
}) {
  return (
    <Modal open={open} onClose={() => { if (!busy) onClose() }}>
      <ModalDialog variant="outlined" sx={{ width }}>
        <ModalClose disabled={busy} />
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            {description ? (
              <Typography level="body-sm" textColor="text.tertiary">{description}</Typography>
            ) : null}
            {children}
            {error ? (
              <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                {error}
              </Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={submitDisabled} onClick={onSubmit}>{submitLabel}</Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}
