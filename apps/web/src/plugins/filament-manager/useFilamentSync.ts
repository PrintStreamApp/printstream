/**
 * Subscribes to the WS `plugin.event` stream and invalidates the spool list when
 * the filament-manager plugin reports an inventory change (auto-add, remain
 * sync, consumption, or another client's edit), so every open tab stays live.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { wsEventSchema } from '@printstream/shared'
import { wsClient } from '../../lib/wsClient'
import { SPOOLS_QUERY_KEY } from './api'

export function useFilamentSync(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    wsClient.start()
    const off = wsClient.onJson((raw) => {
      const parsed = wsEventSchema.safeParse(raw)
      if (!parsed.success) return
      const event = parsed.data
      if (event.type !== 'plugin.event' || event.pluginName !== 'filament-manager') return
      void queryClient.invalidateQueries({ queryKey: SPOOLS_QUERY_KEY })
    })
    return () => {
      off()
      wsClient.stop()
    }
  }, [queryClient])
}
