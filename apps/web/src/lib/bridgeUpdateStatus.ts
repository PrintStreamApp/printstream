import type { BridgeUpdateStatus } from '@printstream/shared'

/**
 * Human-readable label for a bridge update status. Shared by the settings bridge
 * panel and the cross-page bridge-update banner so the wording stays in one place.
 */
export function formatBridgeUpdateStatus(status: BridgeUpdateStatus): string {
  switch (status) {
    case 'current': return 'Current'
    case 'updateAvailable': return 'Update available'
    case 'updateRecommended': return 'Update recommended'
    case 'updateRequired': return 'Update required'
    case 'imageUpdateRequired': return 'Image update required'
    case 'runnerUpdateRequired': return 'Runner update required'
    case 'unsupported': return 'Unsupported'
    case 'unknown': return 'Unknown'
  }
}
