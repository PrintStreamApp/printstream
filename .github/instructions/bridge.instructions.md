---
applyTo: "apps/bridge/**"
description: "Use when working in the bridge runtime: LAN access (MQTT/FTPS/SSDP), library file storage, and the bridge-local 3MF parser."
---

# Bridge Runtime Instructions

The bridge runs next to the printers and owns LAN access: persistent MQTT, FTPS, SSDP discovery, and
**library file storage**. The API talks to it over bridge RPC; it deploys separately from the API, so
a change here only takes effect once the bridge is rebuilt/redeployed.

## Library files are bridge-owned by default

Library files live on the bridge. Local (non-bridge) files are an **unsupported fallback** that may
return one day, so don't delete that path — keep the two in sync.

### 3MF parsing is duplicated — keep it mirrored

`apps/bridge/src/library-3mf.ts` is a hand-kept **mirror** of `apps/api/src/lib/three-mf.ts`. Because
files are bridge-owned, this bridge parser is what normally produces the 3MF index the web sees (via
the `library.inspect3mf` RPC); the API's copy only runs for the local-copy/fallback parse and for
slice-time 3MF rewriting.

When changing the parsed 3MF **index shape** (e.g. a per-plate field like `objects`):
1. Apply the change in **both** parsers (`library-3mf.ts` here and `apps/api/src/lib/three-mf.ts`).
2. Add the field to the shared schema (`bridgeLibraryThreeMfIndexSchema` in
   `packages/shared/src/bridge-runtime.ts`) — Zod strips fields the schema omits, silently dropping
   new data across the RPC boundary.
3. Bump **both** `THREE_MF_PARSER_CACHE_VERSION` constants and the API's
   `BRIDGE_LIBRARY_DERIVED_CACHE_VERSION` (`apps/api/src/lib/bridge-library-files.ts`) so stale
   cached indexes are re-derived instead of served.
4. Remember the bridge must be redeployed for RPC-path changes to take effect.
