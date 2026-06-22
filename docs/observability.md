# Observability

PrintStream ships two complementary observability features. Both are safe to run
on your own hardware and require no external SaaS.

1. **Correlation (request) IDs** — always on. Group every log line emitted while
   handling one request.
2. **Metrics** — opt-in (`METRICS_ENABLED`). An OpenTelemetry meter exposes a
   Prometheus endpoint you can scrape with a self-hosted Prometheus + Grafana.

Distributed **tracing** is not wired yet. OpenTelemetry is used as the
instrumentation layer specifically so traces can be added later (or the metrics
pointed at a different backend) without changing any call sites.

## Correlation IDs

Every HTTP request is assigned a correlation id at the edge of the request
(`apps/api/src/lib/request-context.ts`), made ambient via `AsyncLocalStorage`:

- It is echoed back on the **`X-Request-Id`** response header.
- It is included in error response bodies as `requestId`, so a user-reported
  failure maps straight to server logs.
- Every system log line emitted while handling that request carries the id, and
  the in-app **Logs** view shows and searches it (`req <id>`).
- An inbound `X-Request-Id` is honored when it is safe (`[A-Za-z0-9._-]`, ≤128
  chars), so an upstream proxy or caller can supply one and both sides agree;
  otherwise a UUID is generated.

Non-HTTP entry points (bridge messages, scheduled jobs) can wrap their work in
`withCorrelationId(...)` to participate.

Lines emitted outside any request (startup, MQTT/event callbacks, background
tasks) have a null correlation id — that is expected.

## Metrics

Disabled by default. Set `METRICS_ENABLED=true` to expose a Prometheus endpoint
on `METRICS_PORT` (default `9464`) at `/metrics`. When disabled, no telemetry
runtime starts and every instrument is a cheap no-op, so the self-hosted/OSS
build carries zero overhead unless you opt in.

> **Keep the metrics port internal.** It is meant for an internal scraper only;
> do not publish or reverse-proxy it publicly. The example stack below never
> maps it to the host.

### What is measured

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `printstream_http_server_duration` | histogram (ms) | `http_request_method`, `http_route`, `http_response_status_code` | HTTP request handling time. Routes are the matched pattern (`/api/printers/:id`) to bound cardinality; unmatched requests collapse to `unmatched`. |
| `printstream_print_dispatch_duration` | histogram (ms) | `outcome` (`success`/`failed`/`cancelled`) | Print dispatch (FTPS upload + MQTT start) time and outcome. |
| `printstream_slice_job_duration` | histogram (ms) | `outcome` | Slice job time and outcome. |
| `printstream_ws_events_broadcast` | counter | `type` | WebSocket events fanned out to clients. |
| `printstream_bridge_messages_dropped` | counter | `reason` (`invalid-json`/`schema`) | Inbound bridge frames dropped as malformed (contract drift signal). |
| `printstream_ws_clients` | gauge | — | Currently connected WebSocket clients. |
| `printstream_bridges_connected` | gauge | — | Currently connected bridges. |
| `printstream_process_event_loop_lag_seconds` | gauge | — | Mean event-loop delay since the last scrape. |
| `printstream_process_memory_bytes` | gauge | `type` (`rss`/`heap_used`/`heap_total`) | Process memory usage. |

Histograms also expose `_count` and `_sum`, so request/dispatch/slice rates and
averages come for free.

#### Bridge metrics (forwarded over the session)

Bridges run next to the printers and, in the cloud topology, sit behind NAT —
they cannot be scraped directly. Instead each bridge pushes a small snapshot
over its existing, already-authenticated bridge→API WebSocket session (on the
heartbeat cadence, ~15s), and the API re-exposes it here labelled by
`bridge_id` and `tenant_id`. No inbound route to the bridge is needed, and the
bridge carries no telemetry runtime of its own. A bridge's series clear when its
session ends (or after ~90s without an update).

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `printstream_bridge_printers_monitored` | gauge | `bridge_id`, `tenant_id` | Printers the bridge is monitoring. |
| `printstream_bridge_printers_connected` | gauge | `bridge_id`, `tenant_id` | Monitored printers with a live MQTT connection (a signal the API cannot see on its own). |
| `printstream_bridge_event_loop_lag_seconds` | gauge | `bridge_id`, `tenant_id` | Bridge process mean event-loop delay. |
| `printstream_bridge_memory_rss_bytes` | gauge | `bridge_id`, `tenant_id` | Bridge process resident memory. |
| `printstream_bridge_api_reconnects` | counter | `bridge_id`, `tenant_id` | Cumulative bridge→API reconnects (resets on bridge restart — a flapping-link signal). |

### Running Prometheus + Grafana (example)

An optional Compose overlay stands up Prometheus and Grafana scraping the API,
without publishing the metrics port to the host:

```sh
cp prometheus.example.yml prometheus.yml
docker compose -f compose.yml -f compose.observability.yml up -d
```

- `compose.observability.example.yml` enables `METRICS_ENABLED` on the `api`
  service and adds `prometheus` (scraping `api:9464` on the internal network)
  and `grafana` services.
- `prometheus.example.yml` is the scrape config. Copy it to `prometheus.yml`
  (kept out of git, like `compose.yml`).
- Grafana's UI binds to `127.0.0.1:3000` by default (`GRAFANA_PORT`,
  `GRAFANA_BIND_HOST`). Change the admin password (`GRAFANA_ADMIN_PASSWORD`) and
  keep it behind your own auth/proxy. On first login, add a Prometheus data
  source pointing at `http://prometheus:9090`.

Running the API outside Docker? Point your existing Prometheus at
`http://<api-host>:9464/metrics` instead, and set `METRICS_ENABLED=true` /
`METRICS_PORT` on the API process.

See `docs/configuration.md` for the `METRICS_ENABLED` / `METRICS_PORT` variables.
