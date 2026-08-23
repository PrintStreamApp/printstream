/**
 * The chrome every status toast shares: the fixed stack (top of the screen on a
 * phone, bottom-right on desktop: see `lib/toastPlacement.ts`), the toast
 * surface itself, and the small controls that sit inside one.
 *
 * There is exactly ONE `StatusToastStack` per entry branch: `App` mounts one,
 * `PublicToolApp` mounts the other, and `Root` only ever renders one branch. A
 * surface that renders toasts contributes them as children of the stack above it
 * and must not portal a second one, or the two overlap in the same corner.
 */
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import { Alert, Box, IconButton, Stack, Tooltip, type AlertProps } from '@mui/joy'
import { Portal } from '@mui/base/Portal'
import type { ReactNode } from 'react'
import type { StatusToastColor } from '../lib/statusToastGroup'
import { TOAST_STACK_PLACEMENT } from '../lib/toastPlacement'

export function StatusToastStack({ children, width = 390 }: { children: ReactNode; width?: number }) {
  return (
    <Portal>
      <Box
        sx={{
          position: 'fixed',
          right: { xs: 12, sm: 20 },
          left: { xs: 12, sm: 'auto' },
          ...TOAST_STACK_PLACEMENT,
          width: { xs: 'auto', sm: width },
          zIndex: (theme) => theme.zIndex.tooltip,
          pointerEvents: 'none'
        }}
      >
        <Stack
          spacing={1}
          sx={{
            maxHeight: 'min(70vh, 720px)',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            p: 1,
            m: -1,
            scrollbarGutter: 'stable'
          }}
        >
          {children}
        </Stack>
      </Box>
    </Portal>
  )
}

export function StatusToast({ sx, ...props }: AlertProps & { sx?: AlertProps['sx'] }) {
  return (
    <Alert
      variant="soft"
      {...props}
      sx={[
        {
          p: 1.25,
          borderRadius: 'sm',
          backgroundColor: 'var(--joy-palette-neutral-900)',
          border: '1px solid var(--joy-palette-neutral-700)',
          boxShadow: 'lg',
          pointerEvents: 'auto',
          alignItems: 'flex-start',
          '& .MuiAlert-startDecorator': { mt: 0.25, alignSelf: 'flex-start', flexShrink: 0 },
          '& .MuiAlert-endDecorator': { alignSelf: 'flex-start', mt: -0.25, flexShrink: 0 },
          '& > :not(.MuiAlert-startDecorator):not(.MuiAlert-endDecorator)': {
            flex: 1,
            minWidth: 0
          }
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : [])
      ]}
    />
  )
}

export function StatusToastDismissButton({
  ariaLabel,
  onClick
}: {
  ariaLabel: string
  onClick: () => void
}) {
  return (
    <IconButton
      size="sm"
      variant="plain"
      color="neutral"
      aria-label={ariaLabel}
      onClick={onClick}
      sx={{ flexShrink: 0, alignSelf: 'center' }}
    >
      <CloseRoundedIcon />
    </IconButton>
  )
}

/**
 * A compact icon control for a toast row (cancel, retry, expand). Tighter than
 * Joy's `sm` so two of them still leave room for a file name on a phone; the
 * tooltip carries the wording the label cannot.
 */
export function StatusToastIconAction({
  label,
  color = 'neutral',
  loading = false,
  onClick,
  ariaExpanded,
  children
}: {
  label: string
  color?: StatusToastColor
  loading?: boolean
  onClick: () => void
  ariaExpanded?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip title={label} size="sm" variant="soft">
      <IconButton
        size="sm"
        variant="plain"
        color={color}
        aria-label={label}
        aria-expanded={ariaExpanded}
        loading={loading}
        onClick={onClick}
        sx={{ flexShrink: 0, alignSelf: 'center', '--IconButton-size': '28px' }}
      >
        {children}
      </IconButton>
    </Tooltip>
  )
}

/** The "something happened" marker a settled toast shows where a spinner would be. */
export function StatusToastStatusDot({ color, size = 10 }: { color: StatusToastColor; size?: number }) {
  const fill = `var(--joy-palette-${color}-500)`
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: fill,
        boxShadow: `0 0 0 4px color-mix(in srgb, ${fill} 22%, transparent)`
      }}
    />
  )
}