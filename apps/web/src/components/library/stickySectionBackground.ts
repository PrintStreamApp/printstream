/**
 * The opaque background a sticky section header paints.
 *
 * Its own module because {@link StickySectionHeader} exports components, and a file that mixes
 * components with other exports loses Fast Refresh.
 */

/** The feature query guarding the relative-colour declaration; exported so a test can read it back. */
export const RELATIVE_COLOR_SUPPORTS_QUERY = '@supports (background-color: rgb(from red r g b / 1))'

/**
 * A scroll container's colour token at FULL opacity, plus the plain token as a fallback.
 *
 * Returned as a style fragment rather than a colour because it needs two declarations: a browser
 * without relative colour syntax drops an unrecognised `background-color` outright, and a header
 * with no background at all is worse than a translucent one, since the text would then sit directly
 * on whatever scrolled beneath it.
 *
 * `/ 1` is the load-bearing part. Omitting the alpha component inherits the ORIGIN colour's alpha,
 * so `rgb(from <token> r g b)` hands back the token unchanged, still at 0.6, and the fix reads as
 * applied while changing nothing.
 */
export function opaqueScrollerBackground(token: string) {
  const cssVar = `var(--joy-palette-${token.replace(/\./g, '-')})`
  return {
    bgcolor: token,
    [RELATIVE_COLOR_SUPPORTS_QUERY]: {
      backgroundColor: `rgb(from ${cssVar} r g b / 1)`
    }
  }
}
