/**
 * Server-side provenance for browser-authored slicing inputs.
 *
 * The browser sends its frozen target twice: when staging the immutable project and when queuing
 * the slice. The server verifies that its referenced presets and real printer are still available
 * at both boundaries, then binds that request to the immutable snapshot. The browser-authored 3MF
 * is authoritative. The one preset body retained at queue time is a selected custom machine,
 * which the slicer needs as a runtime identity and custom-bed asset carrier. It must not be used
 * to rebuild the project.
 */
import { createHash } from 'node:crypto'
import { isProjectSlicingPresetId, type CreateSlicingJob, type SlicingTarget } from '@printstream/shared'
import { canonicalJson } from './canonical-json.js'
import { env } from './env.js'
import { badRequest } from './http-error.js'
import { prisma } from './prisma.js'
import { resolveSlicingPresetFiles, type ResolvedSlicingPresetFile } from './slicing-presets.js'

export interface PreparedSlicingConfiguration {
  contractVersion: 1
  slicerTargetId?: string | null
  target: SlicingTarget
}

export interface PreparedSlicingAuthorization extends PreparedSlicingConfiguration {
  printerModel: string | null
  /** Exact custom machine selected by the browser, retained only for slicer runtime mechanics. */
  runtimeMachineProfile?: ResolvedSlicingPresetFile | null
}

/** Lease covering a staged proof until its job is enqueued and protected by a live reference. */
export function preparedSlicingSourceExpiry(now = Date.now()): Date {
  return new Date(now + env.LIBRARY_UNREFERENCED_SLICE_RETENTION_HOURS * 60 * 60 * 1000)
}

/** Stable digest of every frozen setting that selects/authors the prepared engine input. */
export function preparedSlicingConfigurationDigest(input: PreparedSlicingAuthorization): string {
  return createHash('sha256').update(canonicalJson({
    contractVersion: input.contractVersion,
    slicerTargetId: input.slicerTargetId ?? null,
    target: input.target,
    printerModel: input.printerModel,
    // The custom machine is loaded beside the already-authored project at slice time. Bind its
    // exact body into the proof so an overwrite between staging and enqueue cannot silently pair
    // that immutable 3MF with different machine settings or custom-bed assets.
    runtimeMachineProfile: input.runtimeMachineProfile ?? null
  })).digest('hex')
}

/** Verify selected workspace-owned resources and resolve the real printer's current model. */
export async function authorizePreparedSlicingConfiguration(input: PreparedSlicingConfiguration & {
  workspaceId: string
}): Promise<PreparedSlicingAuthorization> {
  const machineId = input.target.printerProfileId
  if (!machineId || isProjectSlicingPresetId(machineId)) {
    throw badRequest('Prepared slicing requires a resolvable printer preset.')
  }
  const requested = [
    { id: machineId, kind: 'machine' as const },
    { id: input.target.processProfileId, kind: 'process' as const },
    ...(input.target.filamentMappings ?? []).map((mapping) => ({ id: mapping.profileId, kind: 'filament' as const }))
  ]
  const files = await resolveSlicingPresetFiles(input.workspaceId, requested)
  const byId = new Map(files.map((file) => [file.id, file]))
  if (!byId.has(machineId)) throw badRequest('The selected printer preset could not be resolved.')
  const processId = input.target.processProfileId
  if (processId && !isProjectSlicingPresetId(processId) && !byId.has(processId)) {
    throw badRequest('The selected process preset could not be resolved.')
  }
  for (const mapping of input.target.filamentMappings ?? []) {
    const id = mapping.profileId
    if (id && !isProjectSlicingPresetId(id) && !byId.has(id)) {
      throw badRequest('A selected filament preset could not be resolved.')
    }
  }

  let printerModel: string | null = input.target.mode === 'manualProfile' ? input.target.printerModel : null
  if (input.target.mode === 'realPrinter') {
    const printer = await prisma.printer.findFirst({
      where: { id: input.target.printerId, workspaceId: input.workspaceId },
      select: { model: true }
    })
    if (!printer) throw badRequest('The target printer no longer exists.')
    printerModel = printer.model
  }
  const machineProfile = byId.get(machineId)!
  return {
    ...input,
    printerModel,
    runtimeMachineProfile: machineProfile.source === 'custom' ? machineProfile : null
  }
}

/**
 * Resolve a prepared source only when its server-issued proof matches this exact slice.
 *
 * A custom machine profile rides beside the source as runtime-only data. The prepared 3MF remains
 * authoritative for project settings; the sidecar supplies the User-preset lineage the CLI needs
 * for compatibility checks and task-local paths for embedded custom-bed assets.
 */
export async function resolvePreparedSlicingSource(input: {
  workspaceId: string
  sourceFileId: string
  request: CreateSlicingJob
  /** Test seam only; production callers always resolve from server-owned state. */
  authorization?: PreparedSlicingAuthorization
}): Promise<{
  id: string
  name: string
  ownerBridgeId: string | null
  storedPath: string
  runtimeMachineProfile: ResolvedSlicingPresetFile | null
} | null> {
  const prepared = input.request.preparedSource
  if (!prepared) return null
  const configurationBase = input.request.contentBase
  const authorization = input.authorization ?? await authorizePreparedSlicingConfiguration({
    workspaceId: input.workspaceId,
    contractVersion: prepared.contractVersion,
    slicerTargetId: input.request.slicerTargetId ?? null,
    target: input.request.target
  })
  const proof = await prisma.preparedSlicingSource.findFirst({
    where: {
      id: prepared.id,
      workspaceId: input.workspaceId,
      sourceFileId: input.sourceFileId,
      configurationBaseFileId: configurationBase?.fileId ?? input.sourceFileId,
      configurationBaseVersionId: configurationBase?.versionId ?? '',
      contractVersion: prepared.contractVersion,
      configurationDigest: preparedSlicingConfigurationDigest(authorization),
      expiresAt: { gt: new Date() },
      libraryFile: {
        workspaceId: input.workspaceId,
        deletedAt: null,
        hidden: true,
        origin: 'snapshot',
        snapshotKey: { not: null }
      }
    },
    select: {
      libraryFile: { select: { id: true, name: true, ownerBridgeId: true, storedPath: true } }
    }
  })
  if (!proof) {
    throw badRequest('The prepared project does not match this source and slicing configuration. Prepare it again.')
  }
  return {
    ...proof.libraryFile,
    runtimeMachineProfile: authorization.runtimeMachineProfile ?? null
  }
}
