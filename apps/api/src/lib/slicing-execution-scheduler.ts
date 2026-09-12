/**
 * Owns the deployment-wide slicing execution slots shared by workspace and public jobs.
 *
 * Queue owners keep their own persistence and lifecycle. This module decides only which queued
 * callback may claim the next slicer slot. Paid workspaces outrank free workspaces, which outrank
 * anonymous work. Production configuration additionally caps anonymous jobs below total capacity,
 * reserving at least one slot for workspace work so a public flood cannot occupy the whole pool.
 */
import { env } from './env.js'

export type SlicingExecutionTier = 'paid' | 'free' | 'anonymous'

export interface SlicingExecutionTicket {
  id: string
  tier: SlicingExecutionTier
  createdAt: Date
  /** Stable anonymous actor key used to spread service across public callers. */
  actorKey?: string
  start: () => void
}

const TIER_WEIGHT: Record<SlicingExecutionTier, number> = {
  paid: 0,
  free: 1,
  anonymous: 2
}

export class SlicingExecutionScheduler {
  private readonly waiting = new Map<string, SlicingExecutionTicket>()
  private readonly active = new Map<string, SlicingExecutionTicket>()
  private readonly activeStartedAt = new Map<string, number>()
  private readonly anonymousStarts = new Map<string, number>()
  private meanDurationMs = 3 * 60_000
  private completedSamples = 0

  constructor(
    private readonly maxConcurrentJobs = env.SLICING_MAX_CONCURRENT_JOBS,
    private readonly maxAnonymousJobs = env.PUBLIC_SLICING_MAX_CONCURRENT_JOBS
  ) {}

  enqueue(ticket: SlicingExecutionTicket): void {
    if (this.waiting.has(ticket.id) || this.active.has(ticket.id)) return
    this.waiting.set(ticket.id, ticket)
    this.pump()
  }

  cancel(ticketId: string): void {
    const cancelled = this.waiting.get(ticketId)
    this.waiting.delete(ticketId)
    this.releaseAnonymousActor(cancelled)
  }

  complete(ticketId: string): void {
    const completed = this.active.get(ticketId)
    const startedAt = this.activeStartedAt.get(ticketId)
    if (startedAt != null) {
      const duration = Math.max(1_000, Date.now() - startedAt)
      this.completedSamples += 1
      this.meanDurationMs += (duration - this.meanDurationMs) / Math.min(this.completedSamples, 20)
    }
    this.activeStartedAt.delete(ticketId)
    this.active.delete(ticketId)
    this.releaseAnonymousActor(completed)
    this.pump()
  }

  position(ticketId: string): number | null {
    const ordered = this.orderedWaiting()
    const index = ordered.findIndex((ticket) => ticket.id === ticketId)
    return index < 0 ? null : index + 1
  }

  /** Rolling estimate based on observed slice duration, with a conservative three-minute seed. */
  estimatedWaitSeconds(ticketId: string): number | null {
    const ticket = this.waiting.get(ticketId)
    const position = this.position(ticketId)
    if (!ticket || position == null) return null
    const slots = ticket.tier === 'anonymous' ? this.maxAnonymousJobs : this.maxConcurrentJobs
    if (slots < 1) return null
    return Math.max(1, Math.ceil(position * this.meanDurationMs / slots / 1_000))
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrentJobs) {
      const ticket = this.nextRunnable()
      if (!ticket) return
      this.waiting.delete(ticket.id)
      this.active.set(ticket.id, ticket)
      this.activeStartedAt.set(ticket.id, Date.now())
      if (ticket.tier === 'anonymous' && ticket.actorKey) {
        this.anonymousStarts.set(ticket.actorKey, (this.anonymousStarts.get(ticket.actorKey) ?? 0) + 1)
      }
      // Claim synchronously before invoking the owner. A callback may immediately enqueue or
      // complete another job, and must never let that re-entrant pump oversubscribe the pool.
      ticket.start()
    }
  }

  private nextRunnable(): SlicingExecutionTicket | null {
    const anonymousActive = Array.from(this.active.values())
      .filter((ticket) => ticket.tier === 'anonymous').length
    return this.orderedWaiting().find((ticket) => (
      ticket.tier !== 'anonymous'
      || anonymousActive < this.maxAnonymousJobs
    )) ?? null
  }

  private orderedWaiting(): SlicingExecutionTicket[] {
    return Array.from(this.waiting.values()).sort((left, right) => {
      const tier = TIER_WEIGHT[left.tier] - TIER_WEIGHT[right.tier]
      if (tier !== 0) return tier
      if (left.tier === 'anonymous' && right.tier === 'anonymous') {
        const usage = (this.anonymousStarts.get(left.actorKey ?? '') ?? 0)
          - (this.anonymousStarts.get(right.actorKey ?? '') ?? 0)
        if (usage !== 0) return usage
      }
      return left.createdAt.getTime() - right.createdAt.getTime()
    })
  }

  private releaseAnonymousActor(ticket: SlicingExecutionTicket | undefined): void {
    if (ticket?.tier !== 'anonymous' || !ticket.actorKey) return
    const actorStillPresent = [...this.waiting.values(), ...this.active.values()]
      .some((candidate) => candidate.actorKey === ticket.actorKey)
    if (!actorStillPresent) this.anonymousStarts.delete(ticket.actorKey)
  }
}

export const slicingExecutionScheduler = new SlicingExecutionScheduler()
