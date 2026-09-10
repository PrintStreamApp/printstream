import { z } from 'zod'
import { LIBRARY_FILE_KINDS, classifyLibraryFileKind, isDirectPrintableFileName, isMeshLibraryFileKind, libraryFileSchema } from './printer.js'
import { IMPORT_FORMAT_LABELS } from './import-formats.js'
import { workspaceSummarySchema } from './workspaces.js'

export const remoteImportProviderSchema = z.enum([
  'makerworld',
  'printables',
  'generic'
])

export type RemoteImportProvider = z.infer<typeof remoteImportProviderSchema>

export const remoteImportUrlKindSchema = z.enum([
  'direct-file',
  'provider-model-page',
  'web-page',
  'unknown'
])

export type RemoteImportUrlKind = z.infer<typeof remoteImportUrlKindSchema>

export const remoteImportStrategySchema = z.enum([
  'server-download',
  'browser-assist',
  'unsupported'
])

export type RemoteImportStrategy = z.infer<typeof remoteImportStrategySchema>

/**
 * What a remotely-discovered file is: every library kind, plus `archive`.
 *
 * DERIVED from `LIBRARY_FILE_KINDS` because `classifyRemoteImportFileType` returns
 * `classifyLibraryFileKind`'s answer verbatim -- so a hand-written list here is a list that must be
 * edited in lockstep with one it already depends on, and adding a library kind without it is a type
 * error at best and an unclassifiable candidate at worst. `archive` is the one member this axis owns
 * outright: a `.zip` is nothing to the library but a legitimate thing to import FROM.
 */
export const remoteImportFileTypeSchema = z.enum([...LIBRARY_FILE_KINDS, 'archive'])

export type RemoteImportFileType = z.infer<typeof remoteImportFileTypeSchema>

export const remoteImportPrintableStatusSchema = z.enum([
  'printer-ready',
  'needs-slicing',
  'unknown'
])

export type RemoteImportPrintableStatus = z.infer<typeof remoteImportPrintableStatusSchema>

/**
 * Hosts whose images the import UI is willing to render.
 *
 * Matched as exact host or dot-suffix, never as a substring: `evil-bblmw.com`
 * must not pass. MakerWorld serves covers from its `bblmw.com` CDN; Printables
 * from `media.printables.com`.
 */
export const REMOTE_IMPORT_THUMBNAIL_HOSTS = [
  'bblmw.com',
  'makerworld.com',
  'printables.com'
] as const

/**
 * The same host set as CSP `img-src` sources, so the sanitizer and the policy
 * cannot drift apart, a cover that passes {@link sanitizeRemoteImportThumbnailUrl}
 * and is then blocked by CSP fails silently, with a broken card and no error.
 *
 * Each host appears TWICE on purpose: CSP's `*.example.com` does not match the
 * apex, but the sanitizer's dot-suffix rule accepts both, so an apex-served cover
 * needs the bare entry as well. Consumed by the API's runtime policy
 * (`apps/api/src/lib/content-security-policy.ts`); `apps/web/vite.config.ts`
 * mirrors it as a literal for the dev server, like the other cross-origin hosts.
 */
export const REMOTE_IMPORT_THUMBNAIL_CSP_SOURCES: string[] = REMOTE_IMPORT_THUMBNAIL_HOSTS.flatMap(
  (host) => [`https://${host}`, `https://*.${host}`]
)

/**
 * Narrows an untrusted thumbnail URL to one that is safe to put in an `<img src>`.
 *
 * The value reaches the web app through the extension handoff query string, which
 * the user (or anything that can craft a link to the import page) controls, so it
 * is filtered here rather than at the render site, where a caller could forget.
 * Returns null for anything that is not `https:` on an allow-listed provider host,
 * which also rejects `javascript:`/`data:` payloads outright.
 */
export function sanitizeRemoteImportThumbnailUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  const allowed = REMOTE_IMPORT_THUMBNAIL_HOSTS.some(
    (candidate) => host === candidate || host.endsWith(`.${candidate}`)
  )
  return allowed ? parsed.toString() : null
}

export const remoteImportCandidateSchema = z.object({
  id: z.string().min(1),
  provider: remoteImportProviderSchema,
  sourceUrl: z.string().url(),
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().nullable(),
  fileType: remoteImportFileTypeSchema,
  printableStatus: remoteImportPrintableStatusSchema,
  confidence: z.number().min(0).max(1),
  recommendationReason: z.string(),
  // Provider cover image. Optional so candidates minted by extension builds that
  // predate this field still parse; sanitized rather than rejected so one bad URL
  // costs the candidate its picture, not its place in the list.
  thumbnailUrl: z.unknown().optional().transform(sanitizeRemoteImportThumbnailUrl)
})

export type RemoteImportCandidate = z.infer<typeof remoteImportCandidateSchema>

export const remoteImportResolutionSchema = z.object({
  url: z.string().url(),
  normalizedUrl: z.string().url(),
  provider: remoteImportProviderSchema,
  kind: remoteImportUrlKindSchema,
  strategy: remoteImportStrategySchema,
  directFileKind: libraryFileSchema.shape.kind.nullable(),
  suggestedFileName: z.string().nullable(),
  candidates: z.array(remoteImportCandidateSchema),
  message: z.string()
})

export type RemoteImportResolution = z.infer<typeof remoteImportResolutionSchema>

export const remoteImportResolveRequestSchema = z.object({
  url: z.string().trim().url()
})

export type RemoteImportResolveRequest = z.infer<typeof remoteImportResolveRequestSchema>

export const remoteImportResolveResponseSchema = z.object({
  resolution: remoteImportResolutionSchema
})

export type RemoteImportResolveResponse = z.infer<typeof remoteImportResolveResponseSchema>

export const remoteImportUrlImportRequestSchema = z.object({
  url: z.string().trim().url(),
  /**
   * Bridge to store the bytes on. Still required: it is the fallback when no folder
   * is named, and the only thing an extension client knows about, it has no folder
   * tree to choose from.
   */
  bridgeId: z.string().trim().min(1),
  /**
   * Library folder to import into. Absent means the default `Imported models`
   * folder on `bridgeId`. When present it also decides the bridge (a folder already
   * belongs to one), so the two cannot disagree.
   */
  folderId: z.string().trim().min(1).nullish()
})

export type RemoteImportUrlImportRequest = z.infer<typeof remoteImportUrlImportRequestSchema>

export const remoteImportUploadResponseSchema = z.object({
  file: libraryFileSchema,
  resolution: remoteImportResolutionSchema,
  canPrintDirectly: z.boolean()
})

export type RemoteImportUploadResponse = z.infer<typeof remoteImportUploadResponseSchema>

export const remoteImportProviderCapabilitySchema = z.object({
  id: remoteImportProviderSchema,
  label: z.string(),
  strategy: remoteImportStrategySchema,
  browserAssisted: z.boolean()
})

export type RemoteImportProviderCapability = z.infer<typeof remoteImportProviderCapabilitySchema>

/**
 * Whether this workspace can pull a MakerWorld model server-side, and under whose
 * account. All three fields are needed to say anything useful: the feature is off
 * until `enabled`, unusable without `accountConnected`, and `accountLabel` is the
 * account a download will actually run as, a workspace shares ONE Bambu connection,
 * so that is frequently not the person clicking. Null label means not connected.
 */
export const remoteImportMakerWorldCapabilitySchema = z.object({
  enabled: z.boolean(),
  accountConnected: z.boolean(),
  accountLabel: z.string().nullable()
})

export type RemoteImportMakerWorldCapability = z.infer<typeof remoteImportMakerWorldCapabilitySchema>

export const remoteImportCapabilitiesResponseSchema = z.object({
  providers: z.array(remoteImportProviderCapabilitySchema),
  directPrintFileTypes: z.array(z.string()),
  importFileTypes: z.array(z.string()),
  libraryFolderName: z.string(),
  makerWorld: remoteImportMakerWorldCapabilitySchema
})

export const remoteImportMakerWorldSettingsRequestSchema = z.object({
  enabled: z.boolean()
})

export type RemoteImportMakerWorldSettingsRequest = z.infer<typeof remoteImportMakerWorldSettingsRequestSchema>

export type RemoteImportCapabilitiesResponse = z.infer<typeof remoteImportCapabilitiesResponseSchema>

export const remoteImportExtensionWorkspaceSchema = z.object({
  workspace: workspaceSummarySchema,
  bridgeCount: z.number().int().nonnegative()
})

export type RemoteImportExtensionWorkspace = z.infer<typeof remoteImportExtensionWorkspaceSchema>

export const remoteImportExtensionContextResponseSchema = z.object({
  authenticated: z.boolean(),
  authEnabled: z.boolean(),
  setupRequired: z.boolean(),
  workspaces: z.array(remoteImportExtensionWorkspaceSchema)
})

export type RemoteImportExtensionContextResponse = z.infer<typeof remoteImportExtensionContextResponseSchema>

export const IMPORTED_MODELS_FOLDER_NAME = 'Imported models'

export const REMOTE_IMPORT_PROVIDER_CAPABILITIES: RemoteImportProviderCapability[] = [
  { id: 'printables', label: 'Printables', strategy: 'browser-assist', browserAssisted: true },
  { id: 'makerworld', label: 'MakerWorld', strategy: 'browser-assist', browserAssisted: true },
  { id: 'generic', label: 'Direct file URL', strategy: 'server-download', browserAssisted: false }
]

export function detectRemoteImportUrl(rawUrl: string): RemoteImportResolution {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return {
      url: rawUrl,
      normalizedUrl: rawUrl,
      provider: 'generic',
      kind: 'unknown',
      strategy: 'unsupported',
      directFileKind: null,
      suggestedFileName: null,
      candidates: [],
      message: 'Paste a full URL.'
    }
  }

  const normalizedUrl = parsed.toString()
  const provider = detectRemoteImportProvider(parsed)
  const fileName = extractFileNameFromUrl(parsed)
  const directFileKind = fileName ? classifyLibraryFileKind(fileName) : 'other'

  if (fileName && directFileKind !== 'other') {
    return {
      url: rawUrl,
      normalizedUrl,
      provider,
      kind: 'direct-file',
      strategy: 'server-download',
      directFileKind,
      suggestedFileName: fileName,
      candidates: [buildRemoteImportCandidate({
        provider,
        sourceUrl: normalizedUrl,
        name: fileName,
        sizeBytes: null,
        confidence: 1
      })],
      message: 'Direct file URL detected. PrintStream can download this file into the library.'
    }
  }

  if (provider === 'makerworld' && isMakerWorldModelPage(parsed)) {
    return {
      url: rawUrl,
      normalizedUrl,
      provider,
      kind: 'provider-model-page',
      strategy: 'browser-assist',
      directFileKind: null,
      suggestedFileName: null,
      candidates: [],
      message: 'MakerWorld model pages need a browser-side helper because the file is not exposed as a stable server-download URL.'
    }
  }

  if (provider === 'printables' && isPrintablesModelPage(parsed)) {
    return {
      url: rawUrl,
      normalizedUrl,
      provider,
      kind: 'provider-model-page',
      strategy: 'browser-assist',
      directFileKind: null,
      suggestedFileName: null,
      candidates: [],
      message: 'Printables model pages are detected. Use a browser-side helper or extension to send the selected file to PrintStream.'
    }
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return {
      url: rawUrl,
      normalizedUrl,
      provider,
      kind: 'web-page',
      strategy: 'unsupported',
      directFileKind: null,
      suggestedFileName: fileName,
      candidates: [],
      message: 'This URL looks like a web page, not a printable file. Paste a direct file URL or use a browser helper on supported model pages.'
    }
  }

  return {
    url: rawUrl,
    normalizedUrl,
    provider,
    kind: 'unknown',
    strategy: 'unsupported',
    directFileKind: null,
    suggestedFileName: fileName,
    candidates: [],
    message: 'Unsupported URL.'
  }
}

export function buildRemoteImportCandidate(input: {
  provider: RemoteImportProvider
  sourceUrl: string
  name: string
  sizeBytes?: number | null
  confidence?: number
  thumbnailUrl?: string | null
}): RemoteImportCandidate {
  const fileType = classifyRemoteImportFileType(input.name)
  const printableStatus = classifyRemoteImportPrintableStatus(input.name)
  return remoteImportCandidateSchema.parse({
    id: stableCandidateId(input.sourceUrl, input.name),
    provider: input.provider,
    sourceUrl: input.sourceUrl,
    name: input.name,
    sizeBytes: input.sizeBytes ?? null,
    fileType,
    printableStatus,
    confidence: input.confidence ?? 0.8,
    recommendationReason: describeRemoteImportCandidate(input.name, fileType, printableStatus),
    thumbnailUrl: input.thumbnailUrl ?? null
  })
}

export function classifyRemoteImportFileType(name: string): RemoteImportFileType {
  const kind = classifyLibraryFileKind(name)
  if (kind !== 'other') return kind
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip') || lower.endsWith('.7z') || lower.endsWith('.rar')) return 'archive'
  return 'other'
}

export function classifyRemoteImportPrintableStatus(name: string): RemoteImportPrintableStatus {
  if (isDirectPrintableFileName(name)) return 'printer-ready'
  const fileType = classifyRemoteImportFileType(name)
  // Every bare mesh needs slicing, by definition: it carries geometry and no toolpaths.
  if (isMeshLibraryFileKind(fileType)) return 'needs-slicing'
  return 'unknown'
}

export function rankRemoteImportCandidates(candidates: RemoteImportCandidate[]): RemoteImportCandidate[] {
  return [...candidates].sort((left, right) => {
    const priorityDelta = candidatePriority(right) - candidatePriority(left)
    if (priorityDelta !== 0) return priorityDelta
    const confidenceDelta = right.confidence - left.confidence
    if (confidenceDelta !== 0) return confidenceDelta
    return left.name.localeCompare(right.name)
  })
}

export function recommendRemoteImportCandidate(candidates: RemoteImportCandidate[]): RemoteImportCandidate | null {
  return rankRemoteImportCandidates(candidates)[0] ?? null
}

export function canPrintRemoteImportCandidateDirectly(candidate: Pick<RemoteImportCandidate, 'name' | 'printableStatus'>): boolean {
  return candidate.printableStatus === 'printer-ready' && isDirectPrintableFileName(candidate.name)
}

function candidatePriority(candidate: RemoteImportCandidate): number {
  const lower = candidate.name.toLowerCase()
  if (lower.endsWith('.gcode.3mf')) return 600
  if (lower.endsWith('.gcode')) return 500
  if (candidate.fileType === '3mf' && candidate.printableStatus === 'printer-ready') return 450
  if (candidate.fileType === '3mf') return 400
  // Meshes rank below any 3MF (which may already be sliced) and above an archive (which may hold
  // anything). STL keeps its own rung above the rest only because it is the one every tool writes.
  if (candidate.fileType === 'stl') return 300
  if (isMeshLibraryFileKind(candidate.fileType)) return 250
  if (candidate.fileType === 'archive') return 100
  return 0
}

function describeRemoteImportCandidate(
  name: string,
  fileType: RemoteImportFileType,
  printableStatus: RemoteImportPrintableStatus
): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.gcode.3mf')) return 'Bambu sliced 3MF can be sent directly to a printer.'
  if (lower.endsWith('.gcode')) return 'G-code can be sent directly to a printer.'
  if (fileType === '3mf' && printableStatus === 'printer-ready') return 'Verified printer-ready 3MF can be sent directly to a printer.'
  if (fileType === '3mf') return '3MF imports to the library; direct printing requires verification that it contains sliced G-code.'
  if (fileType === 'stl') return 'Mesh files import to the library and require slicing before printing.'
  // Named per format rather than "Mesh files", because the reason a user is reading this line is to
  // decide whether the candidate is the one they want, and the format is the distinguishing fact.
  if (isMeshLibraryFileKind(fileType)) {
    return `${IMPORT_FORMAT_LABELS[fileType]} files import to the library and require slicing before printing.`
  }
  if (fileType === 'archive') return 'Archive files are fallback imports and may need manual extraction or slicing.'
  return 'Unsupported file type.'
}

function stableCandidateId(sourceUrl: string, name: string): string {
  return `${name}:${sourceUrl}`
}

export function detectRemoteImportProvider(url: URL): RemoteImportProvider {
  const host = url.hostname.toLowerCase()
  if (host === 'makerworld.com' || host.endsWith('.makerworld.com')) return 'makerworld'
  if (host === 'printables.com' || host.endsWith('.printables.com')) return 'printables'
  return 'generic'
}

function extractFileNameFromUrl(url: URL): string | null {
  const rawPath = url.pathname.split('/').filter(Boolean).at(-1)
  if (!rawPath) return null
  const decoded = safeDecodeURIComponent(rawPath)
  const sanitized = decoded.replace(/\\/g, '/').split('/').at(-1)?.trim() ?? ''
  return sanitized || null
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isMakerWorldModelPage(url: URL): boolean {
  return /\/(?:[a-z]{2}\/)?models?\//i.test(url.pathname)
}

/**
 * The ids a MakerWorld model page URL names, or null when it names none.
 *
 * `designId` is the model; `instanceId` is the specific print profile under it. A
 * shared MakerWorld link often carries the profile in its FRAGMENT
 * (`…/models/578636-slug#profileId-499360`). Fragments never reach a server on their
 * own, so this parse has to happen wherever the user's full pasted string is still
 * intact and the id forwarded explicitly: the browser, or a request body that
 * carried the whole URL.
 *
 * A null `instanceId` is normal, not a failure: the model's own `defaultInstanceId`
 * is the answer then, and only MakerWorld can supply it.
 */
export interface MakerWorldModelRef {
  designId: number
  instanceId: number | null
}

export function parseMakerWorldModelUrl(rawUrl: string): MakerWorldModelRef | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return null
  }
  if (detectRemoteImportProvider(parsed) !== 'makerworld') return null

  // `/models/<id>-<slug>` and `/models/<id>`, with the optional two-letter locale prefix.
  const designMatch = /^\/(?:[a-z]{2}\/)?models?\/(\d+)/i.exec(parsed.pathname)
  const designId = designMatch?.[1] ? Number.parseInt(designMatch[1], 10) : null
  if (designId == null || !Number.isSafeInteger(designId) || designId <= 0) return null

  const instanceMatch = /profileId-(\d+)/i.exec(parsed.hash)
  const parsedInstance = instanceMatch?.[1] ? Number.parseInt(instanceMatch[1], 10) : null
  const instanceId = parsedInstance != null && Number.isSafeInteger(parsedInstance) && parsedInstance > 0
    ? parsedInstance
    : null

  return { designId, instanceId }
}

// Both providers serve the same page under an optional two-letter locale prefix
// (`/de/model/123`), so the prefix is part of the match, not a separate case.
function isPrintablesModelPage(url: URL): boolean {
  return /^\/(?:[a-z]{2}\/)?model\/\d+/i.test(url.pathname)
}
