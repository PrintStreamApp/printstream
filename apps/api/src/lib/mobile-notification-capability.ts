/**
 * Runtime capability advertised to the Android wrapper during origin discovery.
 * Core defaults to unavailable; a shipping sender or self-host relay registers
 * the transport it can actually deliver through when that implementation loads.
 */
import type { MobileNotificationTransport } from '@printstream/shared'

const registrations = new Map<symbol, Exclude<MobileNotificationTransport, 'unavailable'>>()

/** Advertise an installed sender; dispose on plugin shutdown so discovery cannot retain a stale capability. */
export function registerMobileNotificationTransport(next: Exclude<MobileNotificationTransport, 'unavailable'>): () => void {
  const transport = mobileNotificationTransport()
  if (transport !== 'unavailable' && transport !== next) {
    throw new Error(`Mobile notification transport already registered as ${transport}.`)
  }
  const registration = Symbol(next)
  registrations.set(registration, next)
  return () => { registrations.delete(registration) }
}

/** Current native notification transport, or unavailable when no sender loaded. */
export function mobileNotificationTransport(): MobileNotificationTransport {
  return registrations.values().next().value ?? 'unavailable'
}

/** Test seam for restoring the process-global capability registry. */
export function resetMobileNotificationTransportForTests(): void {
  registrations.clear()
}
