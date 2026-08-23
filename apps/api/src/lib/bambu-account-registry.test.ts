import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { bambuAccountResolvers, type BambuAccountCredential } from './bambu-account-registry.js'

const credential = (accountLabel: string): BambuAccountCredential => ({
  accessToken: 'token-value',
  region: 'global',
  accountLabel
})

const query = { workspaceId: 'workspace-1' }

afterEach(() => {
  assert.equal(bambuAccountResolvers.size(), 0, 'a test leaked a registered resolver')
})

test('resolves to null with no resolver registered', async () => {
  assert.equal(await bambuAccountResolvers.resolve(query), null)
})

test('unregistering removes the resolver', async () => {
  const off = bambuAccountResolvers.register(async () => credential('a@example.com'))
  assert.deepEqual(await bambuAccountResolvers.resolve(query), credential('a@example.com'))
  off()
  assert.equal(await bambuAccountResolvers.resolve(query), null)
})

test('returns the first resolver that has a credential', async () => {
  const seen: Array<{ workspaceId: string }> = []
  const off1 = bambuAccountResolvers.register(async (q) => { seen.push(q); return null })
  const off2 = bambuAccountResolvers.register(async () => credential('second@example.com'))
  const off3 = bambuAccountResolvers.register(async () => credential('third@example.com'))

  assert.deepEqual(await bambuAccountResolvers.resolve(query), credential('second@example.com'))
  assert.deepEqual(seen, [query])
  off1(); off2(); off3()
})

// A throwing resolver must read as "no account", never take the whole lookup down,
// otherwise one plugin's bug becomes another plugin's outage.
test('a throwing resolver is skipped rather than propagated', async () => {
  const off1 = bambuAccountResolvers.register(async () => { throw new Error('store unavailable') })
  const off2 = bambuAccountResolvers.register(async () => credential('fallback@example.com'))

  assert.deepEqual(await bambuAccountResolvers.resolve(query), credential('fallback@example.com'))
  off1(); off2()
})

test('a throwing sole resolver resolves to null', async () => {
  const off = bambuAccountResolvers.register(async () => { throw new Error('boom') })
  assert.equal(await bambuAccountResolvers.resolve(query), null)
  off()
})
