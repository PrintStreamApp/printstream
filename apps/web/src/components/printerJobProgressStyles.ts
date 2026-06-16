export const printerJobProgressSx = {
  '--LinearProgress-thickness': '8px',
  flex: 'none',
  borderRadius: '999px',
  backgroundColor: 'var(--joy-palette-neutral-800)',
  '&::before': {
    left: '1px',
    borderRadius: '999px',
    inlineSize: 'max(calc(var(--LinearProgress-percent) * 1% - 2px), 0px)',
    transform: 'scaleY(0.75)',
    transformOrigin: 'left center'
  }
} as const