import type { AppLandingPageSetting } from '@printstream/shared'

export interface LandingPageOption {
  value: AppLandingPageSetting
  label: string
}

export const CORE_LANDING_PAGE_OPTIONS: ReadonlyArray<LandingPageOption> = [
  { value: '/printers', label: 'Printers' },
  { value: '/library', label: 'Library' },
  { value: '/jobs', label: 'Jobs' },
  { value: '/stats', label: 'Stats' },
  { value: '/settings', label: 'Settings' }
]