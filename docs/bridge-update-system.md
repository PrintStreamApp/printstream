# Bridge Version And Update Architecture

## Purpose

PrintStream bridges must stay compatible with the API after server updates
without requiring a privileged host updater. The bridge update system keeps that
boundary tight by splitting the bridge into a stable runner image and a signed
application bundle that can self-update only inside the bridge-owned data
volume.

The updater never mounts the Docker socket, never controls unrelated host
containers, and does not mutate the container image filesystem. When the runner
image is too old for a bundle, the bridge reports that condition and waits for a
normal image pull/restart performed by the operator.

## Architecture Summary

The system has two independently versioned layers:

1. **Runner image**
   - Docker image containing Node, ffmpeg, OS packages, production
     dependencies, and the launcher.
   - Changes only when runtime dependencies or the launcher contract change.
   - Identified by `runnerAbiVersion`, for example `node22-ffmpeg7-v1`.

2. **Bridge app bundle**
   - Signed zip archive containing the built bridge JavaScript application.
   - Stored under `/data/releases/<version>/` in the bridge data volume.
   - Changes for normal bridge application releases.
   - Identified by `version` and `protocolVersion`.

At startup, the launcher reads `/data/releases/current.json`. If it points to a
valid installed bundle, the launcher runs that bundle; otherwise it runs the
image-bundled bridge app. The bridge then registers with the API and reports its
application version, protocol version, runner ABI version, and update channel.

```mermaid
flowchart LR
  CI[GitHub Actions] -->|signed zip + release JSON| Release[GitHub Release]
  Release -->|deploy promotion| ApiData[API BRIDGE_RELEASES_DIR]
  ApiData --> Manifest[API release manifest]
  Manifest --> Bridge[Bridge runtime]
  Bridge -->|verify hash/signature| Staging[/data/releases/.staging]
  Staging --> Current[/data/releases/current.json]
  Current --> Launcher[Bridge launcher]
```

## Compatibility Model

Bridge compatibility is not based on semver alone. The API evaluates bridge
state from four values:

- `version`: display and release selection value for the bridge app bundle.
- `protocolVersion`: API/bridge message compatibility level.
- `runnerAbiVersion`: runtime dependency compatibility level supplied by the
  runner image.
- `updateChannel`: release channel, currently `stable` or `beta`.

The API also compares build metadata when the deployed API knows the current
bridge source fingerprint. This catches same-version drift, such as a bridge
code fix that has not yet been published as a signed app bundle or version bump.
Docker image builds embed a fingerprint derived from `apps/bridge`,
`packages/bridge-runtime`, `packages/shared`, and bridge-relevant build inputs
such as the lockfile and TypeScript config. Settings compares the API image's
fingerprint with the connected bridge image's fingerprint so it can tell whether
a bridge was built from the current bridge-relevant source tree.

The API maps each bridge to a shared update status:

- `unknown`: the bridge has not reported enough metadata.
- `current`: the bridge is on the latest compatible release for its channel.
- `updateAvailable`: a newer compatible app bundle exists.
- `updateRecommended`: the bridge is compatible but below the recommended
  version.
- `updateRequired`: the bridge protocol is below the API minimum supported
  level.
- `imageUpdateRequired`: the bridge semver may still match, but the bridge image
  was built from missing or stale source metadata and needs a Compose rebuild /
  restart.
- `runnerUpdateRequired`: the latest suitable app bundle requires a newer
  runner image.
- `unsupported`: reported metadata is invalid or outside known compatibility
  rules.

Normal printer-affecting RPCs are allowed only for compatible statuses. Bridges
that require updates may connect far enough to report status and receive update
instructions, but unsupported or protocol-incompatible bridges must avoid normal
printer commands.

The shared helper `bridgeUpdateBlocksPrinting` (`packages/shared/src/bridges.ts`) is
the single source of truth for which statuses are blocking (`updateRequired`,
`imageUpdateRequired`, `runnerUpdateRequired`, `unsupported`). The print dispatcher
(`apps/api/src/lib/print-dispatcher.ts`) calls it before every dispatch and refuses to
print through a blocking bridge, so a stale bridge cannot print even if the UI is
bypassed. `bridgeUpdateNeedsAttention` and `bridgeUpdateSupportsInAppUpdate` drive the
web surfacing and the "Update bridge" affordance from the same helper.

## Persistent Data

The API persists bridge update metadata on the `Bridge` model:

```prisma
model Bridge {
  // existing fields omitted
  version                 String?
  buildRevision           String?
  sourceFingerprint       String?
  protocolVersion         Int?
  runnerAbiVersion        String?
  updateChannel           String    @default("stable")
  updateStatus            String?
  latestAvailableVersion  String?
  lastUpdateCheckAt       DateTime?
  lastUpdateError         String?
}
```

The bridge stores active release state in its data volume:

```text
/data/
  bridge-state.json
  releases/
    current.json
    previous.json
    0.4.2/
      manifest.json
      package.json
      dist/
        index.js
        ...
    .staging/
      0.4.3/
```

`current.json` contains a relative release path, entrypoint, activation time,
and health-confirmation state. The launcher does not follow arbitrary absolute
paths from release metadata.

## Release Manifest

The API exposes bridge release manifests at
`GET /api/bridge-runtime/releases/:channel`. Manifests are built from the static
compatibility baseline plus release JSON fragments found in API
`BRIDGE_RELEASES_DIR`, which defaults to `./data/bridge-releases`.

Release fragments have this shape:

```ts
interface BridgeRelease {
  channel: 'stable' | 'beta'
  version: string
  protocolVersion: number
  runnerAbiVersion: string
  minimumRunnerAbiVersion: string
  releasedAt: string
  critical: boolean
  notesUrl: string | null
  bundle: {
    url: string
    sha256: string
    signature: string
    sizeBytes: number
  }
}
```

The API serves zip bundle assets from
`GET /api/bridge-runtime/release-assets/:fileName`. Asset resolution only allows
direct `.zip` files inside `BRIDGE_RELEASES_DIR`, which keeps release URLs
same-origin without exposing arbitrary server files.

## Signing And Trust

Bridge app bundles are signed with an Ed25519 private key. GitHub Actions reads
that key from the `BRIDGE_UPDATE_PRIVATE_KEY` repository secret. Official bridge
runners include the matching public key and use it as the default trust root.
`BRIDGE_UPDATE_PUBLIC_KEY` is an advanced override for development, staging,
self-hosted forks, or key-rotation drills.

The bridge verification path enforces these checks before activation:

- the bundle URL origin must match the configured PrintStream API origin,
- the downloaded bytes must match the release `sha256`,
- the Ed25519 signature over the release hash must verify,
- archive extraction must reject path traversal and absolute paths,
- archive extraction must reject symlinks, and
- release files must be staged under the bridge-owned releases directory.

The private key is release infrastructure only. It must not be copied into
bridge containers, API containers, Compose files, or checked-in source. The
public key is safe to distribute and is compiled into official bridge runners.
Normal public installs do not need to set it in Compose `.env` files.

## Update Flow

### Registration

1. The launcher starts the active app bundle or image-bundled fallback.
2. The bridge registers with the API through the bridge runtime route.
3. Registration includes `version`, `buildRevision`, `sourceFingerprint`,
   `protocolVersion`, `runnerAbiVersion`, and `updateChannel` when those values
   are available from the bridge image.
4. The API persists those values and evaluates the bridge update summary.
5. Bridge WebSocket reconnects also update metadata and broadcast a
   tenant-scoped `resource.changed` event for `bridges` when update-relevant
   fields change.

### Manual Update

1. The settings UI calls `POST /api/bridges/:id/update/check` to refresh the
   API-side status, or `POST /api/bridges/:id/update/start` to start an update.
2. The API sends the connected bridge a `bridge.update.install` RPC.
3. The bridge fetches the channel manifest, selects a compatible bundle, and
   downloads the zip.
4. The bridge verifies origin, SHA-256, and signature.
5. The bridge extracts the bundle into `/data/releases/.staging/<version>/`.
6. Activation moves the staged release to `/data/releases/<version>/`, preserves
   the old pointer in `previous.json`, and writes `current.json` with
   `pendingHealthCheck: true`.
7. The bridge exits so Docker's restart policy relaunches through the launcher.

### Automatic Update

When `BRIDGE_AUTO_UPDATE=true`, the bridge runs the same install flow after
registration if the API reports an installable compatible release. Automatic
update happens before the bridge opens its normal workspace WebSocket, so the
bridge either moves to the new release immediately or continues on the current
compatible release after a failed check.

Automatic updates are app-bundle updates only. They cannot pull Docker images or
modify host containers.

## Health Confirmation And Rollback

Newly activated bundles start with `pendingHealthCheck: true`. After the
relaunched runtime registers successfully, it marks the active pointer confirmed
with `pendingHealthCheck: false` and `confirmedAt`.

Rollback is intentionally narrow:

- if a pending release exits unsuccessfully before health confirmation and
  `previous.json` exists, the launcher restores the previous pointer and retries
  once;
- confirmed releases are not rolled back on later nonzero exits;
- failed update checks, downloads, verification, or extraction leave the current
  bundle active and record `lastUpdateError`; and
- old confirmed releases are cleaned after `BRIDGE_RELEASE_RETENTION_DAYS`.

This keeps rollback focused on failed activations rather than hiding ordinary
runtime crashes after a release has proven healthy.

## API And RPC Surface

HTTP endpoints:

- `GET /api/bridges`: includes each bridge's `update` summary and connection
  stats.
- `POST /api/bridges/:id/test`: checks live bridge responsiveness through a
  ping RPC.
- `POST /api/bridges/:id/update/check`: refreshes update status for one bridge.
- `POST /api/bridges/:id/update/start`: asks a connected bridge to install an
  app-bundle update.
- `GET /api/bridge-runtime/releases/:channel`: returns the bridge release
  manifest for a channel.
- `GET /api/bridge-runtime/release-assets/:fileName`: serves signed bundle zip
  assets from API `BRIDGE_RELEASES_DIR`.

Bridge RPC methods:

- `bridge.ping`
- `bridge.update.check`
- `bridge.update.install`

## Web UI

The bridge settings view shows:

- current bridge app version,
- latest available version,
- protocol version,
- runner ABI version,
- update channel,
- compatibility/update status,
- last update check time,
- last update error,
- bridge connection stats,
- test bridge action,
- check updates action, and
- update bridge action when app self-update is possible.

When `runnerUpdateRequired` is reported, the UI directs the operator to pull a
newer bridge image and restart the bridge rather than offering an app-bundle
update.

Beyond settings, a cross-page banner (`apps/web/src/components/BridgeUpdateBanner.tsx`,
mounted once in the tenant app shell for settings-managers) surfaces any bridge that
needs attention wherever the operator is, with an in-place "Update bridge" action
(`/update/start`) and a "Check again" action (`/update/check`). Blocking statuses are
shown in danger and explain that printing is blocked; image/runner statuses show the
manual pull/restart command instead of an in-app update.

## Release Build And Publication

The bridge update bundle is produced by:

```bash
npm run package:update-bundle:api --workspace @printstream/bridge -- --api-base-url https://printstream.app
```

The packager builds the bridge, zips the production app bundle, excludes the
dedicated demo bridge entrypoint and simulator files, computes the SHA-256 hash,
signs the hash with `BRIDGE_UPDATE_PRIVATE_KEY` or
`BRIDGE_UPDATE_PRIVATE_KEY_FILE`, and writes both files to
`data/bridge-releases`:

- `bridge-<version>.zip`
- `bridge-<version>.release.json`

`.github/workflows/bridge-packages.yml` builds signed update bundles in CI. It
requires:

- repository secret `BRIDGE_UPDATE_PRIVATE_KEY`, and
- repository variable `BRIDGE_UPDATE_API_BASE_URL`, unless a manual workflow
  dispatch supplies `api_base_url`.

Tagged builds use the Git tag version without the `v` prefix, so a tag like
`v0.4.2` produces `bridge-0.4.2.zip` and
`bridge-0.4.2.release.json`. Tag builds attach those assets to the GitHub
release.

## Deployment Promotion

`scripts/deploy/deploy-over-ssh.mjs` promotes bridge update assets during tagged
production deploys. If the deployed commit is exactly tagged, the remote host
downloads the matching GitHub release assets into API `BRIDGE_RELEASES_DIR`
before `docker compose up`:

- `bridge-<version>.zip`
- `bridge-<version>.release.json`

Promotion is enabled by default for tagged commits. Disable it with
`--no-promote-bridge-releases` or `DEPLOY_PROMOTE_BRIDGE_RELEASES=false`.

For local or manually produced artifacts, pass `--sync-bridge-releases` or set
`DEPLOY_SYNC_BRIDGE_RELEASES=true` to sync `data/bridge-releases` to the remote
API release directory before Compose restarts.

## Environment Variables

Bridge runtime variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_VERSION` | bridge `package.json` version | Image-bundled fallback app version, sourced from the bridge `package.json`. Operators do not set this; the launcher injects an activated release's manifest version. |
| `BRIDGE_PROTOCOL_VERSION` | `1` | Image-bundled fallback protocol version. |
| `BRIDGE_RUNNER_ABI_VERSION` | `node22-ffmpeg7-v1` | Runner dependency ABI exposed by the image. |
| `BRIDGE_UPDATE_CHANNEL` | `stable` | Release channel used for update checks. |
| `BRIDGE_AUTO_UPDATE` | `false` | Enables startup app-bundle self-update. |
| `BRIDGE_RELEASES_DIR` | `/data/releases` | Bridge-owned release staging and activation directory. |
| `BRIDGE_RELEASE_RETENTION_DAYS` | `7` | Retention window for old confirmed releases. |
| `BRIDGE_UPDATE_PUBLIC_KEY` | official PrintStream key | Optional Ed25519 public key override used to verify update bundles. |

API/runtime publication variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| API `BRIDGE_RELEASES_DIR` | `./data/bridge-releases` | Directory containing release JSON fragments and zip assets. |
| `BRIDGE_UPDATE_PRIVATE_KEY` | unset | Ed25519 private key used by release tooling and CI to sign bundles. |
| `BRIDGE_UPDATE_PRIVATE_KEY_FILE` | unset | File path alternative to `BRIDGE_UPDATE_PRIVATE_KEY`. |
| `BRIDGE_UPDATE_API_BASE_URL` | unset | CI variable used to generate same-origin bundle URLs. |

## Demo Bridge Separation

The public demo bridge is a dedicated runtime target, not a mode of the live
bridge. Production app-bundle updates exclude demo entrypoints and simulator
files so live bridges do not gain demo runtime code through self-update.

The cloud Compose example runs the demo bridge from the `demo-runtime` Docker
target. Production bridge containers run the normal runtime target and use their
own data volume. The production runtime image installs only production
dependencies for the bridge workspace and copies only bridge, bridge-runtime,
and shared build artifacts, so public bridge images do not distribute the API or
web application directories.

## Operational Rules

- Keep the signing private key outside git and outside deployed runtime
  containers.
- Rotate the signing key by shipping a runner with the new built-in public key
  before publishing bundles signed by the new private key. Use
  `BRIDGE_UPDATE_PUBLIC_KEY` only for controlled override rollouts.
- Treat runner ABI changes as image updates. App-bundle updates cannot solve a
  missing OS package, Node version, native dependency, or launcher contract.
- Keep automatic app-bundle updates disabled until release promotion is
  configured and the deployed runner has the expected trust root.
- Preserve `/data/releases/current.json` and `previous.json` during support
  investigations; they identify the active release and rollback pointer.
- If a bridge reports `runnerUpdateRequired`, pull the newer bridge image and
  restart the bridge before retrying app-bundle update.
