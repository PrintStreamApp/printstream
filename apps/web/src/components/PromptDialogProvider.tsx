import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Input,
  ModalClose,
  ModalDialog,
  type ColorPaletteProp
} from '@mui/joy'
import {
  default as React,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { ConfirmActionDialog } from './ConfirmActionDialog'
import { BackAwareModal as Modal } from './BackAwareModal'

export interface ConfirmDialogOptions {
  title?: ReactNode
  description: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  color?: ColorPaletteProp
  confirmDecorator?: ReactNode
}

export interface TextPromptDialogOptions {
  title?: ReactNode
  description?: ReactNode
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  color?: ColorPaletteProp
  /**
   * Range of `initialValue` pre-selected when the input first receives focus.
   * Defaults to the whole value, so rename prompts start ready to overtype.
   * Pass the basename range (via `splitLibraryFileNameForRename`) when the
   * value is a filename whose extension should stay out of the selection.
   */
  initialSelection?: { start: number; end: number }
  normalizeValue?: (value: string) => string
  validateValue?: (value: string) => string | null
  /**
   * Submit through the server and let IT decide whether the value is acceptable.
   *
   * Return null to accept (the dialog closes and the promise resolves with the
   * value), or a message to reject: the dialog stays open, shows the message,
   * and keeps what the user typed.
   *
   * This exists because the alternative is shipping the server's rule to the
   * browser twice. A rename that must not collide was checked against a list of
   * existing names sent to the page, which is a partial copy of a constraint the
   * database already enforces: it cannot see anything outside what was fetched,
   * and it goes stale the moment someone else takes the name. With this, the
   * only authority is the endpoint, and the dialog just repeats what it said:
   * beside the field, rather than as an alert on the surface behind it after the
   * dialog has closed and taken the typed value with it.
   *
   * `validateValue` still runs first and is for what the browser can settle on
   * its own (empty, too long). Do not put a server rule in it.
   */
  submitValue?: (value: string) => Promise<string | null>
}

interface PromptDialogContextValue {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>
  promptText: (options: TextPromptDialogOptions) => Promise<string | null>
}

type PendingConfirmDialog = {
  kind: 'confirm'
  options: ConfirmDialogOptions
  resolve: (value: boolean) => void
}

type PendingTextPromptDialog = {
  kind: 'text'
  options: TextPromptDialogOptions
  resolve: (value: string | null) => void
}

type PendingDialog = PendingConfirmDialog | PendingTextPromptDialog

const PromptDialogContext = createContext<PromptDialogContextValue | null>(null)

function isTextPromptDialog(dialog: PendingDialog | null): dialog is PendingTextPromptDialog {
  return dialog?.kind === 'text'
}

export function PromptDialogProvider({ children }: { children: ReactNode }) {
  const [activeDialog, setActiveDialog] = useState<PendingDialog | null>(null)
  const activeDialogRef = useRef<PendingDialog | null>(null)
  const queuedDialogsRef = useRef<PendingDialog[]>([])
  const [promptValue, setPromptValue] = useState('')
  // What the SERVER said about the value, kept apart from `validateValue`'s
  // answer: one is recomputed on every keystroke, the other survives until the
  // user changes what was rejected.
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const showNextDialog = useCallback(() => {
    const nextDialog = queuedDialogsRef.current.shift() ?? null
    activeDialogRef.current = nextDialog
    setActiveDialog(nextDialog)
  }, [])

  const enqueueDialog = useCallback(<TResult,>(
    buildDialog: (resolve: (value: TResult) => void) => PendingDialog
  ): Promise<TResult> => {
    return new Promise<TResult>((resolve) => {
      const dialog = buildDialog(resolve)
      if (activeDialogRef.current) {
        queuedDialogsRef.current.push(dialog)
        return
      }

      activeDialogRef.current = dialog
      setActiveDialog(dialog)
    })
  }, [])

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return enqueueDialog<boolean>((resolve) => ({ kind: 'confirm', options, resolve }))
  }, [enqueueDialog])

  const promptText = useCallback((options: TextPromptDialogOptions) => {
    return enqueueDialog<string | null>((resolve) => ({ kind: 'text', options, resolve }))
  }, [enqueueDialog])

  const closeConfirmDialog = useCallback((value: boolean) => {
    const dialog = activeDialogRef.current
    if (dialog?.kind !== 'confirm') return
    dialog.resolve(value)
    showNextDialog()
  }, [showNextDialog])

  const closeTextPromptDialog = useCallback((value: string | null) => {
    const dialog = activeDialogRef.current
    if (dialog?.kind !== 'text') return
    dialog.resolve(value)
    showNextDialog()
  }, [showNextDialog])

  // Pre-select the initial value (or the caller-specified range) once per
  // dialog, so refocusing after a click never re-grabs the user's selection.
  const promptSelectionAppliedRef = useRef(false)
  const handlePromptFocus = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
    const dialog = activeDialogRef.current
    if (dialog?.kind !== 'text' || promptSelectionAppliedRef.current) return
    promptSelectionAppliedRef.current = true
    const selection = dialog.options.initialSelection
    event.target.setSelectionRange(selection?.start ?? 0, selection?.end ?? event.target.value.length)
  }, [])

  useEffect(() => {
    promptSelectionAppliedRef.current = false
    setSubmitError(null)
    setSubmitting(false)
    if (!isTextPromptDialog(activeDialog)) {
      setPromptValue('')
      return
    }

    setPromptValue(activeDialog.options.initialValue ?? '')
  }, [activeDialog])

  useEffect(() => {
    return () => {
      // We intentionally resolve the latest queued dialogs on unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const queuedDialogs = queuedDialogsRef.current

      if (activeDialogRef.current?.kind === 'confirm') {
        activeDialogRef.current.resolve(false)
      } else if (activeDialogRef.current?.kind === 'text') {
        activeDialogRef.current.resolve(null)
      }

      for (const dialog of queuedDialogs) {
        if (dialog.kind === 'confirm') dialog.resolve(false)
        else dialog.resolve(null)
      }
    }
  }, [])

  const promptNormalize = isTextPromptDialog(activeDialog)
    ? activeDialog.options.normalizeValue ?? ((value: string) => value)
    : null
  const normalizedPromptValue = promptNormalize ? promptNormalize(promptValue) : ''
  const validationError = isTextPromptDialog(activeDialog)
    ? activeDialog.options.validateValue?.(normalizedPromptValue) ?? null
    : null
  // Validation first: a value the browser can already tell is wrong should not
  // be reported with a stale answer from the last attempt.
  const promptError = validationError ?? submitError

  /**
   * Submitting is what CLOSES the dialog, not the click, a server that rejects
   * the value keeps it open with the message and everything the user typed.
   */
  const submitPromptDialog = useCallback(async () => {
    const dialog = activeDialogRef.current
    if (dialog?.kind !== 'text' || submitting) return
    const normalize = dialog.options.normalizeValue ?? ((value: string) => value)
    const value = normalize(promptValue)
    if (dialog.options.validateValue?.(value)) return
    if (!dialog.options.submitValue) {
      closeTextPromptDialog(value)
      return
    }
    setSubmitting(true)
    try {
      const rejection = await dialog.options.submitValue(value)
      if (rejection) {
        setSubmitError(rejection)
        return
      }
      closeTextPromptDialog(value)
    } finally {
      setSubmitting(false)
    }
  }, [closeTextPromptDialog, promptValue, submitting])

  const contextValue = useMemo<PromptDialogContextValue>(() => ({ confirm, promptText }), [confirm, promptText])

  return (
    <PromptDialogContext.Provider value={contextValue}>
      {children}

      {activeDialog?.kind === 'confirm' ? (
        <ConfirmActionDialog
          open
          title={activeDialog.options.title ?? 'Confirm action'}
          description={activeDialog.options.description}
          confirmLabel={activeDialog.options.confirmLabel ?? 'Confirm'}
          cancelLabel={activeDialog.options.cancelLabel ?? 'Cancel'}
          color={activeDialog.options.color ?? 'primary'}
          confirmDecorator={activeDialog.options.confirmDecorator ?? null}
          onClose={() => closeConfirmDialog(false)}
          onConfirm={() => closeConfirmDialog(true)}
        />
      ) : null}

      {isTextPromptDialog(activeDialog) ? (
        <Modal open onClose={() => { if (!submitting) closeTextPromptDialog(null) }}>
          <ModalDialog
            component="form"
            variant="outlined"
            onSubmit={(event) => {
              event.preventDefault()
              void submitPromptDialog()
            }}
            sx={{ width: { xs: '95vw', sm: 480 }, maxWidth: '95vw' }}
          >
            <ModalClose disabled={submitting} />
            {activeDialog.options.title ? <DialogTitle>{activeDialog.options.title}</DialogTitle> : null}
            <DialogContent>
              {activeDialog.options.description ?? null}
            </DialogContent>
            <FormControl>
              <FormLabel>{activeDialog.options.label}</FormLabel>
              <Input
                autoFocus
                value={promptValue}
                placeholder={activeDialog.options.placeholder}
                onFocus={handlePromptFocus}
                // Clearing the server's answer on edit, because it was about the
                // value that WAS in the field. Leaving it up would tell the user
                // their new name is taken before anything had asked.
                onChange={(event) => { setSubmitError(null); setPromptValue(event.target.value) }}
              />
            </FormControl>
            {promptError ? (
              <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                {promptError}
              </Alert>
            ) : null}
            <DialogActions>
              <Button
                variant="plain"
                color="neutral"
                disabled={submitting}
                onClick={() => closeTextPromptDialog(null)}
              >
                {activeDialog.options.cancelLabel ?? 'Cancel'}
              </Button>
              {/* Disabled on the VALIDATION error only. A rejected submit leaves
                  its message up while the value is unchanged, and disabling on
                  that would strand the user: retrying the same value is a
                  legitimate move when the name was freed in between. */}
              <Button
                type="submit"
                color={activeDialog.options.color ?? 'primary'}
                loading={submitting}
                disabled={validationError != null}
              >
                {activeDialog.options.confirmLabel ?? 'Save'}
              </Button>
            </DialogActions>
          </ModalDialog>
        </Modal>
      ) : null}
    </PromptDialogContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePromptDialog(): PromptDialogContextValue {
  const context = useContext(PromptDialogContext)
  if (!context) {
    throw new Error('usePromptDialog must be used within PromptDialogProvider')
  }
  return context
}
