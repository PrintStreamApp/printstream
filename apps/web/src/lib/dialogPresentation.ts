/**
 * Shared geometry for a dialog's size MODES.
 *
 * A dialog whose body is a viewport (a 3D scene, a video, an editor) offers more than one size: its
 * normal footprint, a MAXIMIZED one that leaves only a thin gutter, and a FULL SCREEN one that goes
 * edge to edge with no chrome at all. This module owns what each of those means in CSS, for the two
 * shapes a dialog takes in this app:
 *
 *  - a `ModalDialog` placed directly inside a `Modal` (`dialogPresentationProps`), and
 *  - the `ModalOverflow` + `ModalDialog` pair behind `ScrollableModalDialog`
 *    (`scrollableDialogPresentation`).
 *
 * Why this is shared rather than per-dialog `sx`: every mode has to escape the app-wide viewport
 * clamp the theme puts on EVERY `ModalDialog` (`modalDialogAutoScrollStyles`), and Joy applies theme
 * `styleOverrides` AFTER `sx` — so a dialog cannot size past that clamp from its own `sx` at all,
 * however it phrases it. The one escape hatch is the `data-dialog-presentation` attribute, whose
 * matching rules live beside the clamp in `theme/buildTheme.ts`. Left to per-dialog `sx`, this drifted
 * into three different "full screen" sizes (99vw, 96vw, 100vw-inside-a-padded-overflow), none of
 * which actually reached the edge of a phone screen.
 *
 * Insets: maximized positions against `--app-top-inset` / `--app-safe-bottom` rather than centring on
 * the raw viewport, because the status bar / title bar overlays the top — centring on the raw
 * viewport puts the gutter in the wrong place and pushes the dialog under the chrome. Full screen
 * deliberately ignores both: it IS the screen, and its own content is responsible for staying clear
 * of the notch.
 *
 * Counterparts: `theme/buildTheme.ts` (the clamp and its exemptions), `components/ScrollableDialog.tsx`
 * (the overflow host), `hooks/useDialogPresentationState.ts` (the state and its persistence rule),
 * `components/DialogPresentationToggles.tsx` (the buttons that switch modes).
 */
import type { ModalDialogProps } from '@mui/joy'
import type { Theme } from '@mui/joy/styles'
import type { SystemStyleObject } from '@mui/system'

/** One `sx` object — deliberately not the wider `SxProps`, so a caller can merge it into an array. */
type DialogStyles = SystemStyleObject<Theme>

/**
 * How much of the screen a dialog takes.
 *
 * - `standard` — the dialog's own footprint, clamped to the viewport by the theme.
 * - `maximized` — the whole screen bar a gutter, keeping the dialog's border, radius and chrome so
 *   the page behind still reads as present.
 * - `fullscreen` — edge to edge, no border, radius or shadow. The dialog IS the screen.
 */
export type DialogPresentation = 'standard' | 'maximized' | 'fullscreen'

/**
 * Marks a dialog's mode on its root element. The theme reads it to lift the viewport clamp; tests and
 * devtools read it to tell the modes apart. Always emitted, including for `standard`, so the absence
 * of the attribute means "this dialog does not participate" rather than "standard".
 */
export const DIALOG_PRESENTATION_ATTRIBUTE = 'data-dialog-presentation'

/**
 * Gutter left around a maximized dialog: small enough to read as "the whole screen", wide enough that
 * the page behind still shows at the edges — which is the whole difference from `fullscreen`.
 */
export const MAXIMIZED_DIALOG_GUTTER = '0.75rem'

const SAFE_TOP = `calc(var(--app-top-inset, 0px) + ${MAXIMIZED_DIALOG_GUTTER})`
const SAFE_BOTTOM = `calc(var(--app-safe-bottom, 0px) + ${MAXIMIZED_DIALOG_GUTTER})`

export interface DialogPresentationInputs {
  /** The user's "make this bigger" preference. */
  maximized?: boolean
  /** The user's "hide everything but the content" toggle. Implies maximized, taken all the way. */
  fullScreen?: boolean
  /** Size when neither toggle is on. A dialog that is near-full by nature passes `maximized`. */
  base?: Exclude<DialogPresentation, 'fullscreen'>
  /** A presentation the HOST imposes, winning over both toggles — e.g. a page that is the dialog. */
  locked?: DialogPresentation
}

/** Resolves the toggles, the dialog's base size and any host-imposed mode into one presentation. */
export function resolveDialogPresentation(inputs: DialogPresentationInputs): DialogPresentation {
  if (inputs.locked) return inputs.locked
  if (inputs.fullScreen) return 'fullscreen'
  if (inputs.maximized) return 'maximized'
  return inputs.base ?? 'standard'
}

export interface DialogPresentationProps {
  [DIALOG_PRESENTATION_ATTRIBUTE]: DialogPresentation
  layout?: ModalDialogProps['layout']
  sx: DialogStyles
}

/**
 * Props for a `ModalDialog` rendered directly inside a `Modal`.
 *
 * Spread these AFTER the dialog's own `layout`/`sx` so a mode wins over the standard footprint, and
 * merge rather than replace any `sx` the caller still needs (`sx={[ownSx, presentation.sx]}`).
 */
export function dialogPresentationProps(presentation: DialogPresentation): DialogPresentationProps {
  if (presentation === 'fullscreen') {
    return {
      [DIALOG_PRESENTATION_ATTRIBUTE]: presentation,
      // Joy's own fullscreen layout pins the dialog to all four edges and drops the border and
      // radius; the theme rule keyed on the attribute above lifts the clamp that would otherwise
      // hold it 12px short on every side.
      layout: 'fullscreen',
      sx: { m: 0, boxShadow: 'none' }
    }
  }
  if (presentation === 'maximized') {
    return {
      [DIALOG_PRESENTATION_ATTRIBUTE]: presentation,
      // Not Joy's centred layout: that centres on the raw viewport, so a top inset (phone status
      // bar, desktop title bar) eats the top gutter and leaves a double-width one at the bottom.
      // Pinning all four edges is both exactly centred within the safe area and exactly sized.
      layout: 'center',
      sx: {
        top: SAFE_TOP,
        bottom: SAFE_BOTTOM,
        left: MAXIMIZED_DIALOG_GUTTER,
        right: MAXIMIZED_DIALOG_GUTTER,
        width: 'auto',
        height: 'auto',
        transform: 'none',
        m: 0
      }
    }
  }
  return { [DIALOG_PRESENTATION_ATTRIBUTE]: presentation, sx: {} }
}

const DIALOG_SIZING_KEYS = ['width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight'] as const

/**
 * Drop a dialog's own size declarations, keeping everything else it asked for.
 *
 * An enlarged mode replaces the dialog's footprint, and it cannot do that by simply coming later in
 * the `sx` array: MUI emits a RESPONSIVE value (`width: { xs: '100%', md: 1120 }`) as media blocks,
 * including `@media (min-width:0px)` for `xs`, and a media block beats a later flat declaration at
 * equal specificity. Measured: a maximized preview kept its 1120px/96vw width and overflowed the
 * gutter it was supposed to fill. Removing the keys sidesteps the cascade entirely, and works whatever
 * breakpoints the caller happened to use. `sx` entries that are functions or arrays pass through — a
 * theme callback is not a footprint declaration.
 */
export function withoutDialogSizing<T>(styles: T): T {
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) return styles
  const rest = { ...(styles as Record<string, unknown>) }
  for (const key of DIALOG_SIZING_KEYS) delete rest[key]
  return rest as T
}

export interface ScrollableDialogPresentation {
  /** Styles for the `ModalOverflow` wrapper: it supplies the gutter, so the dialog can fill it. */
  overflowSx: DialogStyles
  /** Styles for the `ModalDialog` itself. */
  dialogSx: DialogStyles
  layout?: ModalDialogProps['layout']
  [DIALOG_PRESENTATION_ATTRIBUTE]: DialogPresentation
}

/**
 * Geometry for the `ModalOverflow` + `ModalDialog` pair behind `ScrollableModalDialog`.
 *
 * The wrapper's padding is the gutter here, because the dialog is a flow child of the scroller rather
 * than an absolutely-positioned box: sizing the dialog to the viewport instead would push it past the
 * padding and hand the user a scrollbar over a "full screen" view. Every mode therefore returns the
 * scroller's padding OUTRIGHT, standard included — it is not an override layered on a shell default.
 * That is deliberate: `sx` merging cannot reliably override a RESPONSIVE value with a flat one,
 * because MUI emits a breakpoint object's `xs` entry as `@media (min-width:0px)` and a media block
 * outranks the plain declaration it was meant to replace whatever the array order. Measured: a
 * maximized dialog kept the shell's 8px gutter and ignored its own 12px. `ScrollableModalDialog`
 * applies this; call it directly only when building another overflow-based shell.
 */
export function scrollableDialogPresentation(presentation: DialogPresentation): ScrollableDialogPresentation {
  if (presentation === 'fullscreen') {
    return {
      [DIALOG_PRESENTATION_ATTRIBUTE]: presentation,
      layout: 'fullscreen',
      overflowSx: {
        p: 0,
        // Joy offsets a fullscreen dialog by minus its scroller's padding; that cancellation is
        // written against `--ModalOverflow-paddingY`, so zero the variable rather than the padding
        // alone or the dialog rides 24px above the top of the screen.
        '--ModalOverflow-paddingY': '0px',
        alignItems: 'stretch',
        justifyContent: 'stretch',
        '& .MuiModalDialog-root': { maxHeight: 'none' }
      },
      dialogSx: { width: '100%', maxWidth: 'none', m: 0, boxShadow: 'none', borderRadius: 0 }
    }
  }
  if (presentation === 'maximized') {
    return {
      [DIALOG_PRESENTATION_ATTRIBUTE]: presentation,
      layout: 'center',
      overflowSx: {
        px: MAXIMIZED_DIALOG_GUTTER,
        pt: SAFE_TOP,
        pb: SAFE_BOTTOM,
        alignItems: 'stretch',
        '& .MuiModalDialog-root': { maxHeight: 'none' }
      },
      // `minHeight`, not `height`: inside a scroller Joy pins a centred dialog to `height: max-content`
      // from a rule that outranks `sx`, which would collapse a flex body back to its content. A
      // min-height wins over that at computed-value time. 100% is the scroller's PADDED box, so the
      // dialog fills the gutter exactly instead of overflowing it.
      dialogSx: { width: '100%', maxWidth: 'none', minHeight: '100%' }
    }
  }
  return {
    [DIALOG_PRESENTATION_ATTRIBUTE]: presentation,
    // The ordinary dialog gutter: wider than the maximized one because a standard dialog is meant to
    // read as a card ON a page, and it grows with the screen.
    overflowSx: {
      px: { xs: 1, sm: 2 },
      pt: { xs: SAFE_TOP, sm: 2 },
      pb: { xs: SAFE_BOTTOM, sm: 2 }
    },
    dialogSx: {}
  }
}
