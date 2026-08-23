/**
 * Liveness of the browser TABS connected to this API node.
 *
 * A tab announces itself with a `client` id on its `/ws` connection (minted per tab into
 * `sessionStorage` by `apps/web/src/lib/tabSession.ts`). This module counts that tab's open
 * sockets and, once the last one has gone AND STAYED gone, tells its listeners the tab is over.
 * Its consumer is slicing: a job cancels when the tab that started it closes.
 *
 * The grace period covers what the socket layer cannot tell apart: an in-app navigation that
 * remounts the socket, a laptop lid, and a two-second network blip all look exactly like a close,
 * and the consumer reacts by destroying work. Reconnecting inside the grace retracts the departure
 * with nothing observed.
 *
 * A tab whose DOCUMENT is going away is a different case, and it says so with {@link leaving}
 * (`pagehide` -> a beacon), which departs it at once. That covers closing the tab and reloading it
 * alike: both take the user out of the editor and the slice dialog, and a slice started there is
 * persisted HIDDEN from the library with no action on its toast, so finishing it produces a file
 * the user cannot reach while holding a slicer the next job wants. The beacon is best-effort by
 * nature (a killed tab sends nothing), so the grace remains the backstop rather than the plan.
 *
 * A `client` id is NOT an authentication signal: any caller can send any value. It may only ever
 * narrow what a tab is shown, or reap work that same id created. Never gate access on it.
 *
 * Single-node by construction: a tab connected to a different API node is invisible here, so this
 * is node-local best-effort cleanup only. Under horizontal scale-out two nodes would each see
 * "no sockets" for a tab attached to the other, so the departure signal has to move to shared
 * state before that lands.
 */

/**
 * How long a tab may be socket-less before it counts as closed.
 *
 * Sized against a RELOAD, the common false positive: the app's first socket comes up after the
 * bundle loads, which on a cold cache over a slow link is seconds. Too short cancels a slice
 * because the user pressed F5; too long only delays cleanup of a job nobody is watching, which
 * costs nothing. So it is deliberately generous.
 */
export const CLIENT_SESSION_GRACE_MS = 45_000

export type ClientSessionGoneListener = (clientId: string) => void

export class ClientSessions {
  private readonly openSockets = new Map<string, number>()
  private readonly pendingDepartures = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<ClientSessionGoneListener>()

  constructor(private readonly graceMs: number = CLIENT_SESSION_GRACE_MS) {}

  /** A socket for this tab opened. Cancels any departure the tab was in the middle of. */
  connected(clientId: string): void {
    const pending = this.pendingDepartures.get(clientId)
    if (pending) {
      clearTimeout(pending)
      this.pendingDepartures.delete(clientId)
    }
    this.openSockets.set(clientId, (this.openSockets.get(clientId) ?? 0) + 1)
  }

  /** A socket for this tab closed. Starts the grace only when it was the tab's last one. */
  disconnected(clientId: string): void {
    // An id we are not tracking has nothing left to depart from, it already did, via `leaving`
    // (whose beacon lands before the socket close), or it was never counted. Scheduling a grace
    // here would report the same tab a second time, and its consumer cancels work on every report.
    if (!this.openSockets.has(clientId)) return
    const remaining = (this.openSockets.get(clientId) ?? 0) - 1
    if (remaining > 0) {
      this.openSockets.set(clientId, remaining)
      return
    }
    this.openSockets.delete(clientId)
    if (this.pendingDepartures.has(clientId)) return
    const timer = setTimeout(() => {
      this.pendingDepartures.delete(clientId)
      // Re-check rather than trusting the timer: a socket may have opened between the callback
      // being scheduled by the event loop and it running.
      if (this.openSockets.has(clientId)) return
      for (const listener of this.listeners) {
        try {
          listener(clientId)
        } catch (error) {
          console.warn('[client-sessions] listener failed', (error as Error).message)
        }
      }
    }, this.graceMs)
    // Never hold the process open for a tab that has already left.
    timer.unref?.()
    this.pendingDepartures.set(clientId, timer)
  }

  /**
   * The tab's document is unloading: depart it NOW rather than after the grace.
   *
   * Deliberately ignores the socket count: the beacon routinely arrives before the socket close,
   * and waiting for a tally that is about to drop to zero anyway would just reintroduce the delay
   * this exists to remove. Idempotent, since `disconnected` still runs afterwards.
   */
  leaving(clientId: string): void {
    const pending = this.pendingDepartures.get(clientId)
    if (pending) {
      clearTimeout(pending)
      this.pendingDepartures.delete(clientId)
    }
    this.openSockets.delete(clientId)
    for (const listener of this.listeners) {
      try {
        listener(clientId)
      } catch (error) {
        console.warn('[client-sessions] listener failed', (error as Error).message)
      }
    }
  }

  /** Called once per tab, after the grace, when it has no sockets left. Returns an unsubscribe. */
  onGone(listener: ClientSessionGoneListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** True while the tab has at least one open socket. */
  isConnected(clientId: string): boolean {
    return this.openSockets.has(clientId)
  }

  /** Drop every timer; for tests and shutdown. */
  reset(): void {
    for (const timer of this.pendingDepartures.values()) clearTimeout(timer)
    this.pendingDepartures.clear()
    this.openSockets.clear()
  }
}

export const clientSessions = new ClientSessions()
