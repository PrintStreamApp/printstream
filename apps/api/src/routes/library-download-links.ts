/**
 * Short-lived library download-link issuance and redemption.
 *
 * Minting requires `library.download`. The opaque token is the sole credential
 * when an external desktop app redeems the link, so the token lookup uses
 * root Prisma and re-scopes the file by the link's workspace before streaming.
 * The parent router owns registration order and the shared download stream.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Response, Router } from 'express'
import { LIBRARY_DOWNLOAD_PERMISSION, type LibraryDownloadLinkResponse } from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { env } from '../lib/env.js'
import { notFound } from '../lib/http-error.js'
import { prisma, rootPrisma } from '../lib/prisma.js'
import { requireRouteParam } from '../lib/request-helpers.js'
import { resolveRequestActorAttribution } from '../lib/actor-attribution.js'

const DOWNLOAD_LINK_TTL_MS = 10 * 60 * 1000

type DownloadableLibraryFile = {
  id: string
  workspaceId: string
  name: string
  ownerBridgeId?: string | null
  storedPath: string
}

/** Persist only a hash; the raw token exists only in the minted URL. */
function hashDownloadLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Register issuance and redemption at their original position in the library router. */
export function registerLibraryDownloadLinkRoutes(
  router: Router,
  sendDownload: (response: Response, row: DownloadableLibraryFile) => Promise<void>
): void {
  /** Mint a scoped URL for a desktop app that cannot send the browser session. */
  router.post('/:id/download-link', requireRequestPermission(LIBRARY_DOWNLOAD_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const row = await prisma.libraryFile.findUnique({ where: { id: fileId } }) as DownloadableLibraryFile | null
    if (!row) throw notFound('File not found')

    const now = Date.now()
    // Best-effort pruning must never prevent a valid link from being issued.
    try {
      await prisma.libraryDownloadLink.deleteMany({ where: { expiresAt: { lte: new Date(now) } } })
    } catch (error) {
      console.warn('[library] failed to prune expired download links:', error)
    }

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(now + DOWNLOAD_LINK_TTL_MS)
    const attribution = await resolveRequestActorAttribution(request)
    await prisma.libraryDownloadLink.create({
      data: {
        workspaceId: row.workspaceId,
        libraryFileId: row.id,
        tokenHash: hashDownloadLinkToken(token),
        expiresAt,
        createdById: attribution.createdById
      }
    })

    annotateRequestAuditLog(request, {
      action: 'download-link',
      resource: 'library file',
      summary: `Created a temporary download link for ${row.name}.`,
      metadata: { fileId: row.id, fileName: row.name, expiresAt: expiresAt.toISOString() }
    })

    const base = env.PUBLIC_BASE_URL?.replace(/\/$/, '') || `${request.protocol}://${request.get('host')}`
    const url = `${base}/api/library/download-links/${token}/${encodeURIComponent(row.name)}`
    response.json({ url, expiresAt: expiresAt.toISOString() } satisfies LibraryDownloadLinkResponse)
  })

  /** Redeem by token only, then re-scope the file to the token's workspace. */
  router.get('/download-links/:token{/:filename}', async (request, response) => {
    const token = requireRouteParam(request.params.token, 'Download token')
    const link = await rootPrisma.libraryDownloadLink.findUnique({
      where: { tokenHash: hashDownloadLinkToken(token) }
    })
    if (!link || link.expiresAt.getTime() <= Date.now()) throw notFound('Download link not found or expired')
    const row = await rootPrisma.libraryFile.findFirst({
      where: { id: link.libraryFileId, workspaceId: link.workspaceId }
    }) as DownloadableLibraryFile | null
    if (!row) throw notFound('File not found')
    await sendDownload(response, row)
  })
}
