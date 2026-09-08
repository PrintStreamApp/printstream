import type { ProcessSettingOption } from '@printstream/shared'

/**
 * Display form of a SERIALIZED setting value.
 *
 * Owns the one rule for turning a config scalar into text a human reads: bools as on/off, enum
 * codes through the catalogue's labels, numbers with the option's unit. Callers hold the
 * serialized form throughout (it is what the config, the 3MF and the wire all carry) and reach
 * for this only at the moment of rendering, so it deliberately does not round-trip -- there is
 * no inverse, and an enum label is not a value.
 *
 * Shared because two surfaces show the same setting and must agree on it: the process dialog's
 * recommendation prompt ("Support: on") and the parameter table's cells. A second formatter would
 * let one render `1` where the other renders `on` for the same key, which reads as two different
 * settings rather than one shown twice.
 *
 * An option we do not know is returned VERBATIM rather than guessed at. That is the safe
 * direction: an unlabelled raw value is merely terse, while a value formatted against the wrong
 * option is confidently wrong (an enum index rendered through another enum's labels names a
 * setting the user never chose).
 *
 * @param option the catalogue entry for the key, or undefined when the key is not in the catalogue
 * @param value the serialized scalar, exactly as the config carries it
 * @param opts `sentenceCase` capitalises the boolean words for a standalone context (a table cell,
 *   a chip). Left off, they stay lower case so the value reads correctly INSIDE a sentence, which
 *   is what the recommendation prompt needs. Only bools are affected: an enum label is authored
 *   text and is never re-cased, or "outer brim only" would come back as something the catalogue
 *   does not say.
 */
export function formatSettingValueForDisplay(
  option: ProcessSettingOption | undefined,
  value: string,
  opts?: { sentenceCase?: boolean }
): string {
  if (!option) return value
  if (option.type === 'bool') {
    const on = value === '1'
    if (opts?.sentenceCase) return on ? 'On' : 'Off'
    return on ? 'on' : 'off'
  }
  if (option.type === 'enum') {
    const index = option.enumValues?.indexOf(value) ?? -1
    return option.enumLabels?.[index] ?? value
  }
  // An EMPTY value has no unit: this used to render " mm", a bare unit with nothing in front of it,
  // wherever a config key is present but blank. Tested with `=== ''` and not `trim() === ''` so it
  // agrees exactly with `isUnsetCellValue`, the predicate the parameter table sorts by: a
  // whitespace-only value that one called SET and the other called empty would sort among the rows
  // that have a value while painting as blank, which is the split verdict both exist to avoid.
  if (!option.sidetext || value === '') return value
  // A `percent` / `floatOrPercent` value SERIALIZES with its sign ("15%") while the option also
  // carries "%" as its sidetext, so appending unconditionally renders "15% %". The unit is only
  // ever a suffix, so a value already ending in it is already complete. Trailing space matters:
  // "40 mm" must not swallow the "mm" of a value that genuinely reads "40mm".
  const unit = option.sidetext.trim()
  if (unit && value.trimEnd().endsWith(unit)) return value
  return `${value} ${option.sidetext}`
}
