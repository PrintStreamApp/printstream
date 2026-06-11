/**
 * Compatibility wrappers around the shared auth policy helpers.
 *
 * Local-auth still imports these while the broader auth management surface is
 * moved into core routes, but the underlying storage is now global.
 */
export {
  DEFAULT_AUTH_SESSION_DURATION,
  readAuthSessionDuration as readAuthLocalSessionDuration,
  readAuthSessionMaxAgeSeconds as readAuthLocalSessionMaxAgeSeconds,
  writeAuthSessionDuration as writeAuthLocalSessionDuration
} from '../../lib/auth-policy.js'