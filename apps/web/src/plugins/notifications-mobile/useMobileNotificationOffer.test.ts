import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { AuthBootstrap } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { OfferLifecycleOptions } from './offerLifecycle'
import { openAppNotificationSettings } from '../../native/appSettings'
import { notificationScopes, notificationSelectionKey } from '../../native/notificationScopes'

const dom = installJsdomGlobals()
const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useMobileNotificationOffer } = await import('./useMobileNotificationOffer')
afterEach(cleanup)
after(() => dom.window.close())

function bootstrap(userId: string, admin = false): AuthBootstrap {
  return {
    actor: { type: 'user', userId, isPlatformUser: admin },
    workspace: null,
    runtimePolicy: { selfHosted: false },
    memberWorkspaces: [
      { id: 'first', slug: 'first', name: 'Home' },
      { id: 'second', slug: 'second', name: 'Workshop' }
    ],
    availableWorkspaces: [{ id: 'support', slug: 'support', name: 'Other customer' }]
  } as AuthBootstrap
}

function services() {
  const lifetimes: OfferLifecycleOptions[] = []
  const enabled: string[] = []
  const disabled: string[] = []
  return {
    lifetimes, enabled, disabled,
    supported: () => true,
    read: async (_bootstrap: AuthBootstrap, _signal: AbortSignal) => ({
      configured: true, available: true, enabled: false, permission: true, bindingId: 'binding'
    }),
    enable: async (value: AuthBootstrap, _isCurrent = () => true) => { enabled.push(value.workspace?.id ?? 'platform') },
    disable: async (value: AuthBootstrap, _isCurrent = () => true) => { disabled.push(value.workspace?.id ?? 'platform') },
    start(options: OfferLifecycleOptions) {
      lifetimes.push(options)
      let active = true
      return { isActive: () => active, dispose() { active = false } }
    }
  }
}

async function offer(deps: ReturnType<typeof services>, index = 0) {
  await act(async () => {
    if (await deps.lifetimes[index]!.ready(new AbortController().signal)) deps.lifetimes[index]!.offer()
  })
}

test('one selection includes memberships and administration, never support-only access', async () => {
  const deps = services()
  const value = bootstrap('combined', true)
  const view = renderHook(({ value }) => useMobileNotificationOffer(value, deps), { initialProps: { value } })
  await offer(deps)
  assert.deepEqual(view.result.current.choices.map((row) => row.id), ['first', 'second', 'platform'])
  act(() => view.result.current.select('second', false))
  await act(async () => view.result.current.enable())
  assert.deepEqual(deps.enabled, ['first', 'platform'])
  assert.equal(view.result.current.open, false)
  view.rerender({ value: { ...value, workspace: value.memberWorkspaces[0]! } })
  assert.equal(deps.lifetimes.length, 1)
  assert.equal(view.result.current.open, false)
})

test('Not now suppresses navigation and remounts, while settings remain editable', async () => {
  const deps = services()
  const value = bootstrap('declined')
  const view = renderHook(() => useMobileNotificationOffer(value, deps))
  await offer(deps)
  act(() => view.result.current.dismiss())
  view.unmount()
  const next = renderHook(() => useMobileNotificationOffer(value, deps))
  await offer(deps, 1)
  assert.equal(next.result.current.open, false)
  await act(async () => { openAppNotificationSettings() })
  assert.equal(next.result.current.open, true)
  assert.equal(next.result.current.manual, true)
  assert.equal(next.result.current.choices.some((choice) => choice.selected), false)
})

test('partial failure retains successes and retry only enrolls the failed choice', async () => {
  const deps = services()
  let fail = true
  deps.enable = async (value) => {
    const id = value.workspace!.id
    deps.enabled.push(id)
    if (id === 'second' && fail) throw new Error('Offline')
  }
  const view = renderHook(() => useMobileNotificationOffer(bootstrap('partial'), deps))
  await offer(deps)
  await act(async () => view.result.current.enable())
  assert.equal(view.result.current.open, true)
  assert.equal(view.result.current.error, 'Workshop: Offline')
  assert.equal(view.result.current.choices[0]!.enabled, true)
  fail = false
  await act(async () => view.result.current.enable())
  assert.deepEqual(deps.enabled, ['first', 'second', 'second'])
  assert.equal(view.result.current.open, false)
})

test('account changes stop subsequent enrollments and ignore late completion', async () => {
  const deps = services()
  let finish!: () => void
  let stillCurrent = () => true
  deps.enable = async (value, isCurrent = () => true) => {
    stillCurrent = isCurrent
    deps.enabled.push(value.workspace!.id)
    await new Promise<void>((resolve) => { finish = resolve })
  }
  const view = renderHook(({ value }) => useMobileNotificationOffer(value, deps), {
    initialProps: { value: bootstrap('old') }
  })
  await offer(deps)
  let pending!: Promise<void>
  act(() => {
    pending = view.result.current.enable()
    void view.result.current.enable()
  })
  assert.deepEqual(deps.enabled, ['first'])
  view.rerender({ value: bootstrap('new') })
  assert.equal(stillCurrent(), false, 'in-flight native registration receives the same cancellation fence')
  await act(async () => { finish(); await pending })
  assert.equal(view.result.current.open, false)
  assert.equal(view.result.current.busy, false)
  assert.deepEqual(deps.enabled, ['first'])
})

test('adding a workspace does not preselect previously declined destinations', async () => {
  const deps = services()
  const value = bootstrap('membership-change')
  const view = renderHook(({ value }) => useMobileNotificationOffer(value, deps), { initialProps: { value } })
  await offer(deps)
  act(() => view.result.current.dismiss())
  view.rerender({ value: {
    ...value, memberWorkspaces: [...value.memberWorkspaces, { ...value.memberWorkspaces[0]!, id: 'new', slug: 'new', name: 'New' }]
  } })
  await offer(deps, 1)
  assert.deepEqual(view.result.current.choices.filter((choice) => choice.selected).map((choice) => choice.id), ['new'])
  await act(async () => view.result.current.enable())
  assert.deepEqual(deps.enabled, ['new'])
})

test('settings can opt out locally even when the server is unavailable', async () => {
  const deps = services()
  deps.read = async () => ({ configured: true, available: false, enabled: true, permission: false, bindingId: 'binding' })
  const view = renderHook(() => useMobileNotificationOffer(bootstrap('offline'), deps))
  await act(async () => { openAppNotificationSettings() })
  act(() => {
    view.result.current.select('first', false)
    view.result.current.select('second', false)
  })
  await act(async () => view.result.current.enable())
  assert.deepEqual(deps.disabled, ['first', 'second'])
  assert.deepEqual(deps.enabled, [])
})

test('denying Android permission stops the batch rather than prompting for each workspace', async () => {
  const deps = services()
  deps.enable = async (value) => {
    deps.enabled.push(value.workspace!.id)
    throw Object.assign(new Error('Notifications are blocked in Android settings.'), { code: 'NOTIFICATIONS_BLOCKED' })
  }
  const view = renderHook(() => useMobileNotificationOffer(bootstrap('denied'), deps))
  await offer(deps)
  await act(async () => view.result.current.enable())
  assert.deepEqual(deps.enabled, ['first'])
  assert.equal(view.result.current.open, true)
  assert.equal(view.result.current.choices.every((row) => !row.permission), true)
})

test('anonymous, unsupported and support-only accounts cannot enroll; self-hosted has no platform option', () => {
  const value = bootstrap('boundaries', true)
  assert.deepEqual(notificationScopes({ ...value, actor: { ...value.actor, type: 'anonymous' } }), [])
  assert.deepEqual(notificationScopes({ ...value, actor: { ...value.actor, isPlatformUser: false }, memberWorkspaces: [] }), [])
  const selfHosted = { ...value, runtimePolicy: { ...value.runtimePolicy, selfHosted: true }, memberWorkspaces: [value.memberWorkspaces[0]!] }
  assert.deepEqual(notificationScopes(selfHosted).map((scope) => scope.id), ['first'])
  assert.equal(notificationSelectionKey(value), notificationSelectionKey({ ...value, workspace: value.memberWorkspaces[1]! }))
  const deps = services()
  deps.supported = () => false
  const view = renderHook(() => useMobileNotificationOffer(value, deps))
  assert.equal(view.result.current.open, false)
  assert.equal(deps.lifetimes.length, 0)
})
