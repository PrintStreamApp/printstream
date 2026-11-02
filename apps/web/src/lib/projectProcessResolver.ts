/**
 * Resolves the process from the opened archive, never from the library row's moving head. Catalogue
 * lookups supply baselines only: they cannot replace the opened project's effective values.
 */
import { extractProjectProcessConfig, isProjectSlicingPresetId, type SlicingPresetSummary, type ResolveProcessConfigResponse } from '@printstream/shared'
import type { ProcessConfigResolver } from '../components/ProcessSettingsDialog'

export function projectProcessResolver(input: {
  readSettings: () => Promise<string | null>
  profiles: () => SlicingPresetSummary[]
  resolveInstalled: ProcessConfigResolver
}): ProcessConfigResolver {
  const resolveInstalled = memoizeProcessPresetResolver(input.resolveInstalled)
  return memoizeProcessPresetResolver(async (request) => {
    if (!isProjectSlicingPresetId(request.processProfileId)) return resolveInstalled(request)
    const json = await input.readSettings()
    const project = extractProjectProcessConfig(json ? JSON.parse(json) : null)
    if (!project) throw new Error('The opened project has no process settings')
    const selected = input.profiles().find((profile) => profile.name === project.presetName && !isProjectSlicingPresetId(profile.id))
    if (selected) {
      try {
        const leaf = await resolveInstalled({ ...request, processProfileId: selected.id, sourceFileId: null })
        return { ...leaf, config: project.config, baseConfig: leaf.config,
          overriddenKeys: project.overriddenKeys, declaresOverrides: project.declaresOverrides }
      } catch { /* Missing catalogue baseline cannot erase the opened effective values. */ }
    }
    return { config: project.config, baseConfig: project.config, overriddenKeys: project.overriddenKeys,
      declaresOverrides: project.declaresOverrides, baselineResolved: false, baselineOrigin: { kind: 'declared' } }
  })
}

/**
 * Pin installed revisions per engine and retain the loaded source across engine changes. Source
 * reads never require the previous preset to exist in the destination engine. Failed requests are
 * retryable and cannot replace the last successful descriptor. Each factory belongs to one project.
 */
export function memoizeProcessPresetResolver(resolve: ProcessConfigResolver): ProcessConfigResolver {
  const installed = new Map<string, Promise<ResolveProcessConfigResponse>>()
  const sourceRequests = new Map<string, symbol>()
  const loaded = new Map<string, ResolveProcessConfigResponse>()
  const pendingSources = new Map<string, Promise<ResolveProcessConfigResponse>>()

  const current: ProcessConfigResolver = (request) => {
    const key = JSON.stringify([request.processProfileId, request.targetId])
    const existing = !isProjectSlicingPresetId(request.processProfileId) ? installed.get(key) : undefined
    const requestId = Symbol()
    sourceRequests.set(request.processProfileId, requestId)
    const pending = Promise.resolve().then(async () => {
      try {
        // A cache hit is still an activation. Returning its promise directly would leave the
        // source descriptor on another engine after an A -> B -> A round trip.
        const response = await (existing ?? resolve(request))
        if (sourceRequests.get(request.processProfileId) === requestId) loaded.set(request.processProfileId, response)
        return response
      } catch (error) {
        installed.delete(key)
        throw error
      } finally {
        if (pendingSources.get(request.processProfileId) === pending) pendingSources.delete(request.processProfileId)
      }
    })
    if (!isProjectSlicingPresetId(request.processProfileId)) installed.set(key, pending)
    pendingSources.set(request.processProfileId, pending)
    return pending
  }
  current.peekSource = (profileId) => loaded.get(profileId)
  current.resolveSource = (request) => {
    const previous = loaded.get(request.processProfileId)
    if (previous) return Promise.resolve(previous)
    return pendingSources.get(request.processProfileId) ?? current(request)
  }
  return current
}
