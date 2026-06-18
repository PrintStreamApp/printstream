/**
 * Client for the standalone BambuStudio slicer runtime.
 *
 * The API owns tenant checks, queueing, and library persistence. This
 * client only speaks to the external worker container that runs the CLI.
 */
import { slicingMetadataSchema, slicingTargetDescriptorSchema, type CreateSlicingJob, type SliceEnvelope, type SlicingMetadata, type SlicingOutputLine, type SlicingProfileSummary, type SlicingTargetDescriptor } from '@printstream/shared'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { env } from './env.js'
import type { ResolvedSlicingProfileFile } from './slicing-profiles.js'

export interface SlicerCapabilities {
  configured: boolean
  healthy: boolean
  slicerName: string | null
  defaultTargetId: string | null
  targets: SlicingTargetDescriptor[]
}

export interface SlicerRunInput {
  jobId: string
  sourceFileName: string
  sourcePath: string
  request: CreateSlicingJob
  profileFiles?: ResolvedSlicingProfileFile[]
  signal: AbortSignal
}

export interface SlicerRunResult {
  outputFileName: string | null
  output: SlicingOutputLine[]
  metadata: SlicingMetadata
  artifactPath: string
}

export class SlicerServiceError extends Error {
  readonly output: SlicingOutputLine[]

  constructor(message: string, output: SlicingOutputLine[]) {
    super(message)
    this.name = 'SlicerServiceError'
    this.output = output
  }
}

export class SlicerClient {
  constructor(
    private readonly baseUrl = env.SLICER_SERVICE_URL?.replace(/\/+$/, '') ?? null
  ) {}

  isConfigured(): boolean {
    return this.baseUrl != null
  }

  async capabilities(): Promise<SlicerCapabilities> {
    if (!this.baseUrl) {
      return { configured: false, healthy: false, slicerName: null, defaultTargetId: null, targets: [] }
    }

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
      })
      if (!response.ok) {
        console.warn('[slicer] capabilities failed', `slicer service returned ${response.status}`)
        return { configured: true, healthy: false, slicerName: null, defaultTargetId: null, targets: [] }
      }
      const body = await response.json().catch(() => ({})) as { name?: unknown; defaultTargetId?: unknown; targets?: unknown }
      const targets = parseSlicerTargets(body.targets)
      const defaultTargetId = typeof body.defaultTargetId === 'string' && body.defaultTargetId.trim() ? body.defaultTargetId.trim() : null
      const defaultTarget = defaultTargetId ? targets.find((target) => target.id === defaultTargetId) ?? null : targets[0] ?? null
      return {
        configured: true,
        healthy: true,
        slicerName: defaultTarget?.label ?? (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'PrintStream slicer'),
        defaultTargetId,
        targets
      }
    } catch (error) {
      console.warn('[slicer] capabilities failed', (error as Error).message)
      return { configured: true, healthy: false, slicerName: null, defaultTargetId: null, targets: [] }
    }
  }

  async profiles(targetId?: string | null): Promise<SlicingProfileSummary[]> {
    if (!this.baseUrl) return []
    try {
      const params = new URLSearchParams()
      if (targetId?.trim()) params.set('targetId', targetId.trim())
      const response = await fetch(`${this.baseUrl}/profiles${params.size > 0 ? `?${params.toString()}` : ''}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
      })
      if (!response.ok) {
        console.warn('[slicer] profiles failed', `slicer service returned ${response.status}`)
        return []
      }
      const body = await response.json().catch(() => null) as { profiles?: unknown } | null
      return parseProfiles(body?.profiles)
    } catch (error) {
      console.warn('[slicer] profiles failed', (error as Error).message)
      return []
    }
  }

  /**
   * Resolves a process profile to its fully-merged config map (inherits chain
   * resolved for builtin; custom diff merged onto its base). Returns null when
   * the slicer is unavailable or the profile cannot be resolved.
   */
  async resolveProcessConfig(
    targetId: string | null | undefined,
    profile: { source: 'builtin' | 'custom'; name: string; content?: string }
  ): Promise<Record<string, string | string[]> | null> {
    if (!this.baseUrl) return null
    try {
      const params = new URLSearchParams()
      if (targetId?.trim()) params.set('targetId', targetId.trim())
      const response = await fetch(`${this.baseUrl}/profiles/resolve${params.size > 0 ? `?${params.toString()}` : ''}`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ source: profile.source, name: profile.name, content: profile.content }),
        signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
      })
      if (!response.ok) {
        console.warn('[slicer] resolveProcessConfig failed', `slicer service returned ${response.status}`)
        return null
      }
      const body = await response.json().catch(() => null) as { config?: unknown } | null
      if (!body || typeof body.config !== 'object' || body.config == null) return null
      return normalizeResolvedConfig(body.config as Record<string, unknown>)
    } catch (error) {
      console.warn('[slicer] resolveProcessConfig failed', (error as Error).message)
      return null
    }
  }

  /**
   * Resolves a machine profile to its fully-merged config map (the `inherits`/`include`
   * chain resolved). Used to retarget a project's machine on save without slicing. Returns
   * null when the slicer is unavailable or the machine preset cannot be resolved.
   */
  async resolveMachineConfig(
    targetId: string | null | undefined,
    profile: { source: 'builtin' | 'custom'; name: string; content?: string }
  ): Promise<Record<string, string | string[]> | null> {
    if (!this.baseUrl) return null
    try {
      const params = new URLSearchParams()
      if (targetId?.trim()) params.set('targetId', targetId.trim())
      const response = await fetch(`${this.baseUrl}/profiles/resolve${params.size > 0 ? `?${params.toString()}` : ''}`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ source: profile.source, kind: 'machine', name: profile.name, content: profile.content }),
        // The merged machine profile is small; the short-request cap is fine.
        signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
      })
      if (!response.ok) {
        console.warn('[slicer] resolveMachineConfig failed', `slicer service returned ${response.status}`)
        return null
      }
      const body = await response.json().catch(() => null) as { config?: unknown } | null
      if (!body || typeof body.config !== 'object' || body.config == null) return null
      return normalizeResolvedConfig(body.config as Record<string, unknown>)
    } catch (error) {
      console.warn('[slicer] resolveMachineConfig failed', (error as Error).message)
      return null
    }
  }

  async run(input: SlicerRunInput): Promise<SlicerRunResult> {    if (!this.baseUrl) throw new Error('Slicer service is not configured')
    // The slice request travels to the slicer as a base64 HTTP header, so it must stay small.
    // The editor's per-plate thumbnails (base64 PNGs) are only needed by the API (it bakes them
    // into the sliced output after the slice) — the slicer already receives the arranged 3MF, so
    // strip them from the envelope to avoid blowing the header size limit (HTTP 431).
    const slicerRequest = input.request.sceneEdit?.plateThumbnails
      ? { ...input.request, sceneEdit: { ...input.request.sceneEdit, plateThumbnails: undefined } }
      : input.request
    // Typed against the shared SliceEnvelope so the producer (here) and the slicer's
    // validator (`sliceEnvelopeSchema`) cannot drift.
    const sliceEnvelope: SliceEnvelope = {
      jobId: input.jobId,
      sourceFileName: input.sourceFileName,
      request: slicerRequest,
      profileFiles: input.profileFiles ?? []
    }
    const envelope = Buffer.from(JSON.stringify(sliceEnvelope), 'utf8').toString('base64url')
    const sourceInfo = await stat(input.sourcePath)
    if (!sourceInfo.isFile() || sourceInfo.size <= 0) throw new Error('Slicing source file is missing or empty')

    const artifactDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-'))
    const downloadPath = path.join(artifactDir, 'download.bin')
    const response = await this.runSliceRequest({
      url: `${this.baseUrl}/slice`,
      sourcePath: input.sourcePath,
      sourceSize: sourceInfo.size,
      envelope,
      outputPath: downloadPath,
      signal: input.signal
    }).catch(async (error) => {
      await rm(downloadPath, { force: true }).catch(() => undefined)
      await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    })

    const outputFileName = decodeHeaderValue(response.headers.get('x-printstream-output-file-name'))
    const output = parseOutputLinesHeader(response.headers.get('x-printstream-output-lines'))
    const metadata = parseMetadataHeader(response.headers.get('x-printstream-metadata'))
    const contentLength = parseContentLength(response.headers.get('content-length'))
    if (contentLength != null && contentLength > env.SLICING_MAX_ARTIFACT_BYTES) {
      await rm(downloadPath, { force: true }).catch(() => undefined)
      await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('Sliced artifact exceeds configured size limit')
    }

    const downloadInfo = await stat(downloadPath)
    if (!downloadInfo.isFile() || downloadInfo.size <= 0) {
      await rm(downloadPath, { force: true }).catch(() => undefined)
      await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('Slicer service returned an empty artifact')
    }
    if (downloadInfo.size > env.SLICING_MAX_ARTIFACT_BYTES) {
      await rm(downloadPath, { force: true }).catch(() => undefined)
      await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error('Sliced artifact exceeds configured size limit')
    }

    const artifactPath = path.join(artifactDir, outputFileName || `${input.jobId}.gcode.3mf`)
    if (artifactPath !== downloadPath) {
      await rename(downloadPath, artifactPath)
    }
    return {
      outputFileName,
      output,
      metadata,
      artifactPath
    }
  }

  async progress(jobId: string): Promise<SlicingOutputLine[] | null> {
    if (!this.baseUrl) return null
    try {
      const response = await fetch(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
      })
      if (response.status === 404) return null
      if (!response.ok) {
        console.warn('[slicer] progress failed', `slicer service returned ${response.status}`)
        return null
      }
      const body = await response.json().catch(() => null) as { output?: unknown } | null
      return parseOutputLines(body?.output)
    } catch (error) {
      console.warn('[slicer] progress failed', (error as Error).message)
      return null
    }
  }

  private headers(): Record<string, string> {
    return env.SLICER_SERVICE_TOKEN ? { Authorization: `Bearer ${env.SLICER_SERVICE_TOKEN}` } : {}
  }

  private async runSliceRequest(input: {
    url: string
    sourcePath: string
    sourceSize: number
    envelope: string
    outputPath: string
    signal: AbortSignal
  }): Promise<{ headers: Headers }> {
    const requestBody = Readable.toWeb(createReadStream(input.sourcePath)) as unknown as BodyInit
    // Bound the slice (the long call) by SLICING_REQUEST_TIMEOUT_MS combined with the caller's
    // cancel signal — otherwise a slicer that stalls mid-stream leaves the job slicing forever,
    // holding a concurrency slot. The timeout aborts both the fetch and the body pipeline below.
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(env.SLICING_REQUEST_TIMEOUT_MS)])
    const requestInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(input.sourceSize),
        'X-PrintStream-Slice-Request': input.envelope,
        ...this.headers()
      },
      body: requestBody,
      duplex: 'half',
      signal
    }
    const response = await fetch(input.url, requestInit).catch((error: unknown) => {
      throw normalizeSlicerServiceTransportError(error, signal)
    })

    if (!response.ok) {
      const body = await response.arrayBuffer().catch(() => new ArrayBuffer(0))
      const parsed = parseJsonBuffer(Buffer.from(body)) as { error?: unknown; output?: unknown } | null
      const message = typeof parsed?.error === 'string' ? parsed.error : `Slicer service returned ${response.status}`
      throw new SlicerServiceError(
        normalizeSlicerRuntimeErrorMessage(message),
        parseOutputLines(parsed?.output)
      )
    }

    if (!response.body) {
      throw new Error('Slicer service returned an empty response body')
    }

    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      createWriteStream(input.outputPath)
    ).catch((error: unknown) => {
      if (signal.aborted) {
        throw buildAbortError(signal)
      }
      throw normalizeSlicerServiceTransportError(error, signal)
    })

    return { headers: response.headers }
  }
}

function buildAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' && signal.reason ? signal.reason : 'The operation was aborted')
}

function normalizeSlicerServiceTransportError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return buildAbortError(signal)
  if (!(error instanceof Error)) {
    return new Error(String(error))
  }

  const causeCode = getErrorCauseCode(error)
  if (causeCode === 'HPE_HEADER_OVERFLOW') {
    return new Error('Slicer service returned oversized response headers. Reduce slicer output header payload and retry.')
  }
  if (error.name === 'AbortError') {
    return buildAbortError(signal)
  }
  if (error.message.trim().toLowerCase() === 'fetch failed') {
    const suffix = causeCode ? ` (${causeCode})` : ''
    return new Error(`Unable to reach slicer service while transferring slice data${suffix}`)
  }
  return error
}

function getErrorCauseCode(error: Error): string | null {
  const candidate = (error as { cause?: unknown }).cause
  if (!candidate || typeof candidate !== 'object') return null
  const code = (candidate as { code?: unknown }).code
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null
}

function parseJsonBuffer(buffer: Buffer): unknown {
  if (buffer.byteLength <= 0) return null
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    return null
  }
}

function parseContentLength(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function parseSlicerTargets(value: unknown): SlicingTargetDescriptor[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const parsed = slicingTargetDescriptorSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

function parseProfiles(value: unknown): SlicingProfileSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry == null) return []
    const candidate = entry as {
      id?: unknown
      source?: unknown
      kind?: unknown
      name?: unknown
      filamentIds?: unknown
      filamentType?: unknown
      filamentVendor?: unknown
      printerModels?: unknown
      compatiblePrinters?: unknown
      compatiblePrints?: unknown
      nozzleDiameters?: unknown
      plateTypes?: unknown
      compatiblePrintersCondition?: unknown
      compatiblePrintsCondition?: unknown
      defaultProcessProfile?: unknown
      defaultFilamentProfiles?: unknown
      updatedAt?: unknown
    }
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return []
    if (candidate.source !== 'builtin') return []
    if (candidate.kind !== 'machine' && candidate.kind !== 'process' && candidate.kind !== 'filament') return []
    return [{
      id: candidate.id,
      source: candidate.source,
      kind: candidate.kind,
      name: candidate.name,
      filamentIds: parseStringList(candidate.filamentIds),
      filamentType: typeof candidate.filamentType === 'string' && candidate.filamentType.trim() ? candidate.filamentType.trim() : undefined,
      filamentVendor: typeof candidate.filamentVendor === 'string' && candidate.filamentVendor.trim() ? candidate.filamentVendor.trim() : undefined,
      printerModels: parseStringList(candidate.printerModels),
      compatiblePrinters: parseStringList(candidate.compatiblePrinters),
      compatiblePrints: parseStringList(candidate.compatiblePrints),
      nozzleDiameters: parseNumberList(candidate.nozzleDiameters),
      plateTypes: parseStringList(candidate.plateTypes),
      compatiblePrintersCondition: typeof candidate.compatiblePrintersCondition === 'string' ? candidate.compatiblePrintersCondition : undefined,
      compatiblePrintsCondition: typeof candidate.compatiblePrintsCondition === 'string' ? candidate.compatiblePrintsCondition : undefined,
      defaultProcessProfile: typeof candidate.defaultProcessProfile === 'string' && candidate.defaultProcessProfile.trim() ? candidate.defaultProcessProfile.trim() : undefined,
      defaultFilamentProfiles: parseStringList(candidate.defaultFilamentProfiles),
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : null
    }]
  })
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  return list.length > 0 ? list : undefined
}

function parseNumberList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry) && entry > 0)
  return list.length > 0 ? list : undefined
}

function decodeHeaderValue(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseOutputLinesHeader(value: string | null | undefined): SlicingOutputLine[] {
  if (!value) return []
  try {
    return parseOutputLines(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch {
    return []
  }
}

function parseOutputLines(value: unknown): SlicingOutputLine[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry == null) return []
    const candidate = entry as { stream?: unknown; text?: unknown; createdAt?: unknown }
    if (candidate.stream !== 'stdout' && candidate.stream !== 'stderr' && candidate.stream !== 'system') return []
    if (typeof candidate.text !== 'string') return []
    return [{
      stream: candidate.stream,
      text: candidate.text,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString()
    }]
  })
}

function parseMetadataHeader(value: string | null | undefined): SlicingMetadata {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const result = slicingMetadataSchema.safeParse(parsed)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

function normalizeSlicerRuntimeErrorMessage(message: string): string {
  if (!message || !/GLIBCXX_|GLIBC_/i.test(message) || !/version `[^']+' not found/i.test(message)) {
    return message
  }
  const missingVersions = Array.from(new Set(
    message
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/version `([^']+)' not found/i)
        return match?.[1] ? [match[1]] : []
      })
  ))
  const suffix = missingVersions.length > 0 ? ` (${missingVersions.join(', ')})` : ''
  return `The selected slicer binary is incompatible with this host runtime${suffix}. Choose another slicer target or install a build compiled for this OS image.`
}

export const slicerClient = new SlicerClient()

/**
 * Coerces a resolved BambuStudio config record into the serialized-string form
 * the process-settings editor expects (scalars as strings, vectors as string
 * arrays). Nested objects are dropped.
 */
function normalizeResolvedConfig(record: Record<string, unknown>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') result[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = String(value)
    else if (Array.isArray(value)) {
      result[key] = value.map((entry) => typeof entry === 'string' ? entry : String(entry))
    }
  }
  return result
}
