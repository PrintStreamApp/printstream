/**
 * Build a hook that keeps query caches live from the WebSocket stream.
 *
 * Owns the one piece of this that is easy to get wrong twice: the subscription is a
 * module singleton per sync, so a hook mounted once per slot row or once per printer
 * card still attaches ONE `wsClient` listener. Without that, every mounted copy
 * re-parses every frame, printer status included, which arrives per printer per
 * second, to decide it had nothing to do.
 *
 * Use it for data a PLUGIN owns, where the reader is core code that has no idea the
 * answer arrives over a socket: mount the returned hook inside the plugin's own read
 * hooks so freshness is a property of reading the data, never something each calling
 * surface has to remember. Core-owned caches are invalidated centrally in
 * `hooks/usePrinterWebSocket.ts` instead, that one listener already exists, so adding
 * a key there costs nothing.
 *
 * Assumes the single app-wide `QueryClient` provided in `main.tsx`: the first
 * subscriber's client is the one the shared listener invalidates. Revisit if a surface
 * ever mounts its own.
 */
import { useEffect } from 'react'
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { wsEventSchema, type WsEvent } from '@printstream/shared'
import { wsClient } from './wsClient'

/**
 * Which caches a given event invalidates, or null to ignore it. Called for every WS
 * frame, so keep it to field comparisons.
 */
export type WsQuerySyncSelector = (event: WsEvent) => readonly QueryKey[] | null

/**
 * @param selectKeys maps an event to the keys it stales.
 * @returns a hook taking `enabled`: pass the plugin's per-workspace activation gate so
 * a disabled plugin neither fetches nor listens.
 */
export function createWsQuerySync(selectKeys: WsQuerySyncSelector): (enabled?: boolean) => void {
  let subscriberCount = 0
  let detachListener: (() => void) | null = null

  function attachListener(queryClient: QueryClient): void {
    wsClient.start()
    const off = wsClient.onJson((raw) => {
      const parsed = wsEventSchema.safeParse(raw)
      if (!parsed.success) return
      const keys = selectKeys(parsed.data)
      if (!keys) return
      for (const queryKey of keys) {
        void queryClient.invalidateQueries({ queryKey })
      }
    })
    detachListener = () => {
      off()
      wsClient.stop()
    }
  }

  return function useWsQuerySync(enabled = true): void {
    const queryClient = useQueryClient()

    useEffect(() => {
      if (!enabled) return

      // Attach BEFORE counting. React only stores the cleanup if the effect body
      // returns, so a throw in here (`wsClient.start()` constructs the WebSocket,
      // which raises on a malformed URL or a CSP-blocked connect) would leave the
      // count stranded above zero forever. Every later mount then makes it 2, 3,
      // ... so `subscriberCount === 1` never comes round again and no listener is
      // ever attached: the caches this syncs stop being invalidated for the rest
      // of the tab's life, silently. Counting after means a failed attach leaves
      // the count at 0 and the next mount simply retries.
      if (subscriberCount === 0) attachListener(queryClient)
      subscriberCount += 1

      return () => {
        subscriberCount -= 1
        if (subscriberCount > 0) return
        detachListener?.()
        detachListener = null
      }
    }, [enabled, queryClient])
  }
}
