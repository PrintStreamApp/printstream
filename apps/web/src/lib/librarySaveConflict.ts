/**
 * Client-side prediction of which existing file a library save will replace.
 *
 * Mirrors the server's overwrite matching (`findLibraryOverwriteTarget`, used by
 * `unhideSlicedOutput` and the upload/persist path in
 * apps/api/src/lib/library-files.ts): a save replaces an existing file only when
 * the FINAL saved name — the edited base name plus the flow's declared
 * extension — equals that file's name exactly (case-sensitive, like the server).
 *
 * Base-name overlap with a different extension is deliberately NOT a conflict:
 * saving `benchy` + `.gcode.3mf` next to `benchy.gcode` (or `benchy.stl`)
 * creates a new file on the server, so warning about a replace would be false.
 */
export function findLibrarySaveConflict<T extends { name: string }>(
  files: readonly T[],
  baseName: string,
  extension?: string
): T | null {
  const trimmed = baseName.trim()
  if (!trimmed) return null
  const finalName = extension ? `${trimmed}${extension}` : trimmed
  return files.find((file) => file.name === finalName) ?? null
}
