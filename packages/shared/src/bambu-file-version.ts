/**
 * Bambu 3MF project version vs slicer engine version.
 *
 * OWNS: deciding whether a project was saved by a Bambu Studio NEWER than the engine asked to
 * slice it, which BambuStudio refuses outright.
 *
 * WHY. `BambuStudio.cpp` gates on the loaded project's version before it opens anything:
 *
 *   if (!allow_newer_file && ((cli.maj() < file.maj()) || (cli.maj() == file.maj() && cli.min() < file.min())))
 *       -> CLI_FILE_VERSION_NOT_SUPPORTED (return -24, process exit 232)
 *
 * Two properties of that check drive everything here, and both are easy to get wrong:
 *  - It compares **major and minor ONLY**. Patch and build are ignored, so a 2.7.1.62 engine opens
 *    any 2.7.x project including 2.7.9, and refuses 2.8.0 — comparing full version strings would
 *    both over- and under-report.
 *  - It is a REFUSAL, not a degradation: nothing about the project is wrong and no setting works
 *    around it. The only outs are a newer engine or the CLI's own `--allow-newer-file` escape
 *    hatch, which the user must consciously accept (an older engine can silently misread newer
 *    features, so a successful slice is not proof the gcode is right).
 *
 * Versions arrive in two shapes and both must parse: the 3MF writes zero-padded
 * (`"02.08.00.50"`, from `project_settings.config`'s `version`) while our slicer target registry
 * carries the plain form (`"2.7.1.62"`).
 */

/** Major/minor of a Bambu version string, or null when it isn't one. */
export function parseBambuMajorMinor(version: string | null | undefined): { major: number; minor: number } | null {
  if (!version) return null
  const match = version.trim().match(/^(\d+)\.(\d+)/)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null
  return { major, minor }
}

/** `02.08.00.50` -> `2.8.0.50`, for display next to our plain-form target versions. */
export function formatBambuVersion(version: string | null | undefined): string | null {
  if (!version) return null
  const trimmed = version.trim()
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null
  return trimmed.split('.').map((part) => String(Number(part))).join('.')
}

/**
 * True when `projectVersion` would be refused by an engine at `engineVersion` — i.e. exactly the
 * condition BambuStudio itself tests (major.minor only). False whenever either side is unknown:
 * an unparseable version must never block a slice that would have worked.
 */
export function isProjectNewerThanSlicer(
  projectVersion: string | null | undefined,
  engineVersion: string | null | undefined
): boolean {
  const project = parseBambuMajorMinor(projectVersion)
  const engine = parseBambuMajorMinor(engineVersion)
  if (!project || !engine) return false
  if (engine.major !== project.major) return engine.major < project.major
  return engine.minor < project.minor
}
