import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { GizmoMode } from './editorGeometry'
import { LAYER_HEIGHT_OVERLAY_NAME } from './lib/layerHeightOverlay'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorToolModeLifecycle } = await import('./useEditorToolModeLifecycle')

type LifecycleOptions = Parameters<typeof useEditorToolModeLifecycle>[0]

function lifecycleOptions(overrides: Partial<LifecycleOptions> = {}): LifecycleOptions {
  return {
    mode: 'select',
    setMode: () => {},
    selectedKey: null,
    previousSelectedKeyRef: { current: null },
    layerHeightTarget: null,
    clearLayerHeight: () => {},
    clearLayerHeightBrush: () => {},
    groupByKeyRef: { current: new Map<string, THREE.Group>() },
    textPartKey: null,
    textHostKey: null,
    textSettleRef: { current: undefined },
    clearTextPart: () => {},
    clearTextHost: () => {},
    ...overrides
  }
}

afterEach(cleanup)
after(() => dom.window.close())

test('selection-only tools reset while empty-plate Text waits for a real deselection', () => {
  const modes: GizmoMode[] = []
  const options = lifecycleOptions({ setMode: (mode) => modes.push(mode) })
  const { rerender } = renderHook(
    ({ mode, selectedKey }: { mode: GizmoMode; selectedKey: string | null }) =>
      useEditorToolModeLifecycle({ ...options, mode, selectedKey }),
    { initialProps: { mode: 'cut' as GizmoMode, selectedKey: null as string | null } }
  )

  assert.deepEqual(modes, ['select'])
  rerender({ mode: 'text', selectedKey: null })
  assert.deepEqual(modes, ['select'])
  rerender({ mode: 'text', selectedKey: 'object-1' })
  rerender({ mode: 'text', selectedKey: null })
  assert.deepEqual(modes, ['select', 'select'])
})

test('leaving Text cancels the delayed reseat and clears both text identities', () => {
  const cleared: string[] = []
  const textSettleRef = { current: window.setTimeout(() => {}, 60_000) }
  const clearTimeoutOriginal = window.clearTimeout
  const clearTimeoutCalls: number[] = []
  window.clearTimeout = ((id: number) => {
    clearTimeoutCalls.push(id)
    clearTimeoutOriginal.call(window, id)
  }) as typeof window.clearTimeout

  try {
    const options = lifecycleOptions({
      textPartKey: 'part-1',
      textHostKey: 'object-1',
      textSettleRef,
      clearTextPart: () => cleared.push('part'),
      clearTextHost: () => cleared.push('host')
    })
    const { rerender } = renderHook(
      ({ mode }: { mode: GizmoMode }) => useEditorToolModeLifecycle({ ...options, mode }),
      { initialProps: { mode: 'text' as GizmoMode } }
    )

    assert.deepEqual(cleared, [])
    rerender({ mode: 'select' })
    assert.deepEqual(cleared, ['part', 'host'])
    assert.deepEqual(clearTimeoutCalls, [textSettleRef.current])
  } finally {
    window.clearTimeout = clearTimeoutOriginal
    clearTimeoutOriginal.call(window, textSettleRef.current)
  }
})

test('leaving Variable Layers closes its panel and disposes only the old target overlay', () => {
  const cleared: string[] = []
  const firstGroup = new THREE.Group()
  const overlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  overlay.name = LAYER_HEIGHT_OVERLAY_NAME
  firstGroup.add(overlay)
  const secondGroup = new THREE.Group()
  const groups = new Map([['first', firstGroup], ['second', secondGroup]])
  const options = lifecycleOptions({
    groupByKeyRef: { current: groups },
    clearLayerHeight: () => cleared.push('panel'),
    clearLayerHeightBrush: () => cleared.push('brush')
  })
  const { rerender } = renderHook(
    ({ mode, layerHeightTarget }: { mode: GizmoMode; layerHeightTarget: { key: string } | null }) =>
      useEditorToolModeLifecycle({ ...options, mode, layerHeightTarget }),
    { initialProps: { mode: 'layerHeight' as GizmoMode, layerHeightTarget: { key: 'first' } as { key: string } | null } }
  )

  rerender({ mode: 'layerHeight', layerHeightTarget: { key: 'first' } })
  assert.equal(firstGroup.children.length, 1)
  rerender({ mode: 'select', layerHeightTarget: { key: 'second' } })
  assert.equal(firstGroup.children.length, 0)
  assert.deepEqual(cleared, ['panel', 'brush'])
})
