import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auroraTheme, theme } from './theme'
import { flatThemeVariants } from './flatThemes'

type RootOverride = (input: { ownerState: { color?: string; variant?: string } }) => Record<string, unknown>

// Regression: the theme styled `JoyButton` and `JoyIconButton` but not `JoyMenuButton`, whose root
// class is `MuiMenuButton-root`, not `MuiButton-root`. A soft MenuButton therefore rendered Joy's
// stock fill beside our own: reported as "the Add material button looks different once a printer is
// selected", because selecting a printer is what turns that button into a menu.
test('every theme styles the whole button family, so a MenuButton matches a Button', () => {
  const themes = [
    ['default', theme],
    ['aurora', auroraTheme],
    ...Object.entries(flatThemeVariants).map(([id, variant]) => [id, variant.theme] as const)
  ] as const
  for (const [name, candidate] of themes) {
    // `components` is not on Joy's public Theme type (it is consumed internally by the styled
    // engine), but extendTheme keeps what was passed in, which is exactly what this pins.
    const components = (candidate as unknown as { components: Record<string, { styleOverrides?: { root?: unknown } } | undefined> }).components
    const button = components.JoyButton?.styleOverrides?.root
    const menuButton = components.JoyMenuButton?.styleOverrides?.root
    assert.equal(typeof button, 'function', `${name}: JoyButton has a root override`)
    assert.equal(menuButton, button, `${name}: JoyMenuButton uses the same root override as JoyButton`)
    // And that override actually paints the soft treatment rather than falling through empty.
    const soft = (button as RootOverride)({ ownerState: { variant: 'soft', color: 'primary' } })
    assert.ok(Object.keys(soft).length > 0, `${name}: a soft button gets the app's own styling`)
  }
})
