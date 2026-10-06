/**
 * Distinguishes a browser Back dismissal from the dialog's own close control for diagnostics.
 *
 * Joy reports both as `closeClick`, which is the correct behavior decision. The marker only lets
 * logging name the gesture that requested a close; consumers must not branch policy on it.
 */
const backGestureCloseKey = '__printStreamBackGestureClose'

/** Mark the synthetic close event created by a browser Back gesture. */
export function backGestureCloseEvent(): Record<string, boolean> {
  return { [backGestureCloseKey]: true }
}

/** Whether an event was created by {@link backGestureCloseEvent}. */
export function isBackGestureClose(event: unknown): boolean {
  return typeof event === 'object'
    && event !== null
    && (event as Record<string, unknown>)[backGestureCloseKey] === true
}
