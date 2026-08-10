/**
 * One-click in-place update for the native single-file app: the USER-INITIATED
 * apply half of the native update channel (`native-update-check.ts` is the
 * notify half). Runs inside the service process itself — in the native bundle
 * the API *is* the service — so the web endpoint, the control-channel op, and
 * the tray all converge here with no elevation prompt.
 *
 * Sequence: resolve the promoted build → refuse anything unsigned → download
 * via the licensed redirect → verify sha256 + size + Ed25519 → swap the
 * executable via renames → exit with `SERVICE_RESTART_EXIT_CODE` so the
 * service manager restarts into the new binary. The pre-migration DATABASE
 * backup happens on the other side of that restart — the new binary's first
 * boot cold-copies the still-offline cluster before migrating
 * (`apps/server/src/pre-update-backup.ts`); the portable PostgreSQL ships no
 * pg_dump, and the restart window is when a plain copy is consistent.
 * Crash-loop rollback is also the boot side's job (`apps/server/src/run.ts`
 * counts attempts and restores the `.old` binary; it confirms health once the
 * stack serves).
 *
 * **Never automatic.** Nothing in this module runs on a timer; every caller is
 * a human action (footer button, tray item, `update apply`). That is a product
 * decision (2026-08-09), not an implementation gap.
 *
 * **Inert off the native build.** Every path refuses unless the boot published
 * the native env contract (see `env.ts`): most importantly
 * `PRINTSTREAM_SERVER_EXE`, which only a packaged native run sets — so a dev
 * process can never swap its own node binary.
 *
 * **The licence key never reaches a third party.** The download endpoint
 * answers with a redirect to a short-lived signed URL; the key rides an
 * explicit header on the FIRST request only, and the redirect is followed
 * manually without it (fetch would forward custom headers cross-origin).
 */
import {
  downloadVerifiedExecutable,
  SERVICE_RESTART_EXIT_CODE,
  swapExecutableInPlace,
  writeSelfUpdateState
} from '@printstream/sea-runtime'
import { OFFICIAL_UPDATE_PUBLIC_KEY, type ServerReleaseBinary } from '@printstream/shared'
import { env } from './env.js'
import { isNativeDeployment } from './deployment-mode.js'
import { getInstalledLicenseKey } from './license-state.js'
import {
  fetchCurrentServerBuild,
  installedFingerprint,
  nativeUpdateOrigin,
  nativeUpdatePlatformKey
} from './native-update-check.js'

/** How a licensed install presents its key; mirrors `server-release-channel.ts`. */
const LICENSE_HEADER = 'x-printstream-license'

const RESTART_EXIT_DELAY_MS = 500

export interface NativeUpdateApplyResult {
  accepted: boolean
  /** Machine-readable outcome; `message` is the human sentence for all of them. */
  status: 'started' | 'current' | 'unavailable' | 'busy' | 'failed'
  message: string
}

let applyInFlight = false

/** Test seams: the exit a test cannot take, and a hold-point for race tests. */
interface ApplySeams {
  exitForRestart?: () => void
  beforeDownload?: () => Promise<void>
}

/**
 * Download, verify, and stage the promoted build, then restart the process.
 * Resolves BEFORE the process exits (the exit is scheduled a moment out) so
 * the HTTP/control caller gets its response. Never throws — every failure
 * comes back as `{ accepted: false }` with a user-facing message, because
 * each caller (route, control op, tray-driven CLI) would otherwise invent its
 * own wording for the same failures.
 */
export async function applyNativeUpdate(seams: ApplySeams = {}): Promise<NativeUpdateApplyResult> {
  if (applyInFlight) {
    return { accepted: false, status: 'busy', message: 'An update is already in progress.' }
  }
  applyInFlight = true
  try {
    return await runApply(seams)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The update failed.'
    console.error('[native-update] apply failed', { error })
    return { accepted: false, status: 'failed', message }
  } finally {
    applyInFlight = false
  }
}

async function runApply(seams: ApplySeams): Promise<NativeUpdateApplyResult> {
  const own = installedFingerprint()
  const exePath = env.PRINTSTREAM_SERVER_EXE
  const stateFile = env.PRINTSTREAM_UPDATE_STATE_FILE
  if (!isNativeDeployment() || !own || !exePath || !stateFile) {
    return {
      accepted: false,
      status: 'unavailable',
      message: 'In-place updates are only available on the installed native app.'
    }
  }

  const build = await fetchCurrentServerBuild()
  if (!build) {
    return { accepted: false, status: 'unavailable', message: 'No build has been published yet.' }
  }
  if (build.fingerprint === own) {
    return { accepted: false, status: 'current', message: 'This install already runs the current build.' }
  }
  const platformKey = nativeUpdatePlatformKey()
  const binary = build.binaries[platformKey]
  if (!binary) {
    return {
      accepted: false,
      status: 'unavailable',
      message: `Build ${shortFingerprint(build.fingerprint)} has no binary for ${platformKey}.`
    }
  }
  if (!binary.sha256 || !binary.signature) {
    return {
      accepted: false,
      status: 'unavailable',
      message: 'The published build predates signed updates and cannot be applied in place. Download it from your account instead.'
    }
  }

  await seams.beforeDownload?.()

  const licenseKey = await getInstalledLicenseKey()
  await downloadVerifiedExecutable({
    fetchResponse: () => fetchLicensedBinary(binary, licenseKey),
    targetPath: `${exePath}.new`,
    sha256: binary.sha256,
    sizeBytes: binary.sizeBytes,
    signature: binary.signature,
    publicKeyPem: normalizePemEnvValue(env.NATIVE_UPDATE_PUBLIC_KEY) ?? OFFICIAL_UPDATE_PUBLIC_KEY,
    artifactName: 'PrintStream update'
  })

  const backupPath = await swapExecutableInPlace({ exePath, newFilePath: `${exePath}.new` })
  await writeSelfUpdateState(stateFile, {
    fromFingerprint: own,
    toFingerprint: build.fingerprint,
    updatedAt: new Date().toISOString(),
    bootAttempts: 0,
    backupPath
  })

  const message = `Updating to build ${shortFingerprint(build.fingerprint)} — the app is restarting. If it was started in a terminal, start it again.`
  console.log(`[native-update] ${message}`)
  const exitForRestart = seams.exitForRestart ?? (() => {
    setTimeout(() => process.exit(SERVICE_RESTART_EXIT_CODE), RESTART_EXIT_DELAY_MS).unref()
  })
  exitForRestart()
  return { accepted: true, status: 'started', message }
}

/**
 * First request carries the licence header and does not follow the redirect;
 * the signed URL is then fetched bare. A refusal (invalid key, lapsed updates
 * window) surfaces the channel's own message rather than a bare status code —
 * that message is the renewal prompt.
 */
async function fetchLicensedBinary(binary: ServerReleaseBinary, licenseKey: string | null): Promise<Response> {
  const url = pinnedBinaryUrl(binary.url)
  const first = await fetch(url, {
    headers: licenseKey ? { [LICENSE_HEADER]: licenseKey } : {},
    redirect: 'manual'
  })
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location')
    if (!location) throw new Error('The download redirect carried no destination.')
    return fetch(location)
  }
  if (!first.ok) {
    throw new Error(await describeDownloadRefusal(first, licenseKey))
  }
  return first
}

/**
 * The manifest names its download endpoint; trust it only on the origin the
 * manifest itself was fetched from (mirrors the bridge's origin pinning).
 */
function pinnedBinaryUrl(binaryUrl: string): URL {
  const url = new URL(binaryUrl)
  if (url.origin !== new URL(nativeUpdateOrigin()).origin) {
    throw new Error('The update download URL is not on the release channel origin.')
  }
  return url
}

async function describeDownloadRefusal(response: Response, licenseKey: string | null): Promise<string> {
  const fallback = licenseKey
    ? `The update download was refused (HTTP ${response.status}).`
    : 'The update download needs a valid PrintStream license. Install your license key in Settings, then try again.'
  try {
    const body = await response.json() as { error?: unknown; message?: unknown }
    const message = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : null
    return message ?? fallback
  } catch {
    return fallback
  }
}

function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12)
}

/**
 * A PEM set through a dotenv-style config file arrives single-line with `\n`
 * escapes; a PEM set programmatically (tests) arrives with real newlines. Both
 * must reach `createPublicKey` as real PEM — the same normalization the
 * bridge's `BRIDGE_UPDATE_PUBLIC_KEY` env applies.
 */
function normalizePemEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.replaceAll('\\n', '\n')
}

/** Test seam: drop the in-flight latch between cases. */
export function resetNativeUpdateApplyForTests(): void {
  applyInFlight = false
}
