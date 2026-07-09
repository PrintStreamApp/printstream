import { Box, DialogContent, ModalDialog, ModalOverflow, type DialogContentProps, type ModalDialogProps } from '@mui/joy'
import React from 'react'
import {
  MODAL_DIALOG_VIEWPORT_MAX_HEIGHT,
  MODAL_DIALOG_VIEWPORT_MAX_HEIGHT_FALLBACK,
  modalDialogStructuredLayoutStyles
} from '../lib/modalDialogLayout'

const SCROLL_OVERFLOW_TOLERANCE_PX = 1

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
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  const [hasVerticalOverflow, setHasVerticalOverflow] = React.useState(true)

  React.useEffect(() => {
    const element = bodyRef.current
    if (!element) return undefined

    let frame = 0
    const updateOverflow = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const overflow = element.scrollHeight - element.clientHeight
        setHasVerticalOverflow(overflow > SCROLL_OVERFLOW_TOLERANCE_PX)
      })
    }

    updateOverflow()
    window.addEventListener('resize', updateOverflow)

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateOverflow) : null
    resizeObserver?.observe(element)
    for (const child of Array.from(element.children)) {
      resizeObserver?.observe(child)
    }

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updateOverflow)
      resizeObserver?.disconnect()
    }
  }, [children])

  return (
    <DialogContent
      {...props}
      ref={(node) => {
        bodyRef.current = node
        assignRef(ref, node)
      }}
      sx={[
        {
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflowX: 'hidden',
          overflowY: hasVerticalOverflow ? 'auto' : 'hidden',
          scrollbarGutter: hasVerticalOverflow ? 'stable' : 'auto',
          ...(pinToBottom ? { display: 'flex', flexDirection: 'column-reverse' } : {}),
        },
        ...sxArray(sx)
      ]}
    >
      <Box sx={{ minWidth: 0, pr: hasVerticalOverflow ? 0.75 : 0 }}>
        {children}
      </Box>
    </DialogContent>
  )
})