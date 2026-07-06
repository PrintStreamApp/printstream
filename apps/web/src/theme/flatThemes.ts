/**
 * The flat theme family: minimal matte surfaces, hairline borders, and no
 * gradients, glass, or ambient effects.
 *
 * Three bases share one factory: Graphite (takes after Papra's flat zinc
 * document-app look, offered in four accent colors), Slate (the flat sibling
 * of the Default theme: its navy surfaces and brand teal-green accent, minus
 * the atmosphere), and Code Dark (takes after VS Code's Dark Modern: gray
 * surfaces with the classic blue accent). A base owns the neutral surfaces;
 * an accent owns the primary ramp, the solid-control treatment, and the
 * tinted chrome slots (focus ring, selected tab, empty-state icon).
 *
 * Accent ramp conventions (mirrors what buildTheme's overrides draw on):
 * - 300 is the brand shade (links, selected-tab text, alpha tints); solid
 *   controls instead use a DEEP accent fill with white text so primary
 *   buttons sit in the same register as every other control (neutral
 *   soft/outlined, warning/danger, Code Dark's blue) — a light fill with
 *   dark text read as out of place next to them.
 * - 600-900 are deliberately dark and desaturated — soft/outlined primary
 *   controls fill from them, and a bright shade there reads as loud mud
 *   instead of a quiet tinted surface.
 */
import type { AppThemeSetting } from '@printstream/shared'
import { createAppTheme, type PrintStreamThemePalette } from './buildTheme'

/** Theme ids handled by this module (everything except default/aurora). */
export type FlatAppTheme = Exclude<AppThemeSetting, 'default' | 'aurora'>

export function isFlatAppTheme(value: AppThemeSetting): value is FlatAppTheme {
  return value !== 'default' && value !== 'aurora'
}

interface FlatThemeBase {
  /** Flat page background (no gradient). */
  body: string
  /** Card/panel fill — one shade darker than the body, per the reference apps. */
  panel: string
  /** Hairline border for panels and nav chrome. */
  border: string
  /** Slightly raised border for modals/popups. */
  borderStrong: string
  neutral: Record<number, string>
  background: PrintStreamThemePalette['background']
  text: PrintStreamThemePalette['text']
  /** Sticky table header fill (a step off the panel so the band is legible). */
  tableHeader: string
}

type RampStop = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900

interface FlatThemeAccent {
  /** 50-900 scale following the ramp conventions in the module doc. */
  ramp: Record<RampStop, string>
  /** Joy solid-variant overrides for primary controls. */
  solid: { bg: string; color: string; hoverBg: string; activeBg: string }
  /** 'R, G, B' of the brand shade, for the alpha-tinted chrome slots. */
  brandRgb: string
}

/** Shared warning ramp (Papra's orange, hsl(31 98% 50%)). */
const FLAT_WARNING = {
  50: '#fff4e3', 100: '#ffe4bd', 200: '#ffcd85', 300: '#ffb254',
  400: '#fd9c26', 500: '#e88908', 600: '#b96c06', 700: '#8c5205',
  800: '#653b03', 900: '#472a02'
}

function createFlatChrome(base: FlatThemeBase, accent: FlatThemeAccent): PrintStreamThemePalette['chrome'] {
  const panelRgb = base.panel
  return {
    // 'none'/'transparent' are valid values for the background/shadow slots
    // these vars feed; they disable every ambient/glass effect.
    surfacePanelStyle: 'glass',
    bodyBackground: base.body,
    ambientOverlayBase: 'none',
    ambientOverlayGlow: 'none',
    ambientHighlight: 'none',
    ambientSpectrum: 'none',
    shellNavBackground: panelRgb,
    shellNavBorder: base.border,
    shellNavTopLine: 'rgba(255, 255, 255, 0.04)',
    shellNavInsetHighlight: 'transparent',
    shellNavShadowRing: 'rgba(0, 0, 0, 0.35)',
    sectionNavBackground: panelRgb,
    sectionNavBorder: base.border,
    sectionNavShadowRing: 'rgba(0, 0, 0, 0.25)',
    sectionNavText: 'var(--joy-palette-neutral-400)',
    sectionNavTextHover: 'var(--joy-palette-neutral-50)',
    sectionNavFocusRing: `rgba(${accent.brandRgb}, 0.45)`,
    sectionNavCount: 'var(--joy-palette-neutral-400)',
    sectionNavSeparator: 'rgba(255, 255, 255, 0.14)',
    sectionTabHoverBackground: 'rgba(255, 255, 255, 0.05)',
    sectionTabHoverColor: 'var(--joy-palette-neutral-50)',
    sectionTabSelectedColor: 'var(--joy-palette-primary-200)',
    sectionTabSelectedBackground: `rgba(${accent.brandRgb}, 0.09)`,
    sectionTabSelectedRing: `rgba(${accent.brandRgb}, 0.14)`,
    sectionTabSelectedBorder: 'transparent',
    modalDialogBackground: base.panel,
    modalDialogBorder: base.borderStrong,
    primarySoftCardGradientStart: accent.ramp[800],
    primarySoftCardGradientEnd: accent.ramp[900],
    surfacePanelBackground: base.panel,
    surfacePanelBorder: base.border,
    surfacePanelInsetHighlight: 'transparent',
    surfacePanelShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
    surfacePanelBackdropFilter: 'none',
    surfacePanelGradient: 'none',
    surfacePanelGlow: 'none',
    surfacePanelEdgeHighlight: 'transparent',
    tableHeaderBackground: base.tableHeader,
    tableRowStripeBackground: 'transparent',
    tableRowHoverBackground: 'rgba(255, 255, 255, 0.035)',
    emptyStateBackground: base.panel,
    emptyStateBorder: base.border,
    emptyStateIconBackground: `rgba(${accent.brandRgb}, 0.08)`,
    emptyStateIconBorder: `rgba(${accent.brandRgb}, 0.18)`
  }
}

function createFlatTheme(base: FlatThemeBase, accent: FlatThemeAccent) {
  const chrome = createFlatChrome(base, accent)
  return {
    chrome,
    theme: createAppTheme({
      primary: {
        ...accent.ramp,
        solidBg: accent.solid.bg,
        solidColor: accent.solid.color,
        solidHoverBg: accent.solid.hoverBg,
        solidActiveBg: accent.solid.activeBg
      },
      warning: FLAT_WARNING,
      neutral: base.neutral,
      chrome,
      background: base.background,
      text: base.text
    })
  }
}

/** Papra-style zinc base: body hsl(240 4% 10%), panels hsl(240 4% 8%). */
const GRAPHITE_BASE: FlatThemeBase = {
  body: '#18181b',
  panel: '#131316',
  border: '#26262b',
  borderStrong: '#2e2e33',
  neutral: {
    50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8',
    400: '#a1a1aa', 500: '#71717a', 600: '#3f3f46', 700: '#2a2a2f',
    800: '#1f1f23', 900: '#161619'
  },
  background: {
    body: '#18181b',
    surface: '#131316',
    popup: '#1c1c20',
    level1: '#1c1c20',
    level2: '#232327',
    level3: '#2c2c31'
  },
  text: {
    primary: '#fafafa',
    secondary: '#d4d4d8',
    tertiary: '#a1a1aa',
    icon: '#a1a1aa'
  },
  tableHeader: '#18181c'
}

/** VS Code Dark Modern base: #1f1f1f editor, #181818 side/title bars. */
const CODE_DARK_BASE: FlatThemeBase = {
  body: '#1f1f1f',
  panel: '#181818',
  border: '#2b2b2b',
  borderStrong: '#3c3c3c',
  neutral: {
    50: '#f8f8f8', 100: '#e7e7e7', 200: '#cccccc', 300: '#bbbbbb',
    400: '#9d9d9d', 500: '#6e6e6e', 600: '#454545', 700: '#313131',
    800: '#252525', 900: '#1b1b1b'
  },
  background: {
    body: '#1f1f1f',
    surface: '#181818',
    popup: '#242424',
    level1: '#242424',
    level2: '#2d2d2d',
    level3: '#373737'
  },
  text: {
    primary: '#e7e7e7',
    secondary: '#cccccc',
    tertiary: '#9d9d9d',
    icon: '#9d9d9d'
  },
  tableHeader: '#202020'
}

/** The Default theme's navy-slate surfaces, flattened. */
const SLATE_BASE: FlatThemeBase = {
  body: '#151c2c',
  panel: '#0f1522',
  border: '#252e40',
  borderStrong: '#2e3950',
  neutral: {
    50: '#f8fafc', 100: '#e8edf4', 200: '#cbd5e1', 300: '#b0bccd',
    400: '#8798ad', 500: '#5d7089', 600: '#3b4d66', 700: '#293850',
    800: '#1e2a3e', 900: '#141d2c'
  },
  background: {
    body: '#151c2c',
    surface: '#0f1522',
    popup: '#1a2334',
    level1: '#1a2334',
    level2: '#212c40',
    level3: '#2a374e'
  },
  text: {
    primary: '#f5f8fb',
    secondary: '#d7e0ea',
    tertiary: '#a5b3c4',
    icon: '#a5b3c4'
  },
  tableHeader: '#141b2a'
}

/**
 * The bright ends (50-500) are deliberately muted — mid-lightness, LOW
 * saturation — rather than the reference apps' pastel/neon accents, so the
 * accent sits WITH the matte grays instead of glowing on top of them
 * (design feedback: literal reference-app pastels read overly bright on
 * these bases). Code Dark keeps VS Code's literal button blue, which is
 * already mid-tone.
 */
const GRAPHITE_ACCENTS: Record<Exclude<FlatAppTheme, 'slate' | 'code-dark'>, FlatThemeAccent> = {
  /** Muted take on the PrintStream brand teal-green. */
  'graphite-green': {
    ramp: {
      50: '#e0f0eb', 100: '#b1d9ce', 200: '#86c1b0', 300: '#68b19c',
      400: '#53a18b', 500: '#438975', 600: '#24604c', 700: '#183f32',
      800: '#122b23', 900: '#0c1d17'
    },
    solid: { bg: '#127a5c', color: '#ffffff', hoverBg: '#0f684e', activeBg: '#0c5640' },
    brandRgb: '104, 177, 156'
  },
  /** Steel blue. */
  'graphite-sky': {
    ramp: {
      50: '#e6eef4', 100: '#c2d6e4', 200: '#91b2ca', 300: '#6e9ab9',
      400: '#5689ae', 500: '#457496', 600: '#244c60', 700: '#18323f',
      800: '#12232b', 900: '#0c171d'
    },
    solid: { bg: '#457496', color: '#ffffff', hoverBg: '#3b6584', activeBg: '#325672' },
    brandRgb: '110, 154, 185'
  },
  /** Dusty lavender. */
  'graphite-violet': {
    ramp: {
      50: '#ebe8f4', 100: '#cdc6e2', 200: '#aa9fcb', 300: '#9081bb',
      400: '#7b6caf', 500: '#66549c', 600: '#3b285d', 700: '#271a3d',
      800: '#1c1429', 900: '#130d1c'
    },
    solid: { bg: '#66549c', color: '#ffffff', hoverBg: '#59488a', activeBg: '#4c3d77' },
    brandRgb: '144, 129, 187'
  },
  /** Dusty rose. */
  'graphite-rose': {
    ramp: {
      50: '#f4e6e8', 100: '#e4c4c8', 200: '#cf9ba2', 300: '#c07c85',
      400: '#b4646f', 500: '#a34d58', 600: '#60242e', 700: '#3f181e',
      800: '#2b1216', 900: '#1d0c0f'
    },
    solid: { bg: '#a34d58', color: '#ffffff', hoverBg: '#8f424d', activeBg: '#7b3842' },
    brandRgb: '192, 124, 133'
  }
}

/**
 * VS Code's blue. Unlike the pastel Graphite accents, solid controls follow
 * VS Code itself: #0078d4 with white text, darkening on hover/press.
 */
const CODE_DARK_ACCENT: FlatThemeAccent = {
  ramp: {
    50: '#e3f2fd', 100: '#bbdefb', 200: '#8ec8f8', 300: '#57aef7',
    400: '#2b90e8', 500: '#0078d4', 600: '#244560', 700: '#182d3f',
    800: '#12202b', 900: '#0c151d'
  },
  solid: { bg: '#0078d4', color: '#ffffff', hoverBg: '#026ec1', activeBg: '#0066b8' },
  brandRgb: '0, 120, 212'
}

export interface FlatThemeVariant {
  label: string
  chrome: PrintStreamThemePalette['chrome']
  theme: ReturnType<typeof createAppTheme>
}

/**
 * Every flat theme, keyed by its persisted setting value. The Record over
 * the full FlatAppTheme union keeps this exhaustive: adding a value to the
 * shared appThemeSettingSchema without a variant here fails typecheck.
 */
export const flatThemeVariants: Record<FlatAppTheme, FlatThemeVariant> = {
  'graphite-green': { label: 'Graphite Green', ...createFlatTheme(GRAPHITE_BASE, GRAPHITE_ACCENTS['graphite-green']) },
  'graphite-sky': { label: 'Graphite Sky', ...createFlatTheme(GRAPHITE_BASE, GRAPHITE_ACCENTS['graphite-sky']) },
  'graphite-violet': { label: 'Graphite Violet', ...createFlatTheme(GRAPHITE_BASE, GRAPHITE_ACCENTS['graphite-violet']) },
  'graphite-rose': { label: 'Graphite Rose', ...createFlatTheme(GRAPHITE_BASE, GRAPHITE_ACCENTS['graphite-rose']) },
  // The flat Default: navy base + the same brand teal-green accent the
  // Default theme's primary ramp uses (shared with Graphite Green).
  slate: { label: 'Slate', ...createFlatTheme(SLATE_BASE, GRAPHITE_ACCENTS['graphite-green']) },
  'code-dark': { label: 'Code Dark', ...createFlatTheme(CODE_DARK_BASE, CODE_DARK_ACCENT) }
}

/** Ordered options for the Settings theme selects (shared + per-device). */
export const appThemeOptions: ReadonlyArray<{ value: AppThemeSetting; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'aurora', label: 'Aurora' },
  ...(Object.entries(flatThemeVariants) as Array<[FlatAppTheme, FlatThemeVariant]>).map(
    ([value, variant]) => ({ value, label: variant.label })
  )
]
