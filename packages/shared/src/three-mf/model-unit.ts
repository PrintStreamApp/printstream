/**
 * The `<model unit>` attribute, and the scale factor a non-millimetre 3MF needs.
 *
 * OWNS the port of BambuStudio's `bbs_get_unit_factor` (`bbs_3mf.cpp:618-635`). The 3MF core spec
 * lets a model declare its coordinate space in micron, millimetre, centimetre, inch, foot or metre,
 * defaulting to millimetre when the attribute is absent or unrecognised. BambuStudio honours it
 * (`m_unit_factor`, applied at `:3595`) and always WRITES `millimeter` (`:6945`), so every file it
 * produces is 1.0 and the attribute only matters for foreign files.
 *
 * WHY IT MATTERS HERE. Bambu projects are never affected, but a CAD tool exporting in inches is
 * ordinary, and such a file can be imported for its GEOMETRY ("Import Object" / "Add model" accept
 * `.3mf`). Read as millimetres, an inch-declared model arrives 25.4 times too small: not an error,
 * just a model the user has to notice and rescale by hand, if they notice at all.
 *
 * It cannot be reached by OPENING such a file as a project: without `model_settings.config` the
 * index parser classifies it `geometryOnly` and every project surface refuses it. Import is the
 * one door, which is why this is applied there rather than in the bake.
 *
 * NOT HANDLED: the per-OBJECT `unit` attribute the importer also reads (`bbs_3mf.cpp:5457`). It is
 * a rare corner of the spec, nothing in the corpus uses it, and mixing units within one model needs
 * a per-object factor threaded through component resolution. Worth doing if a real file turns up.
 */

/**
 * Millimetres per unit, mirroring `bbs_get_unit_factor` including its default-to-millimetre rule.
 *
 * Exported because the same numbers answer a SECOND question BambuStudio asks elsewhere: the
 * editor's manual "Convert from inch" / "Convert from meter" (`ModelObject::convert_units`,
 * `Model.cpp:1868`, which hardcodes 25.4 and 1000) rescales a model whose author worked in another
 * unit but whose file DECLARES none. Reading the declaration and rescaling by hand are different
 * features, but an inch is 25.4 mm in both, and the two disagreeing would be a bug with no symptom
 * beyond a model the wrong size.
 */
export const MODEL_UNIT_MILLIMETRES: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000
}

/**
 * The units BambuStudio offers a MANUAL conversion from, in its own order (`ConversionType`,
 * `Model.hpp:756`). It deliberately offers only these two of the six the spec allows: a model
 * authored in microns or feet is not a mistake anyone makes often enough to earn a menu row.
 */
export const CONVERTIBLE_MODEL_UNITS = ['inch', 'meter'] as const

export type ConvertibleModelUnit = (typeof CONVERTIBLE_MODEL_UNITS)[number]

/**
 * The millimetre scale factor for a root model document, or 1 when it declares none.
 *
 * An UNRECOGNISED unit deliberately returns 1 rather than throwing, matching the engine's `else`
 * branch: the spec says to default to millimetres, and refusing an import over an attribute the
 * engine shrugs at would be stricter than the thing we are trying to agree with.
 */
export function threeMfModelUnitFactor(modelXml: string): number {
  const openTag = /<model\b[^>]*>/.exec(modelXml)?.[0]
  if (!openTag) return 1
  const unit = /\bunit\s*=\s*"([^"]*)"/.exec(openTag)?.[1]?.trim().toLowerCase()
  if (!unit) return 1
  return MODEL_UNIT_MILLIMETRES[unit] ?? 1
}
