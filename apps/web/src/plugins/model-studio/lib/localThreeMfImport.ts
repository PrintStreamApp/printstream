/**
 * Reads a 3MF the user picked as an IMPORT (not as the open project) for the server-less host.
 *
 * The api answers the same question by unzipping the upload with yauzl; here the file never leaves
 * the tab, so it is unzipped in a worker (`zipArchiveClient` via {@link openThreeMfArchive}) and fed
 * to the SAME shared extractor. Nothing about which plate, which parts, or how they are re-centred
 * lives here — that is `@printstream/shared/three-mf`'s `mesh-extract.ts`, so the two hosts cannot
 * disagree about what a given file contributes.
 *
 * Counterpart: `apps/api/src/lib/three-mf-mesh-extract.ts`.
 */
import {
  buildSceneManifest,
  extractThreeMfImportMesh,
  type ImportedMesh,
  type ThreeMfImportSource
} from '@printstream/shared/three-mf'
import { openThreeMfArchive, type ThreeMfArchive } from './threeMfArchive'
import { threeMfIndexFromArchive } from './threeMfArchiveIndex'

/** Wraps an already-open archive as the shared extractor's byte source. */
export function threeMfArchiveImportSource(archive: ThreeMfArchive): ThreeMfImportSource {
  return {
    async readEntryText(entryPath) {
      return archive.entryText(entryPath)
    },
    async readPlateIndexes() {
      // Through the shared builder, not a second copy of its six-argument call: the plate list is
      // what decides WHICH plate's geometry an import takes, so a drift here is a silently wrong
      // import rather than an error.
      return threeMfIndexFromArchive(archive).plates.map((plate) => plate.index)
    },
    async readScene(plateIndex) {
      const sceneEntries = archive.sceneEntries()
      // Throwing (rather than returning an empty scene) is what selects the extractor's vanilla-3MF
      // fallback: a file with no Bambu metadata has no scene to read, not an empty one.
      if (!sceneEntries) throw new Error('This 3MF has no Bambu scene metadata')
      return buildSceneManifest(sceneEntries, plateIndex)
    }
  }
}

/**
 * Extract a picked 3MF's printed geometry, in the tab.
 *
 * The archive is disposable — it exists only for this extraction — so it is opened and dropped here
 * rather than being held, unlike the OPEN project's archive which the editor keeps for its session.
 */
export async function extractThreeMfImportFromFile(file: Blob): Promise<ImportedMesh> {
  const archive = await openThreeMfArchive(file)
  return extractThreeMfImportMesh(threeMfArchiveImportSource(archive))
}
