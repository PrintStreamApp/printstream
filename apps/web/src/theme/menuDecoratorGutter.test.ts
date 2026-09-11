import assert from 'node:assert/strict'
import { test } from 'node:test'
import { theme } from './theme'

// Regression: Joy can collapse later ListItemDecorator gutters to zero even when every row has
// identical markup. The menu theme owns the gutter so raw, shared and plugin menus stay aligned.
test('menus pin one icon gutter for every decorated row', () => {
  const components = (theme as unknown as {
    components: Record<string, { styleOverrides?: { root?: Record<string, unknown> } } | undefined>
  }).components
  const root = components.JoyMenu?.styleOverrides?.root
  assert.deepEqual(root?.['& .MuiListItemDecorator-root'], {
    minInlineSize: 'var(--ListItemDecorator-size)'
  })
})
