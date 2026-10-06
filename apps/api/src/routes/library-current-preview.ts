/**
 * Current library-file preview, thumbnail upload, and mesh conversion routes.
 *
 * These viewer-scoped routes keep conditional cache checks before expensive bridge reads,
 * support request cancellation while streaming model bytes, and share the parent's bridge/local
 * path resolution. Register after static version and upload routes, before late file-id mutations.
 */
import { readFile } from 'node:fs/promises'
import express, { type Request, type Response, type Router } from 'express'
import { z } from 'zod'
import { isMeshLibraryFileKind, LIBRARY_VIEW_PERMISSION, type MeshLibraryFileKind, type StagedImportFormat, type LibraryThreeMfPreviewAsset as LibraryThreeMfPreviewAssetDto } from '@printstream/shared'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest, conflict, notFound } from '../lib/http-error.js'
import { MESH_THUMBNAIL_MAX_BYTES, isLikelyPng, writeMeshThumbnailCache } from '../lib/mesh-thumbnail-cache.js'
import { meshToBinaryStl, parseImportedMesh } from '../lib/mesh-import.js'
import { prisma } from '../lib/prisma.js'
import { readPlateIndex, readEntry, readPreviewAssets } from '../lib/three-mf.js'
import { extractThreeMfImportMesh } from '../lib/three-mf-mesh-extract.js'
import { requestAbortSignal, requireRouteParam, sendModelBuffer } from '../lib/request-helpers.js'

type PreviewFileRow = {
  id: string
  kind: string
  ownerBridgeId?: string | null
  storedPath: string
  sizeBytes: number
  uploadedAt: Date
}

interface PreviewRouteDependencies {
  resolveLibraryFilePath: (row: { ownerBridgeId?: string | null; storedPath: string }) => Promise<string>
  sendNotModifiedIfLibraryFileFresh: (request: Request, response: Response, row: PreviewFileRow, variant: string) => boolean
}

/** Register current-file preview routes at their existing file-id seam. */
export function registerLibraryCurrentPreviewRoutes(router: Router, dependencies: PreviewRouteDependencies): void {
  const { resolveLibraryFilePath, sendNotModifiedIfLibraryFileFresh } = dependencies
  /** Embedded STL/STEP preview source for a non-G-code 3MF-backed library file. */
  router.get('/:id/preview-asset', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!row) throw notFound('File not found')
    if (sendNotModifiedIfLibraryFileFresh(request, response, row, 'preview-asset')) return
    const asset = await resolveLibraryFilePreviewAsset(request, response, row, resolveLibraryFilePath)
    if (!asset) return
    response.json(asset satisfies LibraryThreeMfPreviewAssetDto)
  })

  /** Raw internal 3MF model entry bytes used by the plated mesh previewer. */
  router.get('/:id/scene-entry', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!row) throw notFound('File not found')
    // Sub-model entries (Bambu part files) OR the root model entry: objects created by
    // the editor (cut halves, split shells, primitives) carry their mesh inline there.
    const entryPath = z.string().trim().regex(/^3D\/(?:Objects\/[^/]+\.model|3dmodel\.model)$/i).parse(request.query.path)
    if (sendNotModifiedIfLibraryFileFresh(request, response, row, `scene-entry:${entryPath}`)) return

    let onDisk: string
    try {
      onDisk = await resolveLibraryFilePath(row)
    } catch {
      throw notFound('File missing on disk')
    }

    const signal = requestAbortSignal(request, response)
    try {
      const buffer = await readEntry(onDisk, entryPath, signal, 256 * 1024 * 1024)
      if (signal.aborted) return
      await sendModelBuffer(request, response, buffer, 'application/xml; charset=utf-8')
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      throw notFound('Scene model entry missing')
    }
  })

  /** Raw bytes for a specific embedded STL/STEP preview source inside a 3MF. */
  router.get('/:id/preview-asset/content', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!row) throw notFound('File not found')
    const entryPath = z.string().trim().min(1).parse(request.query.entry)
    if (sendNotModifiedIfLibraryFileFresh(request, response, row, `preview-asset-content:${entryPath}`)) return
    const asset = await resolveLibraryFilePreviewAsset(request, response, row, resolveLibraryFilePath)
    if (!asset) return
    if (asset.entryPath !== entryPath) throw notFound('Embedded preview source missing')

    const signal = requestAbortSignal(request, response)
    let onDisk: string
    try {
      onDisk = await resolveLibraryFilePath(row)
    } catch {
      throw notFound('File missing on disk')
    }

    try {
      const buffer = await readEntry(onDisk, asset.entryPath, signal, 256 * 1024 * 1024)
      if (signal.aborted) return
      await sendModelBuffer(request, response, buffer, asset.kind === 'stl' ? 'model/stl' : 'application/octet-stream')
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      throw notFound('Embedded preview source missing')
    }
  })

  /**
   * Persist a client-rendered STL/STEP preview PNG so later views (any client/session)
   * are served the bytes instead of re-fetching the mesh and re-rendering, and, for
   * STEP, re-tessellating server-side. The web renderer is the only producer; the body
   * is a raw PNG. `?v=<uploadedAt>` guards against a client that rendered a now-stale
   * version racing a fresh upload: a mismatch is accepted as a no-op rather than caching
   * the wrong content. Scoped to viewers (rendering a preview needs no manage rights).
   */
  router.put(
    '/:id/thumbnail',
    requireRequestPermission(LIBRARY_VIEW_PERMISSION),
    express.raw({ type: 'image/png', limit: MESH_THUMBNAIL_MAX_BYTES }),
    async (request, response) => {
      const fileId = requireRouteParam(request.params.id, 'File id')
      const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
      if (!row) throw notFound('File not found')
      // 3MF is accepted for geometry-only files (the client only renders mesh thumbnails
      // for those); a render uploaded against a project 3MF just fills a cache that its
      // embedded plate PNGs shadow, so the looser gate cannot change what projects show.
      if (!isMeshLibraryFileKind(row.kind) && row.kind !== '3mf') throw badRequest('Thumbnails are only uploadable for mesh files')

      const body = request.body
      if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Expected a PNG body')
      if (!isLikelyPng(body)) throw badRequest('Body is not a PNG')

      // Ignore (don't cache) a render of a superseded version. uploadedAt is the
      // revision marker the client cache-busts on, so it round-trips it here.
      const renderedFor = typeof request.query.v === 'string' ? request.query.v : null
      if (renderedFor !== null && renderedFor !== row.uploadedAt.toISOString()) {
        response.status(204).end()
        return
      }

      await writeMeshThumbnailCache(row, body)
      response.status(204).end()
    }
  )

  /**
   * Binary STL bytes for a library model file, scoped to viewers (not downloaders) and
   * without an audit-log entry, so the web client can render a 3D preview/thumbnail for
   * files that carry no embedded image.
   *
   * ONE OUTPUT FORMAT, whatever went in: every consumer is the browser's STL loader. STL ships
   * verbatim; STEP is tessellated through OpenCASCADE (BambuStudio-matched quality); OBJ, glTF, AMF,
   * and FBX are parsed and re-serialized. The conversion happens HERE rather than in the browser because
   * the bridge ships no 3D renderer and the client should hold one loader, not six parsers.
   * 3MF/gcode keep using `/thumbnail`, except for geometry-only 3MFs handled below.
   */
  router.get('/:id/mesh', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!row) throw notFound('File not found')
    if (!isMeshLibraryFileKind(row.kind) && row.kind !== '3mf') throw notFound('No mesh available')
    if (sendNotModifiedIfLibraryFileFresh(request, response, row, 'mesh')) return
    const signal = requestAbortSignal(request, response)
    let onDisk: string
    try {
      onDisk = await resolveLibraryFilePath(row)
    } catch {
      throw notFound('File missing on disk')
    }
    try {
      let stl: Buffer
      if (row.kind === '3mf') {
        // Only geometry-only 3MFs (vanilla mesh containers) serve a single mesh here:
        // real projects have per-plate previews and never render through this route.
        const index = await readPlateIndex(onDisk, signal)
        if (!index.geometryOnly) throw notFound('No mesh available')
        stl = Buffer.from(meshToBinaryStl(await extractThreeMfImportMesh(onDisk)))
      } else if (isMeshLibraryFileKind(row.kind)) {
        const buffer = await readFile(onDisk)
        if (signal.aborted) return
        // STL ships verbatim; everything else is converted once per cache window (the ETag 304 above
        // short-circuits warm clients before this point). STEP is the expensive one, having no
        // triangle mesh at all to start from.
        stl = row.kind === 'stl'
          ? buffer
          : Buffer.from(meshToBinaryStl(await parseImportedMesh(
              buffer,
              meshImportFormatForKind(row.kind),
              [],
              { sourceAppearance: false }
            )))
      } else {
        // Unreachable: the gate above admits only a mesh kind or a 3MF. Stated rather than assumed,
        // so the narrowing that lets `meshImportFormatForKind` take a proven kind is enforced by the
        // type checker instead of by a comment.
        throw notFound('No mesh available')
      }
      if (signal.aborted) return
      response.setHeader('Cache-Control', 'private, max-age=300')
      await sendModelBuffer(request, response, stl, 'model/stl')
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      // Every converted format can fail on the CONTENT, not just (like a verbatim STL) on a missing
      // file, so surface the cause: the client only sees a 404 and falls back to the kind label.
      // id and kind only, no name and no path.
      if (row.kind !== 'stl') {
        console.warn(
          `Failed to convert ${row.kind} library file ${row.id} for preview:`,
          error instanceof Error ? error.message : error
        )
      }
      throw notFound('Mesh missing')
    }
  })


}

async function resolveLibraryFilePreviewAsset(
  request: Request,
  response: Response,
  row: { kind: string; ownerBridgeId?: string | null; storedPath: string },
  resolveLibraryFilePath: PreviewRouteDependencies['resolveLibraryFilePath']
): Promise<LibraryThreeMfPreviewAssetDto | null> {
  if (row.kind !== '3mf') throw notFound('No embedded preview source available')
  const signal = requestAbortSignal(request, response)

  let onDisk: string
  try {
    onDisk = await resolveLibraryFilePath(row)
  } catch {
    throw notFound('File missing on disk')
  }

  let assets: LibraryThreeMfPreviewAssetDto[]
  try {
    assets = await readPreviewAssets(onDisk, signal)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return null
    throw notFound('Unable to inspect embedded preview sources')
  }

  if (assets.length === 0) throw notFound('No embedded STL or STEP preview source found')
  if (assets.length > 1) {
    throw conflict('This 3MF contains multiple embedded STL or STEP sources, and source selection is not available yet')
  }
  return assets[0] ?? null
}

/**
 * The import format that reads a given mesh library kind.
 *
 * A cast, not a mapping table: the two catalogues use the same spelling for every bare-mesh format,
 * pinned by `library-file-kinds.test.ts`. It stays a named FUNCTION so the one place relying on that
 * is findable, and it takes a NARROWED kind so the caller has to have proved the kind is a mesh
 * before calling. It used to re-check and `throw notFound` on failure, which was dead code twice
 * over: the route's own gate makes it unreachable, and had it ever fired, the throw sits inside the
 * try below, so the catch would have logged "Failed to convert <kind> ... : No mesh available",
 * blaming the file's content for a routing mistake.
 */
function meshImportFormatForKind(kind: MeshLibraryFileKind): Exclude<StagedImportFormat, '3mf'> {
  return kind
}
