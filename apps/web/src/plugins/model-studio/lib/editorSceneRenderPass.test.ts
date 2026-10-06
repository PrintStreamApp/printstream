import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorSceneRenderPass } from './editorSceneRenderPass'

test('render pass updates overlays and selections before scene, then outlines and view cube', () => {
  const calls: string[] = []
  let hasSecondary = true
  const render = createEditorSceneRenderPass({
    syncPaintOverlays: (interacting) => { calls.push(`paint:${interacting}`) },
    updatePrimarySelection: (interacting, dragJustEnded) => {
      calls.push(`primary:${interacting}:${dragJustEnded}`)
      return dragJustEnded
    },
    syncBrimEarMarkers: () => { calls.push('ears') },
    syncSecondarySelections: () => { calls.push('secondary') },
    syncScreenAnnotations: () => { calls.push('annotations') },
    renderScene: () => { calls.push('scene') },
    hasSecondarySelections: () => hasSecondary,
    renderSelectionOutlines: () => { calls.push('outlines') },
    syncViewCube: () => { calls.push('cube') }
  })

  assert.equal(render(true, true), true)
  assert.deepEqual(calls, [
    'paint:true', 'primary:true:true', 'ears', 'secondary', 'annotations', 'scene', 'outlines', 'cube'
  ])

  calls.length = 0
  hasSecondary = false
  assert.equal(render(false, false), false)
  assert.deepEqual(calls, [
    'paint:false', 'primary:false:false', 'ears', 'secondary', 'annotations', 'scene', 'cube'
  ])
})
