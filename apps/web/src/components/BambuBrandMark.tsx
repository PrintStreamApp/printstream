/**
 * The Bambu Lab brand mark, used in place of the word "Bambu" where a preset name would otherwise
 * spend its most valuable characters on a vendor prefix.
 *
 * This mirrors BambuStudio, which substitutes the same glyph for the same token in its filament
 * picker and nowhere else (`PresetComboBoxes.cpp:1285`, `set_replace_text("Bambu",
 * "BambuStudioBlack")`). Only Bambu gets a mark there; every other vendor stays as text, so a list
 * mixing "Polymaker PolyLite PLA" with a glyph-prefixed Bambu preset is the intended look rather
 * than an inconsistency.
 *
 * The geometry is BambuStudio's `resources/images/BambuStudioBlack.svg` (four rects sheared into a
 * pinwheel). Redrawn inline rather than vendored as a file for one reason that matters: the source
 * asset is hard-filled `#262E30` for a light UI, and this app is dark-only, so it must inherit
 * `currentColor` to be visible at all.
 *
 * Sized in `em` so it tracks whatever type it sits in, and `aria-hidden` because the text beside it
 * already names the preset: a screen reader that announced "Bambu" twice, or a bare "image", would
 * both be worse than silence.
 */
import { Box } from '@mui/joy'

export function BambuBrandMark() {
  return (
    <Box
      component="svg"
      viewBox="0 0 10 12"
      aria-hidden
      sx={{
        width: '0.72em',
        height: '0.86em',
        fill: 'currentColor',
        flexShrink: 0,
        // The glyph is a full-height block where text has a baseline, so it rides high without this.
        verticalAlign: '-0.08em'
      }}
    >
      <path d="M5.33289 4.479V12.0001H9.61044V6.16426L5.33289 4.479Z" />
      <path d="M5.33289 0V3.76054L9.61044 5.4458V0H5.33289Z" />
      <path d="M0.389526 7.52109V0H4.66708V5.83583L0.389526 7.52109Z" />
      <path d="M0.389526 12V8.23946L4.66708 6.5542V12H0.389526Z" />
    </Box>
  )
}

/**
 * A preset name with its leading `Bambu ` vendor token rendered as {@link BambuBrandMark}.
 *
 * LEADING only, deliberately. BambuStudio replaces the token anywhere it appears, but our names are
 * literal preset names rather than its shortened labels, and several contain the word mid-string:
 * "Polymaker PLA Panchroma PLA @Bambu Lab P1S 0.4 nozzle" would become "... @<glyph> Lab P1S",
 * which reads as a Polymaker preset badged with Bambu's mark. A name that does not start with the
 * token renders unchanged.
 */
export function PresetNameWithBrandMark({ name }: { name: string }) {
  const BAMBU_PREFIX = 'Bambu '
  if (!name.startsWith(BAMBU_PREFIX)) return <>{name}</>
  return (
    <>
      <BambuBrandMark />
      {` ${name.slice(BAMBU_PREFIX.length)}`}
    </>
  )
}
