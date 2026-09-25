/**
 * "Print sent" confirmation for a dispatch made from a dialog that another dialog
 * sits behind. Shown by `PrintModal` when a caller passes `showSentConfirmation`
 * (today only the slice-results dialog).
 *
 * Why a dialog and not the usual toast: `DispatchToasts` already reports every send,
 * but when the print setup closes back onto ANOTHER open dialog, that toast lands
 * beside a modal the user is still reading and goes unnoticed, so the send looks like
 * it did nothing. This states only that the print left; the grouped sending toast keeps
 * owning progress, cancel and retry, and is neither replaced nor suppressed.
 */
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded'
import { Alert, Button, DialogActions, DialogContent, DialogTitle, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy'
import { BackAwareModal as Modal } from '../BackAwareModal'
import { formatPrintSentMessage } from './printSentCopy'

export function PrintSentDialog({ fileName, printerNames, onClose }: {
  /** Display name of the dispatched file (already formatted for display). */
  fileName: string
  /** Display names of the printers that accepted the send, in dispatch order. */
  printerNames: string[]
  onClose: () => void
}) {
  return (
    <Modal open onClose={onClose}>
      <ModalDialog variant="outlined" role="alertdialog" sx={{ width: { xs: '95vw', sm: 460 }, maxWidth: '95vw' }}>
        <ModalClose />
        <DialogTitle>Print sent</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25}>
            <Alert color="success" variant="soft" startDecorator={<CheckCircleRoundedIcon />}>
              {formatPrintSentMessage(fileName, printerNames)}
            </Alert>
            <Typography level="body-sm" textColor="text.tertiary">
              Printing starts once the file finishes uploading. You can follow it in the sending
              notification, or on the Jobs page.
            </Typography>
          </Stack>
        </DialogContent>
        {/* No shortcut to the Jobs page: this dialog only appears over another open dialog
            (the slice results, and the 3D editor behind it), and navigating would tear that
            session down to show progress the sending toast is already reporting. */}
        <DialogActions>
          <Button autoFocus onClick={onClose}>Done</Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}
