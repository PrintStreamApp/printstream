/**
 * Suspense fallback for the app's lazily-loaded DIALOGS.
 *
 * Every heavy dialog here is code-split, so the click that opens one is followed by a chunk
 * download before anything renders. With the `fallback={null}` these boundaries used to carry, the
 * screen showed literally nothing for that whole window, on the 3MF editor (~800KB of chunks:
 * EditorView + threeMfScene + BackAwareModal) that reads as a dead click, and users click again.
 * This renders the dialog's SHELL immediately instead, so the surface appears on the same frame as
 * the click and only its contents arrive late.
 *
 * The shell deliberately mirrors the real dialog's footprint (`variant`), so the swap when the
 * chunk lands is a fill-in rather than a resize.
 *
 * **Reached through `LazyDialogBoundary`, not mounted directly.** This covers only the chunk that
 * has not arrived YET; a chunk that never arrives used to unmount the whole app, and pairing the
 * two states in one wrapper is what stops a new lazy dialog taking one without the other. Its
 * `label` is derived there, from the noun the boundary is given.
 *
 * Counterpart for the app SHELL (not a dialog) is `AppLoadingSplash` in `Root.tsx`; inline
 * content uses its own fallback (see `Markdown.tsx`, which shows the raw text meanwhile).
 */
import { Box, Button, CircularProgress, DialogActions, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy'
import { dialogPresentationProps } from '../lib/dialogPresentation'
import { ScrollableModalDialog } from './ScrollableDialog'
import { BackAwareModal } from './BackAwareModal'

export interface LazyDialogFallbackProps {
  /** What is opening, as the user would say it. Announced to screen readers. */
  label: string
  /** Optional detail when the short label cannot say what the startup work is. */
  description?: string
  /**
   * Which shell to draw. `maximized` matches the 3D editor/preview, which open at the shared
   * maximized size; `dialog` matches the standard 720px-wide scrollable form dialogs.
   */
  variant?: 'dialog' | 'maximized'
  /** Dismisses the requested dialog while its code finishes loading harmlessly in the background. */
  onClose: () => void
}

/** Centred spinner + label, the same idiom the editor uses for its own project-loading state. */
function LoadingBody({ label, description }: { label: string; description?: string }) {
  return (
    <Box sx={{ flex: 1, minHeight: 160, display: 'grid', placeItems: 'center' }}>
      <Stack spacing={1} alignItems="center" role="status" aria-live="polite">
        <CircularProgress size="sm" />
        <Typography level="body-sm" textColor="text.tertiary">{label}</Typography>
        {description && (
          <Typography level="body-xs" textColor="text.tertiary" textAlign="center" sx={{ maxWidth: 420 }}>
            {description}
          </Typography>
        )}
      </Stack>
    </Box>
  )
}

export function LazyDialogFallback({ label, description, variant = 'dialog', onClose }: LazyDialogFallbackProps) {
  // The import itself cannot be aborted, but closing can safely unmount this request while the
  // browser finishes and caches it. Reopening then uses that cached module rather than trapping the
  // user behind an operation they cannot control.
  if (variant === 'maximized') {
    // The same shared geometry the real dialog uses, so the swap when the chunk lands is a fill-in
    // rather than a resize.
    const mode = dialogPresentationProps('maximized')
    return (
      <BackAwareModal open onClose={onClose}>
        <ModalDialog variant="outlined" aria-busy {...mode} sx={[mode.sx, { display: 'flex', p: 0 }]}>
          <ModalClose />
          <LoadingBody label={label} description={description} />
          <DialogActions sx={{ px: 2, pb: 2 }}>
            <Button variant="outlined" color="neutral" onClick={onClose}>Close</Button>
          </DialogActions>
        </ModalDialog>
      </BackAwareModal>
    )
  }
  return (
    <BackAwareModal open onClose={onClose}>
      <ScrollableModalDialog variant="outlined" aria-busy sx={{ maxWidth: 720, width: '100%' }}>
        <ModalClose />
        <LoadingBody label={label} description={description} />
        <DialogActions>
          <Button variant="outlined" color="neutral" onClick={onClose}>Close</Button>
        </DialogActions>
      </ScrollableModalDialog>
    </BackAwareModal>
  )
}
