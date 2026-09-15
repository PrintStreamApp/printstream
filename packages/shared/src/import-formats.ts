/**
 * The catalogue of model formats the editor can STAGE as geometry: which extensions name each one,
 * what to call it in a message, and the order they are offered in.
 *
 * OWNS the answer to "is this file importable, and as what". Everything that needed that used to
 * derive it separately -- an extension chain in `three-mf/mesh-stl.ts`, a format-to-extensions map in
 * the web's import store, a hand-written union on the staging worker's request, a capability list on
 * each of the two import stores, and two prose strings in the api's refusals. Six lists, one fact.
 * Adding STEP had already left them disagreeing about `.stp`, and adding three formats at once would
 * have made that permanent, so the fact lives here and each of those derives from it.
 *
 * CONTRACT. `detectImportFormat` is the ONLY way to turn a filename into a format: it is what the
 * api's two import routes refuse on, what the local store refuses on, and what decides which parser
 * runs. A format present here but absent from a host's parser dispatch is a file the picker offers
 * and the parse then rejects, which reads as a broken import rather than an unsupported one -- so
 * `StagedImportFormat` being exhaustive over the parse dispatch is checked by the type system, and
 * the two hosts are checked against each other in `editorImportStore.test.ts`.
 *
 * WHAT THIS IS NOT. It says nothing about how a format is PARSED or what a host has to load to do
 * it (STEP's OpenCASCADE WASM, the browser's in-tab ZIP). That is per-host and stays per-host; only
 * the naming is shared. Nor is it the LIBRARY's file-kind axis (`classifyLibraryFileKind` in
 * `printer-contracts.ts`), which answers a different question -- what a stored file IS, including
 * G-code and formats nothing can import -- and deliberately keeps its own list.
 */

/**
 * Extensions per format, in the order a file picker offers them. Lowercase and dot-prefixed,
 * because {@link detectImportFormat} matches on a lowercased filename suffix.
 *
 * `.glb` and `.gltf` are ONE format: they are the binary and JSON containers of the same asset
 * definition and the parser sniffs which by magic number, exactly as `.step`/`.stp` are one STEP.
 *
 * Order is existing-formats-first rather than alphabetical, so the `accept` string and the refusal
 * messages keep naming the three formats most users arrive with before the ones added later.
 */
export const IMPORT_FORMAT_EXTENSIONS = {
  stl: ['.stl'],
  step: ['.step', '.stp'],
  '3mf': ['.3mf'],
  obj: ['.obj'],
  gltf: ['.gltf', '.glb'],
  amf: ['.amf'],
  fbx: ['.fbx']
} as const satisfies Readonly<Record<string, readonly [string, ...string[]]>>

/** Every staged-import format, in offer order. The source the `StagedImportFormat` enum derives from. */
export const STAGED_IMPORT_FORMATS = Object.keys(IMPORT_FORMAT_EXTENSIONS) as [
  StagedImportFormatName,
  ...StagedImportFormatName[]
]

type StagedImportFormatName = keyof typeof IMPORT_FORMAT_EXTENSIONS

/**
 * How each format is NAMED to a user. Not derivable from the key: the key is a wire value chosen for
 * brevity, while `glTF` is capitalised the way its spec capitalises it and `3MF` is not `3mf`.
 */
export const IMPORT_FORMAT_LABELS: Readonly<Record<StagedImportFormatName, string>> = {
  stl: 'STL',
  step: 'STEP',
  '3mf': '3MF',
  obj: 'OBJ',
  gltf: 'glTF',
  amf: 'AMF',
  fbx: 'FBX'
}

/**
 * Detect the import format from a file name extension. Returns null for anything unsupported, which
 * every caller treats as "refuse this file".
 *
 * Matches the longest extension first so a compound name cannot be claimed by a shorter sibling.
 * Nothing in the current table overlaps, but `.gcode.3mf` already exists one axis over
 * (`isDirectPrintableFileName`) as proof that suffixes here do collide in practice.
 */
export function detectImportFormat(fileName: string): StagedImportFormat | null {
  const lower = fileName.toLowerCase()
  let match: { format: StagedImportFormat; length: number } | null = null
  for (const [format, extensions] of Object.entries(IMPORT_FORMAT_EXTENSIONS)) {
    for (const extension of extensions) {
      if (!lower.endsWith(extension)) continue
      if (match != null && match.length >= extension.length) continue
      match = { format: format as StagedImportFormat, length: extension.length }
    }
  }
  return match?.format ?? null
}

/** Every extension for the given formats, flattened for a file input's `accept` attribute. */
export function importFormatExtensions(formats: readonly StagedImportFormat[]): string[] {
  return formats.flatMap((format) => [...IMPORT_FORMAT_EXTENSIONS[format]])
}

/**
 * The formats named as a user-facing list ("STL, STEP, 3MF, OBJ, glTF, AMF and FBX"), for the refusals
 * that have to say what WOULD have been accepted.
 *
 * Derived rather than written out because those strings sat in the api's two import routes and were
 * already the thing most likely to be forgotten: a message naming three formats on a server that
 * accepts six is worse than no message, since it tells the user their file is unsupported when it is
 * merely misnamed.
 */
export function describeImportFormats(formats: readonly StagedImportFormat[] = STAGED_IMPORT_FORMATS): string {
  const labels = formats.map((format) => IMPORT_FORMAT_LABELS[format])
  if (labels.length <= 1) return labels[0] ?? ''
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/**
 * A staged-import format. Declared here rather than inferred from the Zod schema because the schema
 * derives from {@link STAGED_IMPORT_FORMATS}, and inferring in the other direction would make the
 * table's own types circular.
 */
export type StagedImportFormat = StagedImportFormatName
