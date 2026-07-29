import { Box, DialogContent, ModalDialog, ModalOverflow, type DialogContentProps, type ModalDialogProps } from '@mui/joy'
import React from 'react'
import {
  MODAL_DIALOG_VIEWPORT_MAX_HEIGHT,
  MODAL_DIALOG_VIEWPORT_MAX_HEIGHT_FALLBACK,
  modalDialogStructuredLayoutStyles
} from '../lib/modalDialogLayout'
import { useScrollbarGutter } from '../hooks/useScrollbarGutter'

function sxArray<T>(value: T | readonly T[] | undefined): T[] {
  if (Array.isArray(value)) return [...value]
  return value == null ? [] : [value as T]
}

/**
 * Preferred modal shell for longer forms and detail panes whose body should
 * scroll without pushing the footer out of the viewport.
 */
export const ScrollableModalDialog = React.forwardRef<HTMLDivElement, ModalDialogProps>(function ScrollableModalDialog({ sx, ...props }, ref) {
  return (
    <ModalOverflow
      ref={ref}
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: { xs: 'stretch', sm: 'center' },
        justifyContent: { xs: 'flex-end', sm: 'center' },
        px: { xs: 1, sm: 2 },
        pt: {
          xs: 'calc(var(--app-top-inset, 0px) + 0.75rem)',
          sm: 2
        },
        pb: {
          xs: 'calc(var(--app-safe-bottom, 0px) + 0.75rem)',
          sm: 2
        },
        boxSizing: 'border-box',
        '& .MuiModalDialog-root': {
          maxHeight: MODAL_DIALOG_VIEWPORT_MAX_HEIGHT_FALLBACK,
          '@supports (height: 100dvh)': {
            maxHeight: MODAL_DIALOG_VIEWPORT_MAX_HEIGHT
          }
        }
      }}
    >
      <ModalDialog
        {...props}
        sx={[
          {
            ...modalDialogStructuredLayoutStyles,
            maxWidth: '100%',
            width: '100%'
          },
          ...sxArray(sx)
        ]}
      />
    </ModalOverflow>
  )
})

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') {
    ref(value)
  } else if (ref) {
    ref.current = value
  }
}

/**
 * Scrollable body region paired with `ScrollableModalDialog`.
 *
 * `pinToBottom` anchors the scroll position at the bottom of the content for
 * chat-style threads whose newest entry sits last: the body becomes a
 * `column-reverse` flex container, whose scroll origin is the bottom edge, so
 * the latest message is visible on open and stays pinned as more arrive — with
 * no scroll-to-bottom JS (and none of its post-paint jump). When the content is
 * shorter than the body it simply hugs the bottom, which is the expected
 * chat-thread look.
 */
export const ScrollableDialogBody = React.forwardRef<HTMLDivElement, DialogContentProps & { pinToBottom?: boolean }>(function ScrollableDialogBody({ sx, children, pinToBottom = false, ...props }, ref) {
  const { scrollRef, scrollAreaSx, contentSx } = useScrollbarGutter(children)

  return (
    <DialogContent
      {...props}
      ref={(node) => {
        scrollRef(node)
        assignRef(ref, node)
      }}
      sx={[
        {
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflowX: 'hidden',
          ...scrollAreaSx,
          ...(pinToBottom ? { display: 'flex', flexDirection: 'column-reverse' } : {}),
        },
        ...sxArray(sx)
      ]}
    >
      <Box sx={contentSx}>
        {children}
      </Box>
    </DialogContent>
  )
})