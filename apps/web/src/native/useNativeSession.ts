/** Keeps confirmed native connections in sync with authoritative auth bootstrap results. */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { mobileConnectionNameResponseSchema, type AuthBootstrap } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { notificationScopes } from './notificationScopes'
import { hasAppNotificationSettingsRequest } from './appSettings'
import { isNativeApp, PrintStreamInstance } from './bridge'

/** Unknown/network-error states cannot revoke sessions; name lookup never gates entry. */
export function useNativeSession(authoritative: boolean, connected: boolean, licensedServer: boolean, bootstrap?: AuthBootstrap): void {
  const notificationEntry = useRef(hasAppNotificationSettingsRequest())
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!isNativeApp() || !authoritative) return
    let cancelled = false

    async function update(): Promise<void> {
      try {
        if (!connected) {
          await PrintStreamInstance.signedOut()
          return
        }
        await PrintStreamInstance.enterApp()
        if (cancelled) return
        const destinations = (bootstrap?.memberWorkspaces ?? []).map((workspace) => ({
          name: workspace.name, path: `/workspaces/${workspace.slug}`
        }))
        if (bootstrap?.actor.isPlatformUser && !bootstrap.runtimePolicy.selfHosted) {
          destinations.push({ name: 'Platform', path: '/platform' })
        }
        if (bootstrap?.runtimePolicy.selfHosted && bootstrap.workspace && destinations.length === 0) {
          destinations.push({ name: bootstrap.workspace.name, path: `/workspaces/${bootstrap.workspace.slug}` })
        }
        for (const customer of bootstrap?.customers ?? []) {
          destinations.push({ name: `Billing and licensing: ${customer.name}`.slice(0, 120), path: `/billing/${customer.id}` })
        }
        await PrintStreamInstance.navigation({
          destinations,
          notificationWorkspaces: notificationScopes(bootstrap).length,
          selfHostedAdmin: Boolean(bootstrap?.runtimePolicy.selfHosted && bootstrap.permissions.includes('settings.manage'))
        })
        if (cancelled) return

        if (notificationEntry.current && notificationScopes(bootstrap).length === 0) {
          await PrintStreamInstance.menu({ view: 'settings' })
          return
        }

        // A hosted chooser reached after sign-in hands selection to the local shell.
        // Explicit switcher clicks already open that shell directly and never auto-select.
        if (window.location.pathname === '/workspaces' && !notificationEntry.current && !new URLSearchParams(window.location.search).has('appNotifications')) {
          await PrintStreamInstance.menu({ view: 'startup' })
        }
      } catch {
        console.error('Could not update the native PrintStream session.')
        return
      }
      if (!licensedServer || cancelled) return
      try {
        const result = await queryClient.fetchQuery({
          queryKey: ['native-connection-name', bootstrap?.actor.userId],
          queryFn: async () => mobileConnectionNameResponseSchema.parse(
            await apiFetch('/api/license/mobile-name', { method: 'POST' })
          ),
          staleTime: 10 * 60_000,
          retry: false
        })
        // Logout or server changes while the cloud responds must not restore
        // a stale label. The native bridge also checks origin and membership.
        if (!cancelled) await PrintStreamInstance.setConnectionName(result)
      } catch {
        console.warn('Server name unavailable; keeping the saved connection label.')
      }
    }
    void update()
    return () => { cancelled = true }
  }, [authoritative, connected, licensedServer, queryClient, bootstrap])
}
