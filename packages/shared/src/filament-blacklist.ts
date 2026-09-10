/**
 * Filament/printer compatibility rules: whether a given material, in a given slot, on a given
 * machine, is forbidden ("prohibition") or merely inadvisable ("warning").
 *
 * OWNS the port of BambuStudio's `DevFilaBlacklist::check_filaments_in_blacklist`
 * (`DeviceCore/DevFilaBlackList.cpp`). The RULES are generated from Studio's own data file into
 * `generated/filament-blacklist.generated.ts`; this module owns only the MATCHING and the wording.
 *
 * CONTRACT: `checkFilamentBlacklist` is the one place any surface asks "is this material a problem
 * here?". The print dialogs warn from it and the dispatch guard refuses from it, so a print can
 * never be refused by a check the dialog did not show. Callers must not re-implement a rule, and
 * must not filter the result by severity before showing it -- `blacklistProhibitions` /
 * `blacklistWarnings` exist so the two severities are split the same way everywhere.
 *
 * INVARIANTS worth knowing, because each looks like a bug and has a reason:
 *
 * - An ABSENT predicate matches everything. There is no wildcard sentinel; a rule naming no model
 *   applies to every model. That is why the generator refuses an unresolvable model code: a rule
 *   whose model list silently emptied would widen from "P1 series" to "every printer".
 * - `nozzleFlow` and `nozzleDiameter` treat "unknown" OPPOSITE ways, mirroring Studio exactly. An
 *   unknown flow never matches a flow-constrained rule (Studio compares `value_or("")`), while an
 *   unknown diameter BYPASSES a diameter constraint and the rule still matches (Studio guards that
 *   filter on `has_value()`). Do not "make them consistent": a diameter we failed to parse should
 *   still raise the material-level warning, and a flow we failed to parse should not invent an
 *   E3D-hotend prohibition for someone who has a stock nozzle.
 * - An unknown VENDOR reads as third party, because Studio's `third party` predicate is literally
 *   "not bambu lab" and an empty string satisfies it.
 * - `usedForSupport` / `usedForObject` are three-valued. A rule constraining one never matches when
 *   the caller does not know, since Studio compares two `std::optional<bool>`s. No shipped rule uses
 *   them today, so passing null keeps them correctly inert rather than guessing.
 *
 * WHY a port and not our own table: these rules encode which materials damage which hardware, and
 * Bambu is the only party who knows. They change between Studio releases, which is why they are
 * generated rather than hand-kept. Where we deliberately diverge (severity handling, the empty
 * substitution fallback) the divergence is commented in place.
 *
 * Counterparts: the API guard is `assertFilamentBlacklist` in
 * `apps/api/src/lib/print-filament-compatibility.ts`; the browser adapter is
 * `apps/web/src/lib/filamentBlacklist.ts`, rendered by `components/FilamentBlacklistAlert.tsx`.
 */
import {
  FILAMENT_BLACKLIST_RULES,
  type FilamentBlacklistAction,
  type FilamentBlacklistRule
} from './generated/filament-blacklist.generated.js'

export type { FilamentBlacklistAction, FilamentBlacklistRule }

/**
 * Everything a rule can key on, as one bag.
 *
 * Every field is nullable because every one of them can genuinely be unknown at check time: a tray
 * with no RFID has no filament id, an unparsed nozzle has no flow, a project filament has no
 * physical slot. Read the module header for what each kind of unknown does, since they differ.
 */
export interface FilamentBlacklistQuery {
  /** Canonical `PrinterModel` key. `unknown` matches only rules that name no model. */
  printerModel: string
  /** Bambu preset id, e.g. `GFU04`. Matched case-SENSITIVELY against a rule's exclusions. */
  filamentId: string | null
  /** Material type as reported, e.g. `TPU`, `PPS-CF`. */
  filamentType: string | null
  /** Full preset name, e.g. `Bambu TPU 85A`. */
  filamentName: string | null
  /** Brand. Anything other than `Bambu Lab` (including unknown) counts as third party. */
  filamentVendor: string | null
  nozzleFlow: string | null
  nozzleDiameter: number | null
  /** Physical extruder the slot feeds: 0 = right/main, 1 = left/deputy. */
  extruderId: number | null
  /** True for an external spool (tray 254/255), false for a slot in an AMS unit. */
  externalSpool: boolean
  /** Whether a Filament Track Switch is fitted; some rules only bite when one is. */
  hasFilamentSwitch: boolean
  /** `auto_pa` while running automatic pressure-advance calibration, else null. */
  calibMode: string | null
  /** Whether this filament prints support in the job being checked; null when not known. */
  usedForSupport: boolean | null
  /** Whether this filament prints object geometry in the job being checked; null when not known. */
  usedForObject: boolean | null
}

/** One rule that matched, already worded for display. */
export interface FilamentBlacklistFinding {
  action: FilamentBlacklistAction
  /** Complete sentence, `%s` already substituted. */
  message: string
  /** Bambu help page for this rule, when it has one. */
  wikiUrl: string | null
}

/** Tray indexes Bambu reserves for the external spool(s); everything else is an AMS slot. */
const EXTERNAL_SPOOL_TRAY_INDEXES = new Set([254, 255])

/** Whether a tray index addresses an external spool rather than a slot inside an AMS unit. */
export function isExternalSpoolTrayIndex(trayIndex: number | null | undefined): boolean {
  return trayIndex != null && EXTERNAL_SPOOL_TRAY_INDEXES.has(trayIndex)
}

function lower(value: string | null | undefined): string {
  return (value ?? '').toLowerCase()
}

/**
 * Diameters compare with a tolerance rather than `===`.
 *
 * Studio compares two 32-bit floats and gets exact hits; we parse ours out of a string
 * (`PrinterNozzle.diameter` is `"0.4"`) into a double. The values in play are all one or two
 * decimal places so exact equality would in fact work, but a tolerance costs nothing and means a
 * future `"0.40"` or a rounded report cannot silently stop matching a hardware rule.
 */
const DIAMETER_TOLERANCE = 1e-6

function diameterMatches(candidates: readonly number[], value: number): boolean {
  return candidates.some((candidate) => Math.abs(candidate - value) < DIAMETER_TOLERANCE)
}

/**
 * Whether a vendor string names Bambu, in EITHER vocabulary.
 *
 * The rules carry BambuStudio's raw `filament_vendor`, which is literally "Bambu Lab", while every
 * caller here speaks the app's display brand, which is "Bambu" -- `normalizeFilamentVendorLabel`
 * maps the one to the other on purpose, and `resolveFilamentIdentity` hands out the short form.
 * Comparing the two directly made both vendor-gated rules unreachable: a genuine Bambu PET-CF
 * spool in an AMS raised no prohibition, and Bambu PLA Glow no AMS-wear warning.
 *
 * Canonicalizing HERE rather than in the adapters is deliberate. The adapters are right to speak
 * the app's vocabulary, there is more than one of them, and this module is the only place that
 * knows what vocabulary the rules use. Note the `third party` branch depends on this too: it means
 * "not Bambu", so a half-fix would start applying third-party rules to genuine Bambu filament.
 */
function isBambuVendor(vendor: string): boolean {
  return vendor === 'bambu' || vendor === 'bambu lab'
}

function ruleMatches(rule: FilamentBlacklistRule, query: FilamentBlacklistQuery): boolean {
  const type = lower(query.filamentType)
  const name = lower(query.filamentName)
  const vendor = lower(query.filamentVendor)
  const calibMode = lower(query.calibMode)

  // Model, flow, diameter. Note the deliberate asymmetry between flow and diameter on "unknown",
  // explained in the module header.
  if (rule.modelKeys && !rule.modelKeys.includes(query.printerModel)) return false
  if (rule.nozzleFlows && !rule.nozzleFlows.includes(query.nozzleFlow ?? '')) return false
  if (rule.nozzleDiameters && query.nozzleDiameter != null
    && !diameterMatches(rule.nozzleDiameters, query.nozzleDiameter)) return false

  // `third party` is literally "not Bambu", which an unknown vendor satisfies.
  if (rule.vendor === 'bambu lab' && !isBambuVendor(vendor)) return false
  if (rule.vendor === 'third party' && isBambuVendor(vendor)) return false

  if (rule.calibMode && rule.calibMode !== calibMode) return false

  if (rule.type && rule.type !== type) return false
  if (rule.types && !rule.types.includes(type)) return false
  if (rule.typeSuffix && !type.endsWith(rule.typeSuffix)) return false
  if (rule.name && rule.name !== name) return false
  if (rule.nameSuffix && !name.endsWith(rule.nameSuffix)) return false

  // Three-valued: a rule that cares never matches a caller that does not know.
  if (rule.usedForSupport !== undefined && rule.usedForSupport !== query.usedForSupport) return false
  if (rule.usedForObject !== undefined && rule.usedForObject !== query.usedForObject) return false

  if (rule.hasFilamentSwitch !== undefined && rule.hasFilamentSwitch !== query.hasFilamentSwitch) return false

  if (rule.slot === 'ext' && !query.externalSpool) return false
  if (rule.slot === 'ams' && query.externalSpool) return false

  if (rule.extruderIds && query.extruderId != null && !rule.extruderIds.includes(query.extruderId)) return false

  // Exclusions last, matching Studio's order. `whiteNames` is a CONTAINS test and `whiteFilamentIds`
  // an exact, case-sensitive one; both only apply when we actually know the value.
  if (rule.whiteNames && name && rule.whiteNames.some((white) => name.includes(white))) return false
  if (rule.whiteFilamentIds && query.filamentId && rule.whiteFilamentIds.includes(query.filamentId)) return false

  return true
}

/**
 * The value a matched rule's `%s` is replaced with.
 *
 * DIVERGENCE from BambuStudio, deliberately: Studio formats whatever it has, so an unknown filament
 * name renders "  has a risk of nozzle clogging when using 0.4mm high-flow nozzles". We fall back
 * to the material type and then to a generic noun, because the sentence has to read as English to
 * someone who is being asked to accept a risk.
 */
function substitutionValue(rule: FilamentBlacklistRule, query: FilamentBlacklistQuery): string {
  if (rule.substitution === 'filamentType') {
    return query.filamentType ?? query.filamentName ?? 'This filament'
  }
  if (rule.substitution === 'nameSuffixOrFilamentName' && rule.nameSuffix) {
    return rule.nameSuffix.toUpperCase()
  }
  return query.filamentName ?? query.filamentType ?? 'This filament'
}

function formatMessage(rule: FilamentBlacklistRule, query: FilamentBlacklistQuery): string {
  if (!rule.substitution) return rule.description
  return rule.description.replace('%s', substitutionValue(rule, query))
}

/**
 * Every rule that matches, worded and in rule order.
 *
 * Returns an empty array when nothing matches, which means "no rule had anything to say" rather
 * than "checked and safe" -- there is no rule for most combinations.
 *
 * All matches accumulate: Studio does not stop at the first, and two rules routinely fire together
 * (a hardware prohibition plus a handling warning for the same spool).
 */
export function checkFilamentBlacklist(query: FilamentBlacklistQuery): FilamentBlacklistFinding[] {
  const findings: FilamentBlacklistFinding[] = []
  for (const rule of FILAMENT_BLACKLIST_RULES) {
    if (!ruleMatches(rule, query)) continue
    findings.push({
      action: rule.action,
      message: formatMessage(rule, query),
      wikiUrl: rule.wiki ?? null
    })
  }
  return dedupeFindings(findings)
}

/**
 * Collapse findings that would render as the same sentence.
 *
 * Studio's own pre-print panel dedupes for the same reason (`PrePrintChecker::add`): several rules
 * share one description (all seven E3D entries say the same thing), so a machine with a matching
 * nozzle and two matching materials would otherwise show the identical line twice.
 */
function dedupeFindings(findings: readonly FilamentBlacklistFinding[]): FilamentBlacklistFinding[] {
  const seen = new Set<string>()
  const unique: FilamentBlacklistFinding[] = []
  for (const finding of findings) {
    const key = `${finding.action}\u0000${finding.message}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(finding)
  }
  return unique
}

/** The findings that forbid the combination outright. */
export function blacklistProhibitions(
  findings: readonly FilamentBlacklistFinding[]
): FilamentBlacklistFinding[] {
  return findings.filter((finding) => finding.action === 'prohibition')
}

/** The findings that merely advise against it. */
export function blacklistWarnings(
  findings: readonly FilamentBlacklistFinding[]
): FilamentBlacklistFinding[] {
  return findings.filter((finding) => finding.action === 'warning')
}

/**
 * The refusal sentence for a set of prohibitions, used by the API guard.
 *
 * Composed here rather than at the call site so the dispatch refusal and the dialog's alert quote
 * the same text, per the contract in the module header. `slotLabel` is injected because only the
 * caller knows how its surface names a slot ("AMS A Slot 2", "Ext-L").
 */
export function filamentBlacklistRefusalMessage(
  entries: readonly { slotLabel: string; findings: readonly FilamentBlacklistFinding[] }[]
): string {
  const details = entries.flatMap((entry) =>
    blacklistProhibitions(entry.findings).map((finding) => `${entry.slotLabel}: ${finding.message}`))
  return `This material cannot be printed from the selected slot. ${details.join(' | ')}`
    + ' Load a supported filament, or confirm the unsupported combination in the print dialog.'
}
