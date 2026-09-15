/**
 * Arbitrates a pointer gesture that belongs to viewport content before camera controls see it.
 *
 * OrbitControls installs its own pointer-down listener when it is constructed. Content picking
 * happens later in `useEditorScene`, so merely disabling the controls from the ordinary listener is
 * too late: the camera has already entered a rotate/pan state. The caller runs `claim` from a
 * capture-phase listener, then `release` from pointer-up/cancel.
 */

interface PointerCaptureTarget {
  setPointerCapture(pointerId: number): void
  hasPointerCapture(pointerId: number): boolean
  releasePointerCapture(pointerId: number): void
}

interface ToggleableControl {
  enabled: boolean
}

interface PointerIdentity {
  button: number
  pointerId: number
}

/** A single primary-pointer claim which temporarily disables a competing control. */
export function createPointerClaim(target: PointerCaptureTarget, control: ToggleableControl) {
  let claimedPointerId: number | null = null

  return {
    /**
     * Claim `event` when the caller has established that viewport content owns the press.
     * Returns false for non-primary, nested, or already-disabled gestures.
     */
    claim(event: PointerIdentity, contentOwnsPress: boolean): boolean {
      if (!contentOwnsPress || event.button !== 0 || claimedPointerId !== null || !control.enabled) {
        return false
      }

      claimedPointerId = event.pointerId
      control.enabled = false
      target.setPointerCapture(event.pointerId)
      return true
    },

    /** Release only the pointer that owns this claim; unrelated pointers are ignored. */
    release(event: Pick<PointerIdentity, 'pointerId'>): boolean {
      if (claimedPointerId !== event.pointerId) return false

      claimedPointerId = null
      control.enabled = true
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
      return true
    },

    /** Restore the control if the viewport unmounts during a claimed gesture. */
    dispose(): void {
      if (claimedPointerId === null) return
      const pointerId = claimedPointerId
      claimedPointerId = null
      control.enabled = true
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    }
  }
}
