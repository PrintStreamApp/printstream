/**
 * Core platform-scope notification events, registered on EVERY deployment.
 *
 * Until this module existed, `registerPlatformNotificationEvents` was called
 * only from the private cloud module, so an OSS install had zero platform
 * events and any core emit would be dropped as unregistered. Core events live
 * here; cloud-only operator events stay in `private/cloud/platform-events.ts`.
 * Called once from `index.ts` at boot.
 */
import { registerPlatformNotificationEvents } from './platform-notification-events.js'

export function registerCorePlatformNotificationEvents(): void {
  registerPlatformNotificationEvents([
    {
      event: 'server-backup-failed',
      label: 'Server backup failed',
      variables: ['reason'],
      defaults: {
        enabled: true,
        title: 'Server backup failed',
        body: 'The scheduled backup did not complete: {{reason}}'
      }
    }
  ])
}
