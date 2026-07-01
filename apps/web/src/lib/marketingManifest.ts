/**
 * Core reader for the private marketing route-path manifest.
 *
 * Discovers the leaf `marketingRoutes.ts` from any private module via `import.meta.glob`
 * (eager — but leaf-only, so it pulls in NO view/Joy/chart code), letting the app entry
 * (`src/Root.tsx`) decide marketing-vs-app on a cold load without importing the app shell,
 * the plugin graph, or `@mui/x-charts`.
 *
 * In the open-source build there is no `src/private`, so the glob is empty and
 * `marketingRoutePaths` is `[]` — `Root` then always loads the app (today's behavior).
 */
const manifestModules = import.meta.glob('../private/*/marketingRoutes.ts', { eager: true }) as Record<
  string,
  { MARKETING_ROUTE_PATHS?: readonly string[] }
>

/** Public marketing *page* paths (empty in the public/OSS build). */
export const marketingRoutePaths: ReadonlyArray<string> = Object.values(manifestModules).flatMap(
  (module) => module.MARKETING_ROUTE_PATHS ?? []
)

/** True when `pathname` is a public marketing page the light entry can serve without the app shell. */
export function isMarketingPath(pathname: string): boolean {
  return marketingRoutePaths.includes(pathname)
}
