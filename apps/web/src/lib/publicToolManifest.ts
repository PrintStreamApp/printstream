/**
 * Public tool routes — pages that work with no account, no workspace, and no server data.
 *
 * Distinct from the private marketing manifest (`marketingManifest.ts`) on purpose. Marketing pages
 * are cloud-only and vanish from the open-source build; these are CORE capability, so a self-hosted
 * or OSS install serves them too. The cloud site may wrap one in its own landing copy and SEO entry,
 * but the tool itself does not live behind that.
 *
 * Read by `Root` on a cold load to decide which shell to mount, so this module must stay a leaf:
 * no view, plugin, or Three.js imports, or the entry chunk stops being tiny.
 */

/**
 * Paths served by the lightweight public shell. Deliberately NOT added to index.html's
 * `PS_MARKETING_PATHS`: that list paints the marketing backdrop and the OSS export empties it,
 * neither of which applies to a tool. `main.tsx` reads this manifest directly instead.
 */
export const PUBLIC_TOOL_ROUTE_PATHS = ['/3mf-editor'] as const

export function isPublicToolPath(pathname: string): boolean {
  return (PUBLIC_TOOL_ROUTE_PATHS as readonly string[]).includes(pathname)
}
