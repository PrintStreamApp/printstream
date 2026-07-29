/**
 * Tenant-scoped BambuStudio slicing profile persistence.
 *
 * Custom profile JSON is stored in the existing Setting table using a
 * tenant-qualified key. Built-in profile summaries come from the slicer
 * worker, while custom profile contents are resolved here before a job is
 * submitted to the worker.
 */
import { randomUUID } from 'node:crypto'
import yauzl, { type Entry } from 'yauzl'
import { z } from 'zod'
import {
  extractProfileMetadata,
  isProjectSlicingPresetId,
  omitEmptyMetadata,
  parseBuiltinSlicingPresetId,
  slicingPresetKindSchema,
  stringValue,
  type SlicingPresetKind,
  type SlicingPresetSummary,
  type UploadSlicingPreset
} from '@printstream/shared'
import {
  extractUploadedProfiles as extractUploadedProfilesShared,
  parseProfileJson as parseProfileJsonShared,
  type UploadedProfileEntry
} from '@printstream/shared'
import { badRequest, notFound } from './http-error.js'
import { rootPrisma } from './prisma.js'

const SETTINGS_KEY_PREFIX = 'tenant.slicing.profiles.'

const storedSlicingPresetSchema = z.object({
  id: z.string().trim().min(1),
  kind: slicingPresetKindSchema,
  name: z.string().trim().min(1),
  content: z.string().trim().min(2),
  updatedAt: z.string()
})

type StoredSlicingPreset = z.infer<typeof storedSlicingPresetSchema>
/**
 * A preset summary's metadata: everything that is NOT its identity.
 *
 * Defined by EXCLUSION on purpose. Listing the metadata keys instead meant every
 * field added to `slicingPresetSummarySchema` had to be added here, to the merge,
 * and to the pick — and missing one silently dropped it from custom (tenant-uploaded)
 * presets while builtin presets carried it (issue #66). Inverting it puts the
 * maintenance burden on the small, stable identity set, so a new metadata field
 * flows through with no change here at all.
 */
type ProfileIdentityKey = 'id' | 'source' | 'kind' | 'name' | 'updatedAt'
type ProfileMetadata = Omit<SlicingPresetSummary, ProfileIdentityKey>

export interface ResolvedSlicingPresetFile {
  id: string
  source: 'builtin' | 'custom'
  kind: SlicingPresetKind
  name: string
  content?: string
}

export async function listCustomSlicingPresets(tenantId: string, inheritedProfiles: SlicingPresetSummary[] = []): Promise<SlicingPresetSummary[]> {
  const profiles = await readProfiles(tenantId)
  const customByName = new Map(profiles.map((profile) => [buildProfileLookupKey(profile.kind, profile.name), profile]))
  const inheritedByName = new Map(inheritedProfiles.map((profile) => [buildProfileLookupKey(profile.kind, profile.name), profile]))
  return profiles.map((profile) => toSummary(profile, customByName, inheritedByName))
}

export interface CreateCustomSlicingPresetsResult {
  profiles: SlicingPresetSummary[]
  /** Names of existing same-kind presets that were overwritten by this upload. */
  replaced: string[]
  /**
   * Names of existing same-kind presets the upload would overwrite. Non-empty only when the upload
   * was NOT created (the caller passed no `overwrite`), so the user can confirm before replacing.
   */
  conflicts: string[]
}

export async function createCustomSlicingPreset(tenantId: string, input: UploadSlicingPreset): Promise<SlicingPresetSummary> {
  const { profiles } = await createCustomSlicingPresets(tenantId, input)
  const profile = profiles[0]
  if (!profile) throw badRequest('Uploaded profile file did not contain any slicing presets')
  return profile
}

export async function createCustomSlicingPresets(tenantId: string, input: UploadSlicingPreset): Promise<CreateCustomSlicingPresetsResult> {
  const uploadedProfiles = await extractUploadedProfiles(input)
  const existingProfiles = await readProfiles(tenantId)
  const now = new Date().toISOString()
  const createdProfiles = uploadedProfiles.map((uploadedProfile) => {
    const parsedJson = parseProfileJson(uploadedProfile.content, uploadedProfile.kind)
    return {
      id: `custom:${randomUUID()}`,
      kind: parsedJson.kind,
      name: uploadedProfile.name?.trim() || parsedJson.name,
      content: JSON.stringify(parsedJson.raw, null, 2),
      updatedAt: now
    } satisfies StoredSlicingPreset
  })
  const createdKeys = new Set(createdProfiles.map((profile) => buildProfileLookupKey(profile.kind, profile.name)))
  const collisions = existingProfiles.filter((profile) => createdKeys.has(buildProfileLookupKey(profile.kind, profile.name)))
  const collisionNames = [...new Set(collisions.map((profile) => profile.name))]
  // Without an explicit overwrite, don't touch storage — report the collisions so the user can
  // confirm or decline replacing them.
  if (collisionNames.length > 0 && !input.overwrite) {
    return { profiles: [], replaced: [], conflicts: collisionNames }
  }
  // Overwrite any existing custom preset with the same kind + name rather than keeping duplicates.
  const retained = existingProfiles.filter((profile) => !createdKeys.has(buildProfileLookupKey(profile.kind, profile.name)))
  const nextProfiles = [...retained, ...createdProfiles]
  await writeProfiles(tenantId, nextProfiles)
  const customByName = new Map(nextProfiles.map((profile) => [buildProfileLookupKey(profile.kind, profile.name), profile]))
  return {
    profiles: createdProfiles.map((profile) => toSummary(profile, customByName, new Map())),
    replaced: collisionNames,
    conflicts: []
  }
}

export async function deleteCustomSlicingPreset(tenantId: string, profileId: string): Promise<void> {
  const profiles = await readProfiles(tenantId)
  const next = profiles.filter((profile) => profile.id !== profileId)
  if (next.length === profiles.length) throw notFound('Slicing profile not found')
  await writeProfiles(tenantId, next)
}

export async function resolveSlicingPresetFiles(tenantId: string, profileIds: Array<{ id: string | null | undefined; kind: SlicingPresetKind }>): Promise<ResolvedSlicingPresetFile[]> {
  const customProfiles = await readProfiles(tenantId)
  const resolved: ResolvedSlicingPresetFile[] = []
  for (const requested of profileIds) {
    const id = requested.id?.trim()
    if (!id) continue
    // A `project:` preset needs no file: the input 3MF's own embedded settings ARE that preset.
    if (isProjectSlicingPresetId(id)) continue
    const builtin = parseBuiltinSlicingPresetId(id)
    if (builtin) {
      if (builtin.kind !== requested.kind) throw badRequest('Selected slicing profile type does not match the requested field')
      resolved.push({ id, source: 'builtin', kind: builtin.kind, name: builtin.name })
      continue
    }
    const custom = customProfiles.find((profile) => profile.id === id)
    if (!custom) throw notFound('Slicing profile not found')
    if (custom.kind !== requested.kind) throw badRequest('Selected slicing profile type does not match the requested field')
    resolved.push({ id, source: 'custom', kind: custom.kind, name: custom.name, content: custom.content })
  }
  return resolved
}

async function readProfiles(tenantId: string): Promise<StoredSlicingPreset[]> {
  const setting = await rootPrisma.setting.findUnique({ where: { key: buildSettingsKey(tenantId) } })
  if (!setting) return []
  const parsed = z.array(storedSlicingPresetSchema).safeParse(JSON.parse(setting.value))
  if (!parsed.success) return []
  return parsed.data
}

async function writeProfiles(tenantId: string, profiles: StoredSlicingPreset[]): Promise<void> {
  await rootPrisma.setting.upsert({
    where: { key: buildSettingsKey(tenantId) },
    create: { key: buildSettingsKey(tenantId), value: JSON.stringify(profiles) },
    update: { value: JSON.stringify(profiles) }
  })
}

function buildSettingsKey(tenantId: string): string {
  return `${SETTINGS_KEY_PREFIX}${tenantId}`
}

function toSummary(
  profile: StoredSlicingPreset,
  customByName: Map<string, StoredSlicingPreset>,
  inheritedByName: Map<string, SlicingPresetSummary>,
  visited = new Set<string>()
): SlicingPresetSummary {
  const record = JSON.parse(profile.content) as Record<string, unknown>
  return {
    id: profile.id,
    source: 'custom',
    kind: profile.kind,
    name: profile.name,
    ...resolveProfileMetadata(profile.kind, record, customByName, inheritedByName, visited),
    // Spread AFTER the metadata: this is an identity fact about this preset, and must not be
    // overwritten by a parent's own `derivedFromPresetName` flowing through the metadata merge.
    ...(stringValue(record.inherits) ? { derivedFromPresetName: stringValue(record.inherits) as string } : {}),
    updatedAt: profile.updatedAt
  }
}

function resolveProfileMetadata(
  kind: SlicingPresetKind,
  record: Record<string, unknown>,
  customByName: Map<string, StoredSlicingPreset>,
  inheritedByName: Map<string, SlicingPresetSummary>,
  visited: Set<string>
): Partial<ProfileMetadata> {
  const parentName = stringValue(record.inherits)
  const parentMetadata = parentName
    ? resolveInheritedProfileMetadata(kind, parentName, customByName, inheritedByName, visited)
    : {}
  return mergeProfileMetadata(parentMetadata, extractProfileMetadata(record))
}

function resolveInheritedProfileMetadata(
  kind: SlicingPresetKind,
  parentName: string,
  customByName: Map<string, StoredSlicingPreset>,
  inheritedByName: Map<string, SlicingPresetSummary>,
  visited: Set<string>
): Partial<ProfileMetadata> {
  const key = buildProfileLookupKey(kind, parentName)
  if (visited.has(key)) return {}
  visited.add(key)
  const customParent = customByName.get(key)
  if (customParent) {
    return resolveProfileMetadata(kind, JSON.parse(customParent.content) as Record<string, unknown>, customByName, inheritedByName, visited)
  }
  const inheritedParent = inheritedByName.get(key)
  return inheritedParent ? pickProfileMetadata(inheritedParent) : {}
}

/**
 * Merge an `inherits` parent's metadata with the child's, the child winning per key.
 *
 * `extractProfileMetadata` already drops absent keys, so a key present on the child
 * is a real value and correctly shadows the parent — including an explicit `false`
 * (a child that turns `filament_is_support` off must not inherit the parent's `true`).
 */
function mergeProfileMetadata(parent: Partial<ProfileMetadata>, child: Partial<ProfileMetadata>): Partial<ProfileMetadata> {
  return omitEmptyMetadata({ ...parent, ...child })
}

/**
 * The metadata half of a resolved summary — everything but the identity keys.
 *
 * Destructured rather than key-listed so a field added to the summary schema is
 * carried automatically; only the (stable) identity set is spelled out.
 */
function pickProfileMetadata(profile: SlicingPresetSummary): Partial<ProfileMetadata> {
  const {
    id: _id, source: _source, kind: _kind, name: _name, updatedAt: _updatedAt,
    // Identity, not metadata: whether THIS preset is a derivative says nothing about its child.
    // Inheriting it would mark every descendant as derived from its grandparent.
    derivedFromPresetName: _derivedFromPresetName,
    ...metadata
  } = profile
  return omitEmptyMetadata(metadata)
}

function buildProfileLookupKey(kind: SlicingPresetKind, name: string): string {
  return `${kind}:${name.toLowerCase().trim()}`
}

function readPresetArchive(buffer: Buffer): Promise<UploadedProfileEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open archive'))
        return
      }
      const profiles: UploadedProfileEntry[] = []
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        zipFile.close()
        if (error) reject(error)
        else resolve(profiles)
      }
      zipFile.on('error', (error) => finish(error instanceof Error ? error : new Error('Failed to read archive')))
      zipFile.on('end', () => finish())
      zipFile.on('entry', (entry: Entry) => {
        const fileName = entry.fileName.replace(/\\/g, '/')
        const baseName = fileName.split('/').at(-1)?.toLowerCase() ?? ''
        if (fileName.endsWith('/') || baseName === 'bundle_structure.json' || !baseName.endsWith('.json')) {
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error('Failed to read preset file from archive'))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('end', () => {
            profiles.push({ content: Buffer.concat(chunks).toString('utf8') })
            zipFile.readEntry()
          })
          stream.on('error', (error) => finish(error instanceof Error ? error : new Error('Failed to read preset file from archive')))
        })
      })
      zipFile.readEntry()
    })
  })
}

/**
 * The shared parse, with its plain errors turned into 400s. Shared code has no business knowing
 * about HTTP status codes, and every caller here is a request handler, so the translation happens
 * once at this boundary rather than at each call site.
 */
function parseProfileJson(content: string, fallbackKind?: SlicingPresetKind): { raw: Record<string, unknown>; kind: SlicingPresetKind; name: string } {
  try {
    return parseProfileJsonShared(content, fallbackKind)
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Profile must be valid BambuStudio JSON')
  }
}

/** Same translation for the upload extraction, with yauzl supplying the archive inflate. */
async function extractUploadedProfiles(input: UploadSlicingPreset): Promise<UploadedProfileEntry[]> {
  try {
    return await extractUploadedProfilesShared(input, (bytes) => readPresetArchive(Buffer.from(bytes)))
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Uploaded profile file could not be read')
  }
}
