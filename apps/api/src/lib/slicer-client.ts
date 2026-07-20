/**
 * Client for the standalone BambuStudio slicer runtime(s).
 *
 * The API owns tenant checks, queueing, and library persistence. This client
 * only speaks to the external worker container(s) that run the CLI.
 * `SLICER_SERVICE_URL` may list several identical sidecars (comma-separated):
 * slices go to the least-busy instance, progress polls follow the instance
 * that owns the job, and reads (health/profiles/resolve) fail over in order.
 */
import { slicingMetadataSchema, slicingOutputLineSchema, slicingProfileSummarySchema, slicingTargetDescriptorSchema, type CreateSlicingJob, type SliceEnvelope, type SlicingMetadata, type SlicingOutputLine, type SlicingProfileSummary, type SlicingTargetDescriptor } from '@printstream/shared'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { Agent } from 'undici'
import { env } from './env.js'
import type { ResolvedSlicingProfileFile } from './slicing-profiles.js'

/**
 * Dispatcher for the long-running `/slice` POST only. The slicer sends no response headers until the
 * whole CLI slice finishes, so undici's default 300s `headersTimeout` (and `bodyTimeout`) would abort
 * a legitimately long multi-plate/multi-material slice with an opaque `UND_ERR_HEADERS_TIMEOUT` after
 * the CPU was already spent. Disabling both (0) hands the time ceiling entirely to the caller's
 * `AbortSignal` (SLICING_REQUEST_TIMEOUT_MS), which is the intended bound. Scoped to this request so
 * the rest of the API's HTTP egress keeps undici's safety timeouts.
 */
const sliceRequestDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

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
  private readonly baseUrls: string[]
  /** In-flight slice count per instance base URL; drives least-busy assignment. */
  private readonly inflight = new Map<string, number>()
  /** Active slicer job id -> owning instance, so progress polls hit the instance running the job. */
  private readonly jobInstances = new Map<string, string>()

  /**
   * All instances are assumed to run the same slicer image (same targets and
   * builtin profiles): reads (health, profiles, resolve) try instances in
   * order and return the first success, while slices are assigned to the
   * least-busy instance.
   */
  constructor(baseUrls: string | readonly string[] | null = env.SLICER_SERVICE_URLS) {
    const list = baseUrls == null ? [] : typeof baseUrls === 'string' ? [baseUrls] : [...baseUrls]
    this.baseUrls = list.map((url) => url.replace(/\/+$/, '')).filter((url) => url.length > 0)
  }

  isConfigured(): boolean {
    return this.baseUrls.length > 0
  }

  async capabilities(): Promise<SlicerCapabilities> {
    if (this.baseUrls.length === 0) {
      return { configured: false, healthy: false, slicerName: null, defaultTargetId: null, targets: [] }
    }

    for (const baseUrl of this.baseUrls) {
      try {
        const response = await fetch(`${baseUrl}/health`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
        })
        if (!response.ok) {
          console.warn('[slicer] capabilities failed', `slicer service at ${baseUrl} returned ${response.status}`)
          continue
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
        console.warn('[slicer] capabilities failed', `${baseUrl}: ${(error as Error).message}`)
      }
    }
    return { configured: true, healthy: false, slicerName: null, defaultTargetId: null, targets: [] }
  }

  async profiles(targetId?: string | null): Promise<SlicingProfileSummary[]> {
    for (const baseUrl of this.baseUrls) {
      try {
        const params = new URLSearchParams()
        if (targetId?.trim()) params.set('targetId', targetId.trim())
        const response = await fetch(`${baseUrl}/profiles${params.size > 0 ? `?${params.toString()}` : ''}`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
        })
        if (!response.ok) {
          console.warn('[slicer] profiles failed', `slicer service at ${baseUrl} returned ${response.status}`)
          continue
        }
        const body = await response.json().catch(() => null) as { profiles?: unknown } | null
        return parseProfiles(body?.profiles)
      } catch (error) {
        console.warn('[slicer] profiles failed', `${baseUrl}: ${(error as Error).message}`)
      }
    }
    return []
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
    return this.resolveProfileConfig('process', targetId, profile)
  }

  /**
   * Resolves a FILAMENT profile to its fully-merged config map (same resolution as
   * {@link resolveProcessConfig}, `kind: 'filament'`). Backs the material settings dialog's base
   * values. Returns null when the slicer is unavailable or the profile cannot be resolved.
   */
  async resolveFilamentConfig(
    targetId: string | null | undefined,
    profile: { source: 'builtin' | 'custom'; name: string; content?: string }
  ): Promise<Record<string, string | string[]> | null> {
    return this.resolveProfileConfig('filament', targetId, profile)
  }

  /**
   * Shared resolver behind {@link resolveProcessConfig} / {@link resolveFilamentConfig}: POSTs to the
   * slicer's `/profiles/resolve` (which follows the `inherits` chain for a builtin preset or merges a
   * custom diff onto its system base) and normalizes the returned config.
   */
  private async resolveProfileConfig(
    kind: 'machine' | 'process' | 'filament',
    targetId: string | null | undefined,
    profile: { source: 'builtin' | 'custom'; name: string; content?: string }
  ): Promise<Record<string, string | string[]> | null> {
    for (const baseUrl of this.baseUrls) {
      try {
        const params = new URLSearchParams()
        if (targetId?.trim()) params.set('targetId', targetId.trim())
        const response = await fetch(`${baseUrl}/profiles/resolve${params.size > 0 ? `?${params.toString()}` : ''}`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ source: profile.source, kind, name: profile.name, content: profile.content }),
          signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
        })
        if (!response.ok) {
          console.warn(`[slicer] resolve ${kind} config failed`, `slicer service at ${baseUrl} returned ${response.status}`)
          continue
        }
        const body = await response.json().catch(() => null) as { config?: unknown } | null
        if (!body || typeof body.config !== 'object' || body.config == null) return null
        return normalizeResolvedConfig(body.config as Record<string, unknown>)
      } catch (error) {
        console.warn(`[slicer] resolve ${kind} config failed`, `${baseUrl}: ${(error as Error).message}`)
      }
    }
    return null
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
    for (const baseUrl of this.baseUrls) {
      try {
        const params = new URLSearchParams()
        if (targetId?.trim()) params.set('targetId', targetId.trim())
        const response = await fetch(`${baseUrl}/profiles/resolve${params.size > 0 ? `?${params.toString()}` : ''}`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify({ source: profile.source, kind: 'machine', name: profile.name, content: profile.content }),
          // The merged machine profile is small; the short-request cap is fine.
          signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
        })
        if (!response.ok) {
          console.warn('[slicer] resolveMachineConfig failed', `slicer service at ${baseUrl} returned ${response.status}`)
          continue
        }
        const body = await response.json().catch(() => null) as { config?: unknown } | null
        if (!body || typeof body.config !== 'object' || body.config == null) return null
        return normalizeResolvedConfig(body.config as Record<string, unknown>)
      } catch (error) {
        console.warn('[slicer] resolveMachineConfig failed', `${baseUrl}: ${(error as Error).message}`)
      }
    }
    return null
  }

  /**
   * The 3D build-plate mesh (binary STL) for a printer model, from the slicer's bundled
   * BambuStudio resources, or null when this target has none. Decoration for the editor's bed
   * view, so a miss is normal and logged at debug volume only — the client falls back to the
   * plain millimetre grid. See apps/slicer/src/bed-model.ts.
   */
  async bedModel(targetId: string | null | undefined, printerModel: string): Promise<Buffer | null> {
    for (const baseUrl of this.baseUrls) {
      try {
        const params = new URLSearchParams()
        if (targetId?.trim()) params.set('targetId', targetId.trim())
        params.set('printerModel', printerModel)
        const response = await fetch(`${baseUrl}/bed-model?${params.toString()}`, {
          headers: this.headers(),
          // Tens of kilobytes at most; the short-request cap is plenty.
          signal: AbortSignal.timeout(Math.min(env.SLICING_REQUEST_TIMEOUT_MS, 10_000))
        })
        // 404 = this target ships no bed for that model. Expected, not a failure to report.
        if (response.status === 404) return null
        if (!response.ok) {
          console.warn('[slicer] bedModel failed', `slicer service at ${baseUrl} returned ${response.status}`)
          continue
        }
        return Buffer.from(await response.arrayBuffer())
      } catch (error) {
        console.warn('[slicer] bedModel failed', `${baseUrl}: ${(error as Error).message}`)
      }
    }
    return null
  }

  async run(input: SlicerRunInput): Promise<SlicerRunResult> {
    const baseUrl = this.claimInstance(input.jobId)
    try {
      return await this.runOnInstance(baseUrl, input)
    } finally {
      this.releaseInstance(input.jobId, baseUrl)
    }
  }

  private async runOnInstance(baseUrl: string, input: SlicerRunInput): Promise<SlicerRunResult> {
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
      url: `${baseUrl}/slice`,
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
    // Progress must be read from the instance running the job; before the job
    // is claimed (or after it finishes) there is nothing to poll.
    const baseUrl = this.jobInstances.get(jobId)
    if (!baseUrl) return null
    try {
      const response = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}`, {
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

  /**
   * Assigns a slice to the least-busy instance (first configured wins ties)
   * and records the job -> instance binding for progress routing. The caller
   * must pair this with {@link releaseInstance} (run() does, in a finally).
   */
  private claimInstance(jobId: string): string {
    if (this.baseUrls.length === 0) throw new Error('Slicer service is not configured')
    let chosen = this.baseUrls[0]!
    let chosenInflight = this.inflight.get(chosen) ?? 0
    for (const baseUrl of this.baseUrls) {
      const count = this.inflight.get(baseUrl) ?? 0
      if (count < chosenInflight) {
        chosen = baseUrl
        chosenInflight = count
      }
    }
    this.inflight.set(chosen, chosenInflight + 1)
    this.jobInstances.set(jobId, chosen)
    return chosen
  }

  private releaseInstance(jobId: string, baseUrl: string): void {
    const count = this.inflight.get(baseUrl) ?? 0
    this.inflight.set(baseUrl, Math.max(0, count - 1))
    this.jobInstances.delete(jobId)
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
    const requestInit: RequestInit & { duplex: 'half'; dispatcher: Agent } = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(input.sourceSize),
        'X-PrintStream-Slice-Request': input.envelope,
        ...this.headers()
      },
      body: requestBody,
      duplex: 'half',
      // Disable undici's header/body timeouts for the slice; the AbortSignal above is the real ceiling.
      dispatcher: sliceRequestDispatcher,
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

/**
 * Parse the slicer's `/profiles` response through the SHARED summary schema.
 *
 * Deliberately not a hand-written field list: this used to rebuild each summary
 * field by field, so every field added to `slicingProfileSummarySchema` was
 * silently dropped here on its way to the browser — `filamentIsSupport` and
 * `layerHeight` both arrived at the API and never reached the slice dialog
 * (issue #66). Validating against the schema keeps this hop honest as the
 * contract grows.
 *
 * Non-conforming entries are skipped rather than failing the whole catalogue: a
 * single malformed preset must not blank the slice dialog.
 */
function parseProfiles(value: unknown): SlicingProfileSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const parsed = slicingProfileSummarySchema.safeParse(entry)
    // Builtin presets are the only kind the slicer owns; a `custom` preset coming
    // back from it would shadow the tenant's own stored presets.
    if (!parsed.success || parsed.data.source !== 'builtin') return []
    return [parsed.data]
  })
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

/**
 * Parse the worker's slice output lines through the SHARED schema, for the same
 * reason as {@link parseProfiles} — a hand-listed field set silently drops
 * anything the contract grows (issue #66).
 *
 * `createdAt` is stamped here when the worker omitted it rather than rejecting
 * the line: these lines are the only diagnostic trail a failed slice leaves, so
 * losing one to a missing timestamp costs more than the timestamp is worth.
 */
function parseOutputLines(value: unknown): SlicingOutputLine[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry == null) return []
    const record = entry as Record<string, unknown>
    const candidate = typeof record.createdAt === 'string'
      ? record
      : { ...record, createdAt: new Date().toISOString() }
    const parsed = slicingOutputLineSchema.safeParse(candidate)
    return parsed.success ? [parsed.data] : []
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
