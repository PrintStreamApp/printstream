/**
 * Reading a BambuStudio preset the user supplied — validation, kind detection, and unpacking a
 * preset ARCHIVE into its individual presets.
 *
 * Shared because both surfaces accept preset uploads: the api stores them against a workspace, and
 * the public editor keeps them in the user's own browser (no account, so nowhere else to put them).
 * The rules for what counts as a valid preset, and what kind it is, must not differ between those —
 * a file accepted in one place and rejected in the other would be indefensible.
 *
 * ZIP INFLATE is the one part that stays per-surface, injected as {@link PresetArchiveReader}: the
 * api has yauzl, the browser has fflate, and neither belongs in shared. Everything else here is
 * pure.
 *
 * Errors are plain `Error`s. The api wraps them in `badRequest` at its boundary; the browser shows
 * the message. Shared code has no business knowing about HTTP status codes.
 */
import { slicingPresetKindSchema, type SlicingPresetKind } from './slicing.js'

/** One preset extracted from an upload, before it is given an id or stored anywhere. */
export interface UploadedProfileEntry {
  content: string
  kind?: SlicingPresetKind
  name?: string
}

/** What an upload looks like regardless of where it is headed. */
export interface UploadedProfileInput {
  content: string
  encoding?: 'utf8' | 'base64'
  kind?: SlicingPresetKind
  name?: string
}

/**
 * Inflates a preset archive to its JSON entries. Supplied by the caller because the ZIP
 * implementation differs per surface; only entries the caller considers preset JSON need be
 * returned.
 */
export type PresetArchiveReader = (bytes: Uint8Array) => Promise<UploadedProfileEntry[]>

/** BambuStudio preset exports are ZIPs; detect one by its local/central/spanned signature. */
export function isZipArchiveBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const [a, b, c, d] = [bytes[0], bytes[1], bytes[2], bytes[3]]
  if (a !== 0x50 || b !== 0x4b) return false
  return (c === 0x03 && d === 0x04) || (c === 0x05 && d === 0x06) || (c === 0x07 && d === 0x08)
}

export function parseProfileJson(content: string, fallbackKind?: SlicingPresetKind): { raw: Record<string, unknown>; kind: SlicingPresetKind; name: string } {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error('Profile must be valid BambuStudio JSON')
  }
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) throw new Error('Profile must be a JSON object')
  const record = raw as Record<string, unknown>
  const kind = detectProfileKind(record, fallbackKind)
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name) throw new Error('Profile must include a name')
  if (isInternalBambuStudioResourceName(name)) throw new Error('Profile is a BambuStudio helper resource, not a slicing preset')
  record.type = kind
  return { raw: record, kind, name }
}

function detectProfileKind(record: Record<string, unknown>, fallbackKind?: SlicingPresetKind): SlicingPresetKind {
  const typeKind = slicingPresetKindSchema.safeParse(record.type)
  const detectedKind = typeKind.success ? typeKind.data : detectProfileKindFromSettingsIds(record)
  if (detectedKind && fallbackKind && detectedKind !== fallbackKind) {
    throw new Error('Profile type does not match the selected profile kind')
  }
  const kind = detectedKind ?? fallbackKind
  if (!kind) throw new Error('Profile kind could not be detected from the BambuStudio preset')
  return kind
}

function detectProfileKindFromSettingsIds(record: Record<string, unknown>): SlicingPresetKind | undefined {
  // Match BambuStudio's `import_json_presets()` logic in PresetBundle.cpp,
  // where the owning collection is inferred from these settings ids.
  if (Object.hasOwn(record, 'printer_settings_id')) return 'machine'
  if (Object.hasOwn(record, 'print_settings_id')) return 'process'
  if (Object.hasOwn(record, 'filament_settings_id')) return 'filament'
  return undefined
}

function isInternalBambuStudioResourceName(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\\/]+/g, '_').replace(/\s+/g, '_')
  return normalized.startsWith('fdm_')
    || normalized.startsWith('filament_')
    || normalized.startsWith('filaments_')
    || normalized.includes('recommended_params')
}

/**
 * Turn an upload into its individual presets. A base64 payload that is a ZIP is inflated through
 * `readArchive`; anything else is treated as a single preset document.
 *
 * A single-preset archive keeps the name the user gave the upload — a bundle of several keeps each
 * preset's own name, since one supplied name cannot describe them all.
 */
export async function extractUploadedProfiles(
  input: UploadedProfileInput,
  readArchive: PresetArchiveReader
): Promise<UploadedProfileEntry[]> {
  const encoding = input.encoding ?? 'utf8'
  if (encoding !== 'base64') return [{ content: input.content, kind: input.kind, name: input.name }]

  const bytes = decodeBase64(input.content)
  if (!bytes.length) throw new Error('Uploaded profile file is empty')
  if (!isZipArchiveBytes(bytes)) {
    return [{ content: new TextDecoder().decode(bytes), kind: input.kind, name: input.name }]
  }

  let archiveProfiles: UploadedProfileEntry[]
  try {
    archiveProfiles = await readArchive(bytes)
  } catch {
    throw new Error('Preset archive must be a valid BambuStudio preset export')
  }
  if (archiveProfiles.length === 0) throw new Error('Preset archive did not contain any preset JSON files')
  if (archiveProfiles.length === 1 && input.name?.trim()) {
    const [only] = archiveProfiles
    if (!only) throw new Error('Preset archive did not contain any preset JSON files')
    return [{ content: only.content, kind: only.kind, name: input.name.trim() }]
  }
  return archiveProfiles
}

function decodeBase64(value: string): Uint8Array {
  // `atob` in the browser, `Buffer` in Node — each exists only in its own runtime, and shared code
  // must not carry Node types, hence the structural lookup rather than a direct reference.
  const runtime = globalThis as unknown as {
    atob?: (encoded: string) => string
    Buffer?: { from(encoded: string, encoding: string): Uint8Array }
  }
  if (typeof runtime.atob === 'function') {
    const binary = runtime.atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  if (runtime.Buffer) return new Uint8Array(runtime.Buffer.from(value, 'base64'))
  throw new Error('This environment cannot decode a base64 upload')
}
