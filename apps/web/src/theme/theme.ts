/**
 * Joy UI themes: Default and Aurora.
 *
 * Both mirror the `game-is-up` reference aesthetic: dark, atmospheric
 * palette with high-contrast surfaces, soft inset highlights on interactive
 * controls, and tab/card overrides that read consistently across phone,
 * tablet, and desktop viewports. The flat theme family (Graphite variants,
 * Slate, Code Dark) lives in `flatThemes.ts`.
 */
import { createAppTheme } from './buildTheme'

export const defaultChrome = {
  surfacePanelStyle: 'legacy',
  bodyBackground: 'radial-gradient(circle at top left, #0f5444 0%, #304159 100%)',
  ambientOverlayBase: 'linear-gradient(132deg, rgba(8, 14, 24, 0.03) 0%, rgba(8, 14, 24, 0.09) 100%)',
  ambientOverlayGlow: 'radial-gradient(circle at 50% 10%, rgba(255, 255, 255, 0.08), transparent 34%)',
  ambientHighlight: 'radial-gradient(circle at 50% 8%, rgba(255, 255, 255, 0.12), transparent 32%)',
  ambientSpectrum: 'linear-gradient(115deg, #92f7de 0%, #70ebcd 28%, #61d4bf 58%, #a9f3de 100%)',
  shellNavBackground: 'rgba(13, 23, 38, 0.96)',
  shellNavBorder: 'rgba(118, 164, 220, 0.18)',
  shellNavTopLine: 'rgba(197, 224, 255, 0.16)',
  shellNavInsetHighlight: 'rgba(255, 255, 255, 0.05)',
  shellNavShadowRing: 'rgba(88, 130, 184, 0.14)',
  sectionNavBackground: 'rgba(18, 34, 48, 0.78)',
  sectionNavBorder: 'rgba(129, 166, 214, 0.22)',
  sectionNavShadowRing: 'rgba(113, 160, 214, 0.12)',
  sectionNavText: 'var(--joy-palette-neutral-300)',
  sectionNavTextHover: 'var(--joy-palette-neutral-100)',
  sectionNavFocusRing: 'rgba(129, 166, 214, 0.6)',
  sectionNavCount: 'var(--joy-palette-neutral-400)',
  sectionNavSeparator: 'rgba(255,255,255,0.26)',
  sectionTabHoverBackground: 'rgba(255, 255, 255, 0.03)',
  sectionTabHoverColor: 'var(--joy-palette-neutral-100)',
  sectionTabSelectedColor: 'var(--joy-palette-primary-200)',
  sectionTabSelectedBackground: 'rgba(20, 136, 106, 0.18)',
  sectionTabSelectedRing: 'rgba(141, 255, 216, 0.14)',
  sectionTabSelectedBorder: 'rgba(141, 255, 216, 0.1)',
  modalDialogBackground: 'rgba(15, 23, 38, 0.85)',
  modalDialogBorder: '#304159',
  primarySoftCardGradientStart: '#12342d',
  primarySoftCardGradientEnd: '#0d1322',
  surfacePanelBackground: 'color-mix(in srgb, rgba(19, 27, 42, 0.88) 88%, transparent)',
  surfacePanelBorder: 'rgba(118, 164, 220, 0.16)',
  surfacePanelInsetHighlight: 'rgba(255, 255, 255, 0.026)',
  surfacePanelShadow: '0 10px 20px -18px rgba(0, 0, 0, 0.62)',
  surfacePanelBackdropFilter: 'blur(6px) saturate(1.01)',
  surfacePanelGradient: 'linear-gradient(180deg, rgba(255, 255, 255, 0.012) 0%, rgba(255, 255, 255, 0.004) 28%, rgba(5, 10, 18, 0.05) 100%)',
  surfacePanelGlow: 'radial-gradient(circle at 18% 0%, rgba(141, 255, 216, 0.014), transparent 28%)',
  surfacePanelEdgeHighlight: 'rgba(255, 255, 255, 0.008)',
  tableHeaderBackground: 'color-mix(in srgb, rgba(18, 34, 48, 0.92) 92%, transparent)',
  tableRowStripeBackground: 'rgba(255, 255, 255, 0.018)',
  tableRowHoverBackground: 'rgba(141, 255, 216, 0.05)',
  emptyStateBackground: 'color-mix(in srgb, rgba(19, 27, 42, 0.84) 84%, transparent)',
  emptyStateBorder: 'rgba(118, 164, 220, 0.18)',
  emptyStateIconBackground: 'rgba(20, 136, 106, 0.18)',
  emptyStateIconBorder: 'rgba(141, 255, 216, 0.16)'
} as const

export const auroraChrome = {
  surfacePanelStyle: 'glass',
  bodyBackground: 'radial-gradient(circle at 18% 18%, rgba(32, 196, 138, 0.22), transparent 36%), radial-gradient(circle at 82% 20%, rgba(87, 130, 255, 0.22), transparent 34%), linear-gradient(145deg, #08111b 0%, #0c1724 42%, #101f33 100%)',
  ambientOverlayBase: 'linear-gradient(180deg, rgba(6, 14, 18, 0.12) 0%, rgba(4, 10, 14, 0.36) 100%)',
  ambientOverlayGlow: 'radial-gradient(circle at 18% 10%, rgba(141, 255, 216, 0.12), transparent 34%)',
  ambientHighlight: 'radial-gradient(circle at 82% 86%, rgba(92, 173, 255, 0.14), transparent 30%)',
  ambientSpectrum: 'linear-gradient(135deg, rgba(141, 255, 216, 0.28) 0%, rgba(90, 211, 245, 0.18) 46%, rgba(9, 16, 22, 0) 100%)',
  shellNavBackground: 'rgba(10, 16, 21, 0.86)',
  shellNavBorder: 'rgba(141, 255, 216, 0.12)',
  shellNavTopLine: 'rgba(255, 255, 255, 0.05)',
  shellNavInsetHighlight: 'rgba(255, 255, 255, 0.04)',
  shellNavShadowRing: 'rgba(58, 140, 214, 0.12)',
  sectionNavBackground: 'rgba(14, 22, 28, 0.72)',
  sectionNavBorder: 'rgba(141, 255, 216, 0.12)',
  sectionNavShadowRing: 'rgba(58, 140, 214, 0.1)',
  sectionNavText: 'var(--joy-palette-neutral-300)',
  sectionNavTextHover: 'var(--joy-palette-neutral-100)',
  sectionNavFocusRing: 'rgba(141, 255, 216, 0.4)',
  sectionNavCount: 'var(--joy-palette-neutral-400)',
  sectionNavSeparator: 'rgba(255,255,255,0.2)',
  sectionTabHoverBackground: 'rgba(255, 255, 255, 0.025)',
  sectionTabHoverColor: 'var(--joy-palette-neutral-100)',
  sectionTabSelectedColor: 'var(--joy-palette-primary-200)',
  sectionTabSelectedBackground: 'rgba(141, 255, 216, 0.1)',
  sectionTabSelectedRing: 'rgba(141, 255, 216, 0.16)',
  sectionTabSelectedBorder: 'rgba(141, 255, 216, 0.12)',
  modalDialogBackground: 'rgba(11, 17, 23, 0.9)',
  modalDialogBorder: '#1c313f',
  primarySoftCardGradientStart: '#16241f',
  primarySoftCardGradientEnd: '#10161a',
  surfacePanelBackground: 'rgba(17, 22, 27, 0.72)',
  surfacePanelBorder: 'rgba(141, 255, 216, 0.12)',
  surfacePanelInsetHighlight: 'rgba(255, 255, 255, 0.045)',
  surfacePanelShadow: '0 18px 38px -24px rgba(0, 0, 0, 0.82)',
  surfacePanelBackdropFilter: 'blur(16px) saturate(1.08)',
  surfacePanelGradient: 'linear-gradient(180deg, rgba(255, 255, 255, 0.028) 0%, rgba(255, 255, 255, 0.01) 32%, rgba(4, 9, 12, 0.16) 100%)',
  surfacePanelGlow: 'radial-gradient(circle at 18% 0%, rgba(141, 255, 216, 0.055), transparent 34%)',
  surfacePanelEdgeHighlight: 'rgba(255, 255, 255, 0.02)',
  tableHeaderBackground: 'rgba(13, 19, 24, 0.84)',
  tableRowStripeBackground: 'rgba(255, 255, 255, 0.02)',
  tableRowHoverBackground: 'rgba(141, 255, 216, 0.055)',
  emptyStateBackground: 'rgba(16, 21, 26, 0.7)',
  emptyStateBorder: 'rgba(141, 255, 216, 0.14)',
  emptyStateIconBackground: 'rgba(141, 255, 216, 0.1)',
  emptyStateIconBorder: 'rgba(141, 255, 216, 0.14)'
} as const

export const theme = createAppTheme({
  primary: {
    50: '#e6fff6', 100: '#c2ffea', 200: '#8dffd8', 300: '#57f4c1',
    400: '#33d7a6', 500: '#1cab84', 600: '#14886a', 700: '#106a54',
    800: '#0f5444', 900: '#0d463a'
  },
  warning: {
    50: '#fffde8', 100: '#fff7b3', 200: '#ffeb75', 300: '#ffdd3f',
    400: '#f2c91c', 500: '#cda700', 600: '#9d8100', 700: '#766200',
    800: '#524500', 900: '#312a00'
  },
  neutral: {
    50: '#f8fafc', 100: '#e1e7ef', 200: '#c1ccda', 300: '#d3dde7',
    400: '#c4d0dd', 500: '#687a94', 600: '#506077', 700: '#3b4d66',
    800: '#243043', 900: '#161d2e'
  },
  chrome: defaultChrome,
  background: {
    body: '#070b14',
    surface: 'rgba(19, 27, 42, 0.55)',
    popup: 'rgba(18, 26, 40, 0.96)',
    level1: 'rgba(19, 27, 42, 0.6)',
    level2: '#24364d',
    level3: '#355076'
  },
  text: {
    primary: '#fff',
    secondary: '#dee7f0',
    tertiary: '#d4dee8',
    icon: '#d4dee8'
  }
})

export const auroraTheme = createAppTheme({
  primary: {
    50: '#e6fff6', 100: '#c2ffea', 200: '#8dffd8', 300: '#57f4c1',
    400: '#33d7a6', 500: '#1cab84', 600: '#14886a', 700: '#106a54',
    800: '#0f5444', 900: '#0d463a'
  },
  warning: {
    50: '#fffde8', 100: '#fff7b3', 200: '#ffeb75', 300: '#ffdd3f',
    400: '#f2c91c', 500: '#cda700', 600: '#9d8100', 700: '#766200',
    800: '#524500', 900: '#312a00'
  },
  neutral: {
    50: '#f8fafc', 100: '#e1e7ef', 200: '#c1ccda', 300: '#d3dde7',
    400: '#c4d0dd', 500: '#687a94', 600: '#506077', 700: '#3b4d66',
    800: '#243043', 900: '#161d2e'
  },
  chrome: auroraChrome,
  background: {
    body: '#08111b',
    surface: 'rgba(21, 26, 31, 0.68)',
    popup: 'rgba(14, 18, 23, 0.96)',
    level1: 'rgba(23, 29, 34, 0.82)',
    level2: '#1b232b',
    level3: '#263341'
  },
  text: {
    primary: '#fff',
    secondary: '#d1dbe5',
    tertiary: '#bdcad9',
    icon: '#bdcad9'
  }
})

/**
 * Sticky tab styling shared by every section nav. Pulled out of the
 * layout so individual pages can re-use the same look if they need to
 * present a secondary nav.
 *
 * The padding and height here are the baseline for a row that does no fitting.
 * `AppShell`'s desktop row does, so `navDensitySx` below restates both at every
 * rung and wins on specificity: change one and check the other.
 */
export const sectionTabSx = {
  /**
   * A tab is never narrower than its own label. It grows to share out the bar,
   * and when the labels genuinely do not fit, the ROW scrolls (`AppShell`'s
   * TabList sets `overflowX: auto`) rather than every tab shrinking.
   *
   * `1 0 auto`, not `1 1 auto`: with shrink enabled and a floor of 0 the tabs
   * always gave way, so EVERY label truncated a little and none was readable,
   * and because the row then always fitted, the scroll it is supposed to fall
   * back on never engaged. Growing is still wanted (the tabs fill the pill);
   * only the shrinking was wrong.
   *
   * `max-content` on both breakpoints for the same reason mobile already had
   * it: that row scrolls by design, and now so does this one.
   */
  flex: { xs: '1 0 auto', sm: '1 0 auto' },
  minHeight: { xs: 52, sm: 52 },
  minWidth: { xs: 'max-content', sm: 'max-content' },
  px: { xs: 1, sm: 2 },
  borderRadius: 'md',
  color: 'var(--printstream-section-nav-text)',
  fontSize: { xs: 'sm', sm: 'md' },
  fontWeight: 'md',
  whiteSpace: 'nowrap',
  transition: 'background-color 180ms ease, color 180ms ease, box-shadow 180ms ease, border-color 180ms ease',
  '&:hover': {
    backgroundColor: 'var(--printstream-section-tab-hover-background)',
    color: 'var(--printstream-section-tab-hover-color)'
  },
  '&.Mui-selected': {
    color: 'var(--printstream-section-tab-selected-color)',
    backgroundColor: 'var(--printstream-section-tab-selected-background)',
    boxShadow: 'inset 0 0 0 1px var(--printstream-section-tab-selected-ring)',
    borderColor: 'var(--printstream-section-tab-selected-border)'
  }
} as const

/**
 * How a nav row tightens when its tabs do not fit, keyed off the
 * `data-nav-density` attribute that `useFittedNavDensity` writes.
 *
 * Spread onto the SCROLL CONTAINER, not the tabs: the rules have to out-specify
 * each tab's own `sectionTabSx`, and a container-plus-attribute selector does
 * that on its own. Putting them on the tab would need `!important` or a second
 * responsive object to fight the first.
 *
 * Every rung is stated here, `comfortable` included, so the ladder reads as one
 * table rather than three steps measured against a baseline kept elsewhere.
 * The first three keep every label, only `icons` hides one, and by then the
 * words genuinely do not fit. See the hook for why truncation is not a rung.
 *
 * The padding is deliberately tighter than a button's would be. A tab grows to
 * fill the pill anyway (`sectionTabSx` sets `flex: 1 0 auto`), so generous
 * padding buys no breathing room at a comfortable width, it only inflates the
 * tab's INTRINSIC width, which is the thing the fitting loop measures, and so
 * costs a rung earlier than it needs to.
 */
export const navDensitySx = {
  '&[data-nav-density="comfortable"]': {
    gap: 0.75,
    px: 1,
    '& .MuiTab-root': { px: 1.25, minHeight: 52 },
    '& [data-nav-tab-gap]': { gap: '6px' }
  },
  // Padding only. The type stays at full size through this rung and the next,
  // because a tab's horizontal padding is pure slack -- the text never reaches
  // the edge -- and spending slack costs the reader nothing.
  '&[data-nav-density="snug"]': {
    gap: 0.5,
    px: 0.75,
    '& .MuiTab-root': { px: 0.875, minHeight: 52 },
    '& [data-nav-tab-gap]': { gap: '5px' }
  },
  // Padding at its floor: still clear of the text, but with nothing left to
  // give. Anything past here has to come out of the type or the words.
  '&[data-nav-density="tight"]': {
    gap: 0.375,
    px: 0.5,
    '& .MuiTab-root': { px: 0.5, minHeight: 52 },
    '& [data-nav-tab-gap]': { gap: '4px' }
  },
  // The first rung that costs legibility, and only reached once all three
  // padding rungs are spent.
  '&[data-nav-density="condensed"]': {
    gap: 0.375,
    px: 0.5,
    '& .MuiTab-root': { px: 0.5, minHeight: 48, fontSize: 'sm' },
    '& .MuiTab-root svg': { fontSize: 18 },
    '& [data-nav-tab-gap]': { gap: '4px' },
    // The logo steps with the TYPE, not with the padding. It reads as another
    // piece of lettering in the row, so shrinking it on a rung where every word
    // stayed full size made the bar look like it had changed size when nothing
    // else had.
    '& [data-nav-logo]': { width: 38, height: 38 }
  },
  '&[data-nav-density="icons"]': {
    gap: 0.25,
    px: 0.5,
    // The padding comes BACK here: with no label to pad, this is the icon's
    // hit area rather than slack around text.
    '& .MuiTab-root': { px: 1.25, minHeight: 48 },
    // The icon carries the tab on its own now, so the row must not also
    // reserve the label's width -- `sectionTabSx` floors every tab at
    // `max-content`, which would still be measured from the hidden text.
    '& [data-nav-label]': { display: 'none' },
    '& [data-nav-logo]': { width: 38, height: 38 }
  }
} as const
