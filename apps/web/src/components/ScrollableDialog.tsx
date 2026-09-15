import { Box, DialogContent, ModalDialog, ModalOverflow, type DialogContentProps, type ModalDialogProps } from '@mui/joy'
import React from 'react'
import {
  MODAL_DIALOG_VIEWPORT_MAX_HEIGHT,
  MODAL_DIALOG_VIEWPORT_MAX_HEIGHT_FALLBACK,
  modalDialogStructuredLayoutStyles
} from '../lib/modalDialogLayout'
import {
  DIALOG_PRESENTATION_ATTRIBUTE,
  scrollableDialogPresentation,
  withoutDialogSizing,
  type DialogPresentation
} from '../lib/dialogPresentation'
import { useScrollbarGutter } from '../hooks/useScrollbarGutter'

function sxArray<T>(value: T | readonly T[] | undefined): T[] {
  if (Array.isArray(value)) return [...value]
  return value == null ? [] : [value as T]
}

/**
 * Preferred modal shell for longer forms and detail panes whose body should
 * scroll without pushing the footer out of the viewport.
 *
 * `presentation` switches the shell between its normal footprint and the shared maximized /
 * full-screen modes (`lib/dialogPresentation.ts`). The mode is applied LAST, so it wins over the
 * caller's own width; leave it unset (or `standard`) for an ordinary dialog. Switching it only
 * changes props on the same elements, nothing remounts, so a WebGL canvas in the body survives the
 * toggle.
 */
export const ScrollableModalDialog = React.forwardRef<HTMLDivElement, ModalDialogProps & { presentation?: DialogPresentation }>(
  function ScrollableModalDialog({ sx, presentation = 'standard', layout, ...props }, ref) {
    const mode = scrollableDialogPresentation(presentation)
    // A mode owns the layout it needs (full screen is Joy's `fullscreen` layout); only an ordinary
    // dialog keeps whatever the caller asked for.
    const resolvedLayout = presentation === 'standard' ? layout : mode.layout
    return (
      <ModalOverflow
        ref={ref}
        sx={[
          {
            minHeight: '100dvh',
            display: 'flex',
            alignItems: { xs: 'stretch', sm: 'center' },
            justifyContent: { xs: 'flex-end', sm: 'center' },
            // The scroller's PADDING is owned entirely by the presentation (standard included), not
            // set here and overridden per mode: MUI emits a responsive value's `xs` entry as
            // `@media (min-width:0px)`, and that media block beats a later flat override however the
            // `sx` array is ordered, a maximized dialog silently kept this shell's 8px gutter.
            boxSizing: 'border-box',
            '& .MuiModalDialog-root': {
              maxHeight: MODAL_DIALOG_VIEWPORT_MAX_HEIGHT_FALLBACK,
              '@supports (height: 100dvh)': {
                maxHeight: MODAL_DIALOG_VIEWPORT_MAX_HEIGHT
              }
            }
          },
          mode.overflowSx
        ]}
      >
        <ModalDialog
          {...props}
          layout={resolvedLayout}
          {...{ [DIALOG_PRESENTATION_ATTRIBUTE]: presentation }}
          sx={[
            {
              ...modalDialogStructuredLayoutStyles,
              maxWidth: '100%',
              width: '100%'
            },
            // An enlarged mode replaces the dialog's footprint, so the caller's own size declarations
            // are removed rather than merely overridden: see `withoutDialogSizing`.
            ...(presentation === 'standard' ? sxArray(sx) : sxArray(sx).map(withoutDialogSizing)),
            mode.dialogSx
          ]}
        />
      </ModalOverflow>
    )
  }
)

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
 * the latest message is visible on open and stays pinned as more arrive, with
 * no scroll-to-bottom JS (and none of its post-paint jump). When the content is
 * shorter than the body it simply hugs the bottom, which is the expected
 * chat-thread look.
 */
export const ScrollableDialogBody = React.forwardRef<HTMLDivElement, DialogContentProps & {
  pinToBottom?: boolean
  /** Styles for the stable inner content box, useful when an enlarged dialog needs a flex body. */
  contentSx?: DialogContentProps['sx']
}>(function ScrollableDialogBody({ sx, contentSx, children, pinToBottom = false, ...props }, ref) {
  const { scrollRef, scrollAreaSx, contentSx: gutterContentSx } = useScrollbarGutter(children)

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
      <Box sx={[gutterContentSx, ...sxArray(contentSx)]}>
        {children}
      </Box>
    </DialogContent>
  )
})
