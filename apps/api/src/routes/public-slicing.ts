/**
 * Anonymous, read-only access to the slicer's BUILT-IN catalogue.
 *
 * The public 3MF editor runs with no account and no workspace, but it still has to know which
 * machines, processes, and filaments exist — a project's presets are meaningless without the
 * catalogue they name. That data is not workspace data: it is BambuStudio's bundled presets, shipped
 * inside the slicer image and identical for everyone.
 *
 * The workspace route (`/api/slicing/profiles`) stays exactly as it was. This is a separate surface
 * rather than a relaxation of that one, so the split is structural: **nothing here ever consults a
 * workspace**, so no custom profile, printer, or workspace value can reach an anonymous caller even by
 * mistake. A user's own presets live in their browser on this surface, never on the server.
 *
 * Cost posture: the catalogue is multi-MB and immutable for the life of a slicer image, so it is
 * sent with a long public cache lifetime and its own rate limit (see `app.ts`). It is the one large
 * anonymous body the API serves, which is why it is capped rather than left on the general limiter.
 */
import { Router } from 'express'
import {
  parseBuiltinSlicingPresetId,
  resolveFilamentConfigRequestSchema,
  resolveMachineConfigRequestSchema,
  resolveProcessConfigRequestSchema,
  type ResolveFilamentConfigResponse,
  type ResolveProcessConfigResponse
} from '@printstream/shared'
import { sendModelBuffer } from '../lib/request-helpers.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { slicerClient } from '../lib/slicer-client.js'

export const publicSlicingRouter = Router()

/**
 * How long a browser and any shared cache may keep the catalogue. It only changes when the slicer
 * image does, and a stale entry costs a user nothing worse than a preset added in a newer image not
 * appearing until the cache turns over.
 */
const CATALOGUE_CACHE_SECONDS = 60 * 60

/**
 * The built-in profile catalogue. No workspace customs — those require a workspace by definition, and
 * a caller here has none.
 */
publicSlicingRouter.get('/profiles', async (request, response) => {
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const profiles = await slicerClient.profiles(targetId)
  response.setHeader('Cache-Control', `public, max-age=${CATALOGUE_CACHE_SECONDS}`)
  // Same reasoning as the workspace route: this is the largest JSON the web app loads, and a one-shot
  // `response.json()` is what the dev proxy intermittently truncates on large bodies.
  await sendModelBuffer(request, response, Buffer.from(JSON.stringify({ profiles }), 'utf8'), 'application/json')
})

/**
 * Which slicer targets exist, so the public editor can pick one before asking for its catalogue.
 * Deliberately narrower than `/api/slicing/capabilities`: only what a target IS, never queue depth,
 * concurrency, or health, which describe the deployment rather than the catalogue.
 */
publicSlicingRouter.get('/targets', async (_request, response) => {
  const capabilities = await slicerClient.capabilities()
  response.setHeader('Cache-Control', `public, max-age=${CATALOGUE_CACHE_SECONDS}`)
  response.json({
    configured: capabilities.configured,
    defaultTargetId: capabilities.defaultTargetId,
    targets: capabilities.targets.map((target) => ({
      id: target.id,
      label: target.label,
      family: target.family,
      version: target.version,
      isDefault: target.isDefault,
      prerelease: target.prerelease
    }))
  })
})

/**
 * Resolve a BUILTIN process preset's full config, so the public editor's process "tune" dialog can
 * seed its baseline. Deliberately builtin-ONLY: a custom preset is workspace data (no anonymous
 * caller has one), and a PROJECT preset is resolved in the browser from the 3MF's own
 * `project_settings.config` (the file lives only in the tab), so it never reaches this route.
 */
publicSlicingRouter.post('/resolve-process', async (request, response) => {
  const parsed = resolveProcessConfigRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid resolve request')
  const builtin = parseBuiltinSlicingPresetId(parsed.data.processProfileId)
  if (!builtin || builtin.kind !== 'process') throw badRequest('Only built-in process presets can be resolved here')
  const config = await slicerClient.resolveProcessConfig(parsed.data.targetId ?? null, { source: 'builtin', name: builtin.name })
  if (!config) throw notFound('Process profile could not be resolved')
  // A builtin has no baked overrides: both baselines are the resolved preset.
  const body: ResolveProcessConfigResponse = { config, baseConfig: config, overriddenKeys: [] }
  response.json(body)
})

/** Sibling of {@link resolve-process} for a BUILTIN filament preset. Same builtin-only rationale. */
publicSlicingRouter.post('/resolve-filament', async (request, response) => {
  const parsed = resolveFilamentConfigRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid resolve request')
  const builtin = parseBuiltinSlicingPresetId(parsed.data.filamentProfileId)
  if (!builtin || builtin.kind !== 'filament') throw badRequest('Only built-in filament presets can be resolved here')
  const config = await slicerClient.resolveFilamentConfig(parsed.data.targetId ?? null, { source: 'builtin', name: builtin.name })
  if (!config) throw notFound('Filament profile could not be resolved')
  const body: ResolveFilamentConfigResponse = { config, baseConfig: config, overriddenKeys: [] }
  response.json(body)
})

/**
 * Sibling of {@link resolve-process} for a BUILTIN machine preset, so the public editor can retarget
 * a project to a different printer while SAVING it — the settings rewrite runs in the browser (the
 * file never leaves it), but the target machine's full preset lives in the slicer image and can only
 * come from here. Builtin-only for the same reason as the others: a custom machine preset is
 * workspace data.
 *
 * Unlike the workspace route there is no parent-preset baseline in the response: the browser uses this
 * to AUTHOR settings, not to diff them, so `baseConfig` would be dead weight on a multi-hundred-key
 * body. Counterpart: `apps/web/src/plugins/model-studio/lib/localMachineRetarget.ts`.
 */
publicSlicingRouter.post('/resolve-machine', async (request, response) => {
  const parsed = resolveMachineConfigRequestSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid resolve request')
  const builtin = parseBuiltinSlicingPresetId(parsed.data.machineProfileId)
  if (!builtin || builtin.kind !== 'machine') throw badRequest('Only built-in printer presets can be resolved here')
  const config = await slicerClient.resolveMachineConfig(parsed.data.targetId ?? null, { source: 'builtin', name: builtin.name })
  if (!config) throw notFound('Printer profile could not be resolved')
  response.json({ config, name: builtin.name })
})

/**
 * The modelled 3D build plate for a printer, from the slicer's bundled BambuStudio resources. A
 * printer with no bundled bed answers 404 and the editor keeps its millimetre grid, exactly as the
 * workspace route behaves.
 */
publicSlicingRouter.get('/bed-model', async (request, response) => {
  const printerModel = typeof request.query.printerModel === 'string' ? request.query.printerModel.trim() : ''
  if (!printerModel) throw badRequest('printerModel is required')
  const targetId = typeof request.query.targetId === 'string' ? request.query.targetId : null
  const bytes = await slicerClient.bedModel(targetId, printerModel)
  if (!bytes) throw notFound('No bed model for this printer')
  response.setHeader('Cache-Control', `public, max-age=${CATALOGUE_CACHE_SECONDS}`)
  await sendModelBuffer(request, response, bytes, 'model/stl')
})
