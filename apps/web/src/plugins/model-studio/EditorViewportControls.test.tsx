import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
dom.window.requestAnimationFrame = () => 1
dom.window.cancelAnimationFrame = () => {}

const React = (await import('react')).default
// The Node test transpiler uses classic JSX; Vite supplies the runtime for these app modules.
const reactGlobal = globalThis as typeof globalThis & { React?: typeof React }
const previousReact = reactGlobal.React
reactGlobal.React = React
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { EditorViewportControls } = await import('./EditorViewportControls')

afterEach(() => cleanup())
after(() => {
  if (previousReact) reactGlobal.React = previousReact
  else Reflect.deleteProperty(reactGlobal, 'React')
  dom.window.close()
})

type Props = Parameters<typeof EditorViewportControls>[0]

function controls(overrides: Partial<Props> = {}) {
  const events: string[] = []
  const props: Props = {
    setStripElement: () => {},
    isMobile: false,
    showEditorChrome: true,
    fullScreen: false,
    sidebarCollapsed: false,
    onToggleSidebar: () => events.push('sidebar'),
    onToggleFullScreen: () => events.push('fullscreen'),
    canUndo: true,
    canRedo: false,
    controlsBusy: false,
    onUndo: () => events.push('undo'),
    onRedo: () => events.push('redo'),
    hasProcessSettings: true,
    hasProject: true,
    onOpenParameterTable: () => events.push('parameters'),
    onOpenProjectFiles: () => events.push('files'),
    onOpenEditorSettings: () => events.push('settings'),
    mode: 'translate',
    selectedKey: 'object-1',
    arrangeDisabled: false,
    onChangeMode: (mode) => events.push(`mode:${mode}`),
    onDropToBed: () => events.push('drop'),
    onAutoOrient: () => events.push('orient'),
    onArrangeAll: () => events.push('arrange'),
    ...overrides
  }
  render(<CssVarsProvider><EditorViewportControls {...props} /></CssVarsProvider>)
  return events
}

test('desktop viewport controls route history, sidebar, and tool actions once', () => {
  const events = controls()

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))
  fireEvent.click(screen.getByRole('button', { name: 'Parameter table' }))
  fireEvent.click(screen.getByRole('button', { name: 'Auto-arrange all objects on this plate' }))

  assert.deepEqual(events, ['undo', 'sidebar', 'parameters', 'arrange'])
  assert.equal((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled, true)
})

test('phone 3D-only controls keep history and tools but hide editor chrome actions', () => {
  controls({ isMobile: true, showEditorChrome: false, fullScreen: true })

  assert.ok(screen.getByRole('button', { name: 'Undo' }))
  assert.ok(screen.getByRole('button', { name: 'Move' }))
  assert.equal(screen.queryByRole('button', { name: 'Hide sidebar' }), null)
  assert.equal(screen.queryByRole('button', { name: 'Editor settings' }), null)
  assert.equal(screen.queryByRole('button', { name: 'Parameter table' }), null)
})
