import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'
const dom = installJsdomGlobals()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useProcessSettingsDraft } = await import('./useProcessSettingsDraft')
afterEach(() => cleanup())
after(() => dom.window.close())

test('switching drafts then Cancel leaves selection, settings and history untouched', () => {
  let commits = 0
  const props = { open: true, profileId: 'original', overrides: { wall_loops: '4' }, onProfileChange: () => { ++commits } }
  const view = renderHook((input) => useProcessSettingsDraft(input), { initialProps: props })
  act(() => view.result.current.chooseProfile('custom', { wall_loops: '4' }))
  assert.equal(view.result.current.profileId, 'custom')
  assert.equal(commits, 0)
  view.rerender({ ...props, open: false })
  view.rerender(props)
  assert.equal(view.result.current.profileId, 'original')
  assert.deepEqual(view.result.current.overrides, { wall_loops: '4' })
  assert.equal(commits, 0)
})

test('Apply commits the final draft and unapplied values once, allowing an empty reset map', () => {
  const commits: unknown[] = []
  const view = renderHook(() => useProcessSettingsDraft({ open: true, profileId: 'original', overrides: {},
    onApply: () => { throw new Error('must not create a second history entry') },
    onProfileChange: (id, overrides) => commits.push({ id, overrides }) }))
  act(() => view.result.current.chooseProfile('custom-one', { wall_loops: '4' }))
  act(() => view.result.current.chooseProfile('custom-two', {}))
  assert.deepEqual(commits, [])
  act(() => view.result.current.apply({}, { clearedKeys: [] }))
  assert.deepEqual(commits, [{ id: 'custom-two', overrides: {} }])
})
