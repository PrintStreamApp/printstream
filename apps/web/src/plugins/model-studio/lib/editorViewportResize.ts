/**
 * Sizes the mounted editor viewport and preserves its home-frame policy on resize.
 * The caller installs the returned callback with `editorWindowListeners` and owns teardown.
 */
import type * as THREE from 'three'

interface ViewportResizeOptions {
  container: HTMLElement
  renderer: Pick<THREE.WebGLRenderer, 'setPixelRatio' | 'setSize'>
  camera: THREE.PerspectiveCamera
  userAdjusted: () => boolean
  frameDefaultView: () => void
  requestRender: () => void
}

/** Reapply the capped display density and reframe only an untouched home view. */
export function createEditorViewportResize({
  container,
  renderer,
  camera,
  userAdjusted,
  frameDefaultView,
  requestRender
}: ViewportResizeOptions): () => void {
  return () => {
    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()

    // The dialog's open transition and Settings tab can expose a container that was zero-width.
    // Only a visible, untouched home view should follow that change; a user orbit keeps its pose.
    if (!userAdjusted() && container.clientWidth > 1) frameDefaultView()
    // A settled camera still needs an immediate repaint at its new canvas size.
    requestRender()
  }
}
