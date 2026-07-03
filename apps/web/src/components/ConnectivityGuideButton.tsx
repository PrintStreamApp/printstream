import React from 'react'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import { Button, type ButtonProps } from '@mui/joy'
import { ConnectivityGuideDialog } from './ConnectivityGuideDialog'

/**
 * Self-contained trigger for the "How printers connect" explainer. Drops into
 * any setup surface (Get started, bridge settings, empty states, add-printer)
 * without the caller wiring up dialog state.
 */
export function ConnectivityGuideButton({
  size = 'sm',
  variant = 'outlined',
  color = 'neutral',
  ...props
}: Omit<ButtonProps, 'onClick' | 'children'>) {
  const [open, setOpen] = React.useState(false)

  return (
    <>
      <Button
        size={size}
        variant={variant}
        color={color}
        startDecorator={<HelpOutlineRoundedIcon />}
        onClick={() => setOpen(true)}
        {...props}
      >
        How printers connect
      </Button>
      {open && <ConnectivityGuideDialog onClose={() => setOpen(false)} />}
    </>
  )
}
