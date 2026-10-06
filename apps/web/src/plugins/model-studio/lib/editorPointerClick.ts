/** Shared five-pixel click tolerance for editor pointer tools and selection. */
export const EDITOR_POINTER_CLICK_DRIFT_PX = 5

/** A press that stayed near its start is a click; a larger move belongs to drag or orbit. */
export function isEditorPointerClick(
  press: { x: number; y: number },
  release: { clientX: number; clientY: number }
): boolean {
  return Math.hypot(release.clientX - press.x, release.clientY - press.y) < EDITOR_POINTER_CLICK_DRIFT_PX
}
