/**
 * Headless unread-badge syncer (`shell.background` slot): keeps the shell tab
 * dots in step with support messaging. Marks the Account tab (both mounts)
 * when the platform has unread replies for the signed-in user, and the
 * platform Messages tab when a workspace message awaits the platform team.
 * WS `support` invalidation hints keep the queries live.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SupportUnreadResponse } from '@printstream/shared'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { setShellTabBadge } from '../../lib/shellBadges'

export function SupportUnreadSync({
  userBase = '/api/support',
  includePlatform = true
}: {
  userBase?: string
  includePlatform?: boolean
}) {
  const authBootstrapQuery = useAuthBootstrapQuery()
  const actor = authBootstrapQuery.data?.actor
  const isUser = actor?.type === 'user'
  const isPlatformUser = isUser && actor.isPlatformUser === true

  const userUnreadQuery = useQuery<SupportUnreadResponse>({
    queryKey: ['support', 'user', 'unread', userBase],
    queryFn: ({ signal }) => apiFetch<SupportUnreadResponse>(`${userBase}/unread`, { signal }),
    enabled: isUser,
    staleTime: 30_000,
    meta: { suppressGlobalErrorToast: true }
  })

  const platformUnreadQuery = useQuery<SupportUnreadResponse>({
    queryKey: ['support', 'platform', 'unread'],
    queryFn: ({ signal }) => apiFetch<SupportUnreadResponse>('/api/platform/support/unread', { signal }),
    enabled: includePlatform && isPlatformUser,
    staleTime: 30_000,
    meta: { suppressGlobalErrorToast: true }
  })

  const userUnread = (userUnreadQuery.data?.count ?? 0) > 0
  const platformUnread = (platformUnreadQuery.data?.count ?? 0) > 0

  useEffect(() => {
    // The account tab's value depends on the active workspace mode; badge both.
    setShellTabBadge('/account', userUnread)
    setShellTabBadge('/platform/account', userUnread)
    return () => {
      setShellTabBadge('/account', false)
      setShellTabBadge('/platform/account', false)
    }
  }, [userUnread])

  useEffect(() => {
    setShellTabBadge('/platform/messages', platformUnread)
    return () => {
      setShellTabBadge('/platform/messages', false)
    }
  }, [platformUnread])

  return null
}
