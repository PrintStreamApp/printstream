/**
 * Bounded, sequence-correlated printer command replies. The manager registers a
 * waiter before publishing through the bridge so even an immediate reply is safe.
 * Disconnect/removal rejects waiters; no reply may cross a printer boundary.
 */
export class PrinterCommandReplies {
  private readonly pending = new Map<string, {
    command: string
    timer: ReturnType<typeof setTimeout>
    resolve: (reply: Record<string, unknown>) => void
    reject: (error: Error) => void
  }>()

  /** Register before sending; timeout is in milliseconds and never retries a mutation. */
  wait(printerId: string, sequenceId: string, command: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const key = `${printerId}:${sequenceId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key)
        reject(new Error(`Printer ${command} reply timed out`))
      }, timeoutMs)
      this.pending.set(key, { command, timer, resolve, reject })
    })
  }

  /** Ignore unsolicited replies and replies for a different command or printer. */
  accept(printerId: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const print = (payload as { print?: unknown }).print
    if (!print || typeof print !== 'object') return
    const reply = print as Record<string, unknown>
    const key = `${printerId}:${String(reply.sequence_id)}`
    const pending = this.pending.get(key)
    if (!pending || reply.command !== pending.command) return
    clearTimeout(pending.timer)
    this.pending.delete(key)
    pending.resolve(reply)
  }

  /** Reject all in-flight requests when this printer's connection is no longer usable. */
  clear(printerId: string, reason: string): void {
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(`${printerId}:`)) continue
      clearTimeout(pending.timer)
      this.pending.delete(key)
      pending.reject(new Error(reason))
    }
  }
}
