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
  const promptError = isTextPromptDialog(activeDialog)
    ? activeDialog.options.validateValue?.(normalizedPromptValue) ?? null
    : null

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
        <Modal open onClose={() => closeTextPromptDialog(null)}>
          <ModalDialog
            component="form"
            variant="outlined"
            onSubmit={(event) => {
              event.preventDefault()
              if (promptError) return
              closeTextPromptDialog(normalizedPromptValue)
            }}
            sx={{ width: { xs: '95vw', sm: 480 }, maxWidth: '95vw' }}
          >
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
                onChange={(event) => setPromptValue(event.target.value)}
              />
            </FormControl>
            {promptError ? (
              <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                {promptError}
              </Alert>
            ) : null}
            <DialogActions>
              <Button variant="plain" color="neutral" onClick={() => closeTextPromptDialog(null)}>
                {activeDialog.options.cancelLabel ?? 'Cancel'}
              </Button>
              <Button type="submit" color={activeDialog.options.color ?? 'primary'} disabled={promptError != null}>
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