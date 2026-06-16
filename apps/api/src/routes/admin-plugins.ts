/**
 * Plugin admin routes. Lists installed plugins, installs/uninstalls
 * them, toggles them on/off, and exposes their persisted settings for
 * the management UI.
 *
 * Mounted at `/api/admin/plugins`. Kept off `/api/plugins/...` so it
 * can never collide with a plugin's own sub-router namespace.
 *
 * Two install flows coexist:
 * - Built-in plugins live in code; `POST /:name/install` flips their
 *   enabled flag back on after a previous uninstall.
 * - External plugins arrive as zip uploads via `POST /upload` and are
 *   tracked in the `Plugin` table.
 */
import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { PLUGINS_MANAGE_PERMISSION, updateTenantPluginAvailabilitySchema } from '@printstream/shared'
import multer from 'multer'
import os from 'node:os'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { pluginRegistry } from '../plugin/registry.js'
import {
  PluginInstallError,
  installPluginFromArchive,
  uninstallExternalPlugin
} from '../plugin/installer.js'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { assertRequestPermission } from '../lib/authorization.js'
import { assertFileUploadsAllowed } from '../lib/demo-mode.js'
import { badRequest, forbidden, notFound } from '../lib/http-error.js'
import { broadcastPluginsChanged } from '../lib/ws-resource-events.js'

export const adminPluginsRouter = Router()
adminPluginsRouter.use((request, _response, next) => {
  try {
    assertRequestPermission(request, PLUGINS_MANAGE_PERMISSION)
    if (request.tenant) {
      throw forbidden('Switch to the platform workspace to manage plugin installation and tenant availability.')
    }
    next()
  } catch (error) {
    next(error)
  }
})

/** Cap upload size so a malicious archive cannot fill the disk. */
const MAX_PLUGIN_ARCHIVE_BYTES = 16 * 1024 * 1024

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_request, file, callback) => {
      const safe = file.originalname.replace(/[^a-z0-9._-]/gi, '_')
      callback(null, `bambu-plugin-${Date.now()}-${safe}`)
    }
  }),
  limits: { fileSize: MAX_PLUGIN_ARCHIVE_BYTES }
})

function requireFileUploadsAllowed(_request: Request, _response: Response, next: NextFunction): void {
  try {
    assertFileUploadsAllowed(_request)
    next()
  } catch (error) {
    next(error)
  }
}

adminPluginsRouter.get('/', (_request, response) => {
  response.json({ plugins: pluginRegistry.list() })
})

const enabledSchema = z.object({ enabled: z.boolean() })

adminPluginsRouter.post('/:name/enabled', async (request, response) => {
  const parsed = enabledSchema.safeParse(request.body)
  if (!parsed.success) throw badRequest('Expected { enabled: boolean }')
  const existing = pluginRegistry.get(request.params.name)
  if (!existing) throw notFound('Plugin not found')
  if (!existing.installed) throw badRequest('Plugin is not installed')
  const info = await pluginRegistry.setEnabled(request.params.name, parsed.data.enabled)
  annotateRequestAuditLog(request, {
    action: parsed.data.enabled ? 'enable-plugin' : 'disable-plugin',
    resource: 'plugin',
    summary: `${parsed.data.enabled ? 'Enabled' : 'Disabled'} plugin ${existing.name}.`,
    metadata: {
      pluginName: existing.name,
      enabled: parsed.data.enabled
    }
  })
  response.json({ plugin: info })
})

adminPluginsRouter.post('/:name/install', async (request, response) => {
  const existing = pluginRegistry.get(request.params.name)
  if (!existing) throw notFound('Plugin not found')
  if (existing.source !== 'builtin') {
    throw badRequest('External plugins are installed via /upload')
  }
  const info = await pluginRegistry.install(request.params.name)
  annotateRequestAuditLog(request, {
    action: 'install-plugin',
    resource: 'plugin',
    summary: `Installed plugin ${existing.name}.`,
    metadata: {
      pluginName: existing.name
    }
  })
  response.json({ plugin: info })
})

adminPluginsRouter.post('/:name/uninstall', async (request, response) => {
  const existing = pluginRegistry.get(request.params.name)
  if (!existing) throw notFound('Plugin not found')
  // Destructive: the HTTP verb is POST, but this removes the plugin.
  annotateRequestAuditLog(request, {
    action: 'uninstall-plugin',
    resource: 'plugin',
    summary: `Uninstalled plugin ${existing.name}.`,
    metadata: {
      pluginName: existing.name,
      source: existing.source
    }
  })
  if (existing.source === 'builtin') {
    const info = await pluginRegistry.uninstall(request.params.name)
    response.json({ plugin: info })
    return
  }
  await uninstallExternalPlugin(request.params.name)
  response.json({ plugin: null })
})

adminPluginsRouter.put('/:name/tenant-availability', async (request, response) => {
  const parsed = updateTenantPluginAvailabilitySchema.safeParse(request.body)
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid tenant availability payload')

  const info = await pluginRegistry.setTenantAvailability(request.params.name, parsed.data)
  annotateRequestAuditLog(request, {
    action: 'update-plugin-tenant-availability',
    resource: 'plugin',
    summary: `Updated workspace availability for plugin ${info.name} (allowed=${parsed.data.allowed}, enabled by default=${parsed.data.enabledByDefault}).`,
    metadata: {
      pluginName: info.name,
      allowed: parsed.data.allowed,
      enabledByDefault: parsed.data.enabledByDefault
    }
  })
  response.json({ plugin: info })
})

adminPluginsRouter.post('/upload', requireFileUploadsAllowed, upload.single('package'), async (request, response) => {
  if (!request.file) throw badRequest('No file uploaded under field "package"')
  const tmpPath = path.resolve(request.file.path)
  try {
    const manifest = await installPluginFromArchive(tmpPath)
    const info = pluginRegistry.get(manifest.name)
    annotateRequestAuditLog(request, {
      action: 'upload-plugin',
      resource: 'plugin',
      summary: `Installed uploaded plugin ${manifest.name}.`,
      metadata: {
        pluginName: manifest.name,
        ...(manifest.version ? { pluginVersion: manifest.version } : {})
      }
    })
    broadcastPluginsChanged()
    response.status(201).json({ plugin: info })
  } catch (error) {
    if (error instanceof PluginInstallError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    throw error
  } finally {
    await rm(tmpPath, { force: true })
  }
})

adminPluginsRouter.get('/:name/settings', async (request, response) => {
  if (!pluginRegistry.get(request.params.name)) throw notFound('Plugin not found')
  const settings = await pluginRegistry.listSettings(request.params.name)
  response.json({ settings })
})
