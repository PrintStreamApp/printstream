import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import { Alert, Box, IconButton, Stack, type AlertProps } from '@mui/joy'
import { Portal } from '@mui/base/Portal'
import type { ReactNode } from 'react'

export function StatusToastStack({ children, width = 390 }: { children: ReactNode; width?: number }) {
  return (
    <Portal>
      <Box
        sx={{
          position: 'fixed',
          right: { xs: 12, sm: 20 },
          bottom: { xs: 'calc(var(--app-safe-bottom, 0px) + 84px)', sm: 'calc(var(--app-safe-bottom, 0px) + 12px)' },
          left: { xs: 12, sm: 'auto' },
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