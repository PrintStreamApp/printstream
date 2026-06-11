# Demo Mode Architecture

## Overview

PrintStream's public demo is a tenant-scoped deployment mode built from normal
product boundaries instead of global transport branching. The demo is exposed as
the reserved `demo` tenant, uses explicit anonymous guest permissions, and runs
against a simulator bridge that speaks the same bridge runtime protocol as a
real bridge.

The goal is to keep the demo inside the same architecture used for production:

- the API owns tenant routing, authorization, persistence, audit, and WebSocket
  fanout,
- the bridge owns printer-originated behavior, and
- the web app consumes runtime policy and renders the demo as a normal
  workspace.

Global `DEMO_MODE`, `VITE_DEMO_MODE`, and bridge-side mode switches are not part
of the production runtime. The deployment model is: bootstrap the reserved
`demo` tenant, run the API normally, run the dedicated demo bridge entrypoint,
and send visitors to `/demo`.

## Design Constraints

The public demo is intentionally not implemented as a generic auth-disabled
tenant. Tenant-scoped permission checks bypass enforcement when auth is fully
disabled, which is too permissive for a public workspace. Instead, anonymous
access to the reserved demo tenant resolves to an explicit guest auth context.

The simulator bridge also stays on the transport side of the API boundary. It
does not write database tables directly. It drives the API through the normal
bridge runtime protocol and printer status/report flow.

## Architecture

### Demo Tenant

The public demo is a normal `Tenant` row with the reserved slug `demo`.
Visitors enter that tenant directly, for example via `/demo` or
`/workspaces/demo/printers`.

The demo tenant owns demo-scoped rows and state, including:

- printer records,
- bridge records,
- library rows,
- jobs and historical seeded data,
- stats and audit logs, and
- runtime WebSocket delivery scoped to the tenant.

Leaving the demo tenant returns the rest of the installation to normal
production behavior.

### Guest Access Policy

Anonymous requests to the reserved demo tenant are upgraded to a guest auth
context with an explicit read-mostly permission set. The current guest
permissions allow browsing the demo surface:

- `printers.view`
- `printerStorage.view`
- `printerStorage.download`
- `camera.view`
- `jobs.view`
- `library.view`
- `library.download`

This policy is intentionally narrower than normal authenticated workspace
access. Anonymous visitors do not inherit broader tenant permissions, and write
or admin routes still require the specific permissions they already use.

### Demo Restrictions And Exceptions

The demo keeps the printer fleet explorable but protects seeded state.

- Printer inventory mutations are blocked so the seeded fleet remains stable.
- Settings and auth mutations are blocked.
- Plugin uploads remain blocked.
- Curated demo library content remains read-only.

The current product exception is temporary library upload support for the public
demo. Demo users can upload private temporary files for exploration, subject to
these limits:

- uploads are capped at 15 MB,
- uploads are treated as temporary demo files rather than curated shared
  content, and
- hidden demo uploads are removed by cleanup after 12 hours.

This keeps the demo interactive without allowing permanent shared content
mutation.

### Demo Bridge

The demo bridge uses a dedicated `demo-index` entrypoint and Docker
`demo-runtime` target. It reuses the shared bridge runtime contracts and behaves
like a bridge-connected printer fleet, but the production bridge entrypoint does
not accept a simulator mode flag and the default production bridge image removes
the demo entrypoint files.

The demo bridge is responsible for printer-originated behavior, including:

- scenario scheduling,
- fake status generation,
- per-printer state machines,
- auto-start playlists,
- storage contents,
- camera media, and
- command effects such as pause, resume, stop, light, and refresh-style flows.

It emits the same categories of bridge traffic the API already understands,
including normalized printer status, offline or removed events, camera
responses, and printer-storage RPC responses.

### API Responsibilities

The API remains the source of truth for:

- tenant routing and resolution,
- guest auth policy for the demo tenant,
- request authorization and write restrictions,
- print job persistence,
- historical demo seed data,
- stats and audit logging,
- WebSocket fanout, and
- plugin and print-guard evaluation.

The API no longer owns fake transport behavior for the public demo. Live demo
printer behavior comes from the simulator bridge through the same runtime path
used by real bridged printers.

### Web Responsibilities

The web app renders the demo tenant like any other tenant and consumes runtime
policy from auth bootstrap. It can show public-demo labels, warnings, and UX
affordances, but UI hiding is not the enforcement boundary. API authorization
and demo restrictions remain authoritative.

The web app also redirects `/demo` to the demo workspace printers view while
leaving `/` available for the normal application shell or a future public front
door.

## Bootstrap And Runtime Flow

The public demo is bootstrapped by `npm run demo:bootstrap --workspace
@printstream/api`.

Bootstrap is idempotent and is responsible for:

- creating or updating the reserved `demo` tenant,
- ensuring built-in auth groups exist for that tenant,
- creating or updating the demo bridge row,
- attaching seeded demo printers to that bridge,
- seeding demo library rows and historical jobs, and
- writing the bridge runtime state file used by the simulator bridge.

For local development, `npm run dev:demo` bootstraps the demo tenant, writes the
demo bridge state, prepares the demo library directory, and starts the API, web
app, and simulator bridge together. `npm run dev:demo:parallel` runs the normal
bridge and the simulator bridge side by side.

## Current State Summary

The architecture described above is implemented today:

- the reserved `demo` tenant slug is enforced,
- anonymous demo requests resolve to explicit guest permissions,
- the simulator bridge drives printer status through the bridge runtime path,
- `/demo` lands in the demo workspace,
- global demo env switches have been removed, and
- demo-specific restrictions are enforced through normal route authorization and
  policy checks rather than ad hoc transport branching.

## Future Note

The repo should eventually document a canonical operating policy for keeping
the demo tenant in a known-good state over time. That decision is intentionally
left open for now and does not block the current architecture.
