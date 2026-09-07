/**
 * Which archive entries a plate's preview PNG occupies, and which previews are worth writing.
 *
 * Owns the NAMING and the validity rule, so the two hosts that embed previews cannot disagree about
 * either: the API rewrites a file on disk (`embedPlateThumbnails` in `lib/three-mf-output.ts`, yauzl
 * to yazl) and the browser writes entries straight into the archive it is deflating
 * (`clientThreeMfBake.ts`, fflate). Only the ZIP I/O differs, which is the same split the bake
 * itself keeps.
 *
 * Why it matters that both do it: an editor SAVE runs no slicer, so nothing else regenerates a
 * plate preview. A host that skips this writes a file whose embedded previews still show the layout
 * the project had before the edit, and every surface that reads them (the library card, the plate
 * strip, BambuStudio's own project view) shows the stale one with nothing indicating it is stale.
 *
 * BambuStudio reads two entries per plate and we write the SAME image to both. It renders the small
 * variant at a smaller size rather than expecting different pixels, and the editor renders one
 * preview per plate; writing a genuinely downscaled copy would cost a second render for no visible
 * difference.
 */
import type { SceneEditPlateThumbnail } from '../slicing.js'

/** One preview, resolved to the entries it occupies and the bytes to write there. */
export interface PlateThumbnailEntry {
  /** Archive entry path, e.g. `Metadata/plate_1.png`. */
  name: string
  png: Uint8Array
}

/** The entry paths a plate's preview occupies. `plateIndex` is 1-based, as the archive names it. */
export function plateThumbnailEntryNames(plateIndex: number): readonly string[] {
  return [`Metadata/plate_${plateIndex}.png`, `Metadata/plate_${plateIndex}_small.png`]
}

/**
 * The entries to write for a set of plate previews, skipping any that cannot name a plate or carry
 * no image.
 *
 * Rejects rather than repairs: a preview with a non-positive or non-integer index does not identify
 * a plate, and an empty PNG would replace a good preview with a broken entry, which reads to every
 * consumer as a corrupt archive rather than as a missing thumbnail.
 *
 * Later entries win, so a list carrying two previews for one plate embeds the last, matching the
 * order the caller supplied rather than silently preferring one.
 */
export function plateThumbnailEntries(
  thumbnails: ReadonlyArray<{ plateIndex: number; png: Uint8Array }>
): PlateThumbnailEntry[] {
  const byName = new Map<string, Uint8Array>()
  for (const { plateIndex, png } of thumbnails) {
    if (!Number.isInteger(plateIndex) || plateIndex <= 0 || png.length === 0) continue
    for (const name of plateThumbnailEntryNames(plateIndex)) byName.set(name, png)
  }
  return [...byName].map(([name, png]) => ({ name, png }))
}

/**
 * Decode the wire form, where a preview rides a `SceneEdit` as base64 (no `data:` prefix: the editor
 * strips it at capture).
 *
 * A preview that does not decode is DROPPED rather than throwing. It is a cosmetic entry, and
 * failing a save over one would lose the user's actual work over a picture.
 */
export function decodePlateThumbnails(
  thumbnails: readonly SceneEditPlateThumbnail[] | undefined,
  decodeBase64: (value: string) => Uint8Array
): Array<{ plateIndex: number; png: Uint8Array }> {
  if (!thumbnails?.length) return []
  const decoded: Array<{ plateIndex: number; png: Uint8Array }> = []
  for (const thumbnail of thumbnails) {
    try {
      decoded.push({ plateIndex: thumbnail.plateIndex, png: decodeBase64(thumbnail.png) })
    } catch {
      continue
    }
  }
  return decoded
}
