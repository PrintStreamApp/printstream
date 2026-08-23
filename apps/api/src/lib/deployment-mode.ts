/**
 * Distinguishes the self-hosted (open-source) deployment from the hosted cloud
 * deployment. This drives build-exclusive behavior: most importantly which
 * built-in auth provider is registered: self-hosted runs `auth-password`
 * (email/password, no email infrastructure required), cloud runs `auth-local`
 * (passkeys + one-time email codes via Cloudflare email).
 *
 * The default is derived from the build itself: the private cloud modules under
 * `src/private` are stripped from the public OSS export, so their absence means
 * self-hosted. `SELF_HOSTED` overrides the derivation (e.g. set it when running
 * the full private tree from source to exercise the OSS path locally).
 */
import { env } from './env.js'
import { hasPrivateModules } from './private-modules.js'

/**
 * The three deployments this codebase actually has.
 *
 * They used to be two orthogonal booleans owned by two modules,
 * `isSelfHostedDeployment()` here and a raw `env.PRINTSTREAM_NATIVE` read in
 * `license-enforcement.ts`, with the implication "native is self-hosted"
 * encoded as an `||` at ONE of the sixteen call sites. Every other consumer
 * (auth-provider selection, default-workspace bootstrap, workspace context,
 * print dispatch, bridge updates, admin plugins, email delivery) got the
 * unpatched answer. That was safe only because the native bundle happens to
 * ship no `src/private` directory, i.e. the `||` was load-bearing solely under
 * a configuration that would already be broken, which is the signal that the
 * model was wrong rather than that the patch was needed.
 */
export type DeploymentKind =
  /** The hosted multi-workspace deployment. */
  | 'cloud'
  /** Docker / OSS: the operator runs it, licence enforcement applies. */
  | 'self-hosted'
  /** The packaged single-file app: self-hosted, and additionally native-only behaviour. */
  | 'native'

/**
 * Which of the three this process is.
 *
 * `PRINTSTREAM_NATIVE` wins because it is the most specific: the native app IS
 * a self-hosted deployment, so nothing downstream has to remember to say "or
 * native" again.
 */
export function deploymentKind(): DeploymentKind {
  return resolveDeploymentKind({
    native: env.PRINTSTREAM_NATIVE,
    selfHosted: env.SELF_HOSTED,
    hasPrivateModules: hasPrivateModules()
  })
}

/**
 * The decision itself, as a pure function of its three inputs.
 *
 * Separated from {@link deploymentKind} only so it can be exercised for all
 * three deployments in one process: `env` is parsed once at import, so a test
 * that re-imports this module still sees the environment the first import
 * captured. Callers keep using `deploymentKind()`.
 */
export function resolveDeploymentKind(input: {
  native: boolean
  selfHosted: boolean | undefined
  hasPrivateModules: boolean
}): DeploymentKind {
  if (input.native) return 'native'
  return (input.selfHosted ?? !input.hasPrivateModules) ? 'self-hosted' : 'cloud'
}

/** True for everything the operator runs themselves: Docker/OSS and native alike. */
export function isSelfHostedDeployment(): boolean {
  return deploymentKind() !== 'cloud'
}

/** True only for the packaged single-file app. */
export function isNativeDeployment(): boolean {
  return deploymentKind() === 'native'
}
