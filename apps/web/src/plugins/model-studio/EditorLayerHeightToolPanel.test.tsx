import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { seedEmptyEditorState, type EditorInstance } from './lib/editorModel'

const dom = installJsdomGlobals()
dom.window.requestAnimationFrame = () => 1
dom.window.cancelAnimationFrame = () => {}

const React = (await import('react')).default
// Node's test transpiler uses classic JSX; Vite supplies the runtime in the app.
const reactGlobal = globalThis as typeof globalThis & { React?: typeof React }
const previousReact = reactGlobal.React
reactGlobal.React = React
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { EditorLayerHeightToolPanel } = await import('./EditorLayerHeightToolPanel')

afterEach(cleanup)
after(() => {
  if (previousReact) reactGlobal.React = previousReact
  else Reflect.deleteProperty(reactGlobal, 'React')
  dom.window.close()
})

function fixture(withGeometry: boolean) {
  const state = seedEmptyEditorState()
  const instance: EditorInstance = {
    key: 'object-1', source: { kind: 'object' }, objectId: 1, instanceId: 0, name: 'Test block',
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1, printable: true, parts: [], color: null
  }
  state.plates[0]!.instances.push(instance)
  const group = new THREE.Group()
  if (withGeometry) group.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10)))
  const profiles: Array<{ objectId: number; profile: number[]; checkpoint?: boolean }> = []
  let closed = 0
  render(
    <CssVarsProvider>
      <EditorLayerHeightToolPanel
        target={{ key: 'object-1', objectId: 1 }}
        state={state}
        groups={new Map([['object-1', group]])}
        bounds={{ min: 0.07, max: 0.3 }}
        nominalHeight={0.2}
        firstLayerHeight={0.2}
        onProfileChange={(objectId, profile, checkpoint) => profiles.push({ objectId, profile, checkpoint })}
        onBrushChange={() => {}}
        onClose={() => { closed += 1 }}
      />
    </CssVarsProvider>
  )
  return { profiles, closed: () => closed }
}

test('layer height adapter routes reset and Done for printable geometry', () => {
  const { profiles, closed } = fixture(true)
  assert.ok(screen.getByLabelText('Layer thickness for Test block: drag to paint'))
  fireEvent.click(screen.getByRole('button', { name: 'Reset to uniform layer height' }))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  assert.deepEqual(profiles, [{ objectId: 1, profile: [], checkpoint: undefined }])
  assert.equal(closed(), 1)
})

test('layer height adapter hides controls when the object has no printable geometry', () => {
  fixture(false)
  assert.equal(screen.queryByRole('button', { name: 'Done' }), null)
})
