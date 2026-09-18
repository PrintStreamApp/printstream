import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthBootstrap } from '@printstream/shared'
import { syncNativeNotifications } from './notifications'

function bootstrap(userId: string, memberships = true): AuthBootstrap {
  return {
    actor: { type: 'user', userId, isPlatformUser: true },
    runtimePolicy: { selfHosted: false }, workspace: null,
    memberWorkspaces: memberships ? [{ id: 'one', slug: 'one', name: 'One' }, { id: 'two', slug: 'two', name: 'Two' }] : [],
    availableWorkspaces: [{ id: 'support', slug: 'support', name: 'Support only' }]
  } as AuthBootstrap
}

function services() {
  const accounts: string[] = []
  const renewed: string[] = []
  return {
    accounts, renewed,
    supported: () => true,
    account: async (account: string) => { accounts.push(account) },
    state: async (_value: AuthBootstrap) => ({ configured: true, permission: true, enabled: true, bindingId: 'binding' }),
    register: async (value: AuthBootstrap, _binding: string, isCurrent = () => true) => {
      if (isCurrent()) renewed.push(value.workspace?.id ?? 'platform')
    }
  }
}

test('renewal covers enabled memberships and administration, never support-only workspaces', async () => {
  const deps = services()
  deps.state = async (value) => ({ configured: true, permission: true, enabled: value.workspace?.id !== 'two', bindingId: 'binding' })
  await syncNativeNotifications(bootstrap('person'), deps)
  assert.deepEqual(deps.renewed, ['one', 'platform'])
})

test('an account with no destinations still selects its identity and anonymous access clears it', async () => {
  const deps = services()
  const empty = bootstrap('empty', false)
  empty.actor.isPlatformUser = false
  await syncNativeNotifications(empty, deps)
  await syncNativeNotifications({ ...empty, actor: { ...empty.actor, type: 'anonymous' } }, deps)
  assert.deepEqual(deps.accounts, ['empty', ''])
  assert.deepEqual(deps.renewed, [])
})

test('a newer auth snapshot cancels an older renewal before it can enroll another scope', async () => {
  const deps = services()
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => { finish = resolve })
  deps.state = async () => {
    await waiting
    return { configured: true, permission: true, enabled: true, bindingId: 'binding' }
  }
  const old = syncNativeNotifications(bootstrap('old'), deps)
  await Promise.resolve()
  const empty = bootstrap('new', false)
  empty.actor.isPlatformUser = false
  await syncNativeNotifications(empty, deps)
  finish()
  await old
  assert.deepEqual(deps.accounts, ['old', 'new'])
  assert.deepEqual(deps.renewed, [])
})

test('auth-disabled self-hosted renewal stays in its workspace and is revoked when sign-in becomes required', async () => {
  const deps = services()
  const local = {
    ...bootstrap('unused', false), authEnabled: false,
    actor: { type: 'anonymous' }, runtimePolicy: { selfHosted: true, demoMode: false, managedBridge: false },
    workspace: { id: 'local', slug: 'local', name: 'Local' }
  } as AuthBootstrap
  await syncNativeNotifications(local, deps)
  assert.deepEqual(deps.accounts, ['anonymous:local'])
  assert.deepEqual(deps.renewed, ['local'])
  await syncNativeNotifications({ ...local, authEnabled: true }, deps)
  assert.deepEqual(deps.accounts, ['anonymous:local', ''])
  assert.deepEqual(deps.renewed, ['local'])
})
