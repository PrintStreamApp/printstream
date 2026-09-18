import assert from 'node:assert/strict'
import test from 'node:test'
import type { NotificationMessage } from '@printstream/shared'
import type { ApiPluginContext } from '../../plugin/types.js'
import { withMobileNotificationImage } from './images.js'

const message: NotificationMessage = {
  id: 'message', category: 'system', level: 'info', title: 'Finished', body: 'Ready',
  timestamp: new Date().toISOString(), workspaceId: 'workspace', imageUrl: '/api/jobs/job/snapshot'
}

test('native job snapshots are scoped and copied to the existing short-lived capability cache', async () => {
  const prisma = { printJob: { findFirst: async (args: unknown) => {
    assert.deepEqual(args, { where: { id: 'job', printer: { workspaceId: 'workspace' } }, select: { snapshotPath: true } })
    return { snapshotPath: 'saved.jpg' }
  } } } as unknown as ApiPluginContext['prisma']
  const result = await withMobileNotificationImage(message, prisma, {
    read: async (file) => { assert.equal(file, 'saved.jpg'); return Buffer.from('jpeg') },
    store: (bytes) => { assert.equal(bytes.toString(), 'jpeg'); return 'random-capability' }
  })
  assert.equal(result.imageUrl, '/api/notifications/snapshots/random-capability')
})

test('missing scope, missing image, and oversized images keep the text but omit the picture', async () => {
  const prisma = { printJob: { findFirst: async () => ({ snapshotPath: 'saved.jpg' }) } } as unknown as ApiPluginContext['prisma']
  const images = { read: async () => Buffer.alloc(1024 * 1024 + 1), store: () => { throw new Error('must not store') } }
  assert.equal((await withMobileNotificationImage(message, prisma, images)).imageUrl, undefined)
  assert.equal((await withMobileNotificationImage({ ...message, workspaceId: undefined }, prisma, images)).imageUrl, undefined)
  const absent = await withMobileNotificationImage(message, prisma, { ...images, read: async () => null })
  assert.equal(absent.imageUrl, undefined)
  assert.equal(absent.title, 'Finished')
})
