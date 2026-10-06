/**
 * Workspace library HTTP surface.
 *
 * Composes browse, folder, recycle-bin, file/version, resumable-upload, download/preview, and print
 * endpoints. Library bytes are bridge-owned by default, so persistence and 3MF inspection delegate
 * to focused helpers while Prisma tracks metadata and version history. Static route
 * families must remain registered before `/:id` routes so names such as `uploads` and `versions`
 * are never interpreted as file ids. This module owns only registration order and the shared
 * demo mutation guard; route families, response mapping, and media policy live beside it.
 */
import { mkdirSync } from 'node:fs'
import { Router } from 'express'
import type { Request } from 'express'
import { requestHasDemoModeRestrictions } from '../lib/demo-mode.js'
import { forbidden } from '../lib/http-error.js'
import { libraryDir } from '../lib/library-paths.js'
import { registerLibraryFolderRoutes } from './library-folders.js'
import { registerLibraryBrowseRoutes } from './library-browse.js'
import { toDto, toVersionDto } from './library-dto.js'
import { registerLibraryUploadRoutes } from './library-upload-routes.js'
import {
  resolveLibraryFilePath,
  readLibraryThreeMfIndex,
  sendLibraryFileArchive,
  sendLibraryFileDownload,
  sendNotModifiedIfLibraryFileFresh,
  sendLibraryFilePlates,
  sendLibraryFileThumbnail,
  sendLibraryFileScene,
  sendLibraryFilePlateGcode
} from './library-media.js'
import { registerLibraryFileMutationRoutes } from './library-file-mutations.js'
import { registerLibraryRecycleRoutes } from './library-recycle.js'
import { registerLibraryDownloadLinkRoutes } from './library-download-links.js'
import { registerLibraryVersionListRoute, registerLibraryVersionMediaRoutes } from './library-version-reads.js'
import { registerLibraryVersionPrintRoute } from './library-version-print.js'
import { registerLibraryCurrentPrintRoute } from './library-current-print.js'
import { registerLibraryCurrentPreviewRoutes } from './library-current-preview.js'
import { registerLibraryReprintRoute } from './library-reprint.js'
import { registerLibraryArchivedVersionDeleteRoute, registerLibraryArchivedVersionRestoreRoute, registerLibraryCurrentVersionDeleteRoute } from './library-version-mutations.js'
import { registerLibraryCurrentFileDownloadRoute, registerLibraryCurrentFileMediaRoutes, registerLibraryCurrentFileMetadataRoutes } from './library-current-file-reads.js'


// Created synchronously at module load: a one-time directory ensure, and keeping
// it off the top-level `await` path lets this module compile into a CommonJS SEA
// bundle (Node single-executable apps are CJS-only).
mkdirSync(libraryDir, { recursive: true })

const DEMO_LIBRARY_MUTATION_MESSAGE = 'Curated demo library files are read-only in the public demo.'

export const libraryRouter = Router()

registerLibraryBrowseRoutes(libraryRouter, toDto)

registerLibraryUploadRoutes(libraryRouter, toDto, assertDemoLibraryFileMutationAllowed)

registerLibraryFolderRoutes(libraryRouter, assertDemoLibraryFileMutationAllowed)

registerLibraryRecycleRoutes(libraryRouter, { toDto, assertDemoLibraryFileMutationAllowed })


registerLibraryVersionListRoute(libraryRouter, toVersionDto)

registerLibraryArchivedVersionRestoreRoute(libraryRouter, assertDemoLibraryFileMutationAllowed, toDto, resolveLibraryFilePath)

registerLibraryArchivedVersionDeleteRoute(libraryRouter, assertDemoLibraryFileMutationAllowed)

registerLibraryCurrentVersionDeleteRoute(libraryRouter, assertDemoLibraryFileMutationAllowed, toDto)

registerLibraryVersionPrintRoute(libraryRouter)

registerLibraryVersionMediaRoutes(libraryRouter, {
  sendDownload: sendLibraryFileDownload,
  sendPlates: sendLibraryFilePlates,
  sendThumbnail: sendLibraryFileThumbnail,
  sendArchive: sendLibraryFileArchive,
  sendScene: sendLibraryFileScene,
  sendPlateGcode: sendLibraryFilePlateGcode,
  resolveLocalPath: resolveLibraryFilePath,
  sendNotModified: sendNotModifiedIfLibraryFileFresh
})


registerLibraryCurrentFileDownloadRoute(libraryRouter, sendLibraryFileDownload)

registerLibraryDownloadLinkRoutes(libraryRouter, sendLibraryFileDownload)

registerLibraryCurrentFileMediaRoutes(libraryRouter, {
  sendPlates: sendLibraryFilePlates,
  sendPlateGcode: sendLibraryFilePlateGcode,
  sendArchive: sendLibraryFileArchive,
  sendScene: sendLibraryFileScene,
  sendThumbnail: sendLibraryFileThumbnail
})

registerLibraryCurrentPreviewRoutes(libraryRouter, { resolveLibraryFilePath, sendNotModifiedIfLibraryFileFresh })

registerLibraryCurrentFileMetadataRoutes(libraryRouter, toDto)

registerLibraryFileMutationRoutes(libraryRouter, { toDto, assertDemoMutationAllowed: assertDemoLibraryFileMutationAllowed })

/**
 * Enqueue a library file for printing. The HTTP request returns as soon
 * as the dispatcher accepts the job; the API process performs the slow
 * FTPS upload and MQTT start command in the background.
 */
registerLibraryCurrentPrintRoute(libraryRouter)

/**
 * Re-print: re-issue a `project_file` for the most recently uploaded
 * file. Bambu firmware accepts this without re-uploading because the
 * file remains on the SD card after the previous print.
 */
registerLibraryReprintRoute(libraryRouter, readLibraryThreeMfIndex)



function assertDemoLibraryFileMutationAllowed(request: Request, row: { hidden: boolean }): void {
  if (requestHasDemoModeRestrictions(request) && !row.hidden) {
    throw forbidden(DEMO_LIBRARY_MUTATION_MESSAGE)
  }
}
