/**
 * The `Application` metadata that decides whether BambuStudio reads a project's settings at all.
 *
 * OWNS the one whole-file gate a save can lose by accident. The importer only sets
 * `m_is_bbl_3mf` and a generator version when the root model carries a metadata element whose text
 * starts with `BambuStudio-` and whose remainder parses as a Semver (`bbs_3mf.cpp:4075-4081`).
 * Without it, `dont_load_config` is forced true (`:1905-1908`) and the ENTIRE config half of the
 * archive is skipped: project settings, per-object bindings, plates, filaments. The file still
 * opens, and it opens as bare geometry with every setting silently gone.
 *
 * WHY A SAVE CAN LOSE IT. Only the from-scratch scaffold ever wrote the marker. A copy-path save
 * inherits whatever the base carried, so any base without one produced a settings-less project, and
 * the damage compounds: the saved file has no marker either, so re-opening and re-saving cannot
 * recover what the first open already discarded. Nothing warned, because from OUR side the settings
 * are all present in the file we wrote.
 *
 * WHY STAMPING IS NOT GUESSING. This is not a repair of someone else's data, it is a writer naming
 * the format it just wrote. We author Bambu-shaped documents (`model_settings.config`,
 * `project_settings.config`, plates) whether the base had them or not, so declaring the file as
 * BambuStudio-generated is the accurate statement; omitting it is the inaccurate one.
 *
 * WHY THE VERSION DOES NOT TRACK THE VENDORED SOURCE. Only the `BambuStudio-` prefix and a parseable
 * Semver matter to the importer: the load path's version comparison is commented out
 * (`bbs_3mf.cpp`, the `file_version.maj() > app_version.maj()` block). What the number DOES drive is
 * desktop BambuStudio's "newer 3mf version" dialog, which fires whenever the file's version exceeds
 * the app's and their minors differ (`Plater.cpp`): so raising this to match a freshly vendored
 * engine would nag every user who has not yet updated, on every project we save, to no benefit.
 * Below 2.0.0 there are legacy fixups (prime-tower params, plate translation) we equally do not
 * want, so the value sits deliberately in between: high enough to skip the fixups, low enough to
 * stay quiet. Revisit it when the FILE FORMAT we author changes, not when the engine pin moves.
 */

/** The generator token. Must start with `BambuStudio-`, and the rest must parse as a Semver. */
export const THREE_MF_APPLICATION_MARKER = 'BambuStudio-02.07.01.57'

const APPLICATION_METADATA = /<metadata\s+name="Application"\s*>([^<]*)<\/metadata>/i

/** Whether a root model already declares itself BambuStudio-generated in the form the importer accepts. */
export function hasApplicationMarker(modelXml: string): boolean {
  const value = modelXml.match(APPLICATION_METADATA)?.[1]?.trim()
  return value != null && value.startsWith('BambuStudio-')
}

/**
 * Guarantee the root model carries the generator marker, returning the XML unchanged when it does.
 *
 * A marker naming some OTHER generator is replaced rather than left, because the importer's test is
 * a prefix match: a value of `PrusaSlicer-2.8` is, to it, exactly as absent as no element at all,
 * and leaving it would preserve the appearance of provenance while losing every setting.
 */
export function ensureApplicationMarker(modelXml: string): string {
  if (hasApplicationMarker(modelXml)) return modelXml
  const marker = `  <metadata name="Application">${THREE_MF_APPLICATION_MARKER}</metadata>`
  if (APPLICATION_METADATA.test(modelXml)) return modelXml.replace(APPLICATION_METADATA, marker.trim())
  // Must be a child of <model>, so it goes immediately after the opening tag rather than before
  // <resources>, which a model built from scratch may not have yet.
  const openTag = modelXml.match(/<model\b[^>]*>/)
  if (!openTag?.[0]) return modelXml
  return modelXml.replace(openTag[0], `${openTag[0]}\n${marker}`)
}
