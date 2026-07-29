/**
 * Opening and saving a 3MF that lives on the user's own disk.
 *
 * The public editor has no library behind it: the file comes from a picker or a drop, is parsed in
 * the tab (`threeMfArchive.ts`), and is written back by `clientThreeMfBake.ts`. This module is the
 * bit in between — where the bytes come from and where they go.
 *
 * Two tiers, because browser support is split:
 *  - **File System Access** (Chromium): we keep the handle the user picked, so "Save" overwrites
 *    the very file they opened, like a desktop app. Re-saving does not accumulate copies.
 *  - **Download fallback** (Firefox, Safari): every save produces a new download. Callers should
 *    say so in the UI rather than implying an in-place save happened.
 *
 * The API is deliberately handle-shaped rather than path-shaped: a browser never learns the file's
 * real path, and a handle is the only thing that can be written back.
 */
import { downloadBlob } from '../../../lib/downloadBlob'

/**
 * Minimal structural typings for the File System Access API, which the bundled DOM lib does not
 * declare. Narrow on purpose — only what this module calls, so a future lib.dom that does declare
 * these stays compatible.
 */
interface FileSystemWritable {
  write(data: BufferSource | Blob | string): Promise<void>
  close(): Promise<void>
}
interface FileHandle {
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<FileSystemWritable>
  /** Present on real handles; absent on older implementations, which are then assumed writable. */
  queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
}
interface FilePickerWindow {
  showOpenFilePicker?: (options?: {
    multiple?: boolean
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<FileHandle[]>
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<FileHandle>
}

const THREE_MF_PICKER_TYPES = [{ description: '3MF project', accept: { 'model/3mf': ['.3mf'] } }]

/** A 3MF the user opened from their own machine. */
export interface LocalProjectFile {
  /** File name as the user knows it, for the editor heading and any later download. */
  name: string
  /** The bytes as opened, ready for `openThreeMfArchive`. */
  blob: Blob
  /**
   * Overwrite the file the user opened. Null when this file arrived by a route that yields no
   * writable handle (a drop, an `<input type=file>`, or a browser without File System Access) —
   * the caller falls back to {@link downloadProjectBytes} and should word its UI accordingly.
   */
  saveInPlace: ((bytes: Uint8Array) => Promise<void>) | null
}

/** Whether this browser can overwrite a file the user picked, rather than only download a copy. */
export function supportsFileSystemAccess(): boolean {
  const picker = globalThis as unknown as FilePickerWindow
  return typeof picker.showOpenFilePicker === 'function' && typeof picker.showSaveFilePicker === 'function'
}

/**
 * Show the system file picker.
 *
 * Resolves null when the user dismisses it — a cancelled picker is a normal outcome, not an error
 * to surface. Any other failure propagates, since it means the pick genuinely broke.
 */
export async function openLocalProjectFile(): Promise<LocalProjectFile | null> {
  const picker = globalThis as unknown as FilePickerWindow
  if (!picker.showOpenFilePicker) return null
  let handle: FileHandle | undefined
  try {
    const handles = await picker.showOpenFilePicker({ multiple: false, types: THREE_MF_PICKER_TYPES })
    handle = handles[0]
  } catch (error) {
    if (isPickerDismissal(error)) return null
    throw error
  }
  if (!handle) return null
  const file = await handle.getFile()
  return { name: file.name, blob: file, saveInPlace: (bytes) => writeHandle(handle, bytes) }
}

/**
 * The fallback picker for browsers without File System Access (Firefox, Safari): a plain file
 * input. Resolves null when the user dismisses the dialog.
 *
 * The input is ATTACHED to the document and removed only once it has answered. A detached input is
 * eligible for garbage collection as soon as this function returns, taking its `change` listener
 * with it — the user then picks a file and nothing happens at all, with no error anywhere to
 * explain why. `cancel` is handled too so the promise cannot hang on a dismissed dialog.
 */
export function pickLocalProjectFileViaInput(): Promise<LocalProjectFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.3mf'
    input.style.display = 'none'
    document.body.appendChild(input)
    const settle = (file: File | null) => { input.remove(); resolve(file ? localProjectFileFromFile(file) : null) }
    input.addEventListener('cancel', () => settle(null), { once: true })
    input.addEventListener('change', () => settle(input.files?.[0] ?? null), { once: true })
    input.click()
  })
}

/**
 * Wrap a file that arrived without a picker — a drop, or an `<input type=file>`. There is no
 * writable handle in either case, so this project can only ever be saved as a download.
 */
export function localProjectFileFromFile(file: File): LocalProjectFile {
  return { name: file.name, blob: file, saveInPlace: null }
}

/**
 * "Save as": ask for a destination and write there, returning the handle-backed project so
 * subsequent saves overwrite it. Resolves null if the user dismisses the picker.
 *
 * Falls back to a download when the browser has no picker, in which case there is nothing to keep
 * writing to and the result's `saveInPlace` is null.
 */
export async function saveLocalProjectAs(
  suggestedName: string,
  bytes: Uint8Array
): Promise<LocalProjectFile | null> {
  const picker = globalThis as unknown as FilePickerWindow
  if (!picker.showSaveFilePicker) {
    downloadProjectBytes(suggestedName, bytes)
    return { name: suggestedName, blob: blobFor(bytes), saveInPlace: null }
  }
  let handle: FileHandle
  try {
    handle = await picker.showSaveFilePicker({ suggestedName, types: THREE_MF_PICKER_TYPES })
  } catch (error) {
    if (isPickerDismissal(error)) return null
    throw error
  }
  await writeHandle(handle, bytes)
  return { name: handle.name, blob: blobFor(bytes), saveInPlace: (next) => writeHandle(handle, next) }
}

/** Download the bytes as a file. The only save route on browsers without File System Access. */
export function downloadProjectBytes(fileName: string, bytes: Uint8Array): void {
  downloadBlob(blobFor(bytes), ensureThreeMfExtension(fileName))
}

/**
 * A save-as default derived from the open project: same base name with a `.3mf` extension. Kept
 * separate from the picker call so the suggestion is testable without a browser.
 */
export function suggestedSaveName(openName: string): string {
  const trimmed = openName.trim()
  return ensureThreeMfExtension(trimmed.length > 0 ? trimmed : 'project.3mf')
}

function ensureThreeMfExtension(fileName: string): string {
  if (/\.3mf$/i.test(fileName)) return fileName
  // Only strip something that actually looks like an extension: starts with a letter, no spaces,
  // short. A plain `\.[^.]*$` swallowed the tail of names like "v1.2 bracket", which then saved as
  // "v1.3mf" -- the user's name silently truncated.
  return `${fileName.replace(/\.[A-Za-z][A-Za-z0-9]{0,7}$/, '')}.3mf`
}

function blobFor(bytes: Uint8Array): Blob {
  // Copy into a fresh view: the caller's array may be a slice of a larger buffer, which Blob would
  // otherwise capture whole.
  return new Blob([new Uint8Array(bytes)], { type: 'model/3mf' })
}

async function writeHandle(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  await ensureWritable(handle)
  const writable = await handle.createWritable()
  try {
    await writable.write(blobFor(bytes))
  } finally {
    // Closing is what commits the write; skipping it on an error path would leave a locked,
    // half-written file behind.
    await writable.close()
  }
}

/**
 * A handle from `showOpenFilePicker` carries READ permission only — writing to it needs an explicit
 * readwrite grant, which the browser prompts for. Without this, the first Save on an opened file
 * fails with NotAllowedError even though the user picked the file themselves.
 *
 * Must run inside the save click's transient activation, or the prompt is suppressed and the grant
 * is refused with no dialog.
 */
async function ensureWritable(handle: FileHandle): Promise<void> {
  if (!handle.queryPermission || !handle.requestPermission) return
  if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return
  if (await handle.requestPermission({ mode: 'readwrite' }) === 'granted') return
  throw new Error('PrintStream needs permission to write to this file. Allow it when your browser asks, or use Save as.')
}

/** A dismissed picker rejects with AbortError; every other rejection is a real failure. */
function isPickerDismissal(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
