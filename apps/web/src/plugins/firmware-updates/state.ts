import { wsEventSchema } from '@printstream/shared'

export interface AvailableVersion {
  version: string
  fileAvailable: boolean
  releaseNotes: string | null
  releaseTime: string | null
}

export interface UpdateReport {
  printerId: string
  printerName: string
  model: string
  /** Whether the printer is currently reachable — firmware can only be uploaded when online. */
  online: boolean
  currentVersion: string | null
  sdCardPresent: boolean | null
  latestVersion: string | null
  updateAvailable: boolean
  downloadUrl: string | null
  releaseNotes: string | null
  availableVersions: AvailableVersion[]
}

export interface UpdatesResponse {
  updates: UpdateReport[]
  updatesAvailable: number
}

export type UploadStatus = 'idle' | 'preparing' | 'downloading' | 'uploading' | 'complete' | 'cancelled' | 'error'

export interface UploadProgress {
  printerId: string
  status: UploadStatus
  progress: number
  message: string
  error: string | null
  firmwareFilename: string | null
  firmwareVersion: string | null
}

export interface FirmwareStatusSnapshot {
  printerId: string
  online: boolean
  firmwareVersion: string | null
  sdCardPresent: boolean | null
}

export const UPDATES_STORAGE_KEY = 'bambu.firmware-updates.cache.v1'

export function getUpdatesStorageKey(scopeKey: string): string {
  return `${UPDATES_STORAGE_KEY}.${scopeKey}`
}

export function isActiveUploadStatus(status: UploadStatus | undefined): boolean {
  return status === 'preparing' || status === 'downloading' || status === 'uploading'
}

export function shouldPollUploadProgress(progress: UploadProgress | undefined): boolean {
  return isActiveUploadStatus(progress?.status)
}

export function readStoredUpdates(scopeKey: string): UpdatesResponse | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(getUpdatesStorageKey(scopeKey))
    if (!raw) return undefined
    return JSON.parse(raw) as UpdatesResponse
  } catch {
    return undefined
  }
}

export function writeStoredUpdates(scopeKey: string, data: UpdatesResponse): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(getUpdatesStorageKey(scopeKey), JSON.stringify(data))
  } catch {
    // Ignore storage failures; the live query result still works.
  }
}

export function parseUploadProgressEvent(raw: unknown): UploadProgress | null {
  const parsed = wsEventSchema.safeParse(raw)
  if (!parsed.success) return null

  const event = parsed.data
  if (event.type !== 'plugin.event' || event.pluginName !== 'firmware-updates') return null

  const inner = event.event as Partial<UploadProgress> & { kind?: string }
  if (inner.kind !== 'upload-progress' || typeof inner.printerId !== 'string') return null

  return {
    printerId: inner.printerId,
    status: (inner.status as UploadStatus) ?? 'idle',
    progress: typeof inner.progress === 'number' ? inner.progress : 0,
    message: typeof inner.message === 'string' ? inner.message : '',
    error: typeof inner.error === 'string' ? inner.error : null,
    firmwareFilename: typeof inner.firmwareFilename === 'string' ? inner.firmwareFilename : null,
    firmwareVersion: typeof inner.firmwareVersion === 'string' ? inner.firmwareVersion : null
  }
}

export function parseFirmwareStatusEvent(raw: unknown): FirmwareStatusSnapshot | null {
  const parsed = wsEventSchema.safeParse(raw)
  if (!parsed.success || parsed.data.type !== 'printer.status') return null

  return {
    printerId: parsed.data.status.printerId,
    online: parsed.data.status.online,
    firmwareVersion: parsed.data.status.firmwareVersion,
    sdCardPresent: parsed.data.status.sdCardPresent
  }
}

export function shouldInvalidateFirmwareUpdates(
  previous: FirmwareStatusSnapshot | undefined,
  next: FirmwareStatusSnapshot
): boolean {
  if (!previous) return true
  return previous.printerId !== next.printerId
    || previous.online !== next.online
    || previous.firmwareVersion !== next.firmwareVersion
    || previous.sdCardPresent !== next.sdCardPresent
}

export function getInstallableVersions(update: UpdateReport | undefined): AvailableVersion[] {
  return update?.availableVersions.filter((version) => version.fileAvailable) ?? []
}

export function getDefaultSelectedVersion(
  update: UpdateReport | undefined,
  installableVersions = getInstallableVersions(update)
): string | null {
  if (!update) return installableVersions[0]?.version ?? null
  if (update.latestVersion && installableVersions.some((version) => version.version === update.latestVersion)) {
    return update.latestVersion
  }
  return installableVersions[0]?.version ?? null
}

export function isInstallableVersionSelected(
  installableVersions: AvailableVersion[],
  selectedVersion: string | null
): boolean {
  return Boolean(selectedVersion && installableVersions.some((version) => version.version === selectedVersion))
}

export function isDowngradeSelection(update: UpdateReport | undefined, selectedVersion: string | null): boolean {
  return Boolean(selectedVersion && update?.currentVersion && selectedVersion !== update.latestVersion)
}

export function getSelectedReleaseNotes(update: UpdateReport | undefined, selectedVersion: string | null): string | null {
  if (!selectedVersion || !update) return null
  return update.availableVersions.find((version) => version.version === selectedVersion)?.releaseNotes ?? null
}

export function isUploadedVersionLatest(
  update: UpdateReport | undefined,
  progress: UploadProgress | undefined
): boolean {
  return Boolean(
    progress?.firmwareVersion
    && update?.latestVersion
    && progress.firmwareVersion === update.latestVersion
  )
}

export function firmwareStillPendingInstall(
  update: UpdateReport | undefined,
  progress: UploadProgress | undefined
): boolean {
  return Boolean(
    update
    && progress?.status === 'complete'
    && progress.firmwareVersion
    && progress.firmwareVersion !== update.currentVersion
  )
}

export function shouldShowFirmwareUpdateChip(
  update: UpdateReport | undefined,
  _progress: UploadProgress | undefined
): boolean {
  return Boolean(update?.updateAvailable)
}

export function formatVersionTag(version: string | null | undefined): string {
  return version ? ` ${version}` : ''
}

export function formatFirmwareChipLabel(
  update: UpdateReport | undefined,
  progress: UploadProgress | undefined
): string {
  if (!progress || progress.status === 'idle') return update?.updateAvailable ? 'Update' : 'Firmware'
  if (progress.status === 'complete') return `Flash${formatVersionTag(progress.firmwareVersion)}`
  if (progress.status === 'cancelled') return 'Cancelled'
  if (progress.status === 'error') return 'Upload failed'
  if (progress.status === 'uploading') return progress.progress > 0 ? `Uploading ${progress.progress}%` : 'Uploading'
  if (progress.status === 'downloading') return progress.progress > 0 ? `Downloading ${progress.progress}%` : 'Downloading'
  return 'Preparing update'
}

export function firmwareChipColor(
  update: UpdateReport | undefined,
  progress: UploadProgress | undefined
): 'neutral' | 'warning' | 'primary' | 'success' | 'danger' {
  if (!progress || progress.status === 'idle') return update?.updateAvailable ? 'warning' : 'neutral'
  if (progress.status === 'complete') return 'success'
  if (progress.status === 'error') return 'danger'
  if (progress.status === 'cancelled') return 'warning'
  return 'primary'
}