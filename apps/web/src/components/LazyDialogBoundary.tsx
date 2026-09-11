/**
 * The one wrapper every lazily-loaded DIALOG mounts: its pending state AND its failed state.
 *
 * OWNS both halves of "the chunk is not here yet". {@link LazyDialogFallback} already covered the
 * first (a shell while the chunk downloads); nothing covered the second, and the second is the
 * expensive one. `React.lazy` rejects when its chunk cannot be fetched, and with no error boundary
 * above it React unmounts FROM THE ROOT: the whole app goes blank, taking whatever the user was
 * doing with it. Measured on the public 3MF editor with the parameter table's chunk blocked, the
 * document went from 599 characters of rendered editor to 0, with the opened project gone and no
 * way left to save it.
 *
 * **A deploy is the trigger, not an edge case.** A new build renames every hashed chunk, and
 * `appStaleness.ts` deliberately does NOT reload a tab that `appBusy.ts` reports as busy, which an
 * open editor always is (`editor-edits`, and `dialog-open` because the editor renders inside a
 * `BackAwareModal`). So the users kept on the old bundle are exactly the ones with unsaved work,
 * and the first dialog they open afterwards asks for a chunk that no longer exists.
 *
 * It is ONE component rather than a boundary each caller composes around its own `Suspense`,
 * because a site that can forget the boundary will: the fallback was already uniform across all
 * thirteen lazy dialogs and the error path was missing from all thirteen. Pairing them means a new
 * lazy dialog cannot take the pending state without also taking the failed one.
 * `LazyDialogBoundary.test.ts` fails the build on a bare `Suspense` around a `LazyDialogFallback`.
 *
 * **It does not reload, and it does not retry.** Not reloading is `appStaleness.ts`'s rule: it owns
 * the single reload policy, and reloading here would destroy the very unsaved work this exists to
 * protect. Not retrying is honesty: the usual cause is a chunk replaced by a deploy, so requesting
 * the same hashed URL again can only fail again. What the user needs is to save and then reload,
 * which is what the notice says, and which is possible only because the surface behind it is still
 * standing.
 */
import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { Button, DialogActions, DialogContent, DialogTitle, ModalClose, ModalDialog, Typography } from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { BackAwareModal } from './BackAwareModal'
import { LazyDialogFallback, type LazyDialogFallbackProps } from './LazyDialogFallback'

export interface LazyDialogBoundaryProps {
  /**
   * What is opening, as the user would say it: "the parameter table", "printer settings". Lower
   * case, no leading verb and no trailing ellipsis. It is read into BOTH the loading label
   * ("Opening the parameter table…") and the failure heading ("Couldn't open the parameter table"),
   * so a label written as a status line reads wrong in one of the two.
   */
  label: string
  /** Override the pending copy when the default `Opening ${label}...` hides useful work. */
  pendingLabel?: string
  /** One short explanation of what the pending step is doing. */
  pendingDescription?: string
  /** Which shell to draw while loading. See {@link LazyDialogFallbackProps.variant}. */
  variant?: LazyDialogFallbackProps['variant']
  /**
   * Reset the caller's "is this dialog open" state.
   *
   * REQUIRED, and not only so the notice can be dismissed: the caller still believes the dialog is
   * open, so a notice that merely hid itself would leave the button that opened it inert, since
   * clicking it re-sets a flag that is already true and nothing re-renders.
   */
  onClose: () => void
  children: ReactNode
}

/**
 * Wrap a lazily-loaded dialog: its shell while the chunk downloads, and a dismissible notice
 * instead of a blank app if the chunk never arrives.
 *
 * **Mount this only while the dialog is meant to be open.** It does not take an `open` prop and
 * cannot gate itself: `React.lazy` fetches on first render, and both of the states below are
 * unconditionally OPEN modals, so a boundary mounted next to a closed dialog fetches the chunk
 * nobody asked for and, when that fetch fails, paints a notice over the app whose only exit calls
 * an `onClose` that clears a flag already false. Nothing unmounts, `failed` is never reset, and the
 * user is shut out of the surface behind it. Resetting `failed` on dismiss would not save an
 * ungated caller either, because re-rendering the children re-throws `React.lazy`'s cached
 * rejection straight back into the boundary. Every call site gates with `{open && …}`, an early
 * `return null`, or an enclosing conditional.
 */
export function LazyDialogBoundary({ label, pendingLabel, pendingDescription, variant, onClose, children }: LazyDialogBoundaryProps) {
  return (
    <LazyDialogErrorBoundary label={label} fallback={<LazyDialogFailureNotice label={label} onClose={onClose} />}>
      <Suspense fallback={(
        <LazyDialogFallback
          label={pendingLabel ?? `Opening ${label}…`}
          description={pendingDescription}
          variant={variant}
          onClose={onClose}
        />
      )}>
        {children}
      </Suspense>
    </LazyDialogErrorBoundary>
  )
}

interface ErrorBoundaryProps {
  /** Named in the console line, so a report says which dialog died rather than which component. */
  label: string
  fallback: ReactNode
  children: ReactNode
}

/**
 * Catches the rejection `React.lazy` throws when a chunk will not load, and anything else the
 * dialog throws on the way up.
 *
 * Deliberately catches EVERYTHING rather than sniffing for a chunk-load failure: the message
 * differs per browser and per bundler and would drift silently, and a dialog that throws for its
 * own reasons should not take the app down either. What the notice promises is narrow enough to be
 * true in both cases, which is that the surface behind the dialog is still standing.
 */
class LazyDialogErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The only record that names the dialog. React logs its own message, but with a minified
    // component stack and no idea which surface was being opened, and a chunk that 404s after a
    // deploy is worth seeing in a user's console when they report the notice.
    console.error(`[lazy-dialog] "${this.props.label}" failed to load`, error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * Shown in place of the dialog that would not load.
 *
 * Names no mechanism (no chunks, no modules): what the user can act on is that their work is intact
 * and that reloading fixes it. Closing calls the caller's `onClose`, which unmounts this along with
 * the boundary, so the notice needs no open state of its own.
 */
function LazyDialogFailureNotice({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <BackAwareModal open onClose={onClose}>
      <ModalDialog variant="outlined" sx={{ maxWidth: 440 }}>
        {/* No `sx` on the icon: @mui/icons-material crashes on one here, and it inherits
            `currentColor` anyway, so the title's own colour carries it. */}
        <DialogTitle sx={{ color: 'danger.plainColor' }}>
          <ErrorOutlineRoundedIcon />
          Couldn&apos;t open {label}
        </DialogTitle>
        {/* No onClick: Joy wires ModalClose to the modal's own onClose, and adding one runs it twice. */}
        <ModalClose />
        <DialogContent>
          <Typography level="body-sm">
            This usually means a new version was released while the page was open. Nothing has been
            lost: save your work, then reload the page and try again.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </ModalDialog>
    </BackAwareModal>
  )
}
