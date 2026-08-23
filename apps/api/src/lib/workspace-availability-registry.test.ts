process.env.NODE_ENV = 'test'

/**
 * The seam that lets the cloud module retire a whole account.
 *
 * Core cannot import `private/`, and the cloud module must not copy `disabled`
 * onto each workspace, a copy could not tell, on restore, which of them had
 * been disabled on their own beforehand, so restoring would silently re-enable
 * those too. So availability is DERIVED through this registry, and these tests
 * pin the two properties that makes possible: an outside reason can disable a
 * workspace, and removing that reason restores exactly the previous state.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  clearWorkspaceUnavailability,
  isWorkspaceDisabled,
  listDisabledWorkspaceIds,
  registerWorkspaceUnavailability,
  workspaceDisabledSettingKey
} from './workspace-availability.js'

/** Only the `setting` surface these helpers touch. */
function settingStore(disabledIds: readonly string[]) {
  const keys = new Set(disabledIds.map((id) => workspaceDisabledSettingKey(id)))
  return {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        (keys.has(where.key) ? { value: 'true' } : null),
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((key) => keys.has(key)).map((key) => ({ key }))
    }
  } as never
}

afterEach(() => clearWorkspaceUnavailability())

test('with nothing registered, only the stored flag disables a workspace', async () => {
  const store = settingStore(['ws-disabled'])
  assert.equal(await isWorkspaceDisabled({ workspaceId: 'ws-disabled', prismaClient: store }), true)
  assert.equal(await isWorkspaceDisabled({ workspaceId: 'ws-live', prismaClient: store }), false)
})

test('a registered reason disables a workspace that has no stored flag', async () => {
  registerWorkspaceUnavailability({
    isUnavailable: async (workspaceId) => workspaceId === 'ws-retired',
    filterUnavailable: async (ids) => new Set(ids.filter((id) => id === 'ws-retired'))
  })
  const store = settingStore([])
  assert.equal(await isWorkspaceDisabled({ workspaceId: 'ws-retired', prismaClient: store }), true)
  assert.equal(await isWorkspaceDisabled({ workspaceId: 'ws-live', prismaClient: store }), false)
})

test('clearing the reason restores exactly the stored state, not more', async () => {
  // The property the whole derived design exists for: `ws-disabled` was
  // disabled on its own BEFORE the account was retired, so bringing the account
  // back must leave it disabled. A copy-onto-workspaces approach would have
  // re-enabled it.
  const store = settingStore(['ws-disabled'])
  registerWorkspaceUnavailability({
    isUnavailable: async () => true,
    filterUnavailable: async (ids) => new Set(ids)
  })
  assert.equal(await isWorkspaceDisabled({ workspaceId: 'ws-disabled', prismaClient: store }), true)
  assert.equal(await isWorkspaceDisabled({ workspaceId: 'ws-live', prismaClient: store }), true)

  clearWorkspaceUnavailability()
  assert.equal(await isWorkspaceDisabled({ workspaceId: 'ws-disabled', prismaClient: store }), true)
  assert.equal(await isWorkspaceDisabled({ workspaceId: 'ws-live', prismaClient: store }), false)
})

test('the list form unions both sources', async () => {
  registerWorkspaceUnavailability({
    isUnavailable: async (workspaceId) => workspaceId === 'ws-retired',
    filterUnavailable: async (ids) => new Set(ids.filter((id) => id === 'ws-retired'))
  })
  const disabled = await listDisabledWorkspaceIds({
    workspaceIds: ['ws-disabled', 'ws-retired', 'ws-live'],
    prismaClient: settingStore(['ws-disabled'])
  })
  assert.deepEqual([...disabled].sort(), ['ws-disabled', 'ws-retired'])
})
