# Open-core split

PrintStream is developed in a **private monorepo** (this repository) and published as
open source through scripted snapshots. The hosted (cloud) deployment's closed-source
surface lives in clearly bounded `private/` directories that the public export strips.

## Repositories

| Repo | Visibility | Contents |
| --- | --- | --- |
| `PrintStreamApp/printstream-cloud` (this monorepo) | private | Everything: core + private cloud modules. Source of truth; all development happens here. |
| `PrintStreamApp/printstream` | public | Core app snapshot with fresh history, produced by `scripts/export/export-public.mjs`. |
| `PrintStreamApp/printstream-home-assistant` | public | HACS-compatible Home Assistant integration snapshot, produced by `scripts/export/export-home-assistant.mjs`. |

## What is private

- `apps/api/src/private/` — private API modules. Discovered at startup by
  `apps/api/src/lib/private-modules.ts`; each `<name>/index.ts` default-exports a
  `PrivateApiModule` whose `register(app)` mounts routes. Today: the `cloud` module
  (beta signup, `/api/platform/overview`, `/api/tenants`).
- `apps/web/src/private/` — private web modules. Discovered via `import.meta.glob`
  by `apps/web/src/lib/privateModules.ts`; each `<name>/index.tsx` default-exports a
  `PrivateWebModule` contributing the marketing surface (public routes incl. `/`,
  footer) and/or the platform admin surface (overview + tenants views, nav tabs).
- `packages/shared/src/private/` — contracts for the private surface, consumed as
  `@printstream/shared/private`.
- The **public demo** machinery is private too: `apps/api/src/private/demo/`,
  the bridge simulator entrypoints (`apps/bridge/src/demo-index.ts`,
  `demo-simulator.ts`), the compose demo services (between
  `BEGIN/END PRIVATE DEMO` markers), `data/demo-library/`, and the demo npm
  scripts. Core keeps only the inert demo policy guards. See
  `docs/private/demo.md`.
- `docs/private/` — operational docs for the hosted deployment.

## Rules

- Core code must never import from a `private/` directory. The web app reads private
  modules only through the `src/lib/privateModules.ts` host; the API only through
  `src/lib/private-modules.ts`.
- The core must build, typecheck, and run with all `private/` directories deleted —
  that is exactly what the public export is. Fallbacks: `/` routes into the app,
  `/platform` redirects to `/platform/settings`, the platform nav shows only
  Settings, and the API mounts nothing extra.
- Private modules are first-party code: they may import core `lib`/components
  directly, unlike third-party plugins.
- Self-hosted installs get a workspace from the first-run bootstrap
  (`apps/api/src/lib/default-workspace.ts`, `AUTO_CREATE_DEFAULT_WORKSPACE`),
  since tenant CRUD is part of the private cloud module.

## Publishing a snapshot

```bash
npm run export:public   # → ../printstream-public      (excludes private/ + integrations/)
npm run export:ha       # → ../printstream-home-assistant (HACS layout + LICENSE)
```

Each script copies the tracked files, applies manifest transforms (drops the
`./private` exports entry and private-only npm scripts), and commits a single
snapshot commit in the target repo (initializing `main` with fresh history on first
run). Push the targets to their GitHub repos:

```bash
cd ../printstream-public && git remote add origin git@github.com:PrintStreamApp/printstream.git && git push -u origin main
cd ../printstream-home-assistant && git remote add origin git@github.com:PrintStreamApp/printstream-home-assistant.git && git push -u origin main
```

## Parked branches

Unfinished surfaces live on branches, not in the mainline (and therefore never
reach the public export). Currently: `bridge-desktop-app` — the Electron tray
wrapper for the bridge (desktop packaging scripts, electron deps, the desktop
package CI matrix).

Public contributions arrive as PRs against `PrintStreamApp/printstream` and are
applied to this monorepo manually; the next snapshot export then reconciles the
public repo.
