# Horizontal scale-out (multi-replica API)

> Status: **design / not yet implemented.** This is the plan for running more than
> one `apps/api` replica. Today the cloud runs a single API process; this document
> scopes the work to lift that limit without regressing the single-process build.

## Why this is an epic (and why single-node came first)

The API process is currently the single authoritative holder of all live state. The
single-node efficiency work (tenant-indexed WS fan-out, bounded caches, demand-decayed
camera polling, library listing caps) raises how far *one* replica scales — and one
replica is enough for a long time. Horizontal scale-out is the *next* ceiling: serving
more printers/tenants/clients than one Node process can hold, and surviving the loss of
any single replica.

Two things make it more than "add a load balancer":

1. **Fan-out state is easy.** The WS client registry and the `printerEvents` bus just
   need a way to deliver an event produced on replica A to clients connected to replica
   B. That is a pub/sub problem.
2. **Connection-ownership state is hard.** The API holds *stateful, exclusive*
   connections that cannot be duplicated across replicas:
   - **One MQTT connection per printer** (`printer-manager.ts` `connect()`): two
     replicas both connected to the same printer would double-publish commands and
     double-process telemetry.
   - **One WebSocket session per bridge** (`bridge-session-manager.ts`): a bridge dials
     *one* replica; RPCs (library I/O, FTPS, camera) must be routed to whichever replica
     currently holds that bridge's socket.
   - **Per-printer dispatch serialization + double-print reservation** (`print-dispatcher.ts`):
     the "only one print starting per printer at a time" guarantee is currently a
     process-local `Set`/queue. Across replicas it must become a cluster-wide lease.

   These need an **ownership/affinity layer**, not just pub/sub.

A hard invariant throughout: **the self-hosted build runs API + web + in-box bridge +
Postgres as a single-node deployment** (the open-source Docker Compose stack, and the
native single binary that runs them in one process). Every change here must keep a
zero-infrastructure, single-process mode as the default. Scale-out is a cloud-only
capability layered behind an abstraction whose default implementation is exactly today's
in-process behavior.

## Coupling-point inventory

| State | Location | Class | Scale-out treatment |
|---|---|---|---|
| WS client registry (`clients`, `clientsByTenant`) | `ws-server.ts` | fan-out | publish broadcasts on the cluster bus; each replica delivers to its own sockets |
| `printerEvents` EventEmitter (`status`/`job.*`/`printer.*`) | `printer-events.ts` | fan-out | mirror cross-replica over the cluster bus |
| Authoritative printer status snapshot (`printerStatuses`, `printerManager` `managed`) | `bridge-session-manager.ts`, `printer-manager.ts` | ownership + cache | owned by the replica holding the printer's MQTT/bridge link; replicated for read via shared snapshot store |
| MQTT connection per printer | `printer-manager.ts` `connect()` | **ownership** | printer→replica assignment registry + command routing |
| Bridge WS session (`connections`, `pendingRequests`, `cameraListeners`, `printerFtpActivity`) | `bridge-session-manager.ts` | **ownership** | bridge→replica assignment (naturally sticky on connect); route RPCs to the owning replica |
| Dispatch jobs/queues + double-print reservation (`jobs`, `printerQueues`, reserved set) | `print-dispatcher.ts` | **ownership** + durability | cluster-wide per-printer lease; durable job rows so a replica loss doesn't orphan dispatch |
| Auth rate limiter (`entries` Map) | `rate-limit.ts` | shared counter | shared-store counter (per-tenant/IP) so N replicas don't multiply the budget |
| Camera relay / snapshot hub | `camera-relay.ts`, `camera-snapshot-hub.ts` | ownership | follows printer/bridge ownership; viewers on a non-owning replica subscribe through the bus |

## Target architecture

```
            ┌─────────── Load balancer (sticky for /ws upgrades) ───────────┐
            │                          │                          │
        ┌───▼────┐                ┌────▼───┐                 ┌────▼───┐
        │ api-1  │                │ api-2  │                 │ api-N  │
        │ owns:  │                │ owns:  │                 │ owns:  │
        │ printers{a},           │ printers{b},            │ printers{c},
        │ bridges{x}             │ bridges{y}              │ bridges{z}
        └──┬──┬──┘                └──┬──┬──┘                 └──┬──┬──┘
           │  │                      │  │                      │  │
           │  └──── ClusterBus (pub/sub: events, broadcasts, command routing) ──┘
           │                         │                         │
        ┌──▼─────────────────────────▼─────────────────────────▼──┐
        │  Postgres: data + ownership registry + shared snapshots   │
        └───────────────────────────────────────────────────────────┘
```

Three new primitives, each with an in-process default:

### 1. `ClusterBus` — pluggable pub/sub + request/reply

A small interface the WS broadcaster, `printerEvents`, and dispatcher publish through:

```ts
interface ClusterBus {
  publish(topic: string, message: unknown): Promise<void>
  subscribe(topic: string, handler: (message: unknown) => void): () => void
  // request/reply for routed commands (printer command -> owning replica)
  request(topic: string, message: unknown, opts?: { timeoutMs?: number }): Promise<unknown>
  respond(topic: string, handler: (message: unknown) => Promise<unknown>): () => void
}
```

- **`InProcessClusterBus`** (default): a thin wrapper over an EventEmitter. Identical to
  today's behavior, zero infra. This is what the OSS SEA build and single-replica cloud use.
- **`PostgresClusterBus`** (cloud multi-replica): `LISTEN/NOTIFY` for signals plus a
  shared table for payloads larger than NOTIFY's 8 KB limit (printer status with AMS/HMS
  can exceed it) — the owning replica writes the snapshot row and NOTIFYs a small
  `{topic, key, rev}` signal; subscribers refetch the row. No new infrastructure (Postgres
  is already the datastore, and the OSS build bundles it).
- **`RedisClusterBus`** (optional, later): only if event volume outgrows Postgres
  NOTIFY. Redis pub/sub has no payload limit and would also back the rate-limit counter
  and a BullMQ dispatch queue. New infra; not required for the first scale-out.

### 2. Ownership registry — printer/bridge → replica leases

A Postgres-backed lease table (`replica_assignment`) recording which replica owns each
printer's MQTT connection and each bridge's session, with a heartbeat/TTL. On startup a
replica claims a share; on crash, leases expire and survivors re-claim (driven by the
existing `printer-discovery-reconcile` loop, generalized to "claim unowned printers").
Commands/RPCs for a printer or bridge are routed via `ClusterBus.request` to the owning
replica. Bridge sessions are naturally sticky (the bridge holds one socket), so the
registry mainly records *where* that socket landed.

### 3. Durable dispatch + cluster lease

Dispatch job state moves from the in-heap `Map` to durable rows (a `DispatchJob` table or
reuse of `PrintJob` with a `dispatchState`), and the per-printer "one print starting at a
time" guard becomes a cluster-wide advisory lock (Postgres `pg_advisory_lock` keyed by
printer id, or a lease row). A replica loss then resumes/cleans dispatch instead of
orphaning it. This also closes the existing single-process robustness finding
("dispatch jobs in-memory while side effects are durable — a restart mid-dispatch orphans
both"), so it has standalone value even before multi-replica.

## Phased, incremental plan

Each phase ships independently, keeps the in-process default, and is testable in one process.

- **Phase 0 — seam (no behavior change).** Introduce `ClusterBus` with only
  `InProcessClusterBus`, and route `printerEvents` cross-replica fan-out and
  `wsBroadcaster.broadcast` through it. In single-process mode this is a pass-through.
  Add a `CLUSTER_MODE` env (default `single`). *Deliverable: the seam exists; nothing
  else changes; full test suite green.*
- **Phase 1 — durable dispatch.** ✅ *Implemented (journal + reconcile).* The dispatch
  lifecycle is now written through to the `DispatchJob` table (`dispatch-journal.ts`); a
  durably-committed `startCommandAttemptedAt` marks the rob-1 boundary before the MQTT
  publish. On boot, `dispatch-reconcile.ts` marks pre-publish orphans `interrupted` and,
  as each printer reconnects, best-effort deletes the SD bytes those interrupted uploads
  left (rob-1-safe: only pre-publish rows are ever cleaned). *Still to do for full
  scale-out:* replace the in-heap per-printer `reservedPrinterIds`/queue guard with a
  cluster-wide lease (`pg_advisory_lock` keyed by printer id) — deferred to land with the
  ownership registry in Phase 3, since a single replica doesn't need it yet.
- **Phase 2 — `PostgresClusterBus`.** Implement the LISTEN/NOTIFY + snapshot-table
  adapter. Behind `CLUSTER_MODE=postgres`. With one replica it is a no-op equivalent;
  validated by running two local API processes against one Postgres and asserting a
  status delta on A reaches a WS client on B.
- **Phase 3 — ownership registry + routing.** Printer/bridge lease table, claim-on-start,
  re-claim-on-expiry, and `ClusterBus.request` command routing to the owning replica.
  Generalize `printer-discovery-reconcile` to cluster-aware claiming.
- **Phase 4 — shared rate-limit + LB contract.** Shared-store rate-limit counter; document
  the load-balancer requirement (sticky `/ws` upgrades, or stateless-token WS auth) in
  `docs/deployment.md`.
- **Phase 5 (optional) — `RedisClusterBus`.** Only if Postgres NOTIFY throughput becomes
  the bottleneck.

## Invariants & testing

- **Single-process parity:** `CLUSTER_MODE=single` (the default, and the only mode the OSS
  SEA build ships) must be byte-for-byte today's behavior. The export/public build and the
  SEA binary never depend on a distributed bus.
- **No cross-tenant leak through the bus:** every published event keeps its `tenantId`;
  subscribers re-apply tenant scoping on delivery exactly as `wsBroadcaster` does today.
- **Exactly-once connections:** the ownership registry must guarantee a printer's MQTT
  connection and a bridge's session exist on exactly one replica; a split-brain double
  connection is the primary risk and needs a fenced lease (monotonic token) + reconcile.
- **Test strategy:** unit-test each adapter against the `ClusterBus` contract; an
  integration test boots two API processes on one Postgres and asserts (a) a status delta
  on replica A reaches a client on B, (b) a command for a printer owned by A issued to B is
  routed and executed once, (c) killing A re-homes its printers/bridges to B within the
  lease TTL.

## Open decisions (need a call before Phase 2)

1. **Transport:** Postgres `LISTEN/NOTIFY` (recommended first — no new infra, works in OSS
   self-host, lowest cost) vs Redis (more headroom + a ready shared store, but new infra).
2. **WS sticky sessions vs stateless:** sticky `/ws` at the LB (simplest) vs fully
   stateless WS auth so any replica can serve any socket (more resilient, more work).
3. **Ownership granularity:** per-printer leases (fine-grained rebalancing) vs per-bridge
   (coarser, simpler — all of a bridge's printers move together; aligns with the existing
   bridge-session stickiness).
