/**
 * Remote imports plugin (built-in).
 *
 * Imports printable files from a pasted URL into the bridge-backed library. Two
 * routes in: a DIRECT file URL is downloaded here behind the SSRF guard, and a
 * MAKERWORLD model page is resolved through the workspace's connected Bambu Lab
 * account (see `makerworld-client.ts`), that account is the only credential
 * MakerWorld accepts, so no amount of scraping substitutes for it.
 *
 * Printables publishes no link this can fetch, so it stays unsupported here; the
 * companion browser helper covers it by posting bytes to `/import-upload`, and is
 * deliberately unadvertised in the UI until it ships on the Chrome Web Store.
 *
 * Contract callers rely on: every route that creates a library row goes through
 * `persistLibraryFileFromLocalPath`, so imports get the same folder/bridge
 * resolution, content dedupe, versioning, actor attribution, audit entry, and
 * bridge-byte rollback as a normal upload. This plugin owns only what is
 * import-specific: URL classification, the guarded download, and the
 * `Imported models` landing folder.
 *
 * Counterparts: `apps/web/src/plugins/remote-imports/` (the import view) and the
 * out-of-repo Chrome helper extension, which is the only caller of `/resolve`,
 * `/import-upload`, and `/extension-context`.
 *
 * Routes (mounted under `/api/plugins/remote-imports`):
 * - `GET  /capabilities`: providers, importable/direct-print types, landing folder.
 * - `GET  /extension-context`: sign-in + workspace bootstrap for the extension.
 * - `POST /resolve`: detect provider and import strategy for a pasted URL.
 * - `POST /import-url`: download a direct file URL into the library.
 * - `POST /import-upload`: accept file bytes from the browser helper / extension.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { createWriteStream } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { mkdir, mkdtemp, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import multer from 'multer'
import type { NextFunction, Request, Response as ExpressResponse } from 'express'
import {
  LIBRARY_UPLOAD_PERMISSION,
  REMOTE_IMPORT_PROVIDER_CAPABILITIES,
  SETTINGS_MANAGE_PERMISSION,
  IMPORTED_MODELS_FOLDER_NAME,
  classifyLibraryFileKind,
  detectRemoteImportUrl,
  isDirectPrintableFileName,
  parseMakerWorldModelUrl,
  remoteImportCapabilitiesResponseSchema,
  remoteImportExtensionContextResponseSchema,
  remoteImportMakerWorldSettingsRequestSchema,
  remoteImportResolveRequestSchema,
  remoteImportResolveResponseSchema,
  remoteImportUploadResponseSchema,
  remoteImportUrlImportRequestSchema
} from '@printstream/shared'
import type { LibraryFile, Permission } from '@printstream/shared'
import type { ApiPlugin, ApiPluginContext } from '../../plugin/types.js'
import { annotateRequestAuditLog, skipRequestAuditLog } from '../../lib/audit-logs.js'
import { bambuAccountResolvers, type BambuAccountCredential } from '../../lib/bambu-account-registry.js'
import { resolveMakerWorldDownload } from './makerworld-client.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { authProviderRegistry } from '../../lib/auth-registry.js'
import { assertFileUploadsAllowed } from '../../lib/demo-mode.js'
import { env } from '../../lib/env.js'
import { badRequest, HttpError } from '../../lib/http-error.js'
import { ensureLibraryFolderPath, persistLibraryFileFromLocalPath, toCreatedLibraryFileDto } from '../../lib/library-files.js'
import { rootPrisma } from '../../lib/prisma.js'
import { requireRequestWorkspaceId, singleUploadWithLimit } from '../../lib/request-helpers.js'
import { hasSupportAccessBypass, listSupportAccessibleWorkspaces, readSupportAccessPermissionsForWorkspaces } from '../../lib/support-access.js'
import { filterEnabledWorkspaces } from '../../lib/workspace-availability.js'
import { listWorkspaces } from '../../lib/workspace-resolution.js'

const MAX_IMPORT_BYTES = env.LIBRARY_MAX_UPLOAD_BYTES
const MAX_REMOTE_IMPORT_REDIRECTS = 5

/**
 * Whether MakerWorld imports may use the workspace's Bambu Lab connection.
 *
 * **Absent means ON**, this is an opt-OUT. It started as an opt-in on the reasoning
 * that connecting that account (in `bambu-cloud-sync`) is consent to sync presets and
 * not to fetch models under the same identity. That protected almost nothing in
 * practice: the account credential is the ONLY way to download from MakerWorld, this
 * plugin is already disabled by default, and anyone able to flip this switch could
 * equally enable the plugin, so all the extra step did was leave the plugin's headline
 * feature dead until the user found a second toggle.
 *
 * It survives as an off switch for the case the consent argument was really about: an
 * admin who syncs presets with their own Bambu account but does not want the whole
 * workspace's downloads attributed to it. The UI names that account for the same reason.
 */
const MAKERWORLD_ACCOUNT_IMPORT_SETTING = 'makerWorldAccountImportEnabled'

const uploadDir = path.join(tmpdir(), 'printstream-remote-imports')

/**
 * Library kinds this plugin accepts, as `classifyLibraryFileKind` reports them.
 *
 * One list feeds the guard, the rejection message, and what `/capabilities`
 * advertises, so those three cannot disagree, they did once, with STEP files
 * importing fine while both strings claimed they could not.
 */
const IMPORTABLE_LIBRARY_FILE_KINDS = ['3mf', 'gcode', 'stl', 'step'] as const

const IMPORTABLE_EXTENSIONS_MESSAGE =
  'Only .3mf, .gcode, .gcode.3mf, .stl, .step, or .stp files can be imported'

function isImportableLibraryFileKind(kind: string): boolean {
  return (IMPORTABLE_LIBRARY_FILE_KINDS as readonly string[]).includes(kind)
}

type RemoteImportAddressLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<Array<{ address: string; family: number }>>

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_request, _file, callback) => {
      try {
        await mkdir(uploadDir, { recursive: true })
        callback(null, uploadDir)
      } catch (error) {
        callback(error as Error, uploadDir)
      }
    },
    filename: (_request, file, callback) => {
      const safe = sanitizeImportFileName(file.originalname || 'imported-file')
      callback(null, `${Date.now()}-${safe}`)
    }
  }),
  limits: { fileSize: MAX_IMPORT_BYTES }
})

const uploadSingle = (field: string) => singleUploadWithLimit({
  upload,
  field,
  maxBytes: MAX_IMPORT_BYTES,
  onLimitExceeded: (maxBytes) =>
    new HttpError(413, `File exceeds ${Math.round(maxBytes / (1024 * 1024))} MB upload limit`),
  onMulterError: (error) => new HttpError(400, error.message)
})

/**
 * Demo-mode gate, as middleware so it runs BEFORE multer stages bytes on disk:
 * throwing from inside the handler would orphan the temp file, which nothing
 * sweeps.
 *
 * Deliberately passes no bypass permission: `assertFileUploadsAllowed` skips the
 * check for anyone holding the permission it is handed, and every route here
 * already gates on `LIBRARY_UPLOAD_PERMISSION`, so passing that same permission
 * would make the gate unreachable rather than lenient.
 */
function requireFileUploadsAllowed(request: Request, _response: ExpressResponse, next: NextFunction): void {
  try {
    assertFileUploadsAllowed(request)
    next()
  } catch (error) {
    next(error)
  }
}

export const remoteImportsPlugin: ApiPlugin = createRemoteImportsPlugin()

export function createRemoteImportsPlugin(input: {
  downloadToTempFile?: typeof downloadToTempFile
  persistLibraryFile?: typeof persistLibraryFileFromLocalPath
} = {}): ApiPlugin {
  const downloadToTemp = input.downloadToTempFile ?? downloadToTempFile
  const persistLibraryFile = input.persistLibraryFile ?? persistLibraryFileFromLocalPath

  return {
    name: 'remote-imports',
    version: '0.1.0',
    description: 'Import printable files from direct URLs and prepare provider page URLs for browser-assisted handoff.',
    async register(context) {
      context.router.get('/capabilities', requireRequestPermission(LIBRARY_UPLOAD_PERMISSION), async (request, response) => {
        const workspaceId = requireRequestWorkspaceId(request)
        response.json(remoteImportCapabilitiesResponseSchema.parse({
          providers: REMOTE_IMPORT_PROVIDER_CAPABILITIES,
          directPrintFileTypes: ['gcode', 'gcode.3mf'],
          importFileTypes: [...IMPORTABLE_LIBRARY_FILE_KINDS],
          libraryFolderName: IMPORTED_MODELS_FOLDER_NAME,
          makerWorld: await describeMakerWorldCapability(context, workspaceId)
        }))
      })

      context.router.put(
        '/makerworld-settings',
        requireRequestPermission(SETTINGS_MANAGE_PERMISSION),
        async (request, response) => {
          const workspaceId = requireRequestWorkspaceId(request)
          const parsed = remoteImportMakerWorldSettingsRequestSchema.safeParse(request.body)
          if (!parsed.success) {
            throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid settings payload')
          }
          await context.settings.forWorkspace(workspaceId).set(
            MAKERWORLD_ACCOUNT_IMPORT_SETTING,
            parsed.data.enabled ? 'true' : 'false'
          )
          annotateRequestAuditLog(request, {
            action: 'update',
            resource: 'remote import settings',
            summary: parsed.data.enabled
              ? 'Allowed MakerWorld downloads to use the connected Bambu Lab account.'
              : 'Stopped MakerWorld downloads from using the connected Bambu Lab account.',
            metadata: { setting: MAKERWORLD_ACCOUNT_IMPORT_SETTING, enabled: parsed.data.enabled }
          })
          response.json(await describeMakerWorldCapability(context, workspaceId))
        }
      )

      // Ungated on purpose: this is the extension's BOOTSTRAP, and it must be able
      // to tell "not signed in" from "signed in but cannot upload anywhere". A
      // permission gate collapses both into a 401, leaving the extension unable to
      // prompt correctly. Nothing sensitive escapes: the workspace list is already
      // filtered to workspaces the caller may upload to, and an anonymous caller
      // gets an empty list unless auth is disabled entirely (an open install, where
      // every workspace is reachable anyway).
      context.router.get('/extension-context', async (request, response) => {
        const bootstrap = await authProviderRegistry.buildBootstrap({ demoMode: request.auth.runtimePolicy.demoMode })
        response.json(remoteImportExtensionContextResponseSchema.parse({
          authenticated: request.auth.actor.type !== 'anonymous',
          authEnabled: request.auth.authEnabled,
          setupRequired: bootstrap.setupRequired,
          workspaces: await listExtensionImportWorkspaces(request)
        }))
      })

      context.router.post(
        '/resolve',
        requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
        requireFileUploadsAllowed,
        async (request, response) => {
          // POST by shape only: this classifies a URL and stores nothing, and the helper
          // extension calls it per paste. An audit row per keystroke-ish lookup would be
          // noise with no trail value, so opt out rather than leave the vague auto-entry.
          skipRequestAuditLog(request)
          const parsed = remoteImportResolveRequestSchema.safeParse(request.body)
          if (!parsed.success) {
            throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid resolve payload')
          }
          response.json(remoteImportResolveResponseSchema.parse({
            resolution: detectRemoteImportUrl(parsed.data.url)
          }))
        }
      )

      context.router.post(
        '/import-url',
        requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
        requireFileUploadsAllowed,
        async (request, response) => {
          const parsed = remoteImportUrlImportRequestSchema.safeParse(request.body)
          if (!parsed.success) {
            throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid import payload')
          }

          const workspaceId = requireRequestWorkspaceId(request)
          const importUrl = parsed.data.url
          const resolution = detectRemoteImportUrl(importUrl)

          // A MakerWorld model page has no direct file URL, but the connected Bambu
          // account can resolve one. Tried BEFORE the server-download check, which
          // would otherwise reject the page as "needs a browser helper": the answer
          // this path exists to change.
          const makerWorldRef = parseMakerWorldModelUrl(importUrl)
          if (makerWorldRef) {
            const credential = await resolveOptedInMakerWorldCredential(context, workspaceId)
            const target = await resolveMakerWorldDownload({ ...makerWorldRef, credential })
            const download = await downloadToTemp(target.downloadUrl, { fileNameOverride: target.fileName })
            try {
              const file = await createLibraryImport({
                request,
                workspaceId,
                bridgeId: parsed.data.bridgeId,
                originalName: download.fileName,
                sourcePath: download.filePath,
                sizeBytes: download.sizeBytes,
                folderId: parsed.data.folderId ?? null,
                persistLibraryFile
              })
              response.status(201).json(remoteImportUploadResponseSchema.parse({
                file,
                resolution,
                canPrintDirectly: isDirectPrintableFileName(file.name)
              }))
            } finally {
              await cleanupTempPath(download.cleanupPath)
            }
            return
          }

          if (resolution.strategy !== 'server-download' || resolution.directFileKind == null || resolution.directFileKind === 'other') {
            throw badRequest(resolution.message)
          }

          const download = await downloadToTemp(importUrl)
          try {
            const file = await createLibraryImport({
              request,
              workspaceId,
              bridgeId: parsed.data.bridgeId,
              originalName: download.fileName,
              sourcePath: download.filePath,
              sizeBytes: download.sizeBytes,
              folderId: parsed.data.folderId ?? null,
              persistLibraryFile
            })
            response.status(201).json(remoteImportUploadResponseSchema.parse({
              file,
              resolution,
              canPrintDirectly: isDirectPrintableFileName(file.name)
            }))
          } finally {
            await cleanupTempPath(download.cleanupPath)
          }
        }
      )

      context.router.post(
        '/import-upload',
        requireRequestPermission(LIBRARY_UPLOAD_PERMISSION),
        requireFileUploadsAllowed,
        uploadSingle('file'),
        async (request, response) => {
          if (!request.file) {
            throw badRequest('No file uploaded')
          }
          const workspaceId = requireRequestWorkspaceId(request)
          const bridgeId = typeof request.body?.bridgeId === 'string' ? request.body.bridgeId.trim() : ''
          if (!bridgeId) {
            await unlink(request.file.path).catch(() => undefined)
            throw badRequest('Bridge id is required')
          }
          const folderId = typeof request.body?.folderId === 'string' && request.body.folderId.trim()
            ? request.body.folderId.trim()
            : null
          const sourceUrl = typeof request.body?.sourceUrl === 'string' ? request.body.sourceUrl.trim() : ''
          // No source URL means the helper posted bytes it had already fetched. The
          // synthetic URL only carries the file NAME through the same classifier, so
          // the response describes the file the same way either path reached it.
          const resolution = sourceUrl
            ? detectRemoteImportUrl(sourceUrl)
            : detectRemoteImportUrl(`https://upload.invalid/${encodeURIComponent(request.file.originalname || 'imported-file')}`)
          try {
            const file = await createLibraryImport({
              request,
              workspaceId,
              bridgeId,
              originalName: request.file.originalname,
              sourcePath: request.file.path,
              sizeBytes: request.file.size,
              folderId,
              persistLibraryFile
            })
            response.status(201).json(remoteImportUploadResponseSchema.parse({
              file,
              resolution,
              canPrintDirectly: isDirectPrintableFileName(file.name)
            }))
          } finally {
            await unlink(request.file.path).catch(() => undefined)
          }
        }
      )
    }
  }
}

type ExtensionWorkspace = {
  id: string
  slug: string
  name: string
  description?: string | null
}

type ExtensionWorkspaceEntry<TWorkspace extends ExtensionWorkspace = ExtensionWorkspace> = {
  workspace: TWorkspace
  bridgeCount: number
}

async function listExtensionImportWorkspaces(request: Request): Promise<ExtensionWorkspaceEntry[]> {
  if (request.auth.actor.type === 'anonymous') {
    if (request.auth.authEnabled) return []
    return await countWorkspaceBridges(await filterEnabledWorkspaces({
      workspaces: await listWorkspaces(rootPrisma)
    }))
  }

  if (request.auth.actor.type === 'service-account') {
    const workspace = request.auth.actor.workspace
    if (!workspace || !request.auth.permissions.includes(LIBRARY_UPLOAD_PERMISSION)) return []
    return await countWorkspaceBridges([workspace])
  }

  if (request.auth.actor.isPlatformUser) {
    return await listPlatformUserImportWorkspaces(request.auth.actor.userId, request.auth.platformPermissions ?? request.auth.permissions)
  }

  return await listMemberImportWorkspaces(request.auth.actor.userId)
}

/** Workspaces the user belongs to and may upload into. */
async function listMemberImportWorkspaces(userId: string): Promise<ExtensionWorkspaceEntry[]> {
  const memberships = await rootPrisma.authWorkspaceMembership.findMany({
    where: {
      userId,
      loginDisabled: false
    },
    select: {
      workspace: {
        select: {
          id: true,
          slug: true,
          name: true,
          description: true
        }
      }
    }
  })
  const workspaces = await filterEnabledWorkspaces({ workspaces: memberships.map((membership) => membership.workspace) })
  const uploadWorkspaceIds = await listUserUploadWorkspaceIds(userId, workspaces.map((workspace) => workspace.id))
  return await countWorkspaceBridges(workspaces.filter((workspace) => uploadWorkspaceIds.has(workspace.id)))
}

/** Member workspaces plus any support-accessible workspace whose policy allows uploads. */
async function listPlatformUserImportWorkspaces(
  userId: string,
  platformPermissions: readonly Permission[]
): Promise<ExtensionWorkspaceEntry[]> {
  const memberEntries = await listMemberImportWorkspaces(userId)
  const memberWorkspaceIds = new Set(memberEntries.map((entry) => entry.workspace.id))
  const bypassSupportAccess = hasSupportAccessBypass(platformPermissions)
  const supportWorkspaces = (await listSupportAccessibleWorkspaces({ bypassSupportAccess }))
    .filter((workspace) => !memberWorkspaceIds.has(workspace.id))

  // One batched read rather than a lookup per workspace: a platform user's
  // accessible set is the whole deployment, and this route is reachable without
  // authenticating, so the per-workspace version scaled a query count with it.
  const permissionsByWorkspace = await readSupportAccessPermissionsForWorkspaces({
    workspaceIds: supportWorkspaces.map((workspace) => workspace.id),
    bypassSupportAccess
  })
  const supportImportWorkspaces = supportWorkspaces.filter(
    (workspace) => permissionsByWorkspace.get(workspace.id)?.includes(LIBRARY_UPLOAD_PERMISSION) ?? false
  )

  return [...memberEntries, ...await countWorkspaceBridges(supportImportWorkspaces)]
    .sort((left, right) => left.workspace.name.localeCompare(right.workspace.name))
}

async function listUserUploadWorkspaceIds(userId: string, workspaceIds: readonly string[]): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set()

  const memberships = await rootPrisma.authUserGroupMembership.findMany({
    where: {
      userId,
      group: {
        workspaceId: { in: [...workspaceIds] }
      }
    },
    select: {
      group: {
        select: {
          workspaceId: true,
          permissions: true
        }
      }
    }
  })

  const uploadWorkspaceIds = new Set<string>()
  for (const membership of memberships) {
    const workspaceId = membership.group.workspaceId
    if (workspaceId && membership.group.permissions.includes(LIBRARY_UPLOAD_PERMISSION)) {
      uploadWorkspaceIds.add(workspaceId)
    }
  }
  return uploadWorkspaceIds
}

async function countWorkspaceBridges<TWorkspace extends ExtensionWorkspace>(
  workspaces: readonly TWorkspace[]
): Promise<Array<ExtensionWorkspaceEntry<TWorkspace>>> {
  if (workspaces.length === 0) return []

  const bridges = await rootPrisma.bridge.findMany({
    where: {
      workspaceId: { in: workspaces.map((workspace) => workspace.id) }
    },
    select: {
      workspaceId: true
    }
  })
  const bridgeCounts = new Map<string, number>()
  for (const bridge of bridges) {
    if (!bridge.workspaceId) continue
    bridgeCounts.set(bridge.workspaceId, (bridgeCounts.get(bridge.workspaceId) ?? 0) + 1)
  }

  return workspaces
    .map((workspace) => ({ workspace, bridgeCount: bridgeCounts.get(workspace.id) ?? 0 }))
    .sort((left, right) => left.workspace.name.localeCompare(right.workspace.name))
}

/**
 * What the UI needs to say about MakerWorld imports: whether the workspace turned
 * the feature on, whether an account is actually reachable, and whose it is.
 *
 * Resolved together because they are only meaningful together: "enabled" with no
 * connected account is a button that always fails, and a connected account with the
 * setting off must not be used. The account label is display-only; the token behind
 * it never leaves the server.
 */
async function describeMakerWorldCapability(
  context: ApiPluginContext,
  workspaceId: string
): Promise<{ enabled: boolean; accountConnected: boolean; accountLabel: string | null }> {
  const enabled = await readMakerWorldOptIn(context, workspaceId)
  const credential = await bambuAccountResolvers.resolve({ workspaceId })
  return {
    enabled,
    accountConnected: credential != null,
    accountLabel: credential?.accountLabel ?? null
  }
}

async function readMakerWorldOptIn(context: ApiPluginContext, workspaceId: string): Promise<boolean> {
  // Absent means ON, only an explicit 'false' disables it. See the setting's doc.
  return (await context.settings.forWorkspace(workspaceId).get(MAKERWORLD_ACCOUNT_IMPORT_SETTING)) !== 'false'
}

/**
 * The credential for a MakerWorld download, or a 400 explaining which half is
 * missing. Both refusals are ordinary states a user can fix, so they get their own
 * messages rather than one generic "unavailable": the fixes are in different places
 * (this plugin's setting vs the Bambu Cloud connection).
 */
async function resolveOptedInMakerWorldCredential(
  context: ApiPluginContext,
  workspaceId: string
): Promise<BambuAccountCredential> {
  if (!await readMakerWorldOptIn(context, workspaceId)) {
    throw badRequest('MakerWorld imports are turned off for this workspace. Enable them in the remote imports plugin settings, or use the browser helper extension.')
  }
  const credential = await bambuAccountResolvers.resolve({ workspaceId })
  if (!credential) {
    throw badRequest('No Bambu Lab account is connected for this workspace. Connect one in the Bambu Cloud settings to import from MakerWorld.')
  }
  return credential
}

async function createLibraryImport(input: {
  request: Request
  workspaceId: string
  bridgeId: string
  originalName: string
  sourcePath: string
  sizeBytes: number
  /** Chosen destination; null means the default `Imported models` folder. */
  folderId: string | null
  persistLibraryFile: typeof persistLibraryFileFromLocalPath
}): Promise<LibraryFile> {
  const safeOriginalName = sanitizeImportFileName(input.originalName)
  if (!isImportableLibraryFileKind(classifyLibraryFileKind(safeOriginalName))) {
    throw badRequest(IMPORTABLE_EXTENSIONS_MESSAGE)
  }

  // Only create the landing folder when the caller named no destination, an import
  // into a chosen folder must not also mint `Imported models` as a side effect.
  const folderId = input.folderId ?? await ensureLibraryFolderPath({
    workspaceId: input.workspaceId,
    bridgeId: input.bridgeId,
    baseFolderId: null,
    segments: [IMPORTED_MODELS_FOLDER_NAME]
  })

  const { file } = await input.persistLibraryFile({
    workspaceId: input.workspaceId,
    sourcePath: input.sourcePath,
    fileName: safeOriginalName,
    sizeBytes: input.sizeBytes,
    folderId,
    // The folder wins when both are present (`persistLibraryFileFromLocalPath` reads
    // the folder's owner), so this only matters for the default-folder path.
    bridgeId: input.bridgeId,
    hidden: false,
    request: input.request,
    auditAction: 'import',
    missingBridgeMessage: 'Select a bridge before importing to the library'
  })

  return toCreatedLibraryFileDto(file)
}

export async function downloadToTempFile(url: string, options: {
  /**
   * Name to store the download under, when the caller knows it better than the URL
   * does. MakerWorld's signed CDN links end in an opaque UUID, so the real file name
   * only exists in the API response that produced the link.
   */
  fileNameOverride?: string
} = {}): Promise<{
  fileName: string
  filePath: string
  cleanupPath: string
  sizeBytes: number
}> {
  await mkdir(uploadDir, { recursive: true })
  const tempRoot = await mkdtemp(path.join(uploadDir, 'download-'))
  const response = await fetchRemoteImportUrl(url)
  if (!response.ok) {
    await cleanupTempPath(tempRoot)
    throw badRequest(`Remote file responded ${response.status}`)
  }
  if (!response.body) {
    await cleanupTempPath(tempRoot)
    throw badRequest('Remote file response had no body')
  }

  const headerFileName = parseContentDispositionFileName(response.headers.get('content-disposition'))
  const urlFileName = extractUrlFileName(url)
  const originalName = sanitizeImportFileName(options.fileNameOverride ?? headerFileName ?? urlFileName ?? 'imported-file')
  const targetPath = path.join(tempRoot, originalName)
  const contentLength = parseContentLength(response.headers.get('content-length'))
  if (contentLength != null && contentLength > MAX_IMPORT_BYTES) {
    await cleanupTempPath(tempRoot)
    throw new HttpError(413, `File exceeds ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB upload limit`)
  }
  try {
    await writeRemoteImportBody(response.body as unknown as NodeReadableStream<Uint8Array>, targetPath, MAX_IMPORT_BYTES)
  } catch (error) {
    await cleanupTempPath(tempRoot)
    throw error
  }
  const fileStat = await stat(targetPath)
  return {
    fileName: originalName,
    filePath: targetPath,
    cleanupPath: tempRoot,
    sizeBytes: fileStat.size
  }
}

async function fetchRemoteImportUrl(url: string): Promise<globalThis.Response> {
  let currentUrl = url
  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_IMPORT_REDIRECTS; redirectCount += 1) {
    await assertRemoteImportUrlAllowed(currentUrl)
    const response = await fetch(currentUrl, { redirect: 'manual' })
    if (!isRedirectResponse(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response
    currentUrl = new URL(location, currentUrl).toString()
  }
  throw badRequest('Remote file redirected too many times')
}

/**
 * Rejects URLs that resolve into the deployment's own network, before any request
 * is made, and again for every redirect hop (see {@link fetchRemoteImportUrl}),
 * because the first hop being public says nothing about where hop two points.
 *
 * Known residual gap: the name is resolved here and then independently again by
 * `fetch`, so a record that changes between the two (DNS rebinding) can still slip
 * through. Closing it means pinning the resolved address into the connection,
 * which `fetch` exposes no hook for, a custom dispatcher `lookup` is the fix if
 * this ever guards something more valuable than a file download.
 */
export async function assertRemoteImportUrlAllowed(
  rawUrl: string,
  lookupAddresses: RemoteImportAddressLookup = (hostname, options) => dnsLookup(hostname, options) as Promise<Array<{ address: string; family: number }>>
): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw badRequest('Invalid remote file URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('Remote file URL must use HTTP or HTTPS')
  }

  // `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`), which `isIP`
  // does not recognise: strip them so a literal address is range-checked here
  // rather than falling through to a DNS lookup that would only error out.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw badRequest('Remote file URL points to a private or local network address')
  }
  if (isBlockedRemoteImportAddress(hostname)) {
    throw badRequest('Remote file URL points to a private or local network address')
  }
  // A literal address is already range-checked above and needs no resolution.
  if (isIP(hostname) !== 0) return

  const records = await lookupAddresses(hostname, { all: true, verbatim: true })
  if (records.some((record) => isBlockedRemoteImportAddress(record.address))) {
    throw badRequest('Remote file URL points to a private or local network address')
  }
}

export function isBlockedRemoteImportAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase()
  if (!normalized) return true
  const withoutIpv6Prefix = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized
  const family = isIP(withoutIpv6Prefix)
  if (family === 4) return isBlockedIpv4Address(withoutIpv6Prefix)
  if (family === 6) return isBlockedIpv6Address(normalized)
  return false
}

async function writeRemoteImportBody(body: NodeReadableStream<Uint8Array>, targetPath: string, maxBytes: number): Promise<void> {
  let receivedBytes = 0
  const limitedBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          receivedBytes += value.byteLength
          if (receivedBytes > maxBytes) {
            controller.error(new HttpError(413, `File exceeds ${Math.round(maxBytes / (1024 * 1024))} MB upload limit`))
            await reader.cancel().catch(() => undefined)
            return
          }
          controller.enqueue(value)
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    }
  })
  await pipeline(Readable.fromWeb(limitedBody as unknown as NodeReadableStream<Uint8Array>), createWriteStream(targetPath))
}

function isRedirectResponse(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function parseContentLength(header: string | null): number | null {
  if (!header) return null
  const parsed = Number.parseInt(header, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function isBlockedIpv4Address(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const first = parts[0]!
  const second = parts[1]!
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 198 && (second === 18 || second === 19)) return true
  if (first >= 224) return true
  return false
}

function isBlockedIpv6Address(address: string): boolean {
  if (address === '::' || address === '::1') return true
  // Link-local is fe80::/10: fe80 through febf, not only the fe80: prefix.
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true
  // Unique-local is fc00::/7: fc00 through fdff.
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true
  if (address.startsWith('ff')) return true
  return false
}

function sanitizeImportFileName(raw: string): string {
  const safe = path.posix.basename(raw.replace(/\\/g, '/')).replace(/[^\w.-]+/g, '_')
  if (!safe || safe === '.' || safe === '..') {
    throw badRequest('Invalid filename')
  }
  return safe
}

function extractUrlFileName(url: string): string | null {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).at(-1)
    if (!last) return null
    return decodeURIComponent(last)
  } catch {
    return null
  }
}

function parseContentDispositionFileName(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star?.[1]) {
    return decodeURIComponent(star[1].trim())
  }
  const basic = /filename="?([^"]+)"?/i.exec(header)
  return basic?.[1]?.trim() ?? null
}

async function cleanupTempPath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true }).catch(() => undefined)
}
