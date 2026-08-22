/**
 * What a settings dialog's "changed" markers are actually measured against.
 *
 * A tune dialog shows changes RELATIVE to a preset. Usually that preset is the one the project
 * names, and the markers mean exactly what the user assumes. Sometimes it cannot be — the public
 * 3MF editor has no access to a workspace's custom presets — and the resolver substitutes something
 * weaker. When that happens the markers are still the best available answer, but they no longer mean
 * what they appear to, and the difference is invisible: the same dialog, the same dots, a different
 * question answered.
 *
 * So the RESOLVER reports which case it landed in, and the dialog says so. The alternative — a host
 * re-deriving "did that preset resolve?" beside the resolver that already knows — is what shipped
 * first, and it was wrong in two ways at once: it answered per PRESET while the resolver answers per
 * SLOT, and it had no idea about presets the user had uploaded into their own browser, so the one
 * case with a genuinely incomplete baseline was also the one case that said nothing.
 *
 * Counterparts: `apps/web/src/plugins/model-studio/lib/localProcessResolver.ts` and
 * `localFilamentResolver.ts` produce it; `components/ProcessSettingsDialog.tsx` and
 * `components/library/FilamentSettingsDialog.tsx` render it through `SettingsBaselineNote`.
 */

/**
 * Absent means {@link SettingsBaselineOrigin} `exact` — the overwhelmingly common case, and what
 * every workspace-route response means, so neither host has to set it to say "nothing to explain".
 */
export type SettingsBaselineOrigin =
  /** The preset the project names resolved. The markers mean what they appear to. */
  | { kind: 'exact' }
  /** That preset was unreachable; the standard preset it derives from stood in. */
  | { kind: 'parent'; name: string }
  /** The preset resolved but ITS parent did not, so the baseline holds only what it defines itself. */
  | { kind: 'partial' }
  /** Nothing resolved: the markers are the file's own record of what it changed, not a comparison. */
  | { kind: 'declared' }

/**
 * The caveat to show, or null when the baseline is exact and needs none.
 *
 * `kindWord` is the user's word for the preset ("process" / "filament") so both dialogs read alike.
 * Each string states what was compared AND what that costs, because "approximate" alone leaves the
 * user unable to judge any individual marker.
 */
export function describeSettingsBaseline(origin: SettingsBaselineOrigin | undefined, kindWord: string): string | null {
  switch (origin?.kind) {
    case 'parent':
      return `This project's ${kindWord} preset isn't available here, so changes are shown against "${origin.name}", the standard preset it's based on — an edit whose value matches that standard isn't flagged.`
    case 'partial':
      return `This ${kindWord} preset is based on one that isn't available here, so changes are shown against only the values the preset defines itself — anything it inherits isn't compared.`
    case 'declared':
      return `This project's ${kindWord} preset isn't available here and nothing standard matches it, so the changes shown are the ones the file itself recorded rather than a comparison against a preset.`
    default:
      return null
  }
}
