/**
 * Library file media responses shared by current and archived routes.
 *
 * Owns bridge/local byte resolution, conditional response validators, and large-model streaming.
 * Cache variants are part of the response contract: changing a parser or fixing a truncated body
 * must invalidate old browser entries rather than revalidating them into another 304.
 */
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { Request, Response } from 'express'
import {
  printerModelSchema,
  isMeshLibraryFileKind,
  type LibraryThreeMfScene as LibraryThreeMfSceneDto,
  type ThreeMfIndex as LibraryThreeMfIndexDto
} from '@printstream/shared'
import { THREE_MF_INDEX_PARSER_VERSION, toThreeMfIndexDto } from '@printstream/shared/three-mf'
import {
  inspectBridgeLibraryThreeMf,
  refreshBridgeLibraryThreeMf,
  readBridgeLibraryThumbnail,
  resolveLibraryFileToLocalPath
} from '../lib/bridge-library-files.js'
import { parseDerivedChips } from '../lib/library-derived-chips.js'
import { readMeshThumbnailCache } from '../lib/mesh-thumbnail-cache.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { readEntry, readPlateIndex, readSceneManifest, type ThreeMfIndex as ParsedThreeMfIndex } from '../lib/three-mf.js'
import { parsePlateIndexQuery, requestAbortSignal, sendModelBuffer } from '../lib/request-helpers.js'

/**
 * Local path for a library file's bytes, pulling a bridge-owned file into the local cache first.
 *
 * Logs before rethrowing because every caller converts the failure to a bare `404 File missing on
 * disk`, which erases the only server-side trace of WHY a file the database knows about could not
 * be served, for a bridge-owned file that is a transfer failure (bridge offline, RPC error, disk
 * full), and the 404 alone sends you looking at the file instead of the transport. `storedPath` is
 * a filename the user already sees; nothing secret goes to the log.
 */
export async function resolveLibraryFilePath(row: {
  ownerBridgeId?: string | null
  storedPath: string
}): Promise<string> {
  try {
    return await resolveLibraryFileToLocalPath(row)
  } catch (error) {
    console.warn(`[library] could not resolve bytes for ${row.storedPath}: ${(error as Error).message}`)
    throw error
  }
}

export async function readLibraryThreeMfIndex(
  row: {
    ownerBridgeId?: string | null
    storedPath: string
  },
  signal?: AbortSignal
): Promise<ParsedThreeMfIndex> {
  if (row.ownerBridgeId) {
    return await inspectBridgeLibraryThreeMf(row, signal)
  }
  const onDisk = await resolveLibraryFilePath(row)
  return await readPlateIndex(onDisk, signal)
}

/**
 * Refuse to serve an archive larger than the browser could open anyway. Mirrors
 * `MAX_CLIENT_THREE_MF_BYTES` in the web app's `threeMfArchive.ts`: past this the tab runs out of
 * heap and dies with no recoverable error, so failing here with a message is strictly better than
 * buffering it server-side first.
 */
const MAX_ARCHIVE_RESPONSE_BYTES = 256 * 1024 * 1024

/**
 * ETag variant for the archive. Bump it whenever a bug could have left TRUNCATED bodies in browser
 * caches: the ETag is keyed on the file's bytes, so an unchanged file keeps its old ETag, the
 * server answers 304, and the browser happily re-serves the broken copy forever. Fixing the server
 * is not enough on its own; the tag has to change to orphan those entries.
 *
 * Note the tag is derived from METADATA (see {@link buildLibraryFileEtag}), never from the bytes
 * actually sent, so a body that went out wrong still carries a perfectly valid-looking tag. That
 * is why this constant exists at all, and why each incident needs its own bump.
 *
 * v2: the first cut served the archive with a bare `createReadStream().pipe()`, whose body never
 * completes when read through `fetch()` behind the Vite dev proxy. Chrome cached the empty result
 * and kept revalidating into it, so affected projects failed to open ("could not be opened as a
 * 3MF archive") even after the route was fixed.
 *
 * v3: a concurrent fill of the API's local copy of a bridge-owned file could hand this route a
 * partially-written file (fixed in `bridge-library-files.ts` by filling a temp file and renaming
 * it into place). The short body that produced went out as a 200, was stored, and every later open
 * revalidated into it, one project stayed unopenable in one browser while the same bytes opened
 * everywhere else. `sendModelBuffer` now declares a `Content-Length`, so a short body can no longer
 * be stored as a complete one; this bump clears the entries written before it did.
 */
const ARCHIVE_ETAG_VARIANT = 'archive-v3'

/**
 * Serve a library file's whole 3MF to a client that will parse it in the browser: the editor's
 * read path (`createArchiveProjectSource` in the web app's model-studio plugin).
 *
 * Deliberately separate from {@link sendLibraryFileDownload}, and deliberately gated on
 * `library.view` rather than `library.download`, because this is not a download: it serves the same
 * bytes the `/scene`, `/scene-entry`, and `/plates` routes already expose piecewise, to the same
 * audience, so that one parser produces the scene instead of two. It carries no
 * `Content-Disposition`, is not audited as a download, and is conditional: reopening an unchanged
 * project revalidates to 304 rather than re-sending the archive.
 *
 * Consequence worth naming: a viewer's tab now holds the complete file, so `library.download`
 * governs the download AFFORDANCES (the editor's export/save-to-disk items) and is no longer a hard
 * boundary on the bytes of an openable 3MF. That was a deliberate call when this route was added.
 */
export async function sendLibraryFileArchive(
  request: Request,
  response: Response,
  row: { ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date }
): Promise<void> {
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, ARCHIVE_ETAG_VARIANT)) return
  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  const stats = await stat(onDisk).catch(() => null)
  if (stats && stats.size > MAX_ARCHIVE_RESPONSE_BYTES) {
    throw badRequest('This project is too large to open in the editor.')
  }

  // Through `sendModelBuffer`, NOT a bare `createReadStream().pipe()`. A raw pipe is what
  // `/download` does, and it works there because a download is consumed by the browser writing to
  // disk, but read back through `fetch().arrayBuffer()` (which is how the editor consumes this)
  // the body never completes behind the Vite dev proxy: headers and most of the body arrive, then
  // the tail never does. Verified directly: curl fetched the same URL in 37ms while the browser
  // hung indefinitely, and the same file served through this helper is fine.
  // A 3MF is already a ZIP. Gzipping it again delays the first byte while saving little, and the
  // browser must allocate and decompress an extra representation before it can open the archive.
  await sendModelBuffer(request, response, await readFile(onDisk), 'model/3mf', { compress: false })
}

export async function sendLibraryFileDownload(
  response: Response,
  row: { name: string; ownerBridgeId?: string | null; storedPath: string }
): Promise<void> {
  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }
  response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.name)}"`)
  createReadStream(onDisk).pipe(response)
}

export function sendNotModifiedIfLibraryFileFresh(
  request: Request,
  response: Response,
  row: { ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date },
  variant: string
): boolean {
  const etag = buildLibraryFileEtag(row, variant)
  response.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate, s-maxage=0')
  response.setHeader('ETag', etag)
  response.vary('Cookie')
  response.vary('X-PrintStream-Workspace')
  if (!requestFreshnessMatches(request, etag)) return false
  response.status(304).end()
  return true
}

/**
 * Scene ETag version. The library-file ETag is keyed on the file's bytes, so when the scene parser
 * starts emitting new fields (e.g. exclude-zone labels, prime tower) the ETag for an unchanged file
 * would otherwise stay the same and clients would keep a stale cached `/scene` body via 304.
 *
 * DERIVED from `THREE_MF_INDEX_PARSER_VERSION` rather than hand-bumped, because it was hand-bumped
 * and then forgotten: the parser gained per-part `textInfo` at v34 and this string sat at `scene-v9`
 * (last moved in `1116d157`, for unrelated work), so a browser holding a pre-v34 body kept being
 * handed a 304 and never saw the field the server had started producing. The scene cache on the
 * READ side is already keyed on that constant, so tying the ETag to it makes both ends of the same
 * pipe move together. The `scene-v` prefix stays so a value is still recognisable in a log.
 */
const SCENE_ETAG_VERSION = `scene-v${THREE_MF_INDEX_PARSER_VERSION}`

function buildLibraryFileEtag(
  row: { ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date },
  variant: string
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      row.ownerBridgeId ?? '',
      row.storedPath,
      row.sizeBytes,
      row.uploadedAt.toISOString(),
      variant
    ]))
    .digest('base64url')
  return `"${digest}"`
}

function requestFreshnessMatches(request: Request, etag: string): boolean {
  const header = request.headers['if-none-match']
  if (header == null) return false
  const values = Array.isArray(header) ? header : header.split(',')
  return values.some((value) => value.trim() === '*' || value.trim() === etag)
}

export async function sendLibraryFilePlates(
  request: Request,
  response: Response,
  row: {
    kind: string
    ownerBridgeId?: string | null
    storedPath: string
    sizeBytes: number
    uploadedAt: Date
    derivedChipsJson?: string | null
    derivedChipsVersion?: number | null
  }
): Promise<void> {
  // Include the response contract in the validator. Older builds cached inspection failures as
  // empty 200 responses under the bare `plates` key; changing the key prevents a browser from
  // revalidating and reusing that unsafe response after this strict inspection fix ships.
  if (sendNotModifiedIfLibraryFileFresh(
    request,
    response,
    row,
    `plates:complete-index:v${THREE_MF_INDEX_PARSER_VERSION}`
  )) return
  if (row.kind !== '3mf' && row.kind !== 'gcode') {
    response.json({ plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null, processProfileInherits: null } satisfies LibraryThreeMfIndexDto)
    return
  }
  const signal = requestAbortSignal(request, response)
  try {
    let index = await readLibraryThreeMfIndex(row, signal)
    const knownChips = parseDerivedChips(
      row.derivedChipsJson,
      row.derivedChipsVersion,
      row.storedPath
    )
    const indexLooksIncomplete = knownChips && (
      index.plates.length < knownChips.plateCount
      || (knownChips.projectFilamentChips.length > 0 && index.projectFilaments.length === 0)
    )
    if (indexLooksIncomplete && row.ownerBridgeId) {
      index = await refreshBridgeLibraryThreeMf(row, signal)
    }
    if (knownChips && (
      index.plates.length < knownChips.plateCount
      || (knownChips.projectFilamentChips.length > 0 && index.projectFilaments.length === 0)
    )) {
      throw new Error('3MF inspection returned less metadata than the current library index')
    }
    // Shared with the browser's local-file path, so a plate cannot read as thumbnail-less on one
    // surface and not the other.
    response.json(toThreeMfIndexDto(index) satisfies LibraryThreeMfIndexDto)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    console.warn(`[library] could not inspect plates for ${row.storedPath}: ${(error as Error).message}`)
    // An empty success is unsafe here: print dialogs interpret it as a genuinely material-free
    // file and omit mapping controls. Let the request fail so query retry/error handling can keep
    // the user from dispatching without the archive's real plate and filament metadata.
    throw error
  }
}

export async function sendLibraryFileThumbnail(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date }
): Promise<void> {
  // STL/STEP have no embedded image. The web client renders one with Three.js and
  // uploads it via PUT /:id/thumbnail; here we serve that persisted render. A miss
  // (nothing rendered yet) returns 404 so the client falls back to a live render.
  if (isMeshLibraryFileKind(row.kind)) {
    if (sendNotModifiedIfLibraryFileFresh(request, response, row, 'mesh-thumbnail')) return
    const cached = await readMeshThumbnailCache(row)
    if (!cached) throw notFound('Thumbnail not rendered yet')
    response.setHeader('Content-Type', 'image/png')
    response.send(cached)
    return
  }
  if (row.kind !== '3mf' && row.kind !== 'gcode') throw notFound('No thumbnail available')
  const signal = requestAbortSignal(request, response)
  const plateIndex = parsePlateIndexQuery(request.query.plate)
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `thumbnail:${plateIndex}`)) return
  // Geometry-only 3MFs have no embedded plate PNGs; like STL/STEP they get a
  // client-rendered mesh thumbnail persisted via PUT /:id/thumbnail. Serve that cache
  // when present (content-addressed on the per-version storedPath, so a version swap
  // can never show a stale render) and fall through to the embedded lookups, which
  // 404 for such files, telling the client to render (and upload) one.
  if (row.kind === '3mf') {
    const meshRender = await readMeshThumbnailCache(row)
    if (meshRender) {
      response.setHeader('Content-Type', 'image/png')
      response.send(meshRender)
      return
    }
  }
  if (row.ownerBridgeId) {
    const buffer = await readBridgeLibraryThumbnail(row, plateIndex, signal)
    if (!buffer) throw notFound('Thumbnail missing')
    response.setHeader('Content-Type', 'image/png')
    response.send(buffer)
    return
  }

  let entryPath: string | null = null
  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }
  try {
    const index = await readPlateIndex(onDisk, signal)
    const plate = index.plates.find((entry) => entry.index === plateIndex) ?? index.plates[0]
    entryPath = plate?.thumbnailFile ?? `Metadata/plate_${plateIndex}.png`
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    entryPath = `Metadata/plate_${plateIndex}.png`
  }
  try {
    const buffer = await readEntry(onDisk, entryPath, signal)
    response.setHeader('Content-Type', 'image/png')
    response.send(buffer)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound('Thumbnail missing')
  }
}

export async function sendLibraryFileScene(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date }
): Promise<void> {
  // gcode.3mf still embeds the model (3D/3dmodel.model), so it has a plated mesh scene
  // too: used for the client-rendered thumbnail fallback when no plate PNG is embedded.
  if (row.kind !== '3mf' && row.kind !== 'gcode') throw notFound('No plated 3D scene available')
  const plateIndex = parsePlateIndexQuery(request.query.plate)
  // Optional target-printer override: show the selected printer's bed + unprintable
  // zones rather than the file's embedded machine. Part of the ETag so switching
  // printers in the slice dialog re-fetches a fresh bed.
  const overrideModel = printerModelSchema.safeParse(request.query.printerModel).data ?? null
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `${SCENE_ETAG_VERSION}:${plateIndex}:${overrideModel ?? ''}`)) return

  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  const signal = requestAbortSignal(request, response)
  try {
    const scene = await readSceneManifest(onDisk, plateIndex, signal, overrideModel)
    response.json(scene satisfies LibraryThreeMfSceneDto)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound(error instanceof Error && error.message ? error.message : 'No plated 3D scene available')
  }
}

export async function sendLibraryFilePlateGcode(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string; sizeBytes: number; uploadedAt: Date }
): Promise<void> {
  if (row.kind !== '3mf' && row.kind !== 'gcode') throw notFound('No plate preview available')
  const signal = requestAbortSignal(request, response)
  const plateIndex = parsePlateIndexQuery(request.query.plate)
  if (sendNotModifiedIfLibraryFileFresh(request, response, row, `plate-gcode:${plateIndex}`)) return

  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  let entryPath: string | null = null
  try {
    const index = await readPlateIndex(onDisk, signal)
    const plate = index.plates.find((entry) => entry.index === plateIndex) ?? index.plates[0]
    entryPath = plate?.gcodeFile ?? `Metadata/plate_${plateIndex}.gcode`
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    entryPath = `Metadata/plate_${plateIndex}.gcode`
  }

  try {
    const buffer = await readEntry(onDisk, entryPath, signal, 256 * 1024 * 1024)
    // Route through sendModelBuffer (gzip + chunk-stream) like the other large
    // library payloads: gcode compresses ~5-10x and the chunked send avoids the
    // Vite-dev-proxy tail-truncation a bare response.send() of a big body hits.
    await sendModelBuffer(request, response, buffer, 'text/plain; charset=utf-8')
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    throw notFound('Plate G-code missing')
  }
}
