process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { buildBuiltinSlicingPresetId } from '@printstream/shared'
import { publicSlicingRouter } from './public-slicing.js'
import { slicerClient } from '../lib/slicer-client.js'

/**
 * The point of this surface is that it is anonymous AND carries nothing workspace-specific. Both halves
 * are asserted: a caller with no session gets the catalogue, and what comes back is exactly what the
 * slicer reported — no custom profiles, which by definition belong to a workspace this caller does
 * not have.
 */

const originalProfiles = slicerClient.profiles.bind(slicerClient)
const originalCapabilities = slicerClient.capabilities.bind(slicerClient)
const originalResolveMachineConfig = slicerClient.resolveMachineConfig.bind(slicerClient)
const originalResolveProcessConfig = slicerClient.resolveProcessConfig.bind(slicerClient)
const originalResolveFilamentConfig = slicerClient.resolveFilamentConfig.bind(slicerClient)
const originalBedModel = slicerClient.bedModel.bind(slicerClient)

afterEach(() => {
  slicerClient.profiles = originalProfiles
  slicerClient.capabilities = originalCapabilities
  slicerClient.resolveMachineConfig = originalResolveMachineConfig
  slicerClient.resolveProcessConfig = originalResolveProcessConfig
  slicerClient.resolveFilamentConfig = originalResolveFilamentConfig
  slicerClient.bedModel = originalBedModel
})

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express()
  app.use(express.json())
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
    // No cookie, no workspace header, no permission — the whole point of the surface.
    const response = await fetch(`${baseUrl}/profiles`)
    assert.equal(response.status, 200)
    const body = await response.json() as { profiles: Array<{ id: string }> }
    assert.deepEqual(body.profiles.map((profile) => profile.id), ['machine:X1C'])
    // Publicly cacheable: immutable for the life of a slicer image, and the largest anonymous body
    // the API serves.
    assert.match(response.headers.get('cache-control') ?? '', /public/)
  })
})

test('the catalogue is exactly what the slicer reported, with nothing workspace-owned added', async () => {
  // The workspace route merges custom profiles in. This one must not — a caller here has no workspace,
  // so any custom preset appearing would be someone else's.
  const builtin = [{ id: 'process:0.20mm', kind: 'process', name: '0.20mm Standard' }]
  let workspaceArgumentSeen: unknown = 'not-called'
  slicerClient.profiles = async (targetId) => {
    workspaceArgumentSeen = targetId
    return builtin as unknown as Awaited<ReturnType<typeof slicerClient.profiles>>
  }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/profiles?targetId=bs-2.7`)
    const body = await response.json() as { profiles: unknown[] }
    assert.equal(body.profiles.length, builtin.length)
    assert.equal(workspaceArgumentSeen, 'bs-2.7', 'the target passes through; nothing else does')
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

test('a bed-model request with no printerModel is a bad request, not a 500', async () => {
  let asked = 0
  slicerClient.bedModel = async () => { asked += 1; return null }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bed-model`)
    assert.equal(response.status, 400)
    assert.equal(asked, 0, 'an empty model name never becomes a slicer lookup')
  })
})

test('a printer with no bundled bed model answers 404 rather than erroring', async () => {
  // Not every printer ships a modelled plate, and the editor falls back to its millimetre grid — so a
  // miss is a normal answer the client acts on, never a failure.
  slicerClient.bedModel = async () => null

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/bed-model?printerModel=C11`)
    assert.equal(response.status, 404)
  })
})

// The public editor rewrites a project's machine IN THE BROWSER when saving it for a different
// printer, but the target machine's full preset only exists inside the slicer image — this route is
// the one hop that cannot move into the tab. Counterpart:
// `apps/web/src/plugins/model-studio/lib/localMachineRetarget.ts`.
test('a built-in printer preset resolves anonymously, for the browser-side machine retarget', async () => {
  slicerClient.resolveMachineConfig = async (_targetId, file) => (
    { printer_model: 'H2D', printer_settings_id: file.name } as unknown as Awaited<ReturnType<typeof slicerClient.resolveMachineConfig>>
  )

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-machine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineProfileId: buildBuiltinSlicingPresetId('machine', 'Bambu Lab H2D 0.4 nozzle') })
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { config: Record<string, unknown>; name: string }
    assert.equal(body.name, 'Bambu Lab H2D 0.4 nozzle')
    assert.equal(body.config.printer_model, 'H2D')
  })
})

test('a workspace machine preset id is refused here rather than reaching a workspace lookup', async () => {
  // The whole point of the surface: nothing here ever consults a workspace, so a custom preset must be
  // rejected at the boundary instead of being resolved through some other path.
  let resolved = 0
  slicerClient.resolveMachineConfig = async () => { resolved += 1; return null }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-machine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineProfileId: 'custom:machine:abc' })
    })
    assert.equal(response.status, 400)
    assert.equal(resolved, 0)
  })
})

test('a built-in preset of the wrong kind cannot be resolved as a machine', async () => {
  // The id parses, so only the `kind` half of the guard stands between a process preset name and the
  // machine resolver — which against a real slicer could answer 200 from the wrong catalogue.
  let resolved = 0
  slicerClient.resolveMachineConfig = async () => { resolved += 1; return null }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-machine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineProfileId: buildBuiltinSlicingPresetId('process', '0.20mm Standard @BBL H2D') })
    })
    assert.equal(response.status, 400)
    assert.equal(resolved, 0)
  })
})

test('a built-in process preset resolves anonymously, with the preset as its own baseline', async () => {
  slicerClient.resolveProcessConfig = async (_targetId, preset) => (
    { layer_height: '0.2', print_settings_id: preset.name } as unknown as Awaited<ReturnType<typeof slicerClient.resolveProcessConfig>>
  )

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ processProfileId: buildBuiltinSlicingPresetId('process', '0.20mm Standard @BBL X1C') })
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { config: Record<string, unknown>; baseConfig: Record<string, unknown>; overriddenKeys: string[] }
    assert.equal(body.config.print_settings_id, '0.20mm Standard @BBL X1C')
    // A builtin carries no baked overrides, so there is nothing to reset toward but itself — the editor
    // would badge phantom "modified" settings if these two ever diverged here.
    assert.deepEqual(body.baseConfig, body.config)
    assert.deepEqual(body.overriddenKeys, [])
  })
})

test('a workspace process preset id is refused here rather than reaching a workspace lookup', async () => {
  let resolved = 0
  slicerClient.resolveProcessConfig = async () => { resolved += 1; return null }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ processProfileId: 'custom:process:abc' })
    })
    assert.equal(response.status, 400)
    assert.equal(resolved, 0)
  })
})

test('a built-in FILAMENT id is refused by resolve-process, not resolved as a process preset', async () => {
  // The id parses as a builtin, so the kind is the only thing standing between a filament preset name
  // and the process resolver, which would answer 200 with a config from the wrong catalogue.
  let resolved = 0
  slicerClient.resolveProcessConfig = async () => { resolved += 1; return null }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ processProfileId: buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL X1C') })
    })
    assert.equal(response.status, 400)
    assert.equal(resolved, 0)
  })
})

test('a built-in filament preset resolves anonymously, with the preset as its own baseline', async () => {
  slicerClient.resolveFilamentConfig = async (_targetId, preset) => (
    { filament_type: 'PLA', filament_settings_id: preset.name } as unknown as Awaited<ReturnType<typeof slicerClient.resolveFilamentConfig>>
  )

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-filament`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filamentProfileId: buildBuiltinSlicingPresetId('filament', 'Bambu PLA Basic @BBL X1C') })
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { config: Record<string, unknown>; baseConfig: Record<string, unknown>; overriddenKeys: string[] }
    assert.equal(body.config.filament_settings_id, 'Bambu PLA Basic @BBL X1C')
    assert.deepEqual(body.baseConfig, body.config)
    assert.deepEqual(body.overriddenKeys, [])
  })
})

test('a workspace filament preset id is refused here rather than reaching a workspace lookup', async () => {
  let resolved = 0
  slicerClient.resolveFilamentConfig = async () => { resolved += 1; return null }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-filament`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filamentProfileId: 'custom:filament:abc' })
    })
    assert.equal(response.status, 400)
    assert.equal(resolved, 0)
  })
})

test('a built-in PROCESS id is refused by resolve-filament, not resolved as a filament preset', async () => {
  let resolved = 0
  slicerClient.resolveFilamentConfig = async () => { resolved += 1; return null }

  await withApp(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/resolve-filament`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filamentProfileId: buildBuiltinSlicingPresetId('process', '0.20mm Standard @BBL X1C') })
    })
    assert.equal(response.status, 400)
    assert.equal(resolved, 0)
  })
})
