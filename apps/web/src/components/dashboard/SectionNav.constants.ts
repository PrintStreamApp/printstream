// The mobile primary tab bar grew taller after the logo/tab refresh, so the
// floating section nav needs additional clearance above it.
export const mobileSectionNavDockBottom = 'calc(var(--app-safe-bottom, 0px) + 76px)' as const
export const mobileSectionNavReserveSpace = '68px' as const

// On mobile the section nav lives above the bottom dock, so sections only
// need a light top offset when scrolled into view. Desktop still reserves
// space for the sticky primary tabs plus the sticky section nav.
export const sectionScrollMarginTop = {
  xs: 'calc(var(--app-top-inset, 0px) + 16px)',
  sm: 'calc(var(--app-top-inset, 0px) + 136px)',
  md: 'calc(var(--app-top-inset, 0px) + 138px)'
} as const