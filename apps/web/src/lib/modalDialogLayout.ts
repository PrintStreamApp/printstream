/** Shared viewport guardrails for app dialogs. */
export const MODAL_DIALOG_VIEWPORT_MAX_WIDTH = 'calc(100vw - 1.5rem)'
export const MODAL_DIALOG_VIEWPORT_MAX_HEIGHT = 'calc(100dvh - var(--app-top-inset, 0px) - var(--app-safe-bottom, 0px) - 1.5rem)'
export const MODAL_DIALOG_VIEWPORT_MAX_HEIGHT_FALLBACK = 'calc(100vh - var(--app-top-inset, 0px) - var(--app-safe-bottom, 0px) - 1.5rem)'

export const modalDialogViewportClampStyles = {
  boxSizing: 'border-box',
  minWidth: 0,
  maxWidth: MODAL_DIALOG_VIEWPORT_MAX_WIDTH,
  maxHeight: MODAL_DIALOG_VIEWPORT_MAX_HEIGHT_FALLBACK,
  overflowX: 'hidden',
  '@supports (height: 100dvh)': {
    maxHeight: MODAL_DIALOG_VIEWPORT_MAX_HEIGHT
  }
} as const

export const modalDialogAutoScrollStyles = {
  ...modalDialogViewportClampStyles,
  overflowY: 'auto'
} as const

export const modalDialogStructuredLayoutStyles = {
  ...modalDialogViewportClampStyles,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflowY: 'hidden'
} as const