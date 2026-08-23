/**
 * The official release-signing trust root: the Ed25519 public key whose private
 * half signs release fragments in CI (`BRIDGE_UPDATE_PRIVATE_KEY`). One key
 * covers every self-updating artifact, bridge app bundles, standalone bridge
 * binaries, and native server builds, so "signed by our CI" is a single
 * question with a single answer. Verification happens via
 * `verifyDetachedSha256Signature` (an Ed25519 signature over the artifact's
 * sha256 hex).
 *
 * Public key only, deliberately: nothing in any shipped artifact can sign.
 */
export const OFFICIAL_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5BwqOSY36uuptQybdrY6hjI4zpXHYwxFOLgo358kTWU=
-----END PUBLIC KEY-----
`
