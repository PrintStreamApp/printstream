/**
 * Resolve a request's actor into denormalized display attribution for rows
 * that record "who did this" alongside the authoritative audit log (e.g.
 * library file versions). Returns nulls for anonymous requests (auth
 * disabled) so attribution stays optional end to end.
 */
import type { Request } from 'express'
import { rootPrisma } from './prisma.js'

export interface ActorAttribution {
  createdById: string | null
  createdByName: string | null
}

export async function resolveRequestActorAttribution(request: Request | undefined): Promise<ActorAttribution> {
  const actor = request?.auth?.actor
  if (!actor) return { createdById: null, createdByName: null }
  if (actor.type === 'user') {
    // Auth users are platform-global (one row per email), so the lookup is
    // deliberately unscoped.
    const user = await rootPrisma.authUser.findUnique({
      where: { id: actor.userId },
      select: { displayName: true, email: true }
    }).catch(() => null)
    return {
      createdById: actor.userId,
      createdByName: user?.displayName?.trim() || user?.email || null
    }
  }
  if (actor.type === 'service-account') {
    const account = await rootPrisma.authServiceAccount.findUnique({
      where: { id: actor.serviceAccountId },
      select: { name: true }
    }).catch(() => null)
    return {
      createdById: actor.serviceAccountId,
      createdByName: account?.name ?? null
    }
  }
  return { createdById: null, createdByName: null }
}
