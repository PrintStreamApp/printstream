import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIALOG_PRESENTATION_ATTRIBUTE,
  MAXIMIZED_DIALOG_GUTTER,
  dialogPresentationProps,
  resolveDialogPresentation,
  safeFullscreenControlTop,
  scrollableDialogPresentation,
  withoutDialogSizing
} from './dialogPresentation'

test('a full-screen control cluster moves below native top chrome as one unit', () => {
  assert.equal(safeFullscreenControlTop(false, 8), 8)
  assert.equal(safeFullscreenControlTop(true, 8), 'calc(var(--app-top-inset, 0px) + 8px)')
})

test('a host-imposed presentation outranks both toggles', () => {
  assert.equal(
    resolveDialogPresentation({ locked: 'fullscreen', maximized: false, fullScreen: false }),
    'fullscreen'
  )
  assert.equal(resolveDialogPresentation({ locked: 'standard', fullScreen: true }), 'standard')
})

test('full screen outranks maximized, and the base size applies when neither toggle is on', () => {
  assert.equal(resolveDialogPresentation({ maximized: true, fullScreen: true }), 'fullscreen')
  assert.equal(resolveDialogPresentation({ maximized: true }), 'maximized')
  assert.equal(resolveDialogPresentation({}), 'standard')
  // A dialog that is near-full by nature (the editor) has no smaller footprint to fall back to.
  assert.equal(resolveDialogPresentation({ base: 'maximized' }), 'maximized')
})

test('every mode marks itself, so the theme can lift the viewport clamp on the enlarged ones', () => {
  // The clamp beats `sx`, so this attribute is the ONLY way an enlarged dialog escapes it. Losing it
  // is silent: the dialog still renders, just 12px short on every side.
  for (const presentation of ['standard', 'maximized', 'fullscreen'] as const) {
    assert.equal(dialogPresentationProps(presentation)[DIALOG_PRESENTATION_ATTRIBUTE], presentation)
    assert.equal(scrollableDialogPresentation(presentation)[DIALOG_PRESENTATION_ATTRIBUTE], presentation)
  }
})

/** Reads one breakpoint out of a responsive `sx` value. */
function atBreakpoint(value: unknown, breakpoint: 'xs' | 'sm'): string {
  assert.ok(value && typeof value === 'object', `expected a responsive value, got ${String(value)}`)
  return String((value as Record<string, unknown>)[breakpoint])
}

test('maximized pins all four edges inside the safe area instead of centring on the raw viewport', () => {
  const { sx } = dialogPresentationProps('maximized')
  const styles = sx as Record<string, unknown>
  // Centring would put the whole gutter at the bottom on a device with a status bar / title bar.
  assert.equal(styles.transform, 'none')
  assert.equal(styles.width, 'auto')
  assert.equal(styles.height, 'auto')
  // The safe-area insets are honoured at EVERY width. They are a physical obstruction (a notch, a
  // home indicator), unlike the gutter, which is only stylistic and does collapse below.
  for (const breakpoint of ['xs', 'sm'] as const) {
    assert.match(atBreakpoint(styles.top, breakpoint), /--app-top-inset/)
    assert.match(atBreakpoint(styles.bottom, breakpoint), /--app-safe-bottom/)
  }
})

test('the maximized gutter collapses on a phone, where there is no page behind to reveal', () => {
  // The gutter is what separates `maximized` from `fullscreen`: it lets the page behind show at the
  // edges. On a phone the dialog IS the app, so it was only spending ~a tenth of the width on a
  // margin. Both dialog shapes have to agree, or one kind of dialog fills the screen and the other
  // does not.
  const modal = dialogPresentationProps('maximized').sx as Record<string, unknown>
  assert.equal(atBreakpoint(modal.left, 'xs'), '0px')
  assert.equal(atBreakpoint(modal.right, 'xs'), '0px')
  assert.equal(atBreakpoint(modal.left, 'sm'), MAXIMIZED_DIALOG_GUTTER)
  assert.equal(atBreakpoint(modal.right, 'sm'), MAXIMIZED_DIALOG_GUTTER)
  // A radius with nothing outside it just shows the backdrop through four notches.
  assert.equal(atBreakpoint(modal.borderRadius, 'xs'), '0')
  // And `sm` must RESTATE the radius, never leave it undefined: MUI emits `xs` as
  // `@media (min-width: 0px)` and a sibling resolving to nothing emits no rule, so the phone's 0
  // would win at every width. Measured on the desktop editor, which came back square-cornered.
  assert.match(atBreakpoint(modal.borderRadius, 'sm'), /^var\(/)

  const scroller = scrollableDialogPresentation('maximized').overflowSx as Record<string, unknown>
  assert.equal(atBreakpoint(scroller.px, 'xs'), '0px')
  assert.equal(atBreakpoint(scroller.px, 'sm'), MAXIMIZED_DIALOG_GUTTER)
})

test('full screen uses Joy\'s fullscreen layout in both dialog shapes', () => {
  assert.equal(dialogPresentationProps('fullscreen').layout, 'fullscreen')
  assert.equal(scrollableDialogPresentation('fullscreen').layout, 'fullscreen')
})

test('a full-screen scroller drops its padding AND the variable Joy offsets against', () => {
  const { overflowSx } = scrollableDialogPresentation('fullscreen')
  const styles = overflowSx as Record<string, unknown>
  assert.equal(styles.p, 0)
  // Joy shifts a fullscreen dialog up by `--ModalOverflow-paddingY`. Zeroing the padding alone
  // leaves that offset in place and the dialog rides 24px above the top of the screen.
  assert.equal(styles['--ModalOverflow-paddingY'], '0px')
})

test('a maximized scroller fills its padded box with min-height, not height', () => {
  const styles = scrollableDialogPresentation('maximized').dialogSx as Record<string, unknown>
  // Joy pins a centred dialog inside a scroller to `height: max-content` from a rule that outranks
  // `sx`; only a min-height survives it, and 100% is the padded box so the gutter is exact.
  assert.equal(styles.minHeight, '100%')
  assert.equal(styles.height, undefined)
})

test('standard adds no geometry, so an ordinary dialog keeps its own footprint', () => {
  assert.deepEqual(dialogPresentationProps('standard').sx, {})
  const scrollable = scrollableDialogPresentation('standard')
  assert.deepEqual(scrollable.dialogSx, {})
  assert.equal(scrollable.layout, undefined)
})

test('EVERY mode states the scroller padding outright, standard included', () => {
  // The shell must not set a default that the modes override: MUI emits a responsive value's `xs`
  // entry as `@media (min-width:0px)`, and that media block beats a later flat declaration whatever
  // the `sx` array order. Measured, a maximized dialog kept the shell's 8px gutter over its own
  // 12px. A mode that says nothing about padding silently inherits the wrong gutter again.
  for (const presentation of ['standard', 'maximized', 'fullscreen'] as const) {
    const { overflowSx } = scrollableDialogPresentation(presentation)
    const styles = overflowSx as Record<string, unknown>
    const declaresPadding = 'p' in styles || ('px' in styles && 'pt' in styles && 'pb' in styles)
    assert.ok(declaresPadding, `${presentation} must declare the scroller's padding`)
  }
})

test('withoutDialogSizing removes only the footprint keys', () => {
  // Same cascade trap on the dialog itself: a caller's responsive `width` outranks the mode's flat
  // one, so the mode removes it rather than trying to override it.
  assert.deepEqual(
    withoutDialogSizing({ width: { xs: '100%', md: 1120 }, maxWidth: '100%', p: 0, bgcolor: 'red' }),
    { p: 0, bgcolor: 'red' }
  )
  // A theme callback is not a footprint declaration and must survive untouched.
  const callback = (theme: unknown) => theme
  assert.equal(withoutDialogSizing(callback), callback)
})
