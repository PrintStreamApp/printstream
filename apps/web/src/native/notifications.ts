/** Native enrolment lifecycle. Tokens stay in memory and POST bodies, never browser storage or logs. */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { nativeNotificationAccount, type AuthBootstrap, type MobilePushRegistration } from '@printstream/shared'
import { apiFetch } from '../lib/apiClient'
import { isNativeAndroid } from './bridge'
import { notificationScopes } from './notificationScopes'

export interface DeviceState {
  configured: boolean
  enabled: boolean
  permission: boolean
  bindingId: string
}
interface NativeNotificationsPlugin {
  account(options: { account: string }): Promise<void>
  clear(): Promise<void>
  state(options: { scope: string }): Promise<DeviceState>
  prepare(options: { scope: string; bindingId: string; transport: 'direct' | 'relay'; requestPermission: boolean }): Promise<MobilePushRegistration>
  activate(options: { scope: string; bindingId: string }): Promise<void>
  disable(options: { scope: string }): Promise<void>
  openSettings(): Promise<void>
}
const native = registerPlugin<NativeNotificationsPlugin>('PrintStreamNotifications')
const base = '/api/plugins/notifications-mobile'
let renewalGeneration = 0

/** Open the OS permission controls without changing any server-wide configuration. */
export async function openAndroidNotificationSettings(): Promise<void> {
  await native.openSettings()
}

/** The native state remains readable when a plugin is unavailable, so local opt-out stays possible. */
export async function readNativeNotificationScope(bootstrap: AuthBootstrap, signal: AbortSignal): Promise<DeviceState & { available: boolean }> {
  const device = await nativeNotificationState(bootstrap)
  try {
    const server = await apiFetch<{ configured: boolean }>(base, {
      signal, timeoutMs: 15_000,
      headers: { 'X-PrintStream-Workspace': bootstrap.workspace?.slug ?? 'platform' }
    })
    return { ...device, available: server.configured && device.configured }
  } catch (error) {
    if (signal.aborted) throw error
    return { ...device, available: false }
  }
}

/** Older installed wrappers can still sign out before upgrading their native plugins. */
export function hasNativeNotifications(): boolean {
  return isNativeAndroid() && Capacitor.isPluginAvailable('PrintStreamNotifications')
}

export async function clearNativeNotifications(): Promise<void> {
  renewalGeneration++
  if (hasNativeNotifications()) await native.clear()
}

/** Select the signed-in actor before exposing stored enrolment; switching identities revokes locally. */
export async function nativeNotificationState(bootstrap: AuthBootstrap): Promise<DeviceState> {
  const account = nativeNotificationAccount(bootstrap) ?? ''
  await native.account({ account })
  return native.state({ scope: bootstrap.workspace?.id ?? 'platform' })
}

/** The explicit Enable action and silent renewal share one registration path. */
export async function enableNativeNotifications(bootstrap: AuthBootstrap, isCurrent = () => true): Promise<void> {
  if (!isCurrent()) return
  const state = await nativeNotificationState(bootstrap)
  await registerDevice(bootstrap, state.bindingId, isCurrent, true)
}

/** Native activation rejects a binding revoked while this request was in flight. */
async function registerDevice(bootstrap: AuthBootstrap, bindingId: string, isCurrent = () => true, requestPermission = false): Promise<void> {
  if (!isCurrent()) return
  const scope = bootstrap.workspace?.id ?? 'platform'
  const server = await apiFetch<{ configured: boolean; transport?: 'direct' | 'relay' }>(base, {
    timeoutMs: 15_000,
    headers: { 'X-PrintStream-Workspace': bootstrap.workspace?.slug ?? 'platform' }
  })
  if (!server.configured) throw new Error('Native notifications are not configured on this server.')
  if (!isCurrent()) return
  const transport = server.transport ?? 'direct'
  const registration = await native.prepare({ scope, bindingId, transport, requestPermission })
  if (!isCurrent()) return
  await apiFetch(`${base}/subscriptions`, {
    method: 'POST', body: registration, timeoutMs: 15_000,
    headers: { 'X-PrintStream-Workspace': bootstrap.workspace?.slug ?? 'platform' }
  })
  if (isCurrent()) await native.activate({ scope, bindingId: registration.bindingId })
}

export async function disableNativeNotifications(bootstrap: AuthBootstrap, isCurrent = () => true): Promise<void> {
  if (!isCurrent()) return
  const scope = bootstrap.workspace?.id ?? 'platform'
  const { bindingId } = await native.state({ scope })
  if (!isCurrent()) return
  // Local revocation is immediate even if the server is offline. Its leased registration expires.
  await native.disable({ scope })
  try {
    await apiFetch(`${base}/subscriptions`, {
      method: 'DELETE', body: { bindingId }, timeoutMs: 15_000,
      headers: { 'X-PrintStream-Workspace': bootstrap.workspace?.slug ?? 'platform' }
    })
  } catch {
    console.warn('App notifications disabled locally; server cleanup will expire automatically.')
  }
}

const renewalServices = {
  supported: hasNativeNotifications,
  account: (account: string) => native.account({ account }),
  state: nativeNotificationState,
  register: registerDevice
}

/** Renew enabled scopes on foreground/auth refresh. Injection isolates batch policy from the native bridge in tests. */
export async function syncNativeNotifications(bootstrap: AuthBootstrap, services = renewalServices): Promise<void> {
  const generation = ++renewalGeneration
  const isCurrent = () => generation === renewalGeneration
  if (!services.supported()) return
  const account = nativeNotificationAccount(bootstrap)
  if (!account) {
    await services.account('')
    return
  }
  // A newly signed-in user with no memberships must still revoke the previous
  // account's bindings. An empty destination list is not an auth-state no-op.
  await services.account(account)
  if (!isCurrent()) return
  // Choosing several workspaces upfront must not require visiting each before
  // its lease expires. Explicit scope headers preserve the visible workspace.
  for (const scope of notificationScopes(bootstrap)) {
    if (!isCurrent()) return
    try {
      const state = await services.state(scope.bootstrap)
      if (!isCurrent()) return
      if (state.enabled && state.permission && state.configured) {
        await services.register(scope.bootstrap, state.bindingId, isCurrent)
      }
    } catch {
      console.warn('Could not renew one notification subscription; other workspaces will still be checked.')
    }
  }
}
