/**
 * Suspense fallback for the app's lazily-loaded DIALOGS.
 *
 * Every heavy dialog here is code-split, so the click that opens one is followed by a chunk
 * download before anything renders. With the `fallback={null}` these boundaries used to carry, the
 * screen showed literally nothing for that whole window — on the 3MF editor (~800KB of chunks:
 * EditorView + threeMfScene + BackAwareModal) that reads as a dead click, and users click again.
 * This renders the dialog's SHELL immediately instead, so the surface appears on the same frame as
 * the click and only its contents arrive late.
 *
 * The shell deliberately mirrors the real dialog's footprint (`variant`), so the swap when the
 * chunk lands is a fill-in rather than a resize. Pair every `lazy()` dialog with this — the label
 * is the only per-call decision, and it should name what is opening ("Opening the editor…"), not
 * the mechanism.
 *
 * Counterpart for the app SHELL (not a dialog) is `AppLoadingSplash` in `Root.tsx`; inline
 * content uses its own fallback (see `Markdown.tsx`, which shows the raw text meanwhile).
 */
import { Box, CircularProgress, Modal, ModalDialog, Stack, Typography } from '@mui/joy'
import { ScrollableModalDialog } from './ScrollableDialog'

export interface LazyDialogFallbackProps {
  /** What is opening, as the user would say it. Announced to screen readers. */
  label: string
  /**
   * Which shell to draw. `fullscreen` matches the 3D editor/preview's near-fullscreen dialog
   * (99vw/99dvh); `dialog` matches the standard 720px-wide scrollable form dialogs.
   */
  variant?: 'dialog' | 'fullscreen'
}

/** Centred spinner + label, the same idiom the editor uses for its own "Loading plates…" state. */
function LoadingBody({ label }: { label: string }) {
  return (
    <Box sx={{ flex: 1, minHeight: 160, display: 'grid', placeItems: 'center' }}>
      <Stack spacing={1} alignItems="center" role="status" aria-live="polite">
        <CircularProgress size="sm" />
        <Typography level="body-sm" textColor="text.tertiary">{label}</Typography>
      </Stack>
    </Box>
  )
}

export function LazyDialogFallback({ label, variant = 'dialog' }: LazyDialogFallbackProps) {
  // `open` is unconditional: the fallback only exists while React is suspended, and it unmounts
  // itself the moment the real dialog mounts. Closing is therefore not its job — a dismissible
  // shell would leave the pending import with nowhere to render.
  if (variant === 'fullscreen') {
    return (
      <Modal open>
        <ModalDialog
          variant="outlined"
          layout="center"
          aria-busy
          sx={{ width: '99vw', height: '99dvh', display: 'flex', p: 0 }}
        >
          <LoadingBody label={label} />
        </ModalDialog>
      </Modal>
    )
  }
  return (
    <Modal open>
      <ScrollableModalDialog variant="outlined" aria-busy sx={{ maxWidth: 720, width: '100%' }}>
        <LoadingBody label={label} />
      </ScrollableModalDialog>
    </Modal>
  )
}
