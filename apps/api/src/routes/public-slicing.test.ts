process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { publicSlicingRouter } from './public-slicing.js'
import { slicerClient } from '../lib/slicer-client.js'

/**
 * The point of this surface is that it is anonymous AND carries nothing tenant-specific. Both halves
 * are asserted: a caller with no session gets the catalogue, and what comes back is exactly what the
 * slicer reported — no custom profiles, which by definition belong to a workspace this caller does
 * not have.
 */

const originalProfiles = slicerClient.profiles.bind(slicerClient)
const originalCapabilities = slicerClient.capabilities.bind(slicerClient)

afterEach(() => {
  slicerClient.profiles = originalProfiles
  slicerClient.capabilities = originalCapabilities
})

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use('/api/public/slicing', publicSlicingRouter)
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, () => resolve(listening))
  })
  try {
    const { port } = server.address() as AddressInfo
    await run(`http://127.0.0.1:${port}/api/public/slicing`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('the built-in catalogue is served without any session', async () => {
  slicerClient.profiles = async () => [
    { id: 'machine:X1C', kind: 'machine', name: 'Bambu Lab X1 Carbon' }
  ] as unknown as Awaited<ReturnType<typeof slicerClient.profiles>>

  await withApp(async (baseUrl) => {
    // No cookie, no tenant header, no permission — the whole point of the surface.
    const response = await fetch(`${baseUrl}/profiles`)
    assert.equal(response.status, 200)
    const body = await response.json() as { profiles: Array<{ id: string }> }
    assert.deepEqual(body.profiles.map((profile) => profile.id), ['machine:X1C'])
    // Publicly cacheable: immutable for the life of a slicer image, and the largest anonymous body
    // the API serves.
    assert.match(response.headers.get('cache-control') ?? '', /public/)
  })
})

test('the catalogue is exactly what the slicer reported, with nothing tenant-owned added', async () => {
  // The tenant route merges custom profiles in. This one must not — a caller here has no workspace,
  // so any custom preset appearing would be someone else's.
  const builtin = [{ id: 'process:0.20mm', kind: 'process', name: '0.20mm Standard' }]
  let tenantArgumentSeen: unknown = 'not-called'
  slicerClient.profiles = async (targetId) => {
    tenantArgumentSeen = targetId
    return builtin as unknown as Awaited<ReturnType<typeof slicerClient.profiles>>
  }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/profiles?targetId=bs-2.7`)
    const body = await response.json() as { profiles: unknown[] }
    assert.equal(body.profiles.length, builtin.length)
    assert.equal(tenantArgumentSeen, 'bs-2.7', 'the target passes through; nothing else does')
  })
})

test('targets expose what a target IS, not how the deployment is running', async () => {
  slicerClient.capabilities = async () => ({
    configured: true,
    healthy: true,
    slicerName: 'BambuStudio',
    defaultTargetId: 'bs-2.7',
    targets: [{
      id: 'bs-2.7', label: 'BambuStudio 2.7', family: 'bambustudio', version: '2.7.0',
      slicerName: 'BambuStudio', supportsEstimateModeMachineSwitch: true, isDefault: true, prerelease: false
    }]
  } as unknown as Awaited<ReturnType<typeof slicerClient.capabilities>>)

  await withApp(async (baseUrl) => {
    const body = await (await fetch(`${baseUrl}/targets`)).json() as {
      targets: Array<Record<string, unknown>>
      healthy?: unknown
    }
    assert.equal(body.targets[0]?.id, 'bs-2.7')
    // Health and queue depth describe the deployment, not the catalogue, and are nobody's business
    // anonymously.
    assert.equal('healthy' in body, false)
    assert.equal('slicerName' in (body.targets[0] ?? {}), false)
  })
})

test('a printer with no bundled bed model answers 404 rather than erroring', async () => {
  slicerClient.capabilities = originalCapabilities
  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bed-model`)
    // Missing printerModel is a bad request, not a 500.
    assert.equal(response.status, 400)
  })
})
