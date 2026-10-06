/**
 * Owns the editor viewport's draw order. Selection fit and overlay visibility update before the
 * scene draw; outlines render only after that draw on their separate layer; the view cube follows
 * the final camera pose. The caller owns the live scene objects and frame scheduler.
 */
interface SceneRenderPassOptions {
  syncPaintOverlays: (interacting: boolean) => void
  updatePrimarySelection: (interacting: boolean, dragJustEnded: boolean) => boolean
  syncBrimEarMarkers: () => void
  syncSecondarySelections: () => void
  syncScreenAnnotations: () => void
  renderScene: () => void
  hasSecondarySelections: () => boolean
  renderSelectionOutlines: () => void
  syncViewCube: () => void
}

/** Return whether deferred selection fitting needs one more frame. */
export function createEditorSceneRenderPass(options: SceneRenderPassOptions) {
  return (interacting: boolean, dragJustEnded: boolean): boolean => {
    options.syncPaintOverlays(interacting)
    const needsAnotherFrame = options.updatePrimarySelection(interacting, dragJustEnded)
    options.syncBrimEarMarkers()
    options.syncSecondarySelections()
    options.syncScreenAnnotations()
    options.renderScene()
    if (options.hasSecondarySelections()) options.renderSelectionOutlines()
    options.syncViewCube()
    return needsAnotherFrame
  }
}
