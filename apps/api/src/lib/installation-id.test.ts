import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usePrismaStubs } from '../test-utils/prisma-stubs.js'
import { rootPrisma } from './prisma.js'
import { getInstallationId, resetInstallationIdCache } from './installation-id.js'

const stub = usePrismaStubs()

test('an existing id is never overwritten', async () => {
  // The property the licence binding rests on: if a restart could mint a new id,
  // the install would look like a different machine and lose its own licence.
  resetInstallationIdCache()
  const updates: unknown[] = []
  stub(rootPrisma.setting, 'upsert', async (args: { update: unknown }) => {
    updates.push(args.update)
    return {} as never
  })
  stub(rootPrisma.setting, 'findUnique', async () => ({ value: 'existing-id' }) as never)

  assert.equal(await getInstallationId(), 'existing-id')
  assert.deepEqual(updates, [{}], 'the upsert must carry an empty update, or a restart re-binds the licence')
})

test('the id is read back rather than assumed, so concurrent first calls agree', async () => {
  // Two callers racing the first write must not each keep the value they
  // generated -- one row wins, and everyone has to use that one.
  resetInstallationIdCache()
  stub(rootPrisma.setting, 'upsert', async () => ({}) as never)
  stub(rootPrisma.setting, 'findUnique', async () => ({ value: 'the-winner' }) as never)

  const [first, second] = await Promise.all([getInstallationId(), getInstallationId()])
  assert.equal(first, 'the-winner')
  assert.equal(second, 'the-winner')
})

test('the value is memoised so a refresh does not query every time', async () => {
  resetInstallationIdCache()
  let reads = 0
  stub(rootPrisma.setting, 'upsert', async () => ({}) as never)
  stub(rootPrisma.setting, 'findUnique', async () => { reads += 1; return { value: 'cached-id' } as never })

  await getInstallationId()
  await getInstallationId()
  assert.equal(reads, 1)
})
