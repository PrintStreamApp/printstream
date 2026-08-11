/**
 * Slicing presets the user uploaded on a host with no workspace to keep them in.
 *
 * Signed in, presets belong to the workspace and the api stores them — that is unchanged. This is
 * only for the public editor, where there is no account and nowhere else to put them, so they live
 * in the browser and never leave the machine (the same promise the file itself carries).
 *
 * PARSING is the shared one (`@printstream/shared`), deliberately: the rules for what counts as a
 * valid BambuStudio preset and what kind it is mirror BambuStudio's own `import_json_presets()`,
 * and a file accepted here but rejected by the workspace would be indefensible. Only the ZIP inflate
 * is local, via the bounded zip worker (`zipArchiveClient.ts`).
 *
 * Storage is `localStorage` rather than IndexedDB on purpose: a preset is a few KB of JSON, a whole
 * bundle a few hundred, so the simpler synchronous store is a better fit than an async schema — and
 * a quota failure is reported plainly rather than being swallowed. Revisit if presets ever grow to
 * megabytes.
 */
import { unzipArchiveBytes } from './zipArchiveClient'
import {
  extractUploadedProfiles,
  parseProfileJson,
  type SlicingPresetKind,
  type UploadedProfileEntry
} from '@printstream/shared'

/** One preset held in the browser, before it is matched against a catalogue. */
export interface LocalSlicingPreset {
  id: string
  kind: SlicingPresetKind
  name: string
  /** The preset document as BambuStudio wrote it, which is what a slice would need. */
  raw: Record<string, unknown>
  addedAt: string
}

export class LocalSlicingPresetError extends Error {}

/**
 * Keeps the legacy `…Profiles` spelling on purpose. Everything else in this area was renamed
 * profile -> preset, but this key names data already sitting in users' browsers: renaming it
 * would silently orphan every preset they have uploaded to the public editor. Reserved, not
 * missed — migrate it only with a read-old/write-new pass.
 */
const STORAGE_KEY = 'printstream.modelStudio.localSlicingProfiles'

/** Read every stored preset. A corrupt store yields nothing rather than breaking the settings page. */
export function listLocalSlicingPresets(): LocalSlicingPreset[] {
  const raw = readStorage()?.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isLocalProfile) : []
  } catch {
    return []
  }
}

/**
 * Parse an uploaded preset file and store it. A bundle yields several presets, all stored.
 *
 * Replaces any stored preset of the same kind and name — re-uploading an edited preset is the
 * expected way to update one, and silently keeping both would leave the user picking between
 * identical-looking entries.
 */
export async function addLocalSlicingPresets(file: File): Promise<LocalSlicingPreset[]> {
  const entries = await readUpload(file)
  const existing = listLocalSlicingPresets()
  const added: LocalSlicingPreset[] = []

  for (const entry of entries) {
    const { raw, kind, name } = parseOrThrow(entry)
    added.push({ id: `local:${kind}:${name}`, kind, name, raw, addedAt: new Date().toISOString() })
  }

  const replaced = new Set(added.map((profile) => profile.id))
  writeStorage([...existing.filter((profile) => !replaced.has(profile.id)), ...added])
  return added
}

export function removeLocalSlicingPreset(id: string): void {
  writeStorage(listLocalSlicingPresets().filter((profile) => profile.id !== id))
}

export function clearLocalSlicingPresets(): void {
  readStorage()?.removeItem(STORAGE_KEY)
}

/** Turn the picked file into preset entries, inflating a preset archive with fflate. */
async function readUpload(file: File): Promise<UploadedProfileEntry[]> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // The shared extractor decides whether this is an archive; it takes base64 for the binary case,
  // matching the api upload contract rather than inventing a second one.
  const isJson = file.name.toLowerCase().endsWith('.json')
  const input = isJson
    ? { fileName: file.name, encoding: 'utf8' as const, content: new TextDecoder().decode(bytes) }
    : { fileName: file.name, encoding: 'base64' as const, content: toBase64(bytes) }
  try {
    return await extractUploadedProfiles(input, inflatePresetArchive)
  } catch (error) {
    throw new LocalSlicingPresetError(error instanceof Error ? error.message : 'That preset file could not be read.')
  }
}

/** Unzip via the bounded zip worker, keeping only the JSON entries a preset archive is made of. */
async function inflatePresetArchive(bytes: Uint8Array): Promise<UploadedProfileEntry[]> {
  const files = await unzipArchiveBytes(bytes)
  const decoder = new TextDecoder()
  const entries: UploadedProfileEntry[] = []
  for (const [path, content] of Object.entries(files)) {
    // Directory markers and anything that is not a preset document are not errors — a
    // BambuStudio export carries other files alongside the presets.
    if (path.endsWith('/') || !path.toLowerCase().endsWith('.json')) continue
    entries.push({ content: decoder.decode(content) })
  }
  return entries
}

function parseOrThrow(entry: UploadedProfileEntry): { raw: Record<string, unknown>; kind: SlicingPresetKind; name: string } {
  try {
    return parseProfileJson(entry.content, entry.kind)
  } catch (error) {
    throw new LocalSlicingPresetError(error instanceof Error ? error.message : 'That preset could not be read.')
  }
}

function isLocalProfile(value: unknown): value is LocalSlicingPreset {
  if (typeof value !== 'object' || value == null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.name === 'string' && typeof record.raw === 'object'
}

function readStorage(): Storage | null {
  try {
    // Via `window`, matching `useLocalStorageState` — the app's other browser-storage consumer.
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // Storage access throws outright when the browser blocks it (private mode, third-party
    // restrictions). Presets are then simply unavailable rather than the editor failing to load.
    return null
  }
}

function writeStorage(profiles: LocalSlicingPreset[]): void {
  const storage = readStorage()
  if (!storage) throw new LocalSlicingPresetError('This browser is not allowing PrintStream to store presets.')
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(profiles))
  } catch {
    // Quota is the realistic failure. Say so, rather than reporting a save that did not happen.
    throw new LocalSlicingPresetError('There is no room left in this browser to store more presets. Remove one and try again.')
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked: String.fromCharCode takes the whole slice as arguments and blows the limit on a
  // multi-megabyte preset archive.
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}
