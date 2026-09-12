/**
 * Public tool routes: pages that work with no account, no workspace, and no server data.
 *
 * Like the marketing manifest, route declarations are discovered from private modules. The public
 * editor is hosted only by the cloud deployment; the private manifest disappears from self-hosted,
 * native, and OSS builds, leaving this list empty so those builds route into their normal app.
 *
 * Read by `Root` on a cold load to decide which shell to mount, so this module must stay a leaf:
 * no view, plugin, or Three.js imports, or the entry chunk stops being tiny.
 */

/**
 * Paths served by the lightweight public shell. Deliberately NOT added to index.html's
 * `PS_MARKETING_PATHS`: that list paints the marketing backdrop and the OSS export empties it,
 * neither of which applies to a tool. `main.tsx` reads this manifest directly instead.
 */
let manifestModules: Record<string, { PUBLIC_TOOL_ROUTE_PATHS?: readonly string[] }> = {}
try {
  manifestModules = import.meta.glob('../private/*/publicToolRoutes.ts', { eager: true }) as Record<
    string,
    { PUBLIC_TOOL_ROUTE_PATHS?: readonly string[] }
  >
} catch {
  // Node tests have no Vite transform, which is equivalent to an OSS build with no private route
  // manifest. Keep the leaf importable so its pure path matcher remains testable there.
  manifestModules = {}
}

export const PUBLIC_TOOL_ROUTE_PATHS: ReadonlyArray<string> = Object.values(manifestModules).flatMap(
  (module) => module.PUBLIC_TOOL_ROUTE_PATHS ?? []
)

export function isPublicToolPath(pathname: string): boolean {
  return (PUBLIC_TOOL_ROUTE_PATHS as readonly string[]).includes(pathname)
}
