/**
 * Slicer engine catalogue and installation routes.
 *
 * The service entrypoint registers these after its bearer-token middleware.
 * The slicer owns the engine manifest, installation progress, and downloads;
 * moving installation to the API would make it mutate this process's state
 * from outside. Install/remove remain behind the same bearer token as slicing.
 * Failures in background installs remain observable and queryable via GET.
 */
import type { Express } from 'express'
import { findCatalogueEngine, listCatalogue } from './engines/catalogue.js'
import { beginInstall, failInstall, finishInstall, installStatus, isInstalling, reportInstall } from './engines/progress.js'
import { installEngine, removeEngine } from './engines/install.js'
import { readManifest as readEngineManifest } from './engines/manifest.js'

/** Register privileged engine routes at the entrypoint's existing seam. */
export function registerEngineRoutes(app: Express): void {
  app.get('/engines', async (_request, response) => {
    const [manifest, catalogue] = [await readEngineManifest(), listCatalogue()]
    const installed = new Set(manifest.targets.map((target) => target.id))
    response.json({
      defaultTargetId: manifest.defaultTargetId,
      engines: catalogue.map((engine) => ({
        id: engine.id,
        label: engine.label,
        version: engine.version,
        slicerName: engine.slicerName,
        prerelease: engine.prerelease,
        installed: installed.has(engine.id),
        downloadBytes: engine.asset.bytes,
        installBytes: engine.installBytes,
        // Null unless something is happening right now. A FAILED record is kept
        // deliberately: reverting to plain "not installed" reads as the click
        // having done nothing.
        status: installStatus(engine.id)
      })),
      // Named so a UI can say WHY a host offers nothing, rather than showing an
      // empty list that reads as a loading failure.
      platformSupported: catalogue.length > 0
    })
  })

  app.post('/engines/:id/install', (request, response) => {
    const id = String(request.params.id ?? '')
    if (!findCatalogueEngine(id)) {
      response.status(404).json({ error: `No installable engine named ${id} on this platform.` })
      return
    }
    // Already running: answer the same 202 rather than starting a second download
    // of the same gigabyte because someone clicked twice.
    if (isInstalling(id)) {
      response.status(202).json({ status: installStatus(id) })
      return
    }

    // Started, not awaited. An engine is 220-470 MB and unpacks to over a
    // gigabyte; holding the request open ties the outcome to a socket staying up,
    // and a slow link becomes a caller waiting on a timeout long enough to look
    // like a broken app. Progress is read back from GET /engines, the same shape
    // slicing jobs already use.
    beginInstall(id)
    void installEngine({
      id,
      onProgress: (progress) => {
        const fraction = progress.totalBytes ? (progress.receivedBytes ?? 0) / progress.totalBytes : undefined
        reportInstall(id, progress.label, fraction)
      }
    }).then(
      () => finishInstall(id),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[engines] install of ${id} failed:`, message)
        failInstall(id, message)
      }
    )
    response.status(202).json({ status: installStatus(id) })
  })

  app.delete('/engines/:id', async (request, response, next) => {
    try {
      await removeEngine(String(request.params.id ?? ''))
      response.status(204).end()
    } catch (error) {
      next(error)
    }
  })
}
