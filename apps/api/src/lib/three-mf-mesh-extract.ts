/**
 * Node ZIP I/O for the shared 3MF geometry import.
 *
 * Every DECISION, which plate, which parts, component recursion, transform composition,
 * re-centring, part naming, the triangle cap, lives in `@printstream/shared/three-mf`
 * (`mesh-extract.ts`), because the browser runs the same extraction over a file the user picked in
 * the public 3MF editor, where nothing is uploaded. This file only answers "give me that entry's
 * bytes" with yauzl, and maps the shared refusal onto an HTTP 400.
 *
 * Counterpart: `apps/web/src/plugins/model-studio/lib/localImportStore.ts` (the in-tab archive).
 */
import {
  ThreeMfImportError,
  extractThreeMfImportMesh as extractFromSource,
  type ImportedMesh,
  type ThreeMfImportSource
} from '@printstream/shared/three-mf'
import { badRequest } from './http-error.js'
import { readEntry } from './three-mf-internal.js'
import { readPlateIndex, readSceneManifest, THREE_MF_MODEL_ENTRY_MAX_BYTES } from './three-mf-reader.js'

/**
 * Reads the archive off disk.
 *
 * An ABSENT entry reads as null, which the extractor skips (a dangling `<component>` reference must
 * not fail the whole import). Every other failure, a corrupt ZIP, an unreadable file, an entry over
 * the size cap, is rethrown: swallowing those turned "this archive is broken" into "this 3MF
 * contains no importable model geometry", which sends the user looking at the wrong thing.
 */
function nodeImportSource(filePath: string): ThreeMfImportSource {
  return {
    async readEntryText(entryPath) {
      try {
        return (await readEntry(filePath, entryPath, undefined, THREE_MF_MODEL_ENTRY_MAX_BYTES)).toString('utf8')
      } catch (error) {
        if (isMissingEntryError(error)) return null
        if (error instanceof Error && /^(Entry too large:|Entry exceeds the maximum decoded size)/.test(error.message)) {
          console.warn('[editor] 3MF import refused: model entry exceeds the 256 MiB limit')
          throw new ThreeMfImportError('This 3MF contains a model entry larger than the 256 MiB import limit.')
        }
        throw error
      }
    },
    async readPlateIndexes() {
      return (await readPlateIndex(filePath)).plates.map((plate) => plate.index)
    },
    readScene(plateIndex) {
      return readSceneManifest(filePath, plateIndex)
    }
  }
}

/**
 * `readEntry` signals a missing member with "Entry not found[: path]" (`three-mf-internal.ts`);
 * everything else it throws is a real read failure and must not be mistaken for an absent entry.
 */
function isMissingEntryError(error: unknown): boolean {
  return error instanceof Error && /^Entry not found\b/.test(error.message)
}

/**
 * Extract a 3MF's printed geometry as a staged-import mesh. `objectId` narrows the extraction to one
 * object (Bambu object id). Throws `badRequest` with the shared message when the file holds nothing
 * importable or exceeds the triangle cap.
 */
export async function extractThreeMfImportMesh(
  filePath: string,
  options?: { objectId?: number }
): Promise<ImportedMesh> {
  try {
    return await extractFromSource(nodeImportSource(filePath), options)
  } catch (error) {
    // The shared layer has no HTTP vocabulary, so the mapping happens here rather than there.
    if (error instanceof ThreeMfImportError) throw badRequest(error.message)
    throw error
  }
}
