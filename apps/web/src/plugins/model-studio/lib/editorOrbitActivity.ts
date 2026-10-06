/**
 * Tracks user orbit gestures for the long-lived editor viewport effect.
 * The viewport owns its live activity refs and resets them during teardown;
 * this module owns the matching OrbitControls listener lifetime.
 */

type OrbitActivitySource = {
  addEventListener: (type: 'start' | 'end', listener: () => void) => void
  removeEventListener: (type: 'start' | 'end', listener: () => void) => void
}

/** Install orbit start/end callbacks and release both before controls disposal. */
export function installEditorOrbitActivity(
  orbit: OrbitActivitySource,
  onStart: () => void,
  onEnd: () => void
): () => void {
  orbit.addEventListener('start', onStart)
  orbit.addEventListener('end', onEnd)

  return () => {
    orbit.removeEventListener('start', onStart)
    orbit.removeEventListener('end', onEnd)
  }
}
