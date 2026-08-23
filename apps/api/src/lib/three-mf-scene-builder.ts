/**
 * 3MF scene-builder: bake an editor arrangement (a `SceneEdit`) into a 3MF on disk.
 *
 * The Node half of the editor's write path. {@link buildEditedThreeMf} reads the handful of source
 * entries it needs out of the base archive, hands them to the pure document transforms in
 * the shared `three-mf/bake-documents.ts`, and streams the result into a new archive -- copying every entry it
 * did not rewrite verbatim. {@link writeArrangedThreeMf} is the thin in-project wrapper (no foreign
 * imports).
 *
 * All the 3MF domain knowledge lives in the documents module; what is here is ZIP I/O, the entry
 * read caps, and the copy pass. That is the seam that lets the browser run the same bake over bytes
 * the user picked -- see the documents module's header. This file re-exports that module so api
 * call sites keep importing the whole write surface from here.
 */
import { createWriteStream } from 'node:fs'
import type { SceneEdit } from '@printstream/shared'
import {
  emptyThreeMfBakeSource,
  planEditedThreeMf,
  readThreeMfBakeSource,
  type ImportedObjectInput,
  type ThreeMfBakeOptions,
  type ThreeMfBakeResult,
  type ThreeMfEntryTextReader
} from '@printstream/shared/three-mf'
import yauzl, { type Entry } from 'yauzl'
import yazl from 'yazl'
import { readEntry, readZipEntryBuffer } from './three-mf-internal.js'

// The api barrel still surfaces these two from here (`threeMfTransformFromTRS` and the
// `ImportedObjectInput` shape are part of the write API callers see), so re-export just those.
// Everything else pure now comes straight from `@printstream/shared/three-mf`.
export { threeMfTransformFromTRS, type ImportedObjectInput } from '@printstream/shared/three-mf'


/** Kept as the api-facing name for the shared bake result. */
export type BuildEditedThreeMfResult = ThreeMfBakeResult

/**
 * Build an edited 3MF from a base project (or from scratch when `baseSourcePath` is null) plus an
 * arrangement and a set of imported meshes.
 *
 * Everything this decides lives in the shared bake: {@link readThreeMfBakeSource} pulls the source
 * entries through the reader below, {@link planEditedThreeMf} turns them plus the `SceneEdit` into
 * a plan, and this function only performs the plan's I/O -- streaming the base archive through the
 * transforms, or writing a fresh one. Do not add rewriting logic here; it belongs in the shared
 * module, which the browser editor runs over the user's own bytes.
 */
export async function buildEditedThreeMf(
  baseSourcePath: string | null,
  outputPath: string,
  edit: SceneEdit,
  imports: ImportedObjectInput[] = [],
  options: ThreeMfBakeOptions = {}
): Promise<BuildEditedThreeMfResult> {
  const source = baseSourcePath
    ? await readThreeMfBakeSource(readThreeMfEntryText(baseSourcePath), edit)
    : emptyThreeMfBakeSource()
  const plan = planEditedThreeMf(source, edit, imports, options)

  if (plan.copy && baseSourcePath) {
    await rewriteThreeMfEntries(baseSourcePath, outputPath, plan.copy.transforms, plan.copy.appendEntries)
  } else {
    await writeFreshThreeMf(outputPath, plan.freshEntries ?? [])
  }
  // Judge the bake on what it WROTE. Every other invariant check runs on a file at rest, so a
  // defect the bake introduces stays invisible until someone reopens the project, which is how a
  // variant-scoped physics drop and an unbound object each reached users. Runs after the write
  // because the project-settings transform is applied lazily by it.
  //
  // Reports, never blocks or rewrites: the save has already succeeded, the reasons are all
  // repairable, and the file carries them into the same banner a reopen would raise. Healing here
  // instead would hide the authoring bug that produced them.
  const reasons = plan.settingsRepairReasons()
  if (reasons.length > 0) {
    console.warn(`[three-mf-bake] wrote ${outputPath} with repairable settings defects: ${reasons.join(', ')}${describeUnresolvedFilaments(edit)}`)
  }
  return plan.result
}

/**
 * Why a `filamentPhysics` repair could not have worked, when that is the answer.
 *
 * The restore is all-or-nothing across slots: the arrays are positional and per-key wide, so one
 * unresolved slot cannot be padded without both guessing a value and pushing the array past the real
 * slot count. It therefore writes NOTHING and the project stays flagged: correct, but from the
 * outside indistinguishable from a repair that silently failed, which is exactly how it was reported
 * ("I pressed Repair, it said it worked, and the banner came back").
 *
 * Naming the slots is the difference between an unexplained banner and a fixable one: a preset that
 * resolves in a workspace catalogue but not in the anonymous one is the known trigger, so the same
 * file can be repairable from one host and not another. Returns empty when every slot resolved, so
 * the line stays quiet about filaments when they are not the reason.
 */
function describeUnresolvedFilaments(edit: SceneEdit): string {
  const filaments = edit.filaments ?? []
  if (filaments.length === 0) return ''
  const unresolved = filaments
    .map((filament, index) => (filament.config == null ? index + 1 : null))
    .filter((slot): slot is number => slot !== null)
  if (unresolved.length === 0) return ''
  return ` (filament slots ${unresolved.join(', ')} resolved no preset, so their values could not be restored)`
}

/**
 * The bake's entry reader over a 3MF on disk. Absent or over-cap entries resolve to null, which is
 * the contract `readThreeMfBakeSource` expects -- it decides which of those are fatal (the root
 * model) and which have a defined fallback.
 */
function readThreeMfEntryText(sourcePath: string): ThreeMfEntryTextReader {
  return (entryPath, maxBytes) => readEntry(sourcePath, entryPath, undefined, maxBytes)
    .then((buffer) => buffer.toString('utf8'))
    .catch(() => null)
}


/** Write a brand-new 3MF (ZIP) from a fixed set of UTF-8 text entries. */
function writeFreshThreeMf(outputPath: string, entries: Array<{ name: string; content: string }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputZip = new yazl.ZipFile()
    const output = createWriteStream(outputPath)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (error) {
        output.destroy()
        reject(error)
      } else {
        resolve()
      }
    }
    outputZip.outputStream.pipe(output)
    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('finish', () => finish())
    for (const entry of entries) {
      outputZip.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name)
    }
    outputZip.end()
  })
}

/**
 * Write a copy of `sourcePath` whose plate arrangement matches `edit`: the `3D/3dmodel.model`
 * build items and `Metadata/model_settings.config` plates/instances are regenerated so moved,
 * rotated, scaled, cloned, removed, and re-plated models (across multiple plates) are honored at
 * slice time. Mesh geometry is copied verbatim from the source. Thin wrapper over
 * {@link buildEditedThreeMf} for the common case of an in-project edit with no foreign imports.
 */
export async function writeArrangedThreeMf(sourcePath: string, outputPath: string, edit: SceneEdit): Promise<void> {
  await buildEditedThreeMf(sourcePath, outputPath, edit, [])
}

/**
 * Copies every archive entry verbatim except those named in `transforms`, whose UTF-8 text is
 * passed through the matching transform. Generalizes {@link rewriteModelSettingsThreeMf} to rewrite
 * several entries in one streaming copy pass.
 */
function rewriteThreeMfEntries(
  sourcePath: string,
  outputPath: string,
  transforms: Map<string, (xml: string) => string | null>,
  extraEntries: Array<{ name: string; content: string }> = []
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true }, (openError, sourceZip) => {
      if (openError || !sourceZip) {
        reject(openError ?? new Error('Failed to open 3MF'))
        return
      }

      const outputZip = new yazl.ZipFile()
      const output = createWriteStream(outputPath)
      let settled = false

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        sourceZip.close()
        if (error) {
          output.destroy()
          reject(error)
        } else {
          resolve()
        }
      }

      outputZip.outputStream.pipe(output)
      outputZip.outputStream.on('error', finish)
      output.on('error', finish)
      output.on('finish', () => finish())

      // A 3MF reader rejects archives with two entries of the same name (e.g. a duplicate
      // model_settings.config surfaces as "Duplicated object id"), so never write a name twice.
      const writtenNames = new Set<string>()
      sourceZip.on('error', finish)
      sourceZip.on('end', () => {
        for (const entry of extraEntries) {
          if (writtenNames.has(entry.name)) continue
          writtenNames.add(entry.name)
          outputZip.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name)
        }
        outputZip.end()
      })
      sourceZip.on('entry', (entry: Entry) => {
        if (writtenNames.has(entry.fileName)) { sourceZip.readEntry(); return }
        writtenNames.add(entry.fileName)
        const transform = transforms.get(entry.fileName)
        if (transform) {
          readZipEntryBuffer(sourceZip, entry).then(
            (buffer) => {
              const rewritten = transform(buffer.toString('utf8'))
              // null DROPS the entry: the caller decided the source entry must not survive into
              // the save (a slice record that no longer describes the project's filaments).
              // Forget the name too, so an appended entry may still supply a replacement.
              if (rewritten === null) {
                writtenNames.delete(entry.fileName)
              } else {
                outputZip.addBuffer(Buffer.from(rewritten, 'utf8'), entry.fileName, { mtime: entry.getLastModDate() })
              }
              sourceZip.readEntry()
            },
            finish
          )
          return
        }
        if (entry.fileName.endsWith('/')) {
          outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
          sourceZip.readEntry()
          return
        }
        sourceZip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`Failed to read ${entry.fileName}`))
            return
          }
          stream.on('error', finish)
          stream.on('end', () => sourceZip.readEntry())
          outputZip.addReadStream(stream, entry.fileName, { mtime: entry.getLastModDate() })
        })
      })
      sourceZip.readEntry()
    })
  })
}
