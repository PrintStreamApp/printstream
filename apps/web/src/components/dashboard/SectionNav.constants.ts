// Mobile pages use their natural vertical flow without a section nav. Desktop
// reserves space for the sticky primary tabs plus the sticky section nav.
export const sectionScrollMarginTop = {
  xs: 'calc(var(--app-top-inset, 0px) + 16px)',
  sm: 'calc(var(--app-top-inset, 0px) + 136px)',
  md: 'calc(var(--app-top-inset, 0px) + 138px)'
} as const
